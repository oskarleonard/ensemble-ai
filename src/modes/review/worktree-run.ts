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
  WORKTREE_LOCK_ERROR,
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
  baseSha: string | null;
  dir: string;
  headSha: string;
  // What the worktree seats could read: the tracked tree at headSha, keyed by blob SHA, MINUS the
  // agent-instruction files the engine stripped. Advisory (evidence-manifest.ts), never hashed into
  // the receipt. Subtracting the stripped set is what keeps the artifact honest: `git ls-tree` reads
  // the COMMIT, which still carries a planted CLAUDE.md that no seat could actually open.
  readableSurface: () => ManifestBlob[];
  // Idempotent + never throws — reap is best-effort by contract, plus a `git worktree prune` sweep
  // that self-heals the crash/SIGTERM path on the next run.
  reap: () => void;
  // The agent-instruction files removed from the checkout before any seat ran. Sorted, repo-relative.
  strippedInstructionFiles: string[];
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
// `no-such-pr` · `auth` · `network` · `sha-mismatch` · `lock-contended` · `materialize-failed`.
// Never throws, never partially succeeds — a failed materialization has already reaped whatever it
// created.
export function openWorktree(
  args: OpenWorktreeArgs,
  // `lock` is injected exactly as materializeWorktree injects it — the default IS the per-repo
  // O_EXCL lock. A test needs the seam to prove the contended path returns a NAMED cause instead
  // of throwing (the real lock only gives up after its 10-minute staleness TTL).
  deps: { git?: GitRun; lock?: (gitCommonDir: string) => () => void } = {}
): PreflightError | WorktreeSession {
  const git = deps.git ?? execGit();
  const location = resolveRepoLocation(
    { prSlug: args.prSlug, repoPath: args.repoPath },
    { git }
  );
  if (isPreflightError(location)) return location;

  // `materializeWorktree` RETURNS its git failures, but it can still THROW: `acquireRepoLock` gives
  // up with an Error when a sibling review holds the repo lock past the staleness TTL, and the
  // mkdtemp/chmod of the worktree parent can fail on a full or read-only temp root. The caller
  // (cli.ts) opens the worktree BEFORE the try/finally that reaps it, and turns a PreflightError
  // into a legible exit 3 — a throw here would instead escape as a stack trace and a bare exit 1.
  // So the "never throws" contract above is enforced, not merely asserted.
  let made: PreflightError | Worktree;
  try {
    made = materializeWorktree(
      { headSha: args.headSha, location, pr: args.pr },
      { git, ...(deps.lock ? { lock: deps.lock } : {}) }
    );
  } catch (e) {
    const message = (e as Error).message;
    return {
      kind: message.includes(WORKTREE_LOCK_ERROR) ? 'lock-contended' : 'materialize-failed',
      message,
    };
  }
  if (isPreflightError(made)) return made;

  let reaped = false;
  return {
    baseSha: args.baseSha,
    dir: made.dir,
    headSha: made.headSha,
    readableSurface: () =>
      readReadableSurface(made.dir, made.headSha, { git }).filter(
        (b) => !isStrippedPath(b.path, made.strippedInstructionFiles)
      ),
    reap: () => {
      if (reaped) return;
      reaped = true;
      reapWorktree(location.repoRoot, made.dir, { git });
    },
    strippedInstructionFiles: made.strippedInstructionFiles,
  };
}
