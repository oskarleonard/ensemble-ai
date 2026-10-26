import fs from 'node:fs';
import path from 'node:path';

import { execGit } from './git-exec';

// Where the review mode hands the gathered conventions to seats that read the tree: ONE file in
// the worktree, index first (core/conventions conventionsIndex), instead of the same ~350 KB
// inlined into every part's packet. Named here, not in index.ts, so the writer below and the
// gate's reader (holistic-gate CONVENTIONS_IN_TREE_REL) spell the path from one place.
export const CONVENTIONS_IN_TREE_DIR = '.ensemble-conventions';
export const CONVENTIONS_IN_TREE_FILE = 'CONVENTIONS.md';
// Inside the directory the engine creates: everything in it is ignored, so a seat's `git status`
// / `git diff` in the worktree never shows the engine's file as the PR's own untracked change.
// NESTED, not `.git/info/exclude`: a `.gitignore` negation committed at the PR head outranks the
// exclude file, and the nearest ignore file wins (Munin's gate round on the same write, 2026-10-26).
const IGNORE_ALL = '*\n';

// ── The write is a sandbox-boundary write (Munin, engine ask 5, 2026-10-23) ──────────────────
//
// The worktree is the PR HEAD, i.e. the author's content, and `git worktree add` checks out
// committed symlinks as symlinks. `mkdirSync(dir, { recursive: true })` + `writeFileSync(file)`
// both FOLLOW a symlink, so a PR that committed `.ensemble-conventions` as a link to a writable
// directory (or `.ensemble-conventions/CONVENTIONS.md` as a link to a writable file) redirected
// the engine's write — as the operator's user — to any path that user can write. The gate's
// READER already realpath-checks its side (holistic-gate worktreeReader); this is the writer's.
//
// Four fences, each sufficient alone against the committed-symlink case, kept together because
// they fail differently:
//   1. the PR head must track NOTHING at the engine's path (`git ls-tree` at the head, compared
//      case-folded — the checkout may sit on a case-insensitive filesystem);
//   2. nothing may already sit at the path in the checkout (lstat, which does NOT follow);
//   3. the directory is created NON-recursively (EEXIST if anything appeared in between);
//   4. the file is opened O_CREAT|O_EXCL|O_NOFOLLOW (never an existing file, never through a link).
// Any failure after the directory exists removes it, so a half-written handover never stays in
// the tree for a seat to read. A refusal is reported, and the caller inlines the conventions
// instead — the route a seat on the packet alone already takes.

export type RootEntriesAtHead = (worktreeDir: string, headSha: string) => string[] | null;

// The root entries of the tree at `headSha`, through git in the worktree; null when git could
// not answer (not a repo, unknown object) — fence 1 is then skipped and fences 2–4 stand alone.
export function gitRootEntriesAtHead(worktreeDir: string, headSha: string): string[] | null {
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(headSha)) return null;
  const res = execGit()(['ls-tree', '--name-only', headSha], { cwd: worktreeDir });
  if (!res.ok) return null;
  return res.text.split('\n').filter((l) => l !== '');
}

// Create `file` as a NEW regular file, never through a symlink, and write `body` into it.
export function writeExclusive(file: string, body: string, mode = 0o600): void {
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(file, flags, mode);
  try {
    fs.writeFileSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }
}

export type ConventionsWriteResult = { file: string; ok: true } | { ok: false; why: string };

export interface ConventionsWriteSeams {
  rootEntriesAtHead?: RootEntriesAtHead;
  writeExclusive?: typeof writeExclusive;
}

// Fences 1–3 for ANY directory the engine wants to own at the worktree root (`.ensemble-conventions`,
// `.companions`, …): the head tracks nothing there (case-folded), nothing sits there on disk (lstat),
// and the directory is created non-recursively at 0700. Ok ⇒ the engine owns a fresh, empty, link-free
// directory and may write into it with O_EXCL|O_NOFOLLOW (fence 4). The companions install (Munin's
// review of #145 flagged its `mkdirSync(recursive)` + `cpSync(force)` as the same class) shares it.
export type EngineDirClaim = { dir: string; ok: true } | { ok: false; why: string };

export function claimEngineDir(
  worktreeDir: string,
  headSha: string,
  dirName: string,
  rootEntries: RootEntriesAtHead = gitRootEntriesAtHead
): EngineDirClaim {
  const dir = path.join(worktreeDir, dirName);

  // 1. The head tracks nothing at the path (case-folded).
  const tracked = rootEntries(worktreeDir, headSha)?.find((n) => n.toLowerCase() === dirName.toLowerCase());
  if (tracked !== undefined) return { ok: false, why: `the PR head tracks \`${tracked}\` — the engine never writes over the author's path` };

  // 2. Nothing sits at the path in the checkout — lstat does not follow a link.
  try {
    const st = fs.lstatSync(dir);
    const kind = st.isSymbolicLink() ? 'a symlink' : st.isDirectory() ? 'a directory' : 'a file';
    return { ok: false, why: `${kind} already sits at ${dirName} in the checkout` };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return { ok: false, why: `could not inspect ${dirName}: ${(e as Error).message}` };
  }

  // 3. The directory, non-recursively: EEXIST if anything appeared since the lstat.
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    return { ok: false, why: `could not create ${dirName}: ${(e as Error).message}` };
  }
  return { dir, ok: true };
}

export function writeConventionsInTree(
  worktreeDir: string,
  headSha: string,
  body: string,
  seams: ConventionsWriteSeams = {}
): ConventionsWriteResult {
  const exclusive = seams.writeExclusive ?? writeExclusive;
  const claim = claimEngineDir(worktreeDir, headSha, CONVENTIONS_IN_TREE_DIR, seams.rootEntriesAtHead ?? gitRootEntriesAtHead);
  if (!claim.ok) return claim;
  const dir = claim.dir;
  const file = path.join(dir, CONVENTIONS_IN_TREE_FILE);

  // 4. The file and the ignore-all beside it, each a NEW regular file. The ignore file is written
  // AFTER the conventions file exists: an ignore rule for a file that is not there yet is a
  // promise, not a fact. Any failure from here removes the directory the engine created.
  try {
    exclusive(file, body);
    exclusive(path.join(dir, '.gitignore'), IGNORE_ALL);
    return { file, ok: true };
  } catch (e) {
    try {
      fs.rmSync(dir, { force: true, recursive: true });
    } catch {
      // best effort — the worktree is reaped after the run either way
    }
    return { ok: false, why: `could not write ${CONVENTIONS_IN_TREE_DIR}/${CONVENTIONS_IN_TREE_FILE}: ${(e as Error).message}` };
  }
}
