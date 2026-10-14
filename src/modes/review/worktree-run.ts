import { execGit } from './git-exec';
import { type ManifestBlob, readReadableSurface } from './evidence-manifest';
import {
  type GitRun,
  isPreflightError,
  isStrippedPath,
  materializeWorktree,
  type PreflightError,
  reapWorktree,
  resolveRepoLocation,
  type Worktree,
} from './worktree';

// THE RUN-LEVEL WORKTREE LIFECYCLE — pre-flight, materialize, reap (spec §1, §9). One worktree per
// review run, shared read-only by every qualifying seat, and the user's own checkout is NEVER
// involved: the engine fetches `pull/N/head` from the remote's EXPLICIT url and adds a detached
// worktree at the receipt's `headSha`.
//
// The pieces (resolveRepoLocation / materializeWorktree / reapWorktree / readReadableSurface) are
// each pure over an injected `GitRun` and unit-tested that way. This composes them into the one
// object a caller opens in a `try` and reaps in a `finally` — so the whole sequence has exactly one
// order, and the reap can never be forgotten by a new call site.

export interface WorktreeSession {
  // The base branch name and its TIP sha, when the caller named the ref and the best-effort base
  // fetch succeeded (worktree.ts). Base drift (gate trail v12) reads both; null ⇒ labels off.
  baseRef: string | null;
  baseTip: string | null;
  baseSha: string | null;
  dir: string;
  headSha: string;
  // What the worktree seats could read: the tracked tree at headSha, keyed by blob SHA, MINUS the
  // agent-instruction files the engine stripped. Advisory (evidence-manifest.ts), never hashed into
  // the receipt. Subtracting the stripped set is what keeps the artifact honest: `git ls-tree` reads
  // the COMMIT, which still carries a planted CLAUDE.md that no seat could actually open.
  readableSurface: () => ManifestBlob[];
  // Idempotent + never throws — reap is best-effort by contract. It removes the owner-only parent
  // that holds the worktree AND its private repo; nothing was written into the shared checkout, so
  // a crash/SIGTERM leaks at most one temp parent (never a shared-`.git` admin entry to prune).
  reap: () => void;
  // The agent-instruction files removed from the checkout before any seat ran. Sorted, repo-relative.
  strippedInstructionFiles: string[];
}

export interface OpenWorktreeArgs {
  // The PR's base BRANCH name (`.base.ref`). Named ⇒ the materializer also fetches its tip
  // (best-effort) so the gate can tell "already changed on the base since the branch point".
  // Optional: older callers and tests pass none ⇒ no base fetch.
  baseRef?: string | null;
  // The PR's base SHA, for the seats' `git diff <base>...<head>` range. Prompt context only.
  baseSha: string | null;
  // The head SHA the receipt is tied to. Materialization ASSERTS the worktree resolves to it.
  headSha: string;
  pr: number;
  // The PR's `owner/repo`, parsed from its URL. The local checkout must have a remote pointing at
  // it, or the pre-flight refuses: we never fetch a PR into an unrelated repo.
  prSlug: string;
  repoPath: string;
}

// Fails CLOSED into the named taxonomy: `not-a-repo` · `disallowed-root` · `wrong-repo` ·
// `no-such-pr` · `auth` · `network` · `sha-mismatch` · `materialize-failed`. Never throws, never
// partially succeeds — a failed materialization has already reaped whatever it created.
export function openWorktree(
  args: OpenWorktreeArgs,
  deps: { git?: GitRun } = {}
): PreflightError | WorktreeSession {
  const git = deps.git ?? execGit();
  const location = resolveRepoLocation(
    { prSlug: args.prSlug, repoPath: args.repoPath },
    { git }
  );
  if (isPreflightError(location)) return location;

  // `materializeWorktree` RETURNS its git failures, but it can still THROW: the mkdtemp/chmod of the
  // owner-only parent, or the `git clone --bare --local` / `git init --bare` that creates the private
  // repo, can fail on a full or read-only temp root. The caller (cli.ts) opens the worktree BEFORE the
  // try/finally that reaps it, and turns a PreflightError into a legible exit 3 — a throw here would
  // instead escape as a stack trace and a bare exit 1. So the "never throws" contract above is
  // enforced, not asserted.
  // There is no longer a lock to contend for: each review materializes into its own private repo.
  let made: PreflightError | Worktree;
  try {
    made = materializeWorktree({ baseRef: args.baseRef ?? null, headSha: args.headSha, location, pr: args.pr }, { git });
  } catch (e) {
    return { kind: 'materialize-failed', message: (e as Error).message };
  }
  if (isPreflightError(made)) return made;

  let reaped = false;
  return {
    baseRef: args.baseRef ?? null,
    baseSha: args.baseSha,
    baseTip: made.baseTip,
    dir: made.dir,
    headSha: made.headSha,
    readableSurface: () =>
      readReadableSurface(made.dir, made.headSha, { git }).filter(
        (b) => !isStrippedPath(b.path, made.strippedInstructionFiles)
      ),
    reap: () => {
      if (reaped) return;
      reaped = true;
      reapWorktree(made.dir);
    },
    strippedInstructionFiles: made.strippedInstructionFiles,
  };
}
