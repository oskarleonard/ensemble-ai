import { persistReview } from '../../core/artifacts';
import { parseFindings } from '../../core/findings';
import { assembleCodePacket, PACKET_BUDGETS } from '../../core/packet';
import { renderReviewPrompt } from '../../core/prompt';
import { loadReviewers } from '../../core/reviewers';
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
  type DiffMode,
} from './diff';
import {
  type DepSurfaceResult,
  scanDependencySurface,
} from './dep-surface';
import { type ReviewProfile, SECURITY_OBJECTIVE } from './profile';
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
  // Mode label for a pre-supplied diffText (e.g. a `gh pr diff` capture → 'pr').
  diffMode?: DiffMode;
  diffText?: string;
  objective?: string;
  onProgress?: (msg: string) => void;
  out: string;
  // The review PROFILE: 'code' (default, general review) or 'security' (a
  // security-auditor framing + the local dependency-surface flag). A profile is a
  // thin variation — the engine, coverage, spawn, parse, and receipt are unchanged.
  profile?: ReviewProfile;
  receiptStore?: string;
  reviewers?: ReviewerId[];
  reviewersFile?: string;
  runId: string;
  // Override the reviewer sandbox profile (CLI `--sandbox`). The grok adapter
  // still pins it to a deny-by-default profile (a weaker value falls back), so
  // this can tighten but never weaken the boundary.
  sandbox?: string;
  // Review staged changes (`git diff --cached`) vs HEAD.
  staged?: boolean;
  workingTree?: boolean;
}

export interface ReviewModeResult {
  acquired: AcquiredDiff;
  blocked: boolean;
  blockedReason?: string;
  // The local dependency-surface scan — present ONLY for the 'security' profile
  // (manifest changes + risky imports drawn from the diff; no network).
  depSurface?: DepSurfaceResult;
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
    // No usable diff → the reviewer is NOT run, and this is recorded as a
    // NON-completion (never 'reviewed'). buildDiffReceipt and isDiffReviewed both
    // key "did this reviewer complete?" off terminalState === 'reviewed'; marking a
    // skipped reviewer 'reviewed' would qualify a receipt for a change no reviewer
    // ever saw (fail-OPEN). 'failed-reviewer' keeps a blind/empty packet fail-closed.
    return persistReview(out, {
      findings: [],
      packet,
      prompt,
      raw: null,
      reviewer,
      runId,
      summary: `Did not review with ${reviewer.id} — the diff could not be assembled (incomplete packet), so no trustworthy review ran. Surfaced for review.`,
      terminalState: 'failed-reviewer',
    });
  }
  // Isolate a per-reviewer failure (e.g. its CLI binary can't be resolved, which
  // throws): record it as THIS reviewer's failed-reviewer instead of rejecting the
  // whole Promise.all fan-out, so one missing or broken vendor can't take down the
  // others' reviews.
  const adapter = REVIEW_ADAPTERS[reviewer.id];
  let result: Awaited<ReturnType<typeof adapter>>;
  try {
    result = await adapter(prompt, reviewer);
  } catch (e) {
    return persistReview(out, {
      findings: [],
      packet,
      prompt,
      raw: null,
      reviewer,
      runId,
      summary: `The ${reviewer.id} reviewer could not run: ${(e as Error).message}`,
      terminalState: 'failed-reviewer',
    });
  }
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
  const profile: ReviewProfile = opts.profile ?? 'code';
  const reviewers =
    opts.reviewers && opts.reviewers.length > 0
      ? opts.reviewers
      : [...REVIEWER_IDS];

  const sourceLabel = opts.diffText !== undefined
    ? (opts.diffMode ?? 'raw')
    : opts.staged
      ? 'staged'
      : opts.workingTree
        ? 'working-tree'
        : 'commit';
  log(`Acquiring diff (${sourceLabel} mode)…`);
  const acquired = acquireDiff({
    base: opts.base,
    ceilingBytes,
    cwd: opts.cwd,
    diffMode: opts.diffMode,
    diffText: opts.diffText,
    staged: opts.staged,
    workingTree: opts.workingTree,
  });
  log(
    `Diff: ${acquired.coverage.totalFiles} file(s), ${acquired.coverage.includedFiles} covered, ${acquired.coverage.omittedFiles} omitted · digest ${acquired.canonicalDigest.slice(0, 19)}…`
  );

  // The security profile adds a LOCAL dependency-surface flag over the FULL parsed
  // diff (manifest changes + risky imports) — no network, computed once and surfaced
  // in every return path (including a secret-scan block) so the reader always sees it.
  const depSurface =
    profile === 'security' ? scanDependencySurface(acquired.files) : undefined;

  // Secret-scan the FULL canonical diff (the change identity), not just the
  // covered subset — the payload + the manifest must reflect the whole change.
  // (acquireDiff already parsed these files for coverage — reuse, don't re-parse.)
  const secretScan = scanDiffForSecrets(acquired.files, {
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
      depSurface,
      reviews: [],
      secretScan,
    };
  }

  const packet = assembleCodePacket({
    agentsMd: opts.agentsMd,
    authorSummary: opts.authorSummary,
    diff: acquired.diff,
    objective:
      opts.objective ??
      (profile === 'security' ? SECURITY_OBJECTIVE : DEFAULT_OBJECTIVE),
    pr: 0,
    repo: acquired.repoId ?? '',
  });
  const prompt = renderReviewPrompt(packet, profile);
  if (!packet.complete) {
    log('Packet incomplete (no usable diff) — persisting an empty review.');
  }

  log(`Running ${reviewers.length} reviewer(s): ${reviewers.join(', ')}…`);
  // Load the reviewers config ONCE per run (a file read + JSON parse), then index
  // it per reviewer — not once per reviewer inside the fan-out.
  const resolved = loadReviewers(opts.reviewersFile);
  const reviews = await Promise.all(
    reviewers.map(async (id) => {
      const reviewer: ReviewerConfig = {
        ...resolved[id],
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
    // The covered diff is truncated in the packet when it exceeds the diff budget;
    // a truncated payload must not qualify a receipt (the reviewer saw head+tail).
    diffTruncated: acquired.diff.length > PACKET_BUDGETS.diff,
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
    return { acquired, blocked: false, depSurface, receipt: built.receipt, receiptPath: file, reviews, secretScan };
  }
  log(`No receipt — ${built.error}`);
  return { acquired, blocked: false, depSurface, receiptError: built.error, reviews, secretScan };
}
