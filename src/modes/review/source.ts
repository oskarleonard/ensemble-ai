// PURE diff-source resolution — the one place that decides WHICH diff the review
// runs over, from the CLI flags + whether stdin is piped. No git/gh I/O here (the
// CLI executor performs that on the returned selection), so this stays a small
// fully-unit-testable decision: precedence, conflict detection, and --pr parsing.
//
// Sources, most-explicit first:
//   --pr <N|url>      the diff of GitHub PR #N. A bare integer → `gh pr diff <N>`
//                     in the cwd; a full PR URL (github.com/<owner>/<repo>/pull/<N>)
//                     → `gh pr diff <N> -R <owner>/<repo>`, reviewable from ANY dir
//                     with no checkout (the URL carries owner/repo).
//   --diff-file <p>   a raw unified diff read from a file
//   --staged          staged changes (`git diff --cached`)
//   --working-tree    uncommitted tracked changes vs HEAD (`git diff HEAD`)
//   (stdin)           a piped diff, when NO explicit source flag is given
//   (default)         <base>...HEAD — the current branch vs its merge-base with
//                     the default branch (resolved like `gh pr create`)
//
// At most ONE explicit source may be given; two is a usage error (never a silent
// first-wins, which would review something other than what the user asked for).

export type DiffSourceKind =
  | 'commit'
  | 'diff-file'
  | 'pr'
  | 'staged'
  | 'stdin'
  | 'working-tree';

export interface DiffSourceFlags {
  diffFile?: string;
  pr?: string;
  staged?: boolean;
  stdinPiped?: boolean;
  workingTree?: boolean;
}

export interface DiffSourceSelection {
  // The resolved diff-file path (kind 'diff-file').
  diffFile?: string;
  kind: DiffSourceKind;
  // The repo OWNER (kind 'pr', URL form only) — makes `gh` work from any cwd via
  // `-R <owner>/<repo>`; absent for a bare-integer --pr (uses the cwd's repo).
  owner?: string;
  // The parsed PR number (kind 'pr').
  pr?: number;
  // The repo NAME (kind 'pr', URL form only). Paired with `owner`.
  repo?: string;
}

export interface DiffSourceError {
  error: string;
}

// A parsed GitHub PR reference from a URL.
export interface PrUrlRef {
  owner: string;
  pr: number;
  repo: string;
}

// Parse a GitHub PR URL → {owner, repo, pr}, or null if it isn't one. Tolerates
// http/https, a case-insensitive scheme+host (GitHub.com is a valid host), a trailing
// `/files` or `/commits` sub-tab, a trailing slash, and a `?query`/`#hash`. The PR
// number is a strict positive integer (same rule as the bare --pr form), so
// `.../pull/0` or `.../pull/abc` cleanly returns null → error.
export function parsePrUrl(s: string): PrUrlRef | null {
  const m =
    /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9][0-9]*)(?:\/(?:files|commits))?\/?(?:[?#].*)?$/i.exec(
      s.trim()
    );
  if (!m) return null;
  return { owner: m[1], pr: Number(m[3]), repo: m[2] };
}

export function isDiffSourceError(
  v: DiffSourceSelection | DiffSourceError
): v is DiffSourceError {
  return 'error' in v;
}

const FLAG_LABEL: Record<'diff-file' | 'pr' | 'staged' | 'working-tree', string> = {
  'diff-file': '--diff-file',
  pr: '--pr',
  staged: '--staged',
  'working-tree': '--working-tree',
};

// True when the user named an explicit diff source (so the CLI must NOT read stdin
// — reading a pipe it won't use can block). The one definition of "explicit",
// shared by the stdin-gating in the CLI and the selection below.
export function hasExplicitSource(flags: DiffSourceFlags): boolean {
  return (
    flags.pr !== undefined ||
    flags.diffFile !== undefined ||
    Boolean(flags.staged) ||
    Boolean(flags.workingTree)
  );
}

export function selectDiffSource(
  flags: DiffSourceFlags
): DiffSourceSelection | DiffSourceError {
  const explicit: ('diff-file' | 'pr' | 'staged' | 'working-tree')[] = [];
  if (flags.pr !== undefined) explicit.push('pr');
  if (flags.diffFile !== undefined) explicit.push('diff-file');
  if (flags.staged) explicit.push('staged');
  if (flags.workingTree) explicit.push('working-tree');

  if (explicit.length > 1) {
    return {
      error: `choose at most ONE diff source — got ${explicit
        .map((k) => FLAG_LABEL[k])
        .join(', ')}`,
    };
  }

  if (explicit.length === 1) {
    const kind = explicit[0];
    if (kind === 'pr') {
      const raw = String(flags.pr);
      // A bare, strict decimal integer → PR #N in the cwd's repo. (`Number()` would
      // accept '0x10', '1e3', and whitespace-padded values — none a PR a user typed.)
      if (/^[1-9][0-9]*$/.test(raw)) {
        return { kind, pr: Number(raw) };
      }
      // Otherwise it must be a full GitHub PR URL → carries owner/repo so the diff
      // is fetchable from ANY directory (no local checkout of the branch needed).
      const ref = parsePrUrl(raw);
      if (ref) {
        return { kind, owner: ref.owner, pr: ref.pr, repo: ref.repo };
      }
      return {
        error: `--pr must be a positive integer or a GitHub PR URL (https://github.com/<owner>/<repo>/pull/<N>) — got "${raw}"`,
      };
    }
    if (kind === 'diff-file') return { diffFile: flags.diffFile, kind };
    return { kind };
  }

  // No explicit source: a piped diff wins over the default; otherwise commit mode.
  if (flags.stdinPiped) return { kind: 'stdin' };
  return { kind: 'commit' };
}
