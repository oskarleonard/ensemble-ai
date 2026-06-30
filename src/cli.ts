#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  isReviewerId,
  parseReviewerIds,
  REVIEWER_IDS,
  type ReviewerId,
  type Severity,
  type StoredReview,
} from './core/types';
import { isImplemented, isMode } from './modes';
import { runReviewMode, type ReviewModeResult } from './modes/review';
import type { DepSurfaceResult } from './modes/review/dep-surface';
import type { DiffMode } from './modes/review/diff';
import {
  classifySecurityFinding,
  type ReviewProfile,
  stripSecurityTag,
} from './modes/review/profile';
import {
  type DiffSourceSelection,
  hasExplicitSource,
  isDiffSourceError,
  selectDiffSource,
} from './modes/review/source';

const USAGE = `ensemble-ai — convene multiple AI models on a task, read-only.

Usage:
  ensemble-ai <mode> [options]

Modes:
  review       Cross-vendor review of a code diff (implemented).
  security     Cross-vendor SECURITY audit of a code diff (implemented) —
               the review engine with a security-auditor lens + a local
               dependency-surface flag; findings tagged by security class.
  brainstorm   (planned)

Run \`ensemble-ai review --help\` or \`ensemble-ai security --help\` for options.`;

const REVIEW_USAGE = `ensemble-ai review — review a diff with ALL configured AI reviewers.

Runs every reviewer in the registry (codex + grok) by default and prints their
findings grouped by severity. With NO source flag it reviews the current branch.

Diff source (give at most ONE; default = current branch):
  (default)            <base>...HEAD — the current branch vs its merge-base with
                       the default branch (origin/main; resolved like \`gh pr create\`)
  --pr <N>             the diff of GitHub PR #N (via \`gh pr diff <N>\`)
  --staged             staged changes (\`git diff --cached\`)
  --working-tree       uncommitted tracked changes vs HEAD (\`git diff HEAD\`)
  --diff-file <path>   a raw unified diff read from a file
  (stdin)              a piped diff, e.g. \`git diff main...HEAD | ensemble-ai review\`

Options:
  --base <ref>          base ref for the default (commit) mode
  --reviewers <ids>     comma-separated reviewer ids (default: all configured)
  --no-fail-on-high     do NOT exit non-zero when a HIGH finding is present
  --out <dir>           trail output dir (default: a temp dir, printed)
  --sandbox <profile>   reviewer sandbox profile override (deny-by-default only)
  --allow-sensitive     review even if the diff carries secrets/sensitive paths
  --ceiling <bytes>     coverage byte ceiling (default 200000)
  --cwd <dir>           repo working dir (default: cwd)
  --run-id <id>         trail/receipt run id (default: generated)
  -h, --help            this help

Exit codes: 0 = completed, no HIGH (or gate disabled) · 1 = a reviewer failed
(crash/timeout/no-parse) · 2 = blocked by the secret-scan · 3 = usage / no diff ·
4 = completed WITH a HIGH finding (the gate; disable with --no-fail-on-high).`;

const SECURITY_USAGE = `ensemble-ai security — adversarial SECURITY audit of a diff with ALL reviewers.

A thin PROFILE over \`review\`: the SAME engine + diff sources + receipt + HIGH gate,
but the reviewers run under a security-auditor lens (injection · XSS · authn/authz ·
secret-leak · supply-chain · unsafe deserialization/eval · SSRF · path-traversal ·
crypto misuse) and findings are tagged by security class in the grouped output. It
also runs a LOCAL dependency-surface flag (manifest changes + risky imports in the
diff — NO network / no vuln DB) and reuses the engine's secret-scan.

Diff source (give at most ONE; default = current branch):
  (default)            <base>...HEAD — the current branch vs its merge-base with
                       the default branch (origin/main; resolved like \`gh pr create\`)
  --pr <N>             the diff of GitHub PR #N (via \`gh pr diff <N>\`)
  --staged             staged changes (\`git diff --cached\`)
  --working-tree       uncommitted tracked changes vs HEAD (\`git diff HEAD\`)
  --diff-file <path>   a raw unified diff read from a file
  (stdin)              a piped diff, e.g. \`git diff main...HEAD | ensemble-ai security\`

Options + exit codes are identical to \`ensemble-ai review\` (run \`review --help\`).`;

function genRunId(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${crypto.randomBytes(4).toString('hex')}`;
}

function readStdinIfPiped(): string | undefined {
  if (process.stdin.isTTY) return undefined;
  try {
    const s = fs.readFileSync(0, 'utf8');
    return s.trim() ? s : undefined;
  } catch {
    return undefined;
  }
}

// Capture a child command's stdout (e.g. `gh pr diff N`). A PR diff can be large,
// so the buffer ceiling is generous; a non-zero exit / missing binary returns the
// error text so the CLI can fail with a clear message (exit 3) instead of throwing.
function capture(
  cmd: string,
  cmdArgs: string[],
  cwd: string
): { error: string; ok: false } | { ok: true; text: string } {
  try {
    const text = execFileSync(cmd, cmdArgs, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      // Bound the call so a wedged `gh` (auth prompt, network hang) can't hang the
      // gate forever — fail with a clear error instead.
      timeout: 120_000,
    });
    return { ok: true, text };
  } catch (e) {
    const err = e as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    return { error: stderr || err.message || 'command failed', ok: false };
  }
}

// Turn the resolved diff-source SELECTION into the engine inputs, running the
// git/gh I/O each source needs. Returns a usage-error code (3) on any failure so
// the caller can return it directly.
function resolveSource(
  selection: DiffSourceSelection,
  cwd: string,
  stdinContent: string | undefined
):
  | { code: number }
  | {
      diffMode?: DiffMode;
      diffText?: string;
      staged?: boolean;
      workingTree?: boolean;
    } {
  switch (selection.kind) {
    case 'pr': {
      const cap = capture('gh', ['pr', 'diff', String(selection.pr)], cwd);
      if (!cap.ok) {
        console.error(
          `ensemble-ai review: \`gh pr diff ${selection.pr}\` failed: ${cap.error}`
        );
        return { code: 3 };
      }
      if (!cap.text.trim()) {
        console.error(`ensemble-ai review: PR #${selection.pr} has an empty diff`);
        return { code: 3 };
      }
      return { diffMode: 'pr', diffText: cap.text };
    }
    case 'diff-file': {
      let text: string;
      try {
        text = fs.readFileSync(String(selection.diffFile), 'utf8');
      } catch (e) {
        console.error(
          `ensemble-ai review: cannot read --diff-file: ${(e as Error).message}`
        );
        return { code: 3 };
      }
      if (!text.trim()) {
        console.error(
          `ensemble-ai review: --diff-file ${selection.diffFile} is empty`
        );
        return { code: 3 };
      }
      return { diffText: text };
    }
    case 'stdin':
      return { diffText: stdinContent };
    case 'staged':
      return { staged: true };
    case 'working-tree':
      return { workingTree: true };
    case 'commit':
      return {};
  }
}

const SEVERITY_LABEL: Record<Severity, string> = {
  high: 'HIGH',
  low: 'LOW',
  medium: 'MED',
};
const SEVERITY_ORDER: Severity[] = ['high', 'medium', 'low'];

// True iff any COMPLETED reviewer surfaced a HIGH finding — the gate signal.
function hasHighFinding(reviews: StoredReview[]): boolean {
  return reviews.some(
    (r) =>
      r.terminalState === 'reviewed' &&
      r.findings.some((f) => f.severity === 'high')
  );
}

// The per-reviewer one-line tally for the gate-friendly summary, e.g. `codex 1H/2M`,
// `grok 2H`, `codex clean`, `grok failed`.
function reviewerTally(r: StoredReview): string {
  const id = r.reviewerId ?? r.reviewer.vendor;
  if (r.terminalState !== 'reviewed') return `${id} failed`;
  const counts: Record<Severity, number> = { high: 0, low: 0, medium: 0 };
  for (const f of r.findings) counts[f.severity]++;
  const parts = SEVERITY_ORDER.filter((s) => counts[s] > 0).map(
    (s) => `${counts[s]}${SEVERITY_LABEL[s][0]}`
  );
  return `${id} ${parts.length ? parts.join('/') : 'clean'}`;
}

// `codex 1H/2M · grok 2H · receipt sha256:abc…` — one line a gate/log can grep.
function oneLineSummary(result: ReviewModeResult): string {
  const tallies = result.reviews.map(reviewerTally).join(' · ');
  const receipt = result.receipt
    ? `receipt ${result.receipt.diffDigest.slice(0, 19)}…`
    : 'receipt none';
  return `${tallies} · ${receipt}`;
}

// Strip C0/DEL control characters from reviewer-controlled text before it hits the
// terminal — a crafted diff could induce a reviewer to emit ANSI escapes in a
// finding title/path; printed raw they could rewrite the terminal. Whitespace is
// collapsed so a finding stays one tidy line.
function clean(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function evidenceRef(file?: string, line?: number): string {
  if (!file) return '(uncited)';
  const f = clean(file);
  return line ? `${f}:${line}` : f;
}

// One finding line: `file:line  title`, with a `[class]` security-class tag prepended
// in the security profile (the reviewer's own leading [tag] is stripped to avoid
// duplication, then re-rendered from the canonical class).
function findingLine(
  f: StoredReview['findings'][number],
  profile: ReviewProfile
): string {
  const ref = evidenceRef(f.evidence.file, f.evidence.line);
  if (profile === 'security') {
    const cls = classifySecurityFinding(f);
    return `       [${cls}] ${ref}  ${clean(stripSecurityTag(f.title))}`;
  }
  return `       ${ref}  ${clean(f.title)}`;
}

// Per-reviewer findings grouped by severity (HIGH → MED → LOW), each line carrying
// its file:line evidence so a finding is actionable straight from stdout.
function reviewerBlock(r: StoredReview, profile: ReviewProfile): string[] {
  const id = r.reviewerId ?? r.reviewer.vendor;
  const out: string[] = [];
  out.push('');
  out.push(
    `  ── ${id} [${r.reviewer.vendor} · ${r.reviewer.model}] — ${r.terminalState} ──`
  );
  if (r.terminalState !== 'reviewed') {
    out.push(`     ${clean(r.summary).slice(0, 200)}`);
    return out;
  }
  if (r.findings.length === 0) {
    out.push('     no findings');
    return out;
  }
  for (const sev of SEVERITY_ORDER) {
    const group = r.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    out.push(`     ${SEVERITY_LABEL[sev]}`);
    for (const f of group) out.push(findingLine(f, profile));
  }
  return out;
}

// The local dependency-surface block (security profile only): manifest changes +
// risky imports drawn straight from the diff. Surfaced even when empty so a reader
// sees the check ran and found nothing.
function depSurfaceBlock(d: DepSurfaceResult): string[] {
  const out: string[] = ['  dependency surface:'];
  if (d.manifests.length === 0 && d.riskyImports.length === 0) {
    out.push('     none — no manifest changes or risky imports in the diff');
    return out;
  }
  for (const m of d.manifests) {
    const kind = m.isLockfile ? 'lockfile' : 'manifest';
    out.push(`     ${kind} ${m.label}: ${clean(m.path)} (+${m.added} line(s))`);
    for (const s of m.samples) out.push(`         + ${clean(s).slice(0, 100)}`);
  }
  for (const r of d.riskyImports) {
    out.push(`     risky [${r.cls}] ${r.label} — ${evidenceRef(r.path, r.line)}`);
  }
  return out;
}

function printSummary(result: ReviewModeResult, profile: ReviewProfile): void {
  const a = result.acquired;
  const out: string[] = [];
  out.push('');
  out.push(`ensemble-ai ${profile === 'security' ? 'security' : 'review'} — ${a.mode} mode`);
  if (a.repoId) out.push(`  repo:    ${a.repoId}`);
  if (a.baseRef) out.push(`  base:    ${a.baseRef} (${a.baseSha ?? '?'})`);
  out.push(`  head:    ${a.headSha}`);
  out.push(`  digest:  ${a.canonicalDigest}`);
  out.push(
    `  files:   ${a.coverage.totalFiles} total · ${a.coverage.includedFiles} reviewed · ${a.coverage.omittedFiles} omitted`
  );
  for (const f of a.coverage.files.filter((x) => !x.included)) {
    out.push(`             omitted: ${f.path} (${f.omitReason}/${f.kind})`);
  }
  const ss = result.secretScan;
  if (ss.sensitivePaths.length || ss.inlineSecrets.length) {
    out.push(
      `  secrets: ${ss.sensitivePaths.length} sensitive path(s), ${ss.inlineSecrets.length} inline${ss.overridden ? ' (overridden)' : ''}`
    );
  }
  if (result.depSurface) out.push(...depSurfaceBlock(result.depSurface));
  if (result.blocked) {
    out.push(`  BLOCKED: ${result.blockedReason}`);
    console.error(out.join('\n'));
    return;
  }
  for (const r of result.reviews) out.push(...reviewerBlock(r, profile));
  out.push('');
  if (result.receipt) {
    out.push(`  receipt: ${result.receiptPath}`);
    out.push(
      `           completed: ${result.receipt.completed.join(', ')} · vendors: ${result.receipt.vendors.join(', ')}`
    );
  } else {
    out.push(`  receipt: none — ${result.receiptError ?? 'not qualified'}`);
  }
  out.push('');
  out.push(`  ${oneLineSummary(result)}`);
  out.push('');
  console.log(out.join('\n'));
}

// Shared by `review` (profile 'code') and `security` (profile 'security'): both run
// the SAME engine + diff-source resolution + exit-code contract; the profile only
// swaps the reviewer framing, adds the dependency-surface flag, and labels the usage.
async function reviewCommand(
  args: string[],
  profile: ReviewProfile = 'code'
): Promise<number> {
  const usage = profile === 'security' ? SECURITY_USAGE : REVIEW_USAGE;
  const cmd = profile === 'security' ? 'security' : 'review';
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      options: {
        'allow-sensitive': { type: 'boolean' },
        base: { type: 'string' },
        ceiling: { type: 'string' },
        cwd: { type: 'string' },
        'diff-file': { type: 'string' },
        help: { short: 'h', type: 'boolean' },
        'no-fail-on-high': { type: 'boolean' },
        out: { type: 'string' },
        pr: { type: 'string' },
        reviewers: { type: 'string' },
        'run-id': { type: 'string' },
        sandbox: { type: 'string' },
        staged: { type: 'boolean' },
        'working-tree': { type: 'boolean' },
      },
    }));
  } catch (e) {
    console.error(`ensemble-ai ${cmd}: ${(e as Error).message}`);
    console.error(usage);
    return 3;
  }
  if (values.help) {
    console.log(usage);
    return 0;
  }

  const cwd = values.cwd ? path.resolve(String(values.cwd)) : process.cwd();

  // Resolve the diff source: at most one explicit flag (--pr/--staged/--working-tree/
  // --diff-file), else a piped diff, else the default current-branch range. The
  // selector is PURE; this then runs the git/gh I/O the chosen source needs.
  const sourceFlags = {
    diffFile: typeof values['diff-file'] === 'string' ? values['diff-file'] : undefined,
    pr: typeof values.pr === 'string' ? values.pr : undefined,
    staged: Boolean(values.staged),
    workingTree: Boolean(values['working-tree']),
  };
  // Only consume stdin when NO explicit source is set — otherwise a CI shell that
  // leaves stdin attached to a pipe would BLOCK reading input the run never uses.
  const stdinContent = hasExplicitSource(sourceFlags) ? undefined : readStdinIfPiped();
  const selection = selectDiffSource({ ...sourceFlags, stdinPiped: stdinContent !== undefined });
  if (isDiffSourceError(selection)) {
    console.error(`ensemble-ai ${cmd}: ${selection.error}`);
    return 3;
  }
  const source = resolveSource(selection, cwd, stdinContent);
  if ('code' in source) return source.code;

  // "no --reviewers" → undefined → run the full default set. But if --reviewers IS
  // given, EVERY token must be a known id: a typo like `codex,grokk` must error,
  // never silently drop the unknown and run a narrower set than the user asked for
  // (which would also mint a receipt under a weaker policy). Fail closed.
  let reviewers: ReviewerId[] | undefined;
  if (typeof values.reviewers === 'string') {
    const requested = values.reviewers
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = requested.filter((id) => !isReviewerId(id));
    if (unknown.length > 0 || requested.length === 0) {
      console.error(
        `ensemble-ai ${cmd}: --reviewers "${values.reviewers}" ${
          unknown.length ? `has unknown id(s): ${unknown.join(', ')}` : 'is empty'
        } (known: ${REVIEWER_IDS.join(', ')})`
      );
      return 3;
    }
    reviewers = parseReviewerIds(requested);
  }
  const runId = typeof values['run-id'] === 'string' ? values['run-id'] : genRunId();
  const out =
    typeof values.out === 'string'
      ? path.resolve(values.out)
      : path.join(os.tmpdir(), 'ensemble-ai', runId);
  const ceilingBytes =
    typeof values.ceiling === 'string' ? Number(values.ceiling) : undefined;
  if (ceilingBytes !== undefined && (!Number.isFinite(ceilingBytes) || ceilingBytes <= 0)) {
    console.error(`ensemble-ai ${cmd}: --ceiling must be a positive number`);
    return 3;
  }

  let result: ReviewModeResult;
  try {
    result = await runReviewMode({
      allowSensitive: Boolean(values['allow-sensitive']),
      base: typeof values.base === 'string' ? values.base : undefined,
      ceilingBytes,
      cwd,
      diffMode: source.diffMode,
      diffText: source.diffText,
      onProgress: (m) => console.error(`· ${m}`),
      out,
      profile,
      reviewers,
      runId,
      sandbox: typeof values.sandbox === 'string' ? values.sandbox : undefined,
      staged: source.staged,
      workingTree: source.workingTree,
    });
  } catch (e) {
    console.error(`ensemble-ai ${cmd}: ${(e as Error).message}`);
    return 3;
  }

  printSummary(result, profile);
  console.error(`trail: ${out}`);
  if (result.blocked) return 2;
  // 1 = a reviewer failed to complete (crash / timeout / no parse) — the review is
  // not trustworthy, so this outranks the findings gate below.
  const allReviewed =
    result.reviews.length > 0 &&
    result.reviews.every((r) => r.terminalState === 'reviewed');
  if (!allReviewed) return 1;
  // 4 = the findings GATE: a completed review surfaced a HIGH. Gate-usable by
  // default (a pre-PR hook can fail on it); --no-fail-on-high opts out → 0.
  if (!values['no-fail-on-high'] && hasHighFinding(result.reviews)) return 4;
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const mode = argv[0];
  if (!mode || mode === '-h' || mode === '--help') {
    console.log(USAGE);
    return mode ? 0 : 1;
  }
  if (mode === 'review') return reviewCommand(argv.slice(1), 'code');
  if (mode === 'security') return reviewCommand(argv.slice(1), 'security');
  if (isMode(mode) && !isImplemented(mode)) {
    console.error(`ensemble-ai: mode "${mode}" is planned but not implemented yet.`);
    return 3;
  }
  console.error(`ensemble-ai: unknown mode "${mode}".\n`);
  console.error(USAGE);
  return 3;
}

// Auto-run ONLY when invoked as the actual entry (the `ensemble-ai` bin) — not
// when imported (e.g. by a unit test importing `main`), so tests don't trigger a
// real review against the process's argv.
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`ensemble-ai: ${(e as Error).stack ?? e}`);
      process.exitCode = 1;
    }
  );
}
