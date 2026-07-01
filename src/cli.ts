#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { listReviewers, REVIEWERS_FILE } from './core/reviewers';
import {
  isReviewerId,
  parseReviewerIds,
  REVIEWER_IDS,
  type ReviewerId,
  type Severity,
  type StoredReview,
} from './core/types';
import { runBrainstormMode } from './modes/brainstorm';
import { listVoices, VOICES_FILE } from './modes/brainstorm/voices';
import {
  type BrainstormResult,
  isVoiceId,
  parseVoiceIds,
  VOICE_IDS,
  type VoiceId,
} from './modes/brainstorm/types';
import { runConsultMode } from './modes/consult';
import type { ConsultResult } from './modes/consult/types';
import { isImplemented, isMode, resolveMode } from './modes';
import { runReviewMode, type ReviewModeResult } from './modes/review';
import type { DepSurfaceResult } from './modes/review/dep-surface';
import {
  acquireDiff,
  type AcquiredDiff,
  DEFAULT_COVERAGE_CEILING,
  type DiffMode,
} from './modes/review/diff';
import {
  classifySecurityFinding,
  type ReviewProfile,
  stripSecurityTag,
} from './modes/review/profile';
import {
  computePolicyHash,
  defaultReceiptStore,
  type DiffReviewReceipt,
  readReceipt,
  type ReceiptKey,
  validateReceiptShape,
} from './modes/review/receipt';
import {
  type DiffSourceSelection,
  hasExplicitSource,
  isDiffSourceError,
  selectDiffSource,
} from './modes/review/source';
import { buildPacketPreview, renderPacketPreview } from './plumbing/diff-preview';
import { renderRegistry, type RegistryView } from './plumbing/registry';
import {
  formatReceipt,
  formatVerify,
  isAttestedOnly,
  verifyExitCode,
  verifyReceipt,
} from './plumbing/verify';

const USAGE = `ensemble-ai — convene multiple AI models on a task, read-only.

Usage:
  ensemble-ai <mode> [options]

Modes:
  review       Cross-vendor review of a code diff (implemented).
  security     Cross-vendor SECURITY audit of a code diff (implemented) —
               the review engine with a security-auditor lens + a local
               dependency-surface flag; findings tagged by security class.
  brainstorm   Cross-vendor ideation on a TOPIC (implemented) — each voice
               generates ideas independently, critiques the others, then one
               synthesizes a ranked, de-duplicated recommendation.
  consult      Cross-vendor Q&A on a QUESTION (implemented; alias: ask) — each
               voice answers independently, then one synthesizes what they AGREE
               on (confident) vs where they DIVERGE (look closer).

Plumbing (no reviewer runs — inspect the engine):
  receipt      verify | show a content-tied diff receipt (the pre-PR gate primitive):
               \`receipt verify\` exits 0 iff the current diff is reviewed & current.
  reviewers    (alias: config) list the configured cross-vendor registry (read-only).
  diff         show the assembled review packet that WOULD be sent — cost-preview/debug.

Run \`ensemble-ai <mode|command> --help\` for options.`;

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
  stdinContent: string | undefined,
  cmd = 'review'
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
          `ensemble-ai ${cmd}: \`gh pr diff ${selection.pr}\` failed: ${cap.error}`
        );
        return { code: 3 };
      }
      if (!cap.text.trim()) {
        console.error(`ensemble-ai ${cmd}: PR #${selection.pr} has an empty diff`);
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
          `ensemble-ai ${cmd}: cannot read --diff-file: ${(e as Error).message}`
        );
        return { code: 3 };
      }
      if (!text.trim()) {
        console.error(
          `ensemble-ai ${cmd}: --diff-file ${selection.diffFile} is empty`
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

const BRAINSTORM_USAGE = `ensemble-ai brainstorm — convene multiple AI voices on a TOPIC.

Usage:
  ensemble-ai brainstorm "<topic>" [options]

Three rounds: (1) each voice generates ideas INDEPENDENTLY (no anchoring), (2) each
critiques + extends the OTHERS' ideas, (3) one voice synthesizes a ranked,
de-duplicated recommendation. Voices: codex + grok + claude by default (Claude joins
as a voice here — there is no independence concern, unlike review).

Options:
  --file <path>         include a file's contents as shared context for every voice
  --voices <ids>        comma-separated voice ids (default: codex,grok,claude)
  --synthesizer <id>    which voice runs round 3 (default: claude if present)
  --timeout <seconds>   per-voice timeout (default 300)
  --voices-file <path>  voices config json (default ~/.ensemble-ai/voices.json)
  --json                print the full result as JSON instead of formatted text
  --cwd <dir>           working dir for --file resolution (default: cwd)
  -h, --help            this help

Exit codes: 0 = produced ideas (synthesis printed) · 1 = no usable output (every
voice failed) · 3 = usage or an unexpected operational error.`;

// One brainstorm rendered for the terminal: the three rounds, each line passed
// through clean() (reviewer/voice text is untrusted — a crafted reply could carry
// ANSI escapes). Mirrors printSummary's grouped, scannable shape.
function printBrainstorm(r: BrainstormResult): void {
  const out: string[] = [];
  out.push('');
  out.push(`ensemble-ai brainstorm — ${clean(r.topic).slice(0, 200)}`);
  out.push(`  voices: ${r.roster.join(', ')}`);
  out.push('');
  out.push('Round 1 · independent ideas');
  for (const g of r.generate) {
    out.push('');
    out.push(`  ── ${g.voiceId} ──`);
    if (!g.ok) {
      out.push(`     (no ideas — ${clean(g.error ?? 'failed').slice(0, 160)})`);
      continue;
    }
    if (g.summary) out.push(`     ${clean(g.summary).slice(0, 240)}`);
    for (const idea of g.ideas) {
      out.push(`     • [${idea.id}] ${clean(idea.title)}`);
      if (idea.body) out.push(`         ${clean(idea.body).slice(0, 300)}`);
    }
  }
  if (r.critique.length > 0) {
    out.push('');
    out.push('Round 2 · cross-critique');
    for (const c of r.critique) {
      out.push('');
      out.push(`  ── ${c.voiceId} ──`);
      if (!c.ok) {
        out.push(`     (no critique — ${clean(c.error ?? 'failed').slice(0, 160)})`);
        continue;
      }
      for (const cr of c.critiques) {
        out.push(`     [${cr.stance}] ${clean(cr.target)} — ${clean(cr.assessment).slice(0, 260)}`);
      }
      for (const ex of c.extensions) {
        out.push(`     + ${clean(ex.title)}`);
        if (ex.body) out.push(`         ${clean(ex.body).slice(0, 260)}`);
      }
    }
  }
  out.push('');
  const s = r.synthesis;
  out.push(
    `Round 3 · synthesis${s.by ? ` (by ${s.by})` : ''}${s.degraded ? ' — DEGRADED (deterministic fallback)' : ''}`
  );
  if (s.summary) out.push(`  ${clean(s.summary).slice(0, 400)}`);
  for (const ri of s.ranked) {
    out.push('');
    out.push(
      `  ${ri.rank}. ${clean(ri.title)}${ri.contributors.length ? `  [${ri.contributors.map(clean).join(', ')}]` : ''}`
    );
    if (ri.why) out.push(`     why:  ${clean(ri.why).slice(0, 300)}`);
    if (ri.risks) out.push(`     risk: ${clean(ri.risks).slice(0, 240)}`);
  }
  out.push('');
  console.log(out.join('\n'));
}

// Hard cap on a --file read. Only the first FILE_CONTEXT_BUDGET (24k) is ever embedded
// in a prompt, but fs.readFileSync pulls the WHOLE file into the heap first, so an
// unbounded --file is an OOM vector; 10 MiB is generous for any real context file.
const MAX_BRAINSTORM_FILE_BYTES = 10 * 1024 * 1024;

async function brainstormCommand(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        cwd: { type: 'string' },
        file: { type: 'string' },
        help: { short: 'h', type: 'boolean' },
        json: { type: 'boolean' },
        synthesizer: { type: 'string' },
        timeout: { type: 'string' },
        voices: { type: 'string' },
        'voices-file': { type: 'string' },
      },
    });
  } catch (e) {
    console.error(`ensemble-ai brainstorm: ${(e as Error).message}`);
    console.error(BRAINSTORM_USAGE);
    return 3;
  }
  const { positionals, values } = parsed;
  if (values.help) {
    console.log(BRAINSTORM_USAGE);
    return 0;
  }
  const topic = positionals.join(' ').trim();
  if (!topic) {
    console.error(
      'ensemble-ai brainstorm: a topic is required, e.g. ensemble-ai brainstorm "naming options for X"'
    );
    console.error(BRAINSTORM_USAGE);
    return 3;
  }

  const cwd = values.cwd ? path.resolve(String(values.cwd)) : process.cwd();
  let fileContext: string | undefined;
  if (typeof values.file === 'string') {
    const filePath = path.resolve(cwd, values.file);
    try {
      const bytes = fs.statSync(filePath).size;
      if (bytes > MAX_BRAINSTORM_FILE_BYTES) {
        console.error(
          `ensemble-ai brainstorm: --file ${values.file} is too large (${bytes} bytes > ${MAX_BRAINSTORM_FILE_BYTES}-byte cap)`
        );
        return 3;
      }
      fileContext = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      console.error(
        `ensemble-ai brainstorm: cannot read --file ${values.file}: ${(e as Error).message}`
      );
      return 3;
    }
  }

  // --voices: fail CLOSED on an unknown id (a typo must error, never silently run a
  // narrower roster than asked). Absent → undefined → the default roster.
  let voices: VoiceId[] | undefined;
  if (typeof values.voices === 'string') {
    const requested = values.voices.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = requested.filter((id) => !isVoiceId(id));
    if (unknown.length > 0 || requested.length === 0) {
      console.error(
        `ensemble-ai brainstorm: --voices "${values.voices}" ${
          unknown.length ? `has unknown id(s): ${unknown.join(', ')}` : 'is empty'
        } (known: ${VOICE_IDS.join(', ')})`
      );
      return 3;
    }
    voices = parseVoiceIds(requested);
  }

  let synthesizer: VoiceId | undefined;
  if (typeof values.synthesizer === 'string') {
    if (!isVoiceId(values.synthesizer)) {
      console.error(
        `ensemble-ai brainstorm: --synthesizer "${values.synthesizer}" is not a known voice (known: ${VOICE_IDS.join(', ')})`
      );
      return 3;
    }
    synthesizer = values.synthesizer;
  }

  // --synthesizer must be IN the effective roster: pickSynthesizer only honors an
  // in-roster request and SILENTLY falls back to another voice otherwise, so an
  // out-of-roster id would be dropped without a word. Fail closed, exactly like
  // --voices does for an unknown id.
  const roster = voices ?? VOICE_IDS;
  if (synthesizer && !roster.includes(synthesizer)) {
    console.error(
      `ensemble-ai brainstorm: --synthesizer "${synthesizer}" is not in the voices roster (${roster.join(', ')})`
    );
    return 3;
  }

  let timeoutMs: number | undefined;
  if (typeof values.timeout === 'string') {
    const secs = Number(values.timeout);
    if (!Number.isFinite(secs) || secs <= 0) {
      console.error('ensemble-ai brainstorm: --timeout must be a positive number of seconds');
      return 3;
    }
    timeoutMs = Math.round(secs * 1000);
    if (timeoutMs < 1) {
      // A sub-millisecond value rounds to 0, and `timeoutMs ?? DEFAULT` does NOT restore
      // the default for a present-but-falsy 0 — the watchdog would fire at 0ms and kill
      // every voice instantly. Reject it as out of range.
      console.error('ensemble-ai brainstorm: --timeout is too small (rounds to 0ms)');
      return 3;
    }
  }

  let result: BrainstormResult;
  try {
    result = await runBrainstormMode({
      fileContext,
      onProgress: (m) => console.error(`· ${m}`),
      synthesizer,
      timeoutMs,
      topic,
      voices,
      voicesFile:
        typeof values['voices-file'] === 'string' ? values['voices-file'] : undefined,
    });
  } catch (e) {
    // An unexpected orchestration failure is NOT "every voice failed" (exit 1, the
    // graceful all-voices-empty outcome below) — it is an operational error. Exit 3,
    // matching review mode's runReviewMode catch, so the two modes don't drift.
    console.error(`ensemble-ai brainstorm: ${(e as Error).message}`);
    return 3;
  }

  if (values.json) console.log(JSON.stringify(result, null, 2));
  else printBrainstorm(result);

  // 1 = nothing usable came back (every voice failed to produce ideas).
  const anyIdeas = result.generate.some((g) => g.ok && g.ideas.length > 0);
  return anyIdeas ? 0 : 1;
}

const CONSULT_USAGE = `ensemble-ai consult — convene multiple AI voices on a QUESTION.

Usage:
  ensemble-ai consult "<question>" [options]
  ensemble-ai ask "<question>" [options]      (alias)

Each voice answers the question INDEPENDENTLY (no anchoring), then one voice
synthesizes: what the voices AGREE on (the confident core) vs where they DIVERGE
(flagged "look closer", with who took which position) + a bottom-line
recommendation. Voices: codex + grok + claude by default. For decisions + research.

Options:
  --file <path>         include a file's contents as shared context for every voice
  --critique            run an extra round where each voice reviews the others'
                        answers before synthesis (default: off — answer→synthesize)
  --voices <ids>        comma-separated voice ids (default: codex,grok,claude)
  --synthesizer <id>    which voice runs the synthesis (default: claude if present)
  --timeout <seconds>   per-voice timeout (default 300)
  --voices-file <path>  voices config json (default ~/.ensemble-ai/voices.json)
  --json                print the full result as JSON instead of formatted text
  --cwd <dir>           working dir for --file resolution (default: cwd)
  -h, --help            this help

Exit codes: 0 = produced answers (synthesis printed) · 1 = no usable output (every
voice failed) · 3 = usage or an unexpected operational error.`;

// One consult rendered for the terminal: the independent answers, then the
// synthesis split into AGREE / DIVERGE. Every line passed through clean() (voice
// text is untrusted — a crafted reply could carry ANSI escapes).
function printConsult(r: ConsultResult): void {
  const out: string[] = [];
  out.push('');
  out.push(`ensemble-ai consult — ${clean(r.question).slice(0, 200)}`);
  out.push(`  voices: ${r.roster.join(', ')}`);
  out.push('');
  out.push('Independent answers');
  for (const a of r.answers) {
    out.push('');
    out.push(`  ── ${a.voiceId} ──`);
    if (!a.ok) {
      out.push(`     (no answer — ${clean(a.error ?? 'failed').slice(0, 160)})`);
      continue;
    }
    if (a.summary) out.push(`     ${clean(a.summary).slice(0, 240)}`);
    if (a.answer) out.push(`     ${clean(a.answer).slice(0, 400)}`);
    for (const kp of a.keyPoints) out.push(`       · ${clean(kp).slice(0, 200)}`);
  }
  if (r.critique.length > 0) {
    out.push('');
    out.push('Cross-critique');
    for (const c of r.critique) {
      out.push('');
      out.push(`  ── ${c.voiceId} ──`);
      if (!c.ok) {
        out.push(`     (no notes — ${clean(c.error ?? 'failed').slice(0, 160)})`);
        continue;
      }
      for (const n of c.notes) {
        out.push(`     [${n.stance}] ${clean(n.target)} — ${clean(n.assessment).slice(0, 260)}`);
      }
    }
  }
  out.push('');
  const s = r.synthesis;
  out.push(
    `Synthesis${s.by ? ` (by ${s.by})` : ''}${s.degraded ? ' — DEGRADED (deterministic fallback, NOT compared for agreement)' : ''}`
  );
  if (s.summary) out.push(`  ${clean(s.summary).slice(0, 400)}`);
  if (s.agreements.length > 0) {
    out.push('');
    out.push('  ✓ AGREE (confident)');
    for (const a of s.agreements) {
      out.push(`     • ${clean(a.point).slice(0, 300)}${a.voices.length ? `  [${a.voices.map(clean).join(', ')}]` : ''}`);
    }
  }
  if (s.divergences.length > 0) {
    out.push('');
    out.push('  ⚠ DIVERGE (look closer)');
    for (const d of s.divergences) {
      out.push(`     • ${clean(d.point).slice(0, 300)}`);
      for (const p of d.positions) out.push(`         − ${clean(p).slice(0, 240)}`);
    }
  }
  if (s.recommendation) {
    out.push('');
    out.push('  → Recommendation');
    out.push(`     ${clean(s.recommendation).slice(0, 500)}`);
  }
  out.push('');
  console.log(out.join('\n'));
}

async function consultCommand(args: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        critique: { type: 'boolean' },
        cwd: { type: 'string' },
        file: { type: 'string' },
        help: { short: 'h', type: 'boolean' },
        json: { type: 'boolean' },
        synthesizer: { type: 'string' },
        timeout: { type: 'string' },
        voices: { type: 'string' },
        'voices-file': { type: 'string' },
      },
    });
  } catch (e) {
    console.error(`ensemble-ai consult: ${(e as Error).message}`);
    console.error(CONSULT_USAGE);
    return 3;
  }
  const { positionals, values } = parsed;
  if (values.help) {
    console.log(CONSULT_USAGE);
    return 0;
  }
  const question = positionals.join(' ').trim();
  if (!question) {
    console.error(
      'ensemble-ai consult: a question is required, e.g. ensemble-ai consult "should I use Postgres or SQLite for X?"'
    );
    console.error(CONSULT_USAGE);
    return 3;
  }

  const cwd = values.cwd ? path.resolve(String(values.cwd)) : process.cwd();
  let fileContext: string | undefined;
  if (typeof values.file === 'string') {
    const filePath = path.resolve(cwd, values.file);
    try {
      const bytes = fs.statSync(filePath).size;
      if (bytes > MAX_BRAINSTORM_FILE_BYTES) {
        console.error(
          `ensemble-ai consult: --file ${values.file} is too large (${bytes} bytes > ${MAX_BRAINSTORM_FILE_BYTES}-byte cap)`
        );
        return 3;
      }
      fileContext = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      console.error(
        `ensemble-ai consult: cannot read --file ${values.file}: ${(e as Error).message}`
      );
      return 3;
    }
  }

  // --voices: fail CLOSED on an unknown id (a typo must error, never silently run a
  // narrower roster than asked). Absent → undefined → the default roster.
  let voices: VoiceId[] | undefined;
  if (typeof values.voices === 'string') {
    const requested = values.voices.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = requested.filter((id) => !isVoiceId(id));
    if (unknown.length > 0 || requested.length === 0) {
      console.error(
        `ensemble-ai consult: --voices "${values.voices}" ${
          unknown.length ? `has unknown id(s): ${unknown.join(', ')}` : 'is empty'
        } (known: ${VOICE_IDS.join(', ')})`
      );
      return 3;
    }
    voices = parseVoiceIds(requested);
  }

  let synthesizer: VoiceId | undefined;
  if (typeof values.synthesizer === 'string') {
    if (!isVoiceId(values.synthesizer)) {
      console.error(
        `ensemble-ai consult: --synthesizer "${values.synthesizer}" is not a known voice (known: ${VOICE_IDS.join(', ')})`
      );
      return 3;
    }
    synthesizer = values.synthesizer;
  }

  // --synthesizer must be IN the effective roster: pickSynthesizer only honors an
  // in-roster request and SILENTLY falls back otherwise, so an out-of-roster id would
  // be dropped without a word. Fail closed, exactly like --voices.
  const roster = voices ?? VOICE_IDS;
  if (synthesizer && !roster.includes(synthesizer)) {
    console.error(
      `ensemble-ai consult: --synthesizer "${synthesizer}" is not in the voices roster (${roster.join(', ')})`
    );
    return 3;
  }

  let timeoutMs: number | undefined;
  if (typeof values.timeout === 'string') {
    const secs = Number(values.timeout);
    if (!Number.isFinite(secs) || secs <= 0) {
      console.error('ensemble-ai consult: --timeout must be a positive number of seconds');
      return 3;
    }
    timeoutMs = Math.round(secs * 1000);
    if (timeoutMs < 1) {
      // A sub-millisecond value rounds to 0, and `timeoutMs ?? DEFAULT` does NOT
      // restore the default for a present-but-falsy 0 — the watchdog would fire at
      // 0ms and kill every voice instantly. Reject it as out of range.
      console.error('ensemble-ai consult: --timeout is too small (rounds to 0ms)');
      return 3;
    }
  }

  let result: ConsultResult;
  try {
    result = await runConsultMode({
      critique: Boolean(values.critique),
      fileContext,
      onProgress: (m) => console.error(`· ${m}`),
      question,
      synthesizer,
      timeoutMs,
      voices,
      voicesFile:
        typeof values['voices-file'] === 'string' ? values['voices-file'] : undefined,
    });
  } catch (e) {
    // An unexpected orchestration failure is NOT "every voice failed" (exit 1) — it is
    // an operational error. Exit 3, matching review/brainstorm, so the modes don't drift.
    console.error(`ensemble-ai consult: ${(e as Error).message}`);
    return 3;
  }

  if (values.json) console.log(JSON.stringify(result, null, 2));
  else printConsult(result);

  // 1 = nothing usable came back (every voice failed to answer).
  const anyAnswers = result.answers.some((a) => a.ok);
  return anyAnswers ? 0 : 1;
}

// ── Plumbing commands (no reviewer runs) ─────────────────────────────────────

// Parse a fail-closed `--reviewers` list, defaulting to the FULL registry. Unlike
// review mode (where absent → undefined → "run all"), the gate/preview need a
// CONCRETE required set, so absent → [...REVIEWER_IDS]. A typo still errors (never
// silently narrows the policy). Returns the ids or a usage-error code.
function parseRequiredReviewers(
  raw: string | undefined,
  cmd: string
): ReviewerId[] | { code: number } {
  if (raw === undefined) return [...REVIEWER_IDS];
  const requested = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = requested.filter((id) => !isReviewerId(id));
  if (unknown.length > 0 || requested.length === 0) {
    console.error(
      `ensemble-ai ${cmd}: --reviewers "${raw}" ${
        unknown.length ? `has unknown id(s): ${unknown.join(', ')}` : 'is empty'
      } (known: ${REVIEWER_IDS.join(', ')})`
    );
    return { code: 3 };
  }
  return parseReviewerIds(requested) as ReviewerId[];
}

function positiveCeiling(
  raw: string | undefined,
  cmd: string
): number | undefined | { code: number } {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`ensemble-ai ${cmd}: --ceiling must be a positive number`);
    return { code: 3 };
  }
  return n;
}

const RECEIPT_USAGE = `ensemble-ai receipt — the content-tied diff-receipt gate primitive.

Usage:
  ensemble-ai receipt verify [<path>] [options]   check the CURRENT diff is reviewed
  ensemble-ai receipt show   [<path>] [options]   pretty-print a receipt

verify recomputes the current diff's identity (repo · base/head · content digest)
and checks it against the stored (or --path) receipt: exit 0 = reviewed & current;
NON-ZERO (3) = missing / stale (commits since review) / under-policy / under-coverage,
with the reason printed. This is what a pre-PR \`gh pr create\` hook calls.
show prints a receipt's fields (given a <path>, else looked up for the current diff).

TRUST: by default a pass is TRUSTED BY ATTESTATION (the receipt's completed[]), NOT
proven by reviewer artifacts — a hand-written receipt with a matching diff digest
would also pass, so verify prints a loud warning. A pre-PR gate MUST use --strict
(--require-artifacts) with --trail <dir>, which requires the real per-reviewer
artifacts and FAILS CLOSED (non-zero) on an attestation-only receipt. (Cryptographic
receipt signing — proof against a fabricated receipt+artifacts — is a documented v2.)

Options:
  --base <ref>          base ref for the current-branch diff (default: origin/HEAD)
  --staged              use the staged diff (\`git diff --cached\`) as the current state
  --working-tree        use uncommitted tracked changes (\`git diff HEAD\`)
  --reviewers <ids>     required reviewer policy (default: all configured)
  --ceiling <bytes>     coverage byte ceiling (default 200000)
  --store <dir>         receipt store dir (default: ~/.ensemble-ai/receipts)
  --trail <dir>         a run trail dir to PROVE the immutable reviewer artifacts
                        (default: trust the receipt's completed[] — see receipt.ts)
  --strict, --require-artifacts
                        REQUIRE the real trail artifacts (use with --trail): an
                        attestation-only receipt FAILS CLOSED. The pre-PR hook's mode.
  --cwd <dir>           repo working dir (default: cwd)
  -h, --help            this help`;

async function receiptCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (!sub || sub === '-h' || sub === '--help') {
    console.log(RECEIPT_USAGE);
    return sub ? 0 : 3;
  }
  if (sub !== 'verify' && sub !== 'show') {
    console.error(
      `ensemble-ai receipt: unknown subcommand "${sub}" (expected: verify | show)`
    );
    console.error(RECEIPT_USAGE);
    return 3;
  }
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ positionals, values } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: {
        base: { type: 'string' },
        ceiling: { type: 'string' },
        cwd: { type: 'string' },
        help: { short: 'h', type: 'boolean' },
        'require-artifacts': { type: 'boolean' },
        reviewers: { type: 'string' },
        staged: { type: 'boolean' },
        store: { type: 'string' },
        strict: { type: 'boolean' },
        'trail': { type: 'string' },
        'working-tree': { type: 'boolean' },
      },
    }));
  } catch (e) {
    console.error(`ensemble-ai receipt: ${(e as Error).message}`);
    console.error(RECEIPT_USAGE);
    return 3;
  }
  if (values.help) {
    console.log(RECEIPT_USAGE);
    return 0;
  }

  const receiptPathArg =
    typeof positionals[0] === 'string' ? path.resolve(positionals[0]) : undefined;
  // Read + SHAPE-VALIDATE an explicit receipt file (Codex LOW: no blind cast). Returns
  // a discriminated result so the caller can print WHY a malformed/partial file failed
  // — unreadable, non-JSON, or the specific missing/invalid fields — not a blank "cannot
  // read". Not a trust check (a well-formed forged receipt still parses → strict verify).
  const readReceiptFile = (
    p: string
  ): { receipt: DiffReviewReceipt } | { error: string } => {
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch (e) {
      return { error: `cannot read receipt ${p}: ${(e as Error).message}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { error: `receipt ${p} is not valid JSON: ${(e as Error).message}` };
    }
    try {
      return { receipt: validateReceiptShape(parsed) };
    } catch (e) {
      return { error: `receipt ${p}: ${(e as Error).message}` };
    }
  };

  // `show <path>` needs no git — just read + print the receipt file.
  if (sub === 'show' && receiptPathArg) {
    const res = readReceiptFile(receiptPathArg);
    if ('error' in res) {
      console.error(`ensemble-ai receipt show: ${res.error}`);
      return 3;
    }
    console.log(formatReceipt(res.receipt));
    return 0;
  }

  const required = parseRequiredReviewers(
    typeof values.reviewers === 'string' ? values.reviewers : undefined,
    'receipt'
  );
  if ('code' in required) return required.code;
  const ceiling = positiveCeiling(
    typeof values.ceiling === 'string' ? values.ceiling : undefined,
    'receipt'
  );
  if (typeof ceiling === 'object') return ceiling.code;
  const cwd = values.cwd ? path.resolve(String(values.cwd)) : process.cwd();

  // Both `verify` and `show`-without-path need the LIVE diff identity to derive the
  // receipt key. Fail closed (exit 3) if the base can't be resolved.
  let acquired: AcquiredDiff;
  try {
    acquired = acquireDiff({
      base: typeof values.base === 'string' ? values.base : undefined,
      ceilingBytes: ceiling,
      cwd,
      staged: Boolean(values.staged),
      workingTree: Boolean(values['working-tree']),
    });
  } catch (e) {
    console.error(`ensemble-ai receipt ${sub}: ${(e as Error).message}`);
    return 3;
  }
  const key: ReceiptKey = {
    baseSha: acquired.baseSha,
    diffDigest: acquired.canonicalDigest,
    headSha: acquired.headSha,
    policyHash: computePolicyHash({
      coveragePolicy: { ceilingBytes: ceiling ?? DEFAULT_COVERAGE_CEILING },
      diffMode: acquired.mode,
      reviewerPolicy: required,
    }),
    repo: acquired.repoId,
  };
  const store = values.store ? path.resolve(String(values.store)) : defaultReceiptStore();

  if (sub === 'show') {
    const receipt = readReceipt(store, key);
    if (!receipt) {
      console.error(
        `ensemble-ai receipt show: no receipt for the current diff (repo ${key.repo ?? '(none)'}, head ${key.headSha}) in ${store}`
      );
      return 3;
    }
    console.log(formatReceipt(receipt));
    return 0;
  }

  // verify: read the receipt from --path (explicit) or the store (by key), then run
  // the SAME live validation the engine ships (isDiffReviewed via verifyReceipt).
  let explicit: DiffReviewReceipt | null = null;
  if (receiptPathArg) {
    const res = readReceiptFile(receiptPathArg);
    if ('error' in res) {
      console.error(`ensemble-ai receipt verify: ${res.error}`);
      return 3;
    }
    explicit = res.receipt;
  }
  const verifyDeps = {
    readReceipt: receiptPathArg
      ? () => explicit
      : (k: ReceiptKey) => readReceipt(store, k),
    strict: Boolean(values.strict || values['require-artifacts']),
    trailDir: typeof values.trail === 'string' ? path.resolve(values.trail) : undefined,
  };
  const state = verifyReceipt({ coverage: acquired.coverage, key, required }, verifyDeps);
  console.log(formatVerify(state, key));
  // A PASS with no artifact proof (default mode, no --trail) is trusted-by-attestation
  // and thus forgeable — say so LOUDLY so it is never a silent gate. A strict/--trail
  // pass is artifact-proven → no warning.
  if (state.reviewed && isAttestedOnly(verifyDeps)) {
    console.error(
      'WARNING: this PASS is TRUSTED BY ATTESTATION (the receipt\'s completed[]), NOT proven by reviewer artifacts — a hand-written receipt with a matching diff digest would also pass. For an artifact-proven gate (e.g. a pre-PR hook) run with --strict (--require-artifacts) and --trail <run-trail-dir>.'
    );
  }
  return verifyExitCode(state);
}

const REVIEWERS_USAGE = `ensemble-ai reviewers — list the configured cross-vendor registry (read-only).

Usage:
  ensemble-ai reviewers [options]
  ensemble-ai config    [options]      (alias)

Prints the review/security reviewers (from reviewers.json) and the brainstorm/
consult voices (from voices.json) — id · vendor · model · effort · sandbox — plus
which config file each came from (or "baked defaults"). No mutation.

Options:
  --reviewers-file <path>   reviewers config (default ~/.ensemble-ai/reviewers.json)
  --voices-file <path>      voices config (default ~/.ensemble-ai/voices.json)
  --json                    print the resolved registry as JSON
  -h, --help                this help`;

async function reviewersCommand(args: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      options: {
        help: { short: 'h', type: 'boolean' },
        json: { type: 'boolean' },
        'reviewers-file': { type: 'string' },
        'voices-file': { type: 'string' },
      },
    }));
  } catch (e) {
    console.error(`ensemble-ai reviewers: ${(e as Error).message}`);
    console.error(REVIEWERS_USAGE);
    return 3;
  }
  if (values.help) {
    console.log(REVIEWERS_USAGE);
    return 0;
  }
  const reviewersFile =
    typeof values['reviewers-file'] === 'string'
      ? path.resolve(values['reviewers-file'])
      : REVIEWERS_FILE;
  const voicesFile =
    typeof values['voices-file'] === 'string'
      ? path.resolve(values['voices-file'])
      : VOICES_FILE;
  const view: RegistryView = {
    reviewers: listReviewers(reviewersFile),
    reviewersFile,
    reviewersFileExists: fs.existsSync(reviewersFile),
    voices: listVoices(voicesFile),
    voicesFile,
    voicesFileExists: fs.existsSync(voicesFile),
  };
  if (values.json) console.log(JSON.stringify(view, null, 2));
  else console.log(renderRegistry(view));
  return 0;
}

const DIFF_USAGE = `ensemble-ai diff — show the assembled review packet WITHOUT running a reviewer.

Usage:
  ensemble-ai diff [<diff-source>] [options]

A cost-preview / debug of the EXACT packet the reviewers would receive: the diff
identity + coverage, the per-section manifest (what the reviewer sees), and the
prompt size — no vendor is called, nothing is spent.

Diff source (give at most ONE; default = current branch, like \`ensemble-ai review\`):
  (default)            <base>...HEAD — the current branch vs origin/HEAD
  --pr <N>             the diff of GitHub PR #N (via \`gh pr diff <N>\`)
  --staged             staged changes (\`git diff --cached\`)
  --working-tree       uncommitted tracked changes vs HEAD
  --diff-file <path>   a raw unified diff from a file
  (stdin)              a piped diff

Options:
  --base <ref>          base ref for the default (commit) mode
  --profile <p>         packet profile: code (default) | security
  --reviewers <ids>     reviewers to size the cost preview against (default: all)
  --ceiling <bytes>     coverage byte ceiling (default 200000)
  --full                print the ENTIRE rendered prompt (the literal payload)
  --json                print { packet, prompt } as JSON
  --cwd <dir>           repo working dir (default: cwd)
  -h, --help            this help`;

async function diffCommand(args: string[]): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      options: {
        base: { type: 'string' },
        ceiling: { type: 'string' },
        cwd: { type: 'string' },
        'diff-file': { type: 'string' },
        full: { type: 'boolean' },
        help: { short: 'h', type: 'boolean' },
        json: { type: 'boolean' },
        pr: { type: 'string' },
        profile: { type: 'string' },
        reviewers: { type: 'string' },
        staged: { type: 'boolean' },
        'working-tree': { type: 'boolean' },
      },
    }));
  } catch (e) {
    console.error(`ensemble-ai diff: ${(e as Error).message}`);
    console.error(DIFF_USAGE);
    return 3;
  }
  if (values.help) {
    console.log(DIFF_USAGE);
    return 0;
  }

  let profile: ReviewProfile = 'code';
  if (typeof values.profile === 'string') {
    if (values.profile !== 'code' && values.profile !== 'security') {
      console.error(
        `ensemble-ai diff: --profile must be "code" or "security" (got "${values.profile}")`
      );
      return 3;
    }
    profile = values.profile;
  }
  const reviewers = parseRequiredReviewers(
    typeof values.reviewers === 'string' ? values.reviewers : undefined,
    'diff'
  );
  if ('code' in reviewers) return reviewers.code;
  const ceiling = positiveCeiling(
    typeof values.ceiling === 'string' ? values.ceiling : undefined,
    'diff'
  );
  if (typeof ceiling === 'object') return ceiling.code;
  const cwd = values.cwd ? path.resolve(String(values.cwd)) : process.cwd();

  const sourceFlags = {
    diffFile: typeof values['diff-file'] === 'string' ? values['diff-file'] : undefined,
    pr: typeof values.pr === 'string' ? values.pr : undefined,
    staged: Boolean(values.staged),
    workingTree: Boolean(values['working-tree']),
  };
  const stdinContent = hasExplicitSource(sourceFlags) ? undefined : readStdinIfPiped();
  const selection = selectDiffSource({ ...sourceFlags, stdinPiped: stdinContent !== undefined });
  if (isDiffSourceError(selection)) {
    console.error(`ensemble-ai diff: ${selection.error}`);
    return 3;
  }
  const source = resolveSource(selection, cwd, stdinContent, 'diff');
  if ('code' in source) return source.code;

  let acquired: AcquiredDiff;
  try {
    acquired = acquireDiff({
      base: typeof values.base === 'string' ? values.base : undefined,
      ceilingBytes: ceiling,
      cwd,
      diffMode: source.diffMode,
      diffText: source.diffText,
      staged: source.staged,
      workingTree: source.workingTree,
    });
  } catch (e) {
    console.error(`ensemble-ai diff: ${(e as Error).message}`);
    return 3;
  }
  const preview = buildPacketPreview(acquired, profile);
  if (values.json) {
    console.log(JSON.stringify({ packet: preview.packet, prompt: preview.prompt }, null, 2));
  } else {
    console.log(renderPacketPreview(acquired, preview, { full: Boolean(values.full), profile, reviewers }));
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const raw = argv[0];
  if (!raw || raw === '-h' || raw === '--help') {
    console.log(USAGE);
    return raw ? 0 : 1;
  }
  // Plumbing commands (no reviewer runs) dispatch before the mode registry.
  if (raw === 'receipt') return receiptCommand(argv.slice(1));
  if (raw === 'reviewers' || raw === 'config') return reviewersCommand(argv.slice(1));
  if (raw === 'diff') return diffCommand(argv.slice(1));

  const mode = resolveMode(raw);
  if (mode === 'review') return reviewCommand(argv.slice(1), 'code');
  if (mode === 'security') return reviewCommand(argv.slice(1), 'security');
  if (mode === 'brainstorm') return brainstormCommand(argv.slice(1));
  if (mode === 'consult') return consultCommand(argv.slice(1));
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
