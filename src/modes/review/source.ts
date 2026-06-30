// PURE diff-source resolution — the one place that decides WHICH diff the review
// runs over, from the CLI flags + whether stdin is piped. No git/gh I/O here (the
// CLI executor performs that on the returned selection), so this stays a small
// fully-unit-testable decision: precedence, conflict detection, and --pr parsing.
//
// Sources, most-explicit first:
//   --pr <N>          the diff of GitHub PR #N (via `gh pr diff <N>`)
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
  // The parsed PR number (kind 'pr').
  pr?: number;
}

export interface DiffSourceError {
  error: string;
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
      const n = Number(flags.pr);
      if (!Number.isInteger(n) || n <= 0) {
        return { error: `--pr must be a positive integer (got "${flags.pr}")` };
      }
      return { kind, pr: n };
    }
    if (kind === 'diff-file') return { diffFile: flags.diffFile, kind };
    return { kind };
  }

  // No explicit source: a piped diff wins over the default; otherwise commit mode.
  if (flags.stdinPiped) return { kind: 'stdin' };
  return { kind: 'commit' };
}
