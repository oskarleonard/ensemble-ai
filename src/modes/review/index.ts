import { persistReview } from '../../core/artifacts';
import { parseFindings } from '../../core/findings';
import { assembleCodePacket } from '../../core/packet';
import { renderReviewPrompt } from '../../core/prompt';
import { resolveReviewer } from '../../core/reviewers';
import {
  REVIEWER_IDS,
  type ReviewerConfig,
  type ReviewerId,
  type StoredReview,
  type TerminalState,
} from '../../core/types';
import { REVIEW_ADAPTERS } from '../../reviewers/registry';

import {
  acquireDiff,
  type AcquiredDiff,
  DEFAULT_COVERAGE_CEILING,
  parseDiffFiles,
} from './diff';
import {
  buildDiffReceipt,
  type DiffReviewReceipt,
  defaultReceiptStore,
  writeReceipt,
} from './receipt';
import { scanDiffForSecrets, type SecretScanResult } from './secret-scan';

export interface ReviewModeOptions {
  agentsMd?: string;
  allowSensitive?: boolean;
  authorSummary?: string;
  base?: string;
  ceilingBytes?: number;
  cwd: string;
  diffText?: string;
  objective?: string;
  onProgress?: (msg: string) => void;
  out: string;
  receiptStore?: string;
  reviewers?: ReviewerId[];
  reviewersFile?: string;
  runId: string;
  // Override the reviewer sandbox profile (CLI `--sandbox`). The grok adapter
  // still pins it to a deny-by-default profile (a weaker value falls back), so
  // this can tighten but never weaken the boundary.
  sandbox?: string;
  workingTree?: boolean;
}

export interface ReviewModeResult {
  acquired: AcquiredDiff;
  blocked: boolean;
  blockedReason?: string;
  receipt?: DiffReviewReceipt;
  receiptError?: string;
  receiptPath?: string;
  reviews: StoredReview[];
  secretScan: SecretScanResult;
}

const DEFAULT_OBJECTIVE =
  'Adversarial cross-vendor review of a code diff — find correctness, security, and convention issues a same-vendor author might miss.';

// Run ONE reviewer over the prepared prompt + persist its per-reviewer artifact.
// Mirrors the proven dashboard flow: a watchdog timeout/parse-failure marks the
// reviewer failed-reviewer (a cut-off review is not trusted even if it partly
// parsed); an incomplete packet skips the (separate-quota) call entirely.
async function reviewOne(
  out: string,
  runId: string,
  reviewer: ReviewerConfig,
  prompt: string,
  packetComplete: boolean,
  packet: ReturnType<typeof assembleCodePacket>
): Promise<StoredReview> {
  if (!packetComplete) {
    return persistReview(out, {
      findings: [],
      packet,
      prompt,
      raw: null,
      reviewer,
      runId,
      summary: `Skipped the ${reviewer.id} review — the diff could not be assembled, so the packet is incomplete. Surfaced for review.`,
      terminalState: 'reviewed',
    });
  }
  const result = await REVIEW_ADAPTERS[reviewer.id](prompt, reviewer);
  const parsed = result.raw ? parseFindings(result.raw) : null;
  const terminalState: TerminalState =
    parsed && !parsed.parseError && !result.timedOut
      ? 'reviewed'
      : 'failed-reviewer';
  const summary = result.timedOut
    ? 'The reviewer timed out before completing — its output is incomplete and not trusted.'
    : parsed?.summary || 'The reviewer produced no parseable findings.';
  return persistReview(out, {
    findings: parsed?.findings ?? [],
    packet,
    prompt,
    raw: result.raw,
    reviewer,
    runId,
    summary,
    terminalState,
  });
}

// The review MODE end-to-end: acquire the diff (+ identity + coverage + digest) →
// secret-scan the payload (fail-closed unless allowSensitive) → assemble the
// bounded packet → run each reviewer READ-ONLY under the watchdog → parse + write
// the per-reviewer trail → build + write the content-tied receipt when the review
// qualifies. Emits FACTS (findings + execution status + coverage + receipt) — never
// a gate verdict; the gate policy is the consumer's.
export async function runReviewMode(
  opts: ReviewModeOptions
): Promise<ReviewModeResult> {
  const log = opts.onProgress ?? (() => {});
  const ceilingBytes = opts.ceilingBytes ?? DEFAULT_COVERAGE_CEILING;
  const reviewers =
    opts.reviewers && opts.reviewers.length > 0
      ? opts.reviewers
      : [...REVIEWER_IDS];

  log(`Acquiring diff (${opts.workingTree ? 'working-tree' : opts.diffText !== undefined ? 'raw' : 'commit'} mode)…`);
  const acquired = acquireDiff({
    base: opts.base,
    ceilingBytes,
    cwd: opts.cwd,
    diffText: opts.diffText,
    workingTree: opts.workingTree,
  });
  log(
    `Diff: ${acquired.coverage.totalFiles} file(s), ${acquired.coverage.includedFiles} covered, ${acquired.coverage.omittedFiles} omitted · digest ${acquired.canonicalDigest.slice(0, 19)}…`
  );

  // Secret-scan the FULL canonical diff (the change identity), not just the
  // covered subset — the payload + the manifest must reflect the whole change.
  const files = parseDiffFiles(acquired.rawDiff);
  const secretScan = scanDiffForSecrets(files, {
    allowSensitive: opts.allowSensitive,
  });
  if (secretScan.blocked) {
    const paths = [
      ...secretScan.sensitivePaths.map((p) => `${p.path} (${p.label})`),
      ...secretScan.inlineSecrets.map((s) => `${s.path} (${s.label})`),
    ];
    const reason = `diff carries sensitive content: ${paths.join(', ')} — pass --allow-sensitive to review anyway`;
    log(`BLOCKED — ${reason}`);
    return {
      acquired,
      blocked: true,
      blockedReason: reason,
      reviews: [],
      secretScan,
    };
  }

  const packet = assembleCodePacket({
    agentsMd: opts.agentsMd,
    authorSummary: opts.authorSummary,
    diff: acquired.diff,
    objective: opts.objective ?? DEFAULT_OBJECTIVE,
    pr: 0,
    repo: acquired.repoId ?? '',
  });
  const prompt = renderReviewPrompt(packet);
  if (!packet.complete) {
    log('Packet incomplete (no usable diff) — persisting an empty review.');
  }

  log(`Running ${reviewers.length} reviewer(s): ${reviewers.join(', ')}…`);
  const reviews = await Promise.all(
    reviewers.map(async (id) => {
      const reviewer: ReviewerConfig = {
        ...resolveReviewer(id, opts.reviewersFile),
        ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
      };
      log(`  · ${id} (${reviewer.vendor} · ${reviewer.model})…`);
      const r = await reviewOne(
        opts.out,
        opts.runId,
        reviewer,
        prompt,
        packet.complete,
        packet
      );
      log(
        `  · ${id}: ${r.terminalState} — ${r.findings.length} finding(s)`
      );
      return r;
    })
  );

  // Build the content-tied receipt — only when every required reviewer completed
  // AND coverage has no omitted source file (else no receipt; the reason is
  // reported, the gate stays the consumer's).
  const built = buildDiffReceipt({
    baseRef: acquired.baseRef,
    baseSha: acquired.baseSha,
    coverage: acquired.coverage,
    coveragePolicy: { ceilingBytes },
    diffDigest: acquired.canonicalDigest,
    diffMode: acquired.mode,
    headSha: acquired.headSha,
    repo: acquired.repoId,
    required: reviewers,
    reviews,
    runId: opts.runId,
  });
  if (built.ok && built.receipt) {
    const store = opts.receiptStore ?? defaultReceiptStore();
    const file = writeReceipt(store, built.receipt);
    log(`Receipt written: ${file}`);
    return { acquired, blocked: false, receipt: built.receipt, receiptPath: file, reviews, secretScan };
  }
  log(`No receipt — ${built.error}`);
  return { acquired, blocked: false, receiptError: built.error, reviews, secretScan };
}
