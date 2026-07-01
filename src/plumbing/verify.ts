// The `receipt verify` / `receipt show` plumbing commands' PURE core — the
// content-tied diff-receipt gate primitive the future pre-PR hook calls. `verify`
// re-derives the live diff identity and asks the SAME isDiffReviewed the engine
// ships (stale / copied / under-policy / under-coverage / artifact-missing) whether
// the current state is reviewed; `show` pretty-prints a receipt. The CLI does the
// git I/O (acquireDiff) + the receipt read; everything here is pure + unit-tested.

import { readReview } from '../core/artifacts';
import type { ReviewerId, StoredReview } from '../core/types';
import type { Coverage } from '../modes/review/diff';
import {
  type DiffReviewReason,
  type DiffReviewReceipt,
  type DiffReviewState,
  isDiffReviewed,
  type ReceiptKey,
} from '../modes/review/receipt';

// When no trail dir is supplied, the receipt's own `completed[]` IS the record: a
// receipt is only ever written after every required reviewer completed AND coverage
// held (see buildDiffReceipt), so trusting it here is honest — the gate's realistic
// defense (stale / copied / under-policy / under-coverage) still runs against the
// LIVE diff. This synthesizes a 'reviewed' StoredReview for each claimed-complete
// id so isDiffReviewed's artifact loop passes exactly for the covered reviewers.
// With a trail dir, the real immutable artifacts are read instead (the deeper proof
// against a deleted-artifact-but-kept-receipt case).
export function receiptBackedReadReview(
  receipt: DiffReviewReceipt
): (runId: string, id: ReviewerId) => StoredReview | null {
  return (runId, id) =>
    receipt.completed.includes(id)
      ? {
          findings: [],
          packet: { complete: true, manifest: [] },
          reviewer: { effort: '', model: '', vendor: '' },
          reviewerId: id,
          runId,
          summary: 'receipt-backed (no trail dir provided)',
          terminalState: 'reviewed',
        }
      : null;
}

export interface VerifyDeps {
  readReceipt: (key: ReceiptKey) => DiffReviewReceipt | null;
  // Optional trail dir of the immutable per-reviewer artifacts. When omitted, the
  // receipt's completed[] is trusted (receiptBackedReadReview).
  trailDir?: string;
}

// Validate the live diff against a receipt (from an explicit path or the store).
// Reads the receipt ONCE and threads it to isDiffReviewed's injected deps.
export function verifyReceipt(
  live: { coverage: Coverage; key: ReceiptKey; required: ReviewerId[] },
  deps: VerifyDeps
): DiffReviewState {
  const receipt = deps.readReceipt(live.key);
  const trailDir = deps.trailDir;
  const readReviewFn: (runId: string, id: ReviewerId) => StoredReview | null =
    trailDir
      ? (runId, id) => readReview(trailDir, runId, id)
      : receipt
        ? receiptBackedReadReview(receipt)
        : () => null;
  return isDiffReviewed(live, {
    readReceipt: () => receipt,
    readReview: readReviewFn,
  });
}

// Gate exit code: 0 iff the current diff is reviewed & current; any not-reviewed
// reason (missing / stale / mismatch / incomplete) is a single non-zero (3) so a
// pre-PR hook just checks `!= 0`; the printed reason carries the detail.
export function verifyExitCode(state: DiffReviewState): number {
  return state.reviewed ? 0 : 3;
}

const REASON_EXPLANATION: Record<DiffReviewReason, string> = {
  'artifact-missing':
    'ARTIFACT MISSING — a required reviewer artifact is absent or did not complete (pass --trail <dir>)',
  'incomplete-coverage':
    'INCOMPLETE COVERAGE — the current diff omits a source file the review did not cover',
  'incomplete-policy':
    'INCOMPLETE POLICY — the receipt does not cover every required reviewer',
  'no-receipt':
    'NO RECEIPT — the current diff identity has no review receipt; it has not been reviewed',
  reviewed:
    'VALID & CURRENT — the current diff matches a qualifying cross-vendor review receipt',
  stale:
    'STALE — a receipt exists but its diff digest no longer matches the current state (commits since review)',
};

// The formatted `verify` verdict: the live identity + the pass/fail reason. PURE.
export function formatVerify(
  state: DiffReviewState,
  key: ReceiptKey
): string {
  const out: string[] = [];
  out.push('');
  out.push(`ensemble-ai receipt verify — ${state.reviewed ? 'PASS' : 'FAIL'}`);
  out.push(`  repo:    ${key.repo ?? '(none)'}`);
  out.push(`  head:    ${key.headSha}`);
  out.push(`  digest:  ${key.diffDigest}`);
  out.push(`  verdict: ${REASON_EXPLANATION[state.reason]}`);
  if (state.receipt) {
    out.push(
      `  receipt: runId ${state.receipt.runId} · completed ${state.receipt.completed.join(', ')} · vendors ${state.receipt.vendors.join(', ')}`
    );
  }
  out.push('');
  return out.join('\n');
}

// The formatted `show` output: every field of a stored receipt, human-readable. PURE.
export function formatReceipt(receipt: DiffReviewReceipt): string {
  const c = receipt.coverage;
  const out: string[] = [];
  out.push('');
  out.push('ensemble-ai receipt show');
  out.push(`  repo:      ${receipt.repo ?? '(none)'}`);
  out.push(`  base:      ${receipt.baseRef ?? '(none)'} (${receipt.baseSha ?? '?'})`);
  out.push(`  head:      ${receipt.headSha}`);
  out.push(`  mode:      ${receipt.diffMode}`);
  out.push(`  digest:    ${receipt.diffDigest}`);
  out.push(`  policy:    ${receipt.policyHash}`);
  out.push(`  reviewers: ${receipt.reviewerPolicy.join(', ')} (policy)`);
  out.push(`  completed: ${receipt.completed.join(', ')}`);
  out.push(`  vendors:   ${receipt.vendors.join(', ')}`);
  out.push(`  runId:     ${receipt.runId}`);
  out.push(
    `  coverage:  ${c.totalFiles} total · ${c.includedFiles} reviewed · ${c.omittedFiles} omitted`
  );
  for (const o of c.omitted) {
    out.push(`               omitted: ${o.path} (${o.reason}/${o.kind})`);
  }
  out.push('');
  return out.join('\n');
}
