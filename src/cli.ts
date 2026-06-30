#!/usr/bin/env node
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
} from './core/types';
import { isImplemented, isMode } from './modes';
import { runReviewMode, type ReviewModeResult } from './modes/review';

const USAGE = `ensemble-ai — convene multiple AI models on a task, read-only.

Usage:
  ensemble-ai <mode> [options]

Modes:
  review       Cross-vendor review of a code diff (implemented).
  brainstorm   (planned)
  security     (planned)

Run \`ensemble-ai review --help\` for review options.`;

const REVIEW_USAGE = `ensemble-ai review — cross-vendor review of a code diff.

Diff source (first match wins):
  --diff-file <path>   review a raw unified diff from a file
  (stdin)              piped diff, e.g. \`git diff main...HEAD | ensemble-ai review\`
  --working-tree       review uncommitted tracked changes vs HEAD
  (default)            review <base>...HEAD (base auto-resolved like \`gh pr create\`)

Options:
  --base <ref>          base ref for the default (commit) mode
  --reviewers <ids>     comma-separated reviewer ids (default: all configured)
  --out <dir>           trail output dir (default: a temp dir, printed)
  --sandbox <profile>   reviewer sandbox profile override (deny-by-default only)
  --allow-sensitive     review even if the diff carries secrets/sensitive paths
  --ceiling <bytes>     coverage byte ceiling (default 200000)
  --cwd <dir>           repo working dir (default: cwd)
  --run-id <id>         trail/receipt run id (default: generated)
  -h, --help            this help

Exit codes: 0 = review completed (even WITH findings) · 1 = a reviewer failed
(crash/timeout/no-parse) · 2 = blocked by the secret-scan · 3 = usage / no diff.`;

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

function printSummary(result: ReviewModeResult): void {
  const a = result.acquired;
  const out: string[] = [];
  out.push('');
  out.push(`ensemble-ai review — ${a.mode} mode`);
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
  if (result.blocked) {
    out.push(`  BLOCKED: ${result.blockedReason}`);
    console.error(out.join('\n'));
    return;
  }
  out.push('');
  for (const r of result.reviews) {
    const high = r.findings.filter((f) => f.severity === 'high').length;
    out.push(
      `  ${r.reviewerId} [${r.reviewer.vendor} · ${r.reviewer.model}]: ${r.terminalState} — ${r.findings.length} finding(s)${high ? `, ${high} high` : ''}`
    );
    if (r.summary) out.push(`      ${r.summary.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
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
  console.log(out.join('\n'));
}

async function reviewCommand(args: string[]): Promise<number> {
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
        out: { type: 'string' },
        reviewers: { type: 'string' },
        'run-id': { type: 'string' },
        sandbox: { type: 'string' },
        'working-tree': { type: 'boolean' },
      },
    }));
  } catch (e) {
    console.error(`ensemble-ai review: ${(e as Error).message}`);
    console.error(REVIEW_USAGE);
    return 3;
  }
  if (values.help) {
    console.log(REVIEW_USAGE);
    return 0;
  }

  const cwd = values.cwd ? path.resolve(String(values.cwd)) : process.cwd();
  let diffText: string | undefined;
  const diffFile = values['diff-file'];
  if (typeof diffFile === 'string') {
    try {
      diffText = fs.readFileSync(diffFile, 'utf8');
    } catch (e) {
      console.error(`ensemble-ai review: cannot read --diff-file: ${(e as Error).message}`);
      return 3;
    }
  } else if (!values['working-tree']) {
    diffText = readStdinIfPiped();
  }

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
        `ensemble-ai review: --reviewers "${values.reviewers}" ${
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
    console.error('ensemble-ai review: --ceiling must be a positive number');
    return 3;
  }

  let result: ReviewModeResult;
  try {
    result = await runReviewMode({
      allowSensitive: Boolean(values['allow-sensitive']),
      base: typeof values.base === 'string' ? values.base : undefined,
      ceilingBytes,
      cwd,
      diffText,
      onProgress: (m) => console.error(`· ${m}`),
      out,
      reviewers,
      runId,
      sandbox: typeof values.sandbox === 'string' ? values.sandbox : undefined,
      workingTree: Boolean(values['working-tree']),
    });
  } catch (e) {
    console.error(`ensemble-ai review: ${(e as Error).message}`);
    return 3;
  }

  printSummary(result);
  console.error(`trail: ${out}`);
  if (result.blocked) return 2;
  // Exit code = EXECUTION status, never a gate verdict: 0 even WITH findings; 1
  // only when a reviewer failed to complete (crash / timeout / no parse).
  const allReviewed =
    result.reviews.length > 0 &&
    result.reviews.every((r) => r.terminalState === 'reviewed');
  return allReviewed ? 0 : 1;
}

export async function main(argv: string[]): Promise<number> {
  const mode = argv[0];
  if (!mode || mode === '-h' || mode === '--help') {
    console.log(USAGE);
    return mode ? 0 : 1;
  }
  if (mode === 'review') return reviewCommand(argv.slice(1));
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
