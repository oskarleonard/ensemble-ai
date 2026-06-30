import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sanitizePathSegment } from '../../core/artifacts';
import { sha256Hex } from '../../core/hash';
import type { ReviewerId, StoredReview } from '../../core/types';

import type { Coverage, DiffMode } from './diff';

// The content-tied DIFF receipt — the diff analog of the spec-review receipt
// doctrine. A diff earns a receipt only after a qualifying cross-vendor review;
// the receipt is then re-validated LIVE against the immutable per-(runId,
// reviewerId) artifacts — never trusted as a stored boolean. So a copied receipt,
// a codex-only run, a post-review commit, or a partial-source-coverage run can
// never make a diff count as reviewed.
//
// Honest scope (NOT "anti-forgery"): the live check defends against the realistic
// failures — a STALE receipt (post-commit), a COPIED receipt (wrong digest), a
// codex-only / partial receipt (under-policy / under-coverage). It is NOT a
// trust boundary against a malicious local actor who fabricates both receipt AND
// artifacts (same user as the gate → such an actor could equally remove the gate).
// A signed / external-status receipt is the later hardening, out of v1 scope.
//
// KEY difference from the spec receipt: the core emits FACTS, so a reviewer
// "completed" means terminalState === 'reviewed' — NO `gate` requirement (the
// gate/dispositions are a consuming host's policy, not the portable core's).

export interface ReceiptCoverage {
  includedFiles: number;
  // Omitted files, NAMED with kind + reason — a 'source' omission disqualifies.
  omitted: { kind: string; path: string; reason: string }[];
  omittedFiles: number;
  totalFiles: number;
}

export interface DiffReviewReceipt {
  baseRef: string | null;
  baseSha: string | null;
  completed: ReviewerId[];
  coverage: ReceiptCoverage;
  // The canonical-diff content digest (NOT a commit SHA — a raw diff has no
  // intrinsic commit identity; the base+head SHAs carry that, separately).
  diffDigest: string;
  diffMode: DiffMode;
  headSha: string;
  // A digest of the gating policy: { reviewerPolicy, diffMode, coveragePolicy }.
  policyHash: string;
  repo: string | null;
  reviewerPolicy: ReviewerId[];
  runId: string;
  vendors: string[];
}

export interface CoveragePolicy {
  ceilingBytes: number;
}

export function computePolicyHash(args: {
  coveragePolicy: CoveragePolicy;
  diffMode: DiffMode;
  reviewerPolicy: ReviewerId[];
}): string {
  const canonical = JSON.stringify({
    coveragePolicy: args.coveragePolicy,
    diffMode: args.diffMode,
    reviewerPolicy: [...args.reviewerPolicy].sort(),
  });
  return `sha256:${sha256Hex(canonical)}`;
}

// The full reviewed identity (Codex f5): keyed by repo + BOTH SHAs + the diff
// digest + the policy — so two bases, or two reviewer policies, on one head do
// NOT collide/overwrite.
export interface ReceiptKey {
  baseSha: string | null;
  diffDigest: string;
  headSha: string;
  policyHash: string;
  repo: string | null;
}

export function receiptKeyHash(key: ReceiptKey): string {
  const canonical = JSON.stringify({
    baseSha: key.baseSha,
    diffDigest: key.diffDigest,
    headSha: key.headSha,
    policyHash: key.policyHash,
    repo: key.repo,
  });
  return sha256Hex(canonical);
}

function slug(s: string | null): string {
  return sanitizePathSegment(s ?? 'unknown').slice(0, 80) || 'x';
}

export function defaultReceiptStore(): string {
  return (
    process.env.ENSEMBLE_RECEIPTS_DIR ||
    path.join(os.homedir(), '.ensemble-ai', 'receipts')
  );
}

// Local, discoverable, push-free store: a per-machine cache (correct for a local
// gate — the receipt stays on the machine, nothing pushed or shared). Grouped by
// repo + head (browsable), the full-key hash disambiguates.
export function receiptPath(storeDir: string, key: ReceiptKey): string {
  return path.join(
    storeDir,
    slug(key.repo),
    slug(key.headSha),
    `${receiptKeyHash(key)}.json`
  );
}

export function keyOf(receipt: DiffReviewReceipt): ReceiptKey {
  return {
    baseSha: receipt.baseSha,
    diffDigest: receipt.diffDigest,
    headSha: receipt.headSha,
    policyHash: receipt.policyHash,
    repo: receipt.repo,
  };
}

export function writeReceipt(
  storeDir: string,
  receipt: DiffReviewReceipt
): string {
  const file = receiptPath(storeDir, keyOf(receipt));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2));
  fs.renameSync(tmp, file);
  return file;
}

export function readReceipt(
  storeDir: string,
  key: ReceiptKey
): DiffReviewReceipt | null {
  try {
    return JSON.parse(
      fs.readFileSync(receiptPath(storeDir, key), 'utf8')
    ) as DiffReviewReceipt;
  } catch {
    return null;
  }
}

// Coverage QUALIFIES a receipt only when every omitted path is allowlisted
// (generated / binary) — an omitted SOURCE file means the review didn't cover the
// change, so it must NOT qualify (Codex f4). Returns the disqualifying source
// paths (empty = qualified).
export function coverageShortfall(coverage: ReceiptCoverage): string[] {
  return coverage.omitted
    .filter((o) => o.kind !== 'generated' && o.kind !== 'binary')
    .map((o) => o.path);
}

export function summarizeCoverage(coverage: Coverage): ReceiptCoverage {
  return {
    includedFiles: coverage.includedFiles,
    omitted: coverage.files
      .filter((f) => !f.included)
      .map((f) => ({
        kind: f.kind,
        path: f.path,
        reason: f.omitReason ?? 'omitted',
      })),
    omittedFiles: coverage.omittedFiles,
    totalFiles: coverage.totalFiles,
  };
}

export interface BuildReceiptResult {
  error?: string;
  ok: boolean;
  receipt?: DiffReviewReceipt;
}

// PURE: at write time, decide whether the review QUALIFIES the diff and, if so,
// build the receipt. Enforces: every required reviewer reached terminalState
// 'reviewed' (facts — NO gate) AND coverage has no omitted source file. Builds
// exactly the receipt isDiffReviewed will then accept.
export function buildDiffReceipt(args: {
  baseRef: string | null;
  baseSha: string | null;
  coverage: Coverage;
  coveragePolicy: CoveragePolicy;
  diffDigest: string;
  diffMode: DiffMode;
  headSha: string;
  repo: string | null;
  required: ReviewerId[];
  reviews: StoredReview[];
  runId: string;
}): BuildReceiptResult {
  const summary = summarizeCoverage(args.coverage);
  const shortfall = coverageShortfall(summary);
  if (shortfall.length > 0) {
    return {
      error: `coverage incomplete — omitted source file(s): ${shortfall.join(', ')}`,
      ok: false,
    };
  }
  const vendors: string[] = [];
  for (const id of args.required) {
    const r = args.reviews.find((x) => x.reviewerId === id);
    if (!r || r.terminalState !== 'reviewed') {
      return { error: `not qualified — ${id} did not complete`, ok: false };
    }
    vendors.push(r.reviewer.vendor);
  }
  return {
    ok: true,
    receipt: {
      baseRef: args.baseRef,
      baseSha: args.baseSha,
      completed: [...args.required],
      coverage: summary,
      diffDigest: args.diffDigest,
      diffMode: args.diffMode,
      headSha: args.headSha,
      policyHash: computePolicyHash({
        coveragePolicy: args.coveragePolicy,
        diffMode: args.diffMode,
        reviewerPolicy: args.required,
      }),
      repo: args.repo,
      reviewerPolicy: [...args.required],
      runId: args.runId,
      vendors: [...new Set(vendors)],
    },
  };
}

export type DiffReviewReason =
  | 'reviewed'
  | 'no-receipt'
  | 'stale'
  | 'incomplete-policy'
  | 'incomplete-coverage'
  | 'artifact-missing';

export interface DiffReviewState {
  reason: DiffReviewReason;
  receipt: DiffReviewReceipt | null;
  reviewed: boolean;
}

// LIVE validation — the heart of the gate (Phase 2 calls this; Phase 1 ships +
// tests it). A diff counts as cross-vendor reviewed ONLY when: (a) a receipt
// exists for the full live identity, (b) its digest still matches the live diff
// (a post-review commit → stale), (c) completed[] covers the required policy
// (codex-only fails), (d) live coverage has no omitted SOURCE file, and (e) EVERY
// required reviewer's immutable (runId, reviewerId) artifact actually reached
// terminalState 'reviewed'. `readReceipt`/`readReview` are injected so this is
// pure + unit-testable, and the artifact (not the receipt's claim) is the proof.
export function isDiffReviewed(
  live: {
    coverage: Coverage;
    key: ReceiptKey;
    required: ReviewerId[];
  },
  deps: {
    readReceipt: (key: ReceiptKey) => DiffReviewReceipt | null;
    readReview: (runId: string, reviewerId: ReviewerId) => StoredReview | null;
  }
): DiffReviewState {
  const receipt = deps.readReceipt(live.key);
  if (!receipt) return { reason: 'no-receipt', receipt: null, reviewed: false };
  if (receipt.diffDigest !== live.key.diffDigest) {
    return { reason: 'stale', receipt, reviewed: false };
  }
  if (!live.required.every((id) => receipt.completed.includes(id))) {
    return { reason: 'incomplete-policy', receipt, reviewed: false };
  }
  if (coverageShortfall(summarizeCoverage(live.coverage)).length > 0) {
    return { reason: 'incomplete-coverage', receipt, reviewed: false };
  }
  for (const id of live.required) {
    const r = deps.readReview(receipt.runId, id);
    if (!r || r.terminalState !== 'reviewed') {
      return { reason: 'artifact-missing', receipt, reviewed: false };
    }
  }
  return { reason: 'reviewed', receipt, reviewed: true };
}
