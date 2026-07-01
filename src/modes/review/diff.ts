import { execFileSync } from 'node:child_process';

import { sha256Hex } from '../../core/hash';

// Diff acquisition + the canonical-diff content digest + per-file COVERAGE.
//
// A raw `git diff` has NO intrinsic commit identity, so the manifest records the
// base+head commit (or an explicit working-tree marker) AND a SEPARATE content
// digest — the two are kept distinct (a digest is not a commit SHA). Coverage is
// per-file and EXPLICIT: binary / generated / over-limit files are NAMED as
// omitted, never silently dropped — so the headline "verifiable manifest" can't
// lie about what the reviewer actually saw.

export type DiffMode = 'commit' | 'working-tree' | 'staged' | 'pr' | 'raw';
export type FileKind = 'source' | 'generated' | 'binary';
export type OmitReason = 'binary' | 'generated' | 'over-limit';

// The default coverage ceiling (bytes of included diff). Generous — modern
// context windows are large — but bounded so an enormous diff can't silently
// blow past the prompt budget. Over-limit files are NAMED, not dropped.
export const DEFAULT_COVERAGE_CEILING = 200_000;

// Paths whose omission does NOT make a review partial-in-a-bad-way: lockfiles,
// build output, minified/generated assets, snapshots. A reviewer reading these
// adds nothing; omitting them is expected. An omitted SOURCE file, by contrast,
// means the review didn't cover the change → the receipt must not qualify.
const GENERATED_PATTERNS: RegExp[] = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)bun\.lockb$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)(dist|build|out|coverage|node_modules|vendor)\//,
  /(^|\/)\.next\//,
  /\.min\.(js|css)$/,
  /\.(js|css)\.map$/,
  /\.snap$/,
];

export function classifyFileKind(path: string, isBinary: boolean): FileKind {
  if (isBinary) return 'binary';
  return GENERATED_PATTERNS.some((re) => re.test(path)) ? 'generated' : 'source';
}

export interface FileDiff {
  added: number;
  bytes: number;
  isBinary: boolean;
  kind: FileKind;
  path: string;
  raw: string;
  removed: number;
}

// Pull the changed path out of a `diff --git a/<p> b/<p>` section. Prefers the
// `+++ b/<path>` line (authoritative for adds/edits); falls back to the
// `rename to` line, then the `diff --git` header. Returns 'unknown' rather than
// throwing on a shape we don't recognize (a degraded entry, still NAMED).
function pathOfSection(section: string): string {
  const plus = section.match(/^\+\+\+ b\/(.+)$/m);
  if (plus && plus[1] !== 'dev/null') return plus[1].trim();
  const renameTo = section.match(/^rename to (.+)$/m);
  if (renameTo) return renameTo[1].trim();
  const minus = section.match(/^--- a\/(.+)$/m);
  if (minus && minus[1] !== 'dev/null') return minus[1].trim();
  const header = section.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (header) return header[2].trim();
  return 'unknown';
}

// Split a unified diff into per-file sections (each starts at a `diff --git`
// line) and classify each. PURE — feed it a diff string, get structured files.
export function parseDiffFiles(raw: string): FileDiff[] {
  if (!raw.trim()) return [];
  // Anchor splits to a `diff --git` at column 0 (a hunk body line that merely
  // starts with "diff --git" can't, since hunk content is prefixed by +/-/space).
  const parts = raw.split(/^(?=diff --git )/m).filter((s) => s.trim());
  return parts.map((section) => {
    const isBinary =
      /^Binary files .* differ$/m.test(section) ||
      /^GIT binary patch$/m.test(section);
    const path = pathOfSection(section);
    let added = 0;
    let removed = 0;
    for (const line of section.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) added++;
      else if (line.startsWith('-') && !line.startsWith('---')) removed++;
    }
    return {
      added,
      bytes: Buffer.byteLength(section, 'utf8'),
      isBinary,
      kind: classifyFileKind(path, isBinary),
      path,
      raw: section,
      removed,
    };
  });
}

export interface CoverageFileEntry {
  added: number;
  bytes: number;
  included: boolean;
  kind: FileKind;
  omitReason?: OmitReason;
  path: string;
  removed: number;
}

export interface Coverage {
  files: CoverageFileEntry[];
  includedBytes: number;
  includedFiles: number;
  omittedFiles: number;
  totalBytes: number;
  totalFiles: number;
}

// Coverage PRESENTATION — one wording shared by the review summary (cli
// printSummary), the `diff` packet preview, and the receipt renderers
// (plumbing/verify), so the `total · reviewed · omitted` skeleton and the
// `omitted: <path> (<reason>/<kind>)` line have a single source of truth and can't
// drift. Pure; take structural args so both a Coverage entry and a ReceiptCoverage
// entry satisfy them. Callers supply their own left-indent.
export function coverageCounts(c: {
  includedFiles: number;
  omittedFiles: number;
  totalFiles: number;
}): string {
  return `${c.totalFiles} total · ${c.includedFiles} reviewed · ${c.omittedFiles} omitted`;
}

export function omittedLine(o: {
  kind: string;
  path: string;
  reason: string | undefined;
}): string {
  // `reason` is optional on a Coverage entry (only omitted files carry one, and they
  // always do — computeCoverage sets binary/generated/over-limit); the `?? 'omitted'`
  // matches summarizeCoverage's fallback so the shared line never renders "undefined".
  return `omitted: ${o.path} (${o.reason ?? 'omitted'}/${o.kind})`;
}

// Decide which file diffs the reviewer actually sees, bounded by a byte ceiling,
// and record EVERY file's disposition. Binary + generated files are omitted by
// kind; remaining (source) files are included in order until the ceiling, after
// which they're omitted as 'over-limit' — NAMED, never silently dropped. The
// included sections are concatenated into the diff the packet carries (so the
// reviewer sees exactly what coverage says, with no mid-file truncation).
export function computeCoverage(
  files: FileDiff[],
  ceilingBytes: number = DEFAULT_COVERAGE_CEILING
): { coverage: Coverage; includedDiff: string } {
  const entries: CoverageFileEntry[] = [];
  const includedSections: string[] = [];
  let includedBytes = 0;
  for (const f of files) {
    const base = {
      added: f.added,
      bytes: f.bytes,
      kind: f.kind,
      path: f.path,
      removed: f.removed,
    };
    if (f.kind === 'binary') {
      entries.push({ ...base, included: false, omitReason: 'binary' });
      continue;
    }
    if (f.kind === 'generated') {
      entries.push({ ...base, included: false, omitReason: 'generated' });
      continue;
    }
    if (includedBytes + f.bytes > ceilingBytes && includedBytes > 0) {
      entries.push({ ...base, included: false, omitReason: 'over-limit' });
      continue;
    }
    entries.push({ ...base, included: true });
    includedSections.push(f.raw);
    includedBytes += f.bytes;
  }
  const coverage: Coverage = {
    files: entries,
    includedBytes,
    includedFiles: entries.filter((e) => e.included).length,
    omittedFiles: entries.filter((e) => !e.included).length,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    totalFiles: files.length,
  };
  return { coverage, includedDiff: includedSections.join('') };
}

// Normalize a diff for a STABLE content digest: LF line endings + a single
// trailing newline. The digest identifies the CHANGE (the full base...HEAD diff),
// independent of coverage — so two reviews of the same change collide on digest
// even if one was partial.
export function canonicalizeDiff(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
}

export function diffDigest(raw: string): string {
  return `sha256:${sha256Hex(canonicalizeDiff(raw))}`;
}

// ── git I/O ────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[], opts?: { quiet?: boolean }): string {
  // `opts.quiet` silences stderr for the OPTIONAL-probe path (base resolution,
  // repoId, rev-parse) so git's own noise ("fatal: not a git repository" when
  // reviewing a PR URL from a non-repo cwd like /tmp) never leaks to the user. The
  // default keeps stderr on the parent so real diff errors stay visible.
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: opts?.quiet ? ['ignore', 'pipe', 'ignore'] : ['pipe', 'pipe', 'inherit'],
  });
}

function gitOrNull(cwd: string, args: string[]): string | null {
  // An optional probe that fails means "not available" → null (stderr silenced).
  try {
    return git(cwd, args, { quiet: true }).trim();
  } catch {
    return null;
  }
}

// The repo identity for the receipt store key: the normalized origin remote URL
// if there is one, else the absolute repo root. Stable across worktrees of the
// same repo (they share a remote) and machine-local for a remote-less repo.
export function resolveRepoId(cwd: string): string | null {
  const remote = gitOrNull(cwd, ['remote', 'get-url', 'origin']);
  if (remote) {
    return remote
      .replace(/^git@([^:]+):/, 'https://$1/')
      .replace(/\.git$/, '')
      .replace(/\/$/, '');
  }
  return gitOrNull(cwd, ['rev-parse', '--show-toplevel']);
}

// Resolve the base the SAME way `gh pr create` will: an explicit `--base`, else
// the repo's default branch (origin/HEAD), else a local `main`/`master`. Returns
// null when none resolves — the caller FAILS CLOSED (an unresolvable base means
// we can't compute base...HEAD, so the diff is undefined → never "reviewed").
export function resolveBase(cwd: string, explicit?: string): string | null {
  if (explicit) return explicit;
  const originHead = gitOrNull(cwd, [
    'symbolic-ref',
    'refs/remotes/origin/HEAD',
  ]);
  if (originHead) return originHead.replace(/^refs\//, '');
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (gitOrNull(cwd, ['rev-parse', '--verify', '--quiet', ref]) !== null) {
      return ref;
    }
  }
  return null;
}

export interface AcquiredDiff {
  baseRef: string | null;
  baseSha: string | null;
  canonicalDigest: string;
  coverage: Coverage;
  // The COVERED diff (included files only) — exactly what the reviewer sees.
  diff: string;
  // The parsed per-file diffs (the full set, pre-coverage) — computed here for
  // coverage and reused by the caller's secret-scan, so the raw diff is parsed once.
  files: FileDiff[];
  headSha: string;
  mode: DiffMode;
  // The full base...HEAD diff before coverage filtering (the digest is over this).
  rawDiff: string;
  repoId: string | null;
}

export interface AcquireDiffOpts {
  base?: string;
  ceilingBytes?: number;
  cwd: string;
  // The mode LABEL for a pre-supplied diffText (default 'raw'). A `gh pr diff`
  // capture passes 'pr' so the manifest/receipt name the source honestly; the text
  // is still treated as raw (no git resolution, no local commit identity).
  diffMode?: DiffMode;
  // A pre-supplied raw diff (mode 'raw' unless diffMode overrides): no git
  // resolution, no commit identity.
  diffText?: string;
  // Override the headSha for a pre-supplied diffText — used for a `gh pr diff` of a
  // URL PR, where the CLI resolves the PR head SHA (`gh pr view --json headRefOid`)
  // so the receipt is content-tied to the exact PR head instead of a generic label.
  headShaOverride?: string;
  // Review staged changes (`git diff --cached`) vs HEAD.
  staged?: boolean;
  // Review uncommitted tracked changes vs HEAD instead of base...HEAD.
  workingTree?: boolean;
}

// The one entry the CLI calls. Resolves the diff + identity + coverage + digest.
// THROWS with a clear message when the base can't be resolved in commit mode
// (fail-closed) — never silently reviews the wrong range.
export function acquireDiff(opts: AcquireDiffOpts): AcquiredDiff {
  const ceiling = opts.ceilingBytes ?? DEFAULT_COVERAGE_CEILING;
  const repoId = resolveRepoId(opts.cwd);

  let mode: DiffMode;
  let rawDiff: string;
  let baseRef: string | null = null;
  let baseSha: string | null = null;
  let headSha: string;

  if (opts.diffText !== undefined) {
    mode = opts.diffMode ?? 'raw';
    rawDiff = opts.diffText;
    headSha =
      opts.headShaOverride ??
      (mode === 'pr'
        ? 'gh pr diff (no local commit identity)'
        : 'raw diff (no commit identity)');
  } else if (opts.staged) {
    mode = 'staged';
    rawDiff = git(opts.cwd, ['diff', '--cached']);
    baseSha = gitOrNull(opts.cwd, ['rev-parse', 'HEAD']);
    baseRef = 'HEAD';
    headSha = 'staged/index (no commit identity)';
  } else if (opts.workingTree) {
    mode = 'working-tree';
    rawDiff = git(opts.cwd, ['diff', 'HEAD']);
    baseSha = gitOrNull(opts.cwd, ['rev-parse', 'HEAD']);
    baseRef = 'HEAD';
    headSha = 'working-tree (no commit identity)';
  } else {
    mode = 'commit';
    const base = resolveBase(opts.cwd, opts.base);
    if (!base) {
      throw new Error(
        'could not resolve a base ref (no --base, no origin/HEAD, no main/master) — refusing to review an undefined range'
      );
    }
    baseRef = base;
    baseSha = gitOrNull(opts.cwd, ['rev-parse', base]);
    headSha =
      gitOrNull(opts.cwd, ['rev-parse', 'HEAD']) ??
      'working-tree (no commit identity)';
    rawDiff = git(opts.cwd, ['diff', `${base}...HEAD`]);
  }

  const files = parseDiffFiles(rawDiff);
  const { coverage, includedDiff } = computeCoverage(files, ceiling);
  return {
    baseRef,
    baseSha,
    canonicalDigest: diffDigest(rawDiff),
    coverage,
    // The COVERED diff ONLY — never fall back to rawDiff. When coverage included
    // nothing (every file generated/binary), includedDiff is '' and the packet must
    // stay empty → incomplete → skipped, NOT silently carry the omitted files the
    // manifest swears the reviewer never saw (and possibly blow the prompt budget).
    diff: includedDiff,
    files,
    headSha,
    mode,
    rawDiff,
    repoId,
  };
}
