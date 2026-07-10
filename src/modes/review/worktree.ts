import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readEnsembleConfig } from './ensemble-config';

// WORKTREE EVIDENCE MODE — materialize the PR head as a detached, read-only worktree of a repo
// the user ALREADY has cloned, so a seat sees the whole project the way Oskar does manually,
// without ever touching his checkout (spec §1).
//
// UNTRUSTED CONTENT IS CHECKED OUT BEFORE ANY SEAT SANDBOX EXISTS, so the materialization itself
// must be inert (spec §9, codex-f2):
//   · no hooks               — `-c core.hooksPath=/dev/null` on every git invocation
//   · no submodule recursion — `--no-recurse-submodules` on fetch AND worktree add
//   · no LFS smudge          — `GIT_LFS_SKIP_SMUDGE=1` + the lfs filters emptied, so git-lfs
//                              never runs and therefore never reads the tree's own `.lfsconfig`
//   · tracked files only     — a fresh detached worktree carries no .env / WIP / node_modules
//   · no deps installed      — seats read code, they do not run it
//
// The write into `.git` is the hazard this fleet has scars from: `git worktree add` mutates the
// SHARED object store + `worktree/` admin dir, so materialization is SERIALIZED per repo by an
// O_EXCL lock in the repo's common gitdir. Reap is try/finally + a `git worktree prune` sweeper
// for the crash/SIGTERM paths.

export type GitRun = (
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> }
) => { error: string; ok: false } | { ok: true; text: string };

// The failure taxonomy the pre-flight fails CLOSED into (spec §9, codex-f4 × grok-f2). Every
// branch is a distinct, legible cause — never a generic "git failed".
export type PreflightErrorKind =
  | 'auth'
  | 'disallowed-root'
  | 'network'
  | 'no-such-pr'
  | 'not-a-repo'
  | 'sha-mismatch'
  | 'wrong-repo';

export interface PreflightError {
  kind: PreflightErrorKind;
  message: string;
}

export interface RepoLocation {
  // The EXPLICIT fetch URL. We never assume `origin` exposes `pull/N/head`; the ref is fetched
  // from this url by name (spec §9).
  fetchUrl: string;
  repoRoot: string;
  slug: string; // owner/repo
}

export function isPreflightError(v: unknown): v is PreflightError {
  return typeof v === 'object' && v !== null && 'kind' in v && 'message' in v;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────────────

// Normalize any GitHub remote form to `owner/repo`, lowercased. Handles
// `git@github.com:o/r.git`, `https://github.com/o/r.git`, `ssh://git@github.com/o/r`,
// and a trailing slash. Returns null when it is not a GitHub remote we can compare.
export function remoteSlug(url: string): string | null {
  const s = url.trim().replace(/\.git$/i, '').replace(/\/+$/, '');
  const m =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/\s]+)\/([^/\s]+)$/i.exec(
      s
    );
  return m ? `${m[1].toLowerCase()}/${m[2].toLowerCase()}` : null;
}

// Map git's stderr to the taxonomy. Ordered most-specific first; anything unrecognized stays
// `network` (the conservative default: retryable, not a security claim).
export function classifyGitError(stderr: string): PreflightErrorKind {
  const s = stderr.toLowerCase();
  if (/couldn't find remote ref|no such ref|unadvertised object|not our ref/.test(s)) {
    return 'no-such-pr';
  }
  if (/authentication failed|permission denied|could not read username|403 forbidden|access denied/.test(s)) {
    return 'auth';
  }
  // `404` must be matched as git's OWN not-found phrasing, never as a bare substring: a repo,
  // branch, or proxy hostname containing "404" would otherwise be reported as the definitive
  // security-flavored `wrong-repo` instead of the conservative retryable `network`. Both real
  // forms are matched: `remote: Repository not found.` and `fatal: repository '<url>' not found`.
  if (/repository not found|repository '[^']*' not found|error: 404|status code 404/.test(s)) {
    return 'wrong-repo';
  }
  return 'network';
}

// The ALLOWED-REPO-ROOTS pre-flight (gate-r3 pin 5). A POSITIVE allowlist of repo roots, read
// from CONSUMER CONFIG — never engine-baked. ensemble-ai is public MIT: a baked denylist would
// publish the very repo names it fences. No config ⇒ no engine policy ⇒ allow (the fence is the
// consumer's to declare, and its absence must not silently block every user).
// Absent / unreadable / malformed config → no consumer policy declared → null.
export function allowedRootsFromConfig(configPath?: string): string[] | null {
  const roots = readEnsembleConfig(configPath).allowedRepoRoots;
  if (!Array.isArray(roots) || roots.length === 0) return null;
  const strs = roots.filter((r): r is string => typeof r === 'string' && r.trim().length > 0);
  return strs.length > 0 ? strs.map((r) => path.resolve(r)) : null;
}

// Is `repoRoot` inside one of the allowed roots? Compared on RESOLVED paths with a separator
// boundary, so `/a/repo-evil` is not "under" `/a/repo`.
export function rootAllowed(repoRoot: string, allowed: string[] | null): boolean {
  if (!allowed) return true;
  const real = path.resolve(repoRoot);
  return allowed.some((root) => {
    const rel = path.relative(root, real);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

// ── Pre-flight ────────────────────────────────────────────────────────────────────────

// Resolve the base repo from the PR URL and PROVE the local checkout is that repo before any
// fetch or trail write. Fails closed, with a named cause. The remote's fetch URL is the fact we
// compare — not the directory name, not the cwd.
export function resolveRepoLocation(
  args: { prSlug: string; repoPath: string },
  deps: { allowedRoots?: string[] | null; git: GitRun }
): PreflightError | RepoLocation {
  const repoPath = path.resolve(args.repoPath);
  const top = deps.git(['rev-parse', '--show-toplevel'], { cwd: repoPath });
  if (!top.ok) {
    return {
      kind: 'not-a-repo',
      message: `--repo ${repoPath} is not a git repository (${top.error.trim() || 'rev-parse failed'})`,
    };
  }
  const repoRoot = top.text.trim();

  const allowed =
    deps.allowedRoots === undefined ? allowedRootsFromConfig() : deps.allowedRoots;
  if (!rootAllowed(repoRoot, allowed)) {
    return {
      kind: 'disallowed-root',
      message: `${repoRoot} is not under any allowedRepoRoots entry in your ensemble-ai config — refusing to materialize a worktree outside the roots you allowed`,
    };
  }

  // Compare EVERY remote's fetch URL, not just `origin`: a fork checkout may name the upstream
  // anything. Any remote pointing at the PR's repo proves this is the right checkout.
  const remotes = deps.git(['remote'], { cwd: repoRoot });
  const names = remotes.ok ? remotes.text.split('\n').map((s) => s.trim()).filter(Boolean) : [];
  const want = args.prSlug.toLowerCase();
  const seen: string[] = [];
  for (const name of names) {
    const url = deps.git(['remote', 'get-url', name], { cwd: repoRoot });
    if (!url.ok) continue;
    const raw = url.text.trim();
    const slug = remoteSlug(raw);
    if (slug) seen.push(slug);
    if (slug === want) return { fetchUrl: raw, repoRoot, slug: want };
  }
  return {
    kind: 'wrong-repo',
    message: `--repo ${repoRoot} does not have a remote pointing at ${args.prSlug} (found: ${seen.length ? seen.join(', ') : 'no GitHub remotes'}) — refusing to fetch a PR into an unrelated repo`,
  };
}

// ── Materialization ───────────────────────────────────────────────────────────────────

// Git invocations run with hooks disabled and the LFS smudge/process filters emptied. Setting
// the filters to the empty string means git runs NO filter program, so `git-lfs` never executes
// and the tree's own `.lfsconfig` is never consulted — the in-tree config is inert by
// construction rather than by a flag we hope git honors.
const INERT_GIT_CONFIG = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.clean=',
  '-c', 'filter.lfs.required=false',
];

const INERT_ENV = { GIT_LFS_SKIP_SMUDGE: '1' };

export interface Worktree {
  dir: string;
  headSha: string;
}

// Serialize per repo: `git worktree add` writes into the SHARED `.git`. O_EXCL create is the
// lock; a stale lock older than the TTL is reclaimed (a crashed run must not wedge the repo
// forever). Returns a release function; never throws on release.
//
// OWNERSHIP IS PROVEN, NOT ASSUMED. A blind `unlink(lock)` on release is unsafe once reclaim
// exists: holder A stalls past the TTL, B reclaims and takes the lock, A finishes and its
// release() deletes B's LIVE lock — C then enters while B is mid-`worktree add`, which is the
// exact concurrent-write corruption this lock exists to prevent. So each holder writes a unique
// token and only ever removes a lock still carrying ITS token. The same check guards the stale
// reclaim, so we never unlink a lock that was replaced between our stat and our unlink.
function lockToken(): string {
  return `${process.pid}:${randomUUID()}`;
}

function removeLockIfOwned(lock: string, token: string): void {
  try {
    if (fs.readFileSync(lock, 'utf8').trim() === token) fs.unlinkSync(lock);
  } catch {
    /* gone, or replaced by another holder — either way it is not ours to remove */
  }
}

export function acquireRepoLock(
  gitCommonDir: string,
  opts: { retries?: number; sleepMs?: number; staleMs?: number } = {}
): () => void {
  const lock = path.join(gitCommonDir, 'ensemble-ai-worktree.lock');
  const sleepMs = opts.sleepMs ?? 500;
  const staleMs = opts.staleMs ?? 10 * 60_000;
  // Wait at least as long as the staleness TTL. A shorter budget could never reach the reclaim
  // branch, so a sibling holding the lock across a legitimately slow `git fetch` (a large repo,
  // a cold object store) would throw as "wedged" while it was merely working.
  const retries = opts.retries ?? Math.ceil(staleMs / sleepMs);
  const token = lockToken();
  for (let i = 0; i <= retries; i++) {
    try {
      const fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeSync(fd, token);
      fs.closeSync(fd);
      return () => removeLockIfOwned(lock, token);
    } catch {
      try {
        const held = fs.readFileSync(lock, 'utf8').trim();
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        // Reclaim ONLY the exact stale lock we just observed: if the holder released and a third
        // process took it in between, `held` no longer matches and we leave the new lock alone.
        if (age > staleMs) removeLockIfOwned(lock, held);
      } catch {
        /* raced with the holder — just wait */
      }
      // Synchronous sleep: this runs before any seat spawns, and the lock must be held across
      // the whole materialization (an async gap would let a sibling interleave a worktree add).
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs);
    }
  }
  throw new Error(
    `ensemble-ai: could not acquire the worktree lock at ${lock} after ${retries} attempts (${Math.round((retries * sleepMs) / 1000)}s) — another review is materializing a worktree in this repo`
  );
}

// Fetch the PR head by EXPLICIT url + ref, then add a detached worktree at it, then PROVE the
// worktree's HEAD is the SHA the receipt is tied to. A mismatch ABORTS and reaps — never
// proceed on wrong-SHA evidence (spec §9, grok-f1).
export function materializeWorktree(
  args: { headSha: string; location: RepoLocation; pr: number; worktreeRoot?: string },
  // `lock` is injected so the serialization can be exercised (and stubbed) independently of the
  // real repo — the default IS the per-repo O_EXCL lock.
  deps: { git: GitRun; lock?: (gitCommonDir: string) => () => void }
): PreflightError | Worktree {
  const { location } = args;
  const common = deps.git(['rev-parse', '--git-common-dir'], { cwd: location.repoRoot });
  if (!common.ok) {
    return { kind: 'not-a-repo', message: `cannot resolve the git dir of ${location.repoRoot}` };
  }
  const gitCommonDir = path.resolve(location.repoRoot, common.text.trim());
  const release = (deps.lock ?? acquireRepoLock)(gitCommonDir);
  let dir: string | null = null;
  try {
    const fetched = deps.git(
      [
        ...INERT_GIT_CONFIG,
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        '--no-write-fetch-head',
        location.fetchUrl,
        `pull/${args.pr}/head`,
      ],
      { cwd: location.repoRoot, env: INERT_ENV }
    );
    if (!fetched.ok) {
      return { kind: classifyGitError(fetched.error), message: `fetch pull/${args.pr}/head from ${location.fetchUrl} failed: ${fetched.error.trim()}` };
    }
    // Materialize by SHA, not FETCH_HEAD: the fetch proved the object exists locally, and
    // checking out the receipt's own headSha removes any window where FETCH_HEAD could have
    // been rewritten by a concurrent fetch in the shared .git.
    dir = fs.mkdtempSync(path.join(args.worktreeRoot ?? os.tmpdir(), 'ensemble-worktree-'));
    fs.rmSync(dir, { recursive: true, force: true }); // git wants to create it itself
    const added = deps.git(
      [...INERT_GIT_CONFIG, 'worktree', 'add', '--detach', '--no-recurse-submodules', dir, args.headSha],
      { cwd: location.repoRoot, env: INERT_ENV }
    );
    if (!added.ok) {
      const kind = /invalid reference|not a valid object|unknown revision/i.test(added.error)
        ? 'no-such-pr'
        : classifyGitError(added.error);
      return { kind, message: `worktree add at ${args.headSha.slice(0, 12)} failed: ${added.error.trim()}` };
    }
    const head = deps.git(['rev-parse', 'HEAD'], { cwd: dir });
    const actual = head.ok ? head.text.trim() : '';
    if (actual !== args.headSha) {
      reapWorktree(location.repoRoot, dir, deps);
      dir = null;
      return {
        kind: 'sha-mismatch',
        message: `worktree HEAD is ${actual || '(unresolvable)'} but the review is tied to ${args.headSha} — ABORTING rather than reviewing wrong-SHA evidence`,
      };
    }
    const made = { dir, headSha: args.headSha };
    dir = null; // ownership transfers to the caller's try/finally
    return made;
  } finally {
    if (dir) reapWorktree(location.repoRoot, dir, deps);
    release();
  }
}

// Reap: remove the worktree, then `prune` so a crash/SIGTERM path (dir gone, admin entry left)
// self-heals on the next run. Never throws — reap is best-effort by contract.
export function reapWorktree(repoRoot: string, dir: string, deps: { git: GitRun }): void {
  try {
    deps.git([...INERT_GIT_CONFIG, 'worktree', 'remove', '--force', dir], { cwd: repoRoot });
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(dir, { force: true, recursive: true });
  } catch {
    /* best-effort */
  }
  try {
    deps.git([...INERT_GIT_CONFIG, 'worktree', 'prune'], { cwd: repoRoot });
  } catch {
    /* best-effort */
  }
}
