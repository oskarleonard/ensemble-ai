// The `receipt verify` / `receipt show` plumbing commands' PURE core — the
// content-tied diff-receipt gate primitive the future pre-PR hook calls. `verify`
// re-derives the live diff identity and asks the SAME isDiffReviewed the engine
// ships (stale / copied / under-policy / under-coverage / artifact-missing) whether
// the current state is reviewed; `show` pretty-prints a receipt. The CLI does the
// git I/O (acquireDiff) + the receipt read; everything here is pure + unit-tested.

import { readReview } from '../core/artifacts';
import type { ReviewerId, StoredReview } from '../core/types';
import { type Coverage, coverageCounts, omittedLine } from '../modes/review/diff';
import {
  type EvidenceMap,
  formatEvidenceShortfall,
} from '../modes/review/evidence';
import {
  type DiffReviewReason,
  type DiffReviewReceipt,
  type DiffReviewState,
  isDiffReviewed,
  type ReceiptKey,
  resolveReceipt,
} from '../modes/review/receipt';

// TRUST MODEL — two modes, by design:
//
//   • DEFAULT (attested): with no trail dir, the receipt's own `completed[]` IS the
//     record. A receipt is only ever written after every required reviewer completed
//     AND coverage held (see buildDiffReceipt), so trusting a receipt the ENGINE
//     wrote is honest, and the realistic defenses (stale / copied / under-policy /
//     under-coverage) still run against the LIVE diff. BUT this is NOT forgery-proof:
//     a hand-written receipt JSON carrying the right diff digest would also pass,
//     because completed[] is a CLAIM, not a proof. So attested mode emits a LOUD
//     warning (see the CLI) and MUST NOT be the mode a pre-PR gate relies on.
//   • STRICT (--strict / --require-artifacts): the real immutable per-(runId,
//     reviewerId) artifacts are the proof. A receipt that is only completed[]-attested
//     — no resolvable trail — FAILS CLOSED (artifact-missing). This is the mode the
//     pre-PR HOOK must use.
//
// Cryptographic receipt SIGNING (a receipt no local actor can fabricate) is the
// documented v2 hardening — out of v1 scope; see receipt.ts. This function stays
// pure; the CLI owns the warning + flag wiring.
//
// receiptBackedReadReview synthesizes a 'reviewed' StoredReview for each
// claimed-complete id so isDiffReviewed's artifact loop passes exactly for the
// covered reviewers — used ONLY in default (attested) mode.
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
  // Accept a receipt whose realized per-seat evidence is weaker than the caller's intent
  // (`--accept-degraded`). Off by default — a silent accept is the fail-open.
  acceptDegraded?: boolean;
  // What this caller asks to have been evidenced, per seat. Absent ⇒ packet-mode ⇒ no check.
  intendedEvidence?: EvidenceMap;
  // The same identity hashed under the legacy schema; consulted when the primary key misses.
  legacyKey?: ReceiptKey;
  readReceipt: (key: ReceiptKey) => DiffReviewReceipt | null;
  // When true, REQUIRE the real per-reviewer trail artifacts to prove the review:
  // attestation-only (completed[]) never satisfies the gate, and a receipt without a
  // resolvable artifact trail FAILS CLOSED (artifact-missing). This is the mode the
  // pre-PR hook must use — the receipt's completed[] is a claim; the artifact is proof.
  strict?: boolean;
  // Optional trail dir of the immutable per-reviewer artifacts. When omitted in the
  // DEFAULT mode, the receipt's completed[] is trusted (receiptBackedReadReview);
  // when omitted in STRICT mode, verification fails closed.
  trailDir?: string;
}

// Did this verification PASS by attestation alone (no artifact proof)? True only in
// default mode with no trail dir — the CLI uses this to emit the loud warning that a
// pass is trusted-by-attestation, not artifact-proven, so it is never silently
// forgeable. (A strict pass, or any trail-dir pass, is artifact-proven → no warning.)
export function isAttestedOnly(deps: VerifyDeps): boolean {
  return !deps.strict && !deps.trailDir;
}

// Validate the live diff against a receipt (from an explicit path or the store).
// Reads the receipt ONCE and threads it to isDiffReviewed's injected deps.
export function verifyReceipt(
  live: { coverage: Coverage; key: ReceiptKey; required: ReviewerId[] },
  deps: VerifyDeps
): DiffReviewState {
  // The SAME schema-compat lookup isDiffReviewed performs, so the attested-mode readReview below
  // is backed by the receipt the state machine will read (a legacy receipt found via the legacy
  // key must still satisfy its own completed[] attestation). Resolved ONCE here and injected as a
  // constant, so isDiffReviewed needs no key of its own.
  const receipt = resolveReceipt(deps.readReceipt, live.key, deps.legacyKey);
  const trailDir = deps.trailDir;
  // Resolve HOW a reviewer's terminal state is proven:
  //   trail dir → read the real immutable artifacts (strongest proof);
  //   strict + no trail → () => null, so isDiffReviewed reports artifact-missing (fail closed);
  //   default + no trail → trust the receipt's completed[] (attested).
  const readReviewFn: (runId: string, id: ReviewerId) => StoredReview | null =
    trailDir
      ? (runId, id) => readReview(trailDir, runId, id)
      : deps.strict
        ? () => null
        : receipt
          ? receiptBackedReadReview(receipt)
          : () => null;
  return isDiffReviewed(
    {
      ...live,
      acceptDegraded: deps.acceptDegraded,
      intendedEvidence: deps.intendedEvidence,
    },
    {
      readReceipt: () => receipt,
      readReview: readReviewFn,
    }
  );
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
  'evidence-degraded':
    'EVIDENCE DEGRADED — a receipt exists, but a seat was evidenced more weakly than you are asking for',
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
  // A degraded verdict must NAME the weaker seat and point at the flag — never a mystery miss
  // (gate-r3 pin 2).
  if (state.evidenceGaps && state.evidenceGaps.length > 0) {
    out.push(`  evidence: ${formatEvidenceShortfall(state.evidenceGaps)}`);
  }
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
  if (receipt.peerReviewers && receipt.peerReviewers.length > 0) {
    out.push(
      `  peers:     ${receipt.peerReviewers.map((p) => `${p.id} (${p.vendor}) ${p.state}`).join(', ')}`
    );
  }
  out.push(`  runId:     ${receipt.runId}`);
  out.push(`  coverage:  ${coverageCounts(c)}`);
  for (const o of c.omitted) {
    out.push(`               ${omittedLine({ kind: o.kind, path: o.path, reason: o.reason })}`);
  }
  out.push('');
  return out.join('\n');
}
