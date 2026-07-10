import { execGit } from './git-exec';
import { type ManifestBlob, readReadableSurface } from './evidence-manifest';
import {
  type GitRun,
  isPreflightError,
  materializeWorktree,
  type PreflightError,
  reapWorktree,
  resolveRepoLocation,
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
  baseSha: string | null;
  dir: string;
  headSha: string;
  // What the worktree seats could read: the tracked tree at headSha, keyed by blob SHA. Advisory
  // (evidence-manifest.ts), never hashed into the receipt.
  readableSurface: () => ManifestBlob[];
  // Idempotent + never throws — reap is best-effort by contract, plus a `git worktree prune` sweep
  // that self-heals the crash/SIGTERM path on the next run.
  reap: () => void;
}

export interface OpenWorktreeArgs {
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
// `no-such-pr` · `auth` · `network` · `sha-mismatch`. Never throws, never partially succeeds — a
// failed materialization has already reaped whatever it created.
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

  const made = materializeWorktree(
    { headSha: args.headSha, location, pr: args.pr },
    { git }
  );
  if (isPreflightError(made)) return made;

  let reaped = false;
  return {
    baseSha: args.baseSha,
    dir: made.dir,
    headSha: made.headSha,
    readableSurface: () => readReadableSurface(made.dir, made.headSha, { git }),
    reap: () => {
      if (reaped) return;
      reaped = true;
      reapWorktree(location.repoRoot, made.dir, { git });
    },
  };
}
