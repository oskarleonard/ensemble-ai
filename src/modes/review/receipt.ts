import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sanitizePathSegment } from '../../core/artifacts';
import { sha256Hex } from '../../core/hash';
import type { ReviewerId, StoredReview, TerminalState } from '../../core/types';

import type { Coverage, DiffMode } from './diff';
import type { GateDispositionSummary } from './gate';

// The content-tied DIFF receipt — the diff analog of the spec-review receipt
// doctrine. A diff earns a receipt only after a qualifying cross-vendor review;
// the receipt is then re-validated LIVE against the immutable per-(runId,
// reviewerId) artifacts — never trusted as a stored boolean. So a copied receipt,
// a codex-only run, a post-review commit, or a partial-source-coverage run can
// never make a diff count as reviewed.
//
// Honest scope (NOT "anti-forgery"): the live check defends against the realistic
// failures — a STALE receipt (post-commit), a COPIED receipt (wrong digest), a
// codex-only / partial receipt (under-policy / under-coverage). The STRICT verify mode
// (--require-artifacts, see plumbing/verify.ts) additionally requires the immutable
// per-reviewer artifacts, so a hand-written completed[]-only receipt fails closed. What
// remains out of scope is a malicious local actor who fabricates BOTH receipt AND
// artifacts (same user as the gate → such an actor could equally remove the gate):
// closing that needs CRYPTOGRAPHIC receipt SIGNING (a receipt no local actor can forge)
// or an external status check — the documented v2 hardening, deliberately NOT in v1.
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

// An ADDITIVE peer reviewer beyond the core codex/grok policy — the default-on cold
// Opus ('claude') reviewer. `claude` is not a core ReviewerId (it mints no receipt),
// but it IS a full peer reviewer whose completion the run depends on, so the receipt
// RECORDS it for completeness. `vendor` carries the model label (e.g. `anthropic/opus`).
export interface PeerReviewerRecord {
  id: string;
  state: TerminalState;
  vendor: string;
}

export interface DiffReviewReceipt {
  baseRef: string | null;
  baseSha: string | null;
  completed: ReviewerId[];
  coverage: ReceiptCoverage;
  // Additive peer reviewers beyond the core codex/grok policy (the default-on Opus
  // 'claude' reviewer). RECORDED for completeness + legibility — the core policy
  // (reviewerPolicy/completed) still mints + keys the receipt, so `receipt verify`
  // is unchanged; a run WITH a peer reviewer is only ever persisted when that peer
  // ALSO completed (see cli.ts). So a present, `reviewed` peer here means a full
  // N-reviewer pass; its absence, a core-only (`--no-claude`) one — the two are no
  // longer indistinguishable. Omitted on a codex/grok-only receipt.
  peerReviewers?: PeerReviewerRecord[];
  // The gate-disposition summary (Phase 2) — additive, host-owned POLICY metadata: the gate's
  // verdict counts + the HONORED dismissed HIGH ids + whether the trail durably wrote (false ⇒
  // dismissals were NOT honored). RECORDED for legibility + retro-scoring; `receipt verify` NEVER
  // reads it (isDiffReviewed keys off the diff digest + completed[] + coverage + artifacts only),
  // so a receipt with or without it verifies IDENTICALLY. Omitted on a `--no-claude` run (no gate).
  gateDisposition?: GateDispositionSummary;
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

// Does this receipt's IDENTITY (repo + both SHAs + policy — everything EXCEPT the diff
// digest) match the live key? The store lookup binds all five key fields implicitly
// (the receipt file is ADDRESSED by the full-key hash), so a `receipt verify <path>`
// that reads a file directly must re-bind the same identity or it becomes a strictly
// weaker gate than the store path. The digest is deliberately excluded here so a
// digest-only drift (commits since review) still surfaces as `stale` via isDiffReviewed,
// not a blunt no-receipt.
export function receiptIdentityMatches(
  receipt: DiffReviewReceipt,
  key: ReceiptKey
): boolean {
  return (
    receipt.repo === key.repo &&
    receipt.baseSha === key.baseSha &&
    receipt.headSha === key.headSha &&
    receipt.policyHash === key.policyHash
  );
}

export function writeReceipt(
  storeDir: string,
  receipt: DiffReviewReceipt
): string {
  const file = receiptPath(storeDir, keyOf(receipt));
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  // Owner-only (0600): a receipt records what/where was reviewed. writeFileSync's mode
  // is umask-masked, so chmod after to GUARANTEE 0600, then atomically rename in.
  fs.writeFileSync(tmp, JSON.stringify(receipt, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return file;
}

// Lightweight structural validation of a receipt read from untrusted JSON — reject a
// malformed / partial file with a CLEAR error instead of blind-casting it (Codex LOW).
// This is a shape check, NOT a trust boundary: a well-formed but FORGED receipt still
// parses (that's the attestation caveat above → guard with strict verify). It only
// catches corrupt / truncated / hand-broken files before they reach the gate logic.
export function validateReceiptShape(value: unknown): DiffReviewReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('receipt is not a JSON object');
  }
  const o = value as Record<string, unknown>;
  const isStr = (v: unknown): boolean => typeof v === 'string';
  const isStrOrNull = (v: unknown): boolean => v === null || typeof v === 'string';
  const isStrArr = (v: unknown): boolean =>
    Array.isArray(v) && v.every((x) => typeof x === 'string');
  const errs: string[] = [];
  if (!isStr(o.diffDigest)) errs.push('diffDigest (string)');
  if (!isStr(o.diffMode)) errs.push('diffMode (string)');
  if (!isStr(o.headSha)) errs.push('headSha (string)');
  if (!isStr(o.policyHash)) errs.push('policyHash (string)');
  if (!isStr(o.runId)) errs.push('runId (string)');
  if (!isStrOrNull(o.repo)) errs.push('repo (string|null)');
  if (!isStrOrNull(o.baseRef)) errs.push('baseRef (string|null)');
  if (!isStrOrNull(o.baseSha)) errs.push('baseSha (string|null)');
  if (!isStrArr(o.completed)) errs.push('completed (string[])');
  if (!isStrArr(o.reviewerPolicy)) errs.push('reviewerPolicy (string[])');
  if (!isStrArr(o.vendors)) errs.push('vendors (string[])');
  // peerReviewers is OPTIONAL (absent on codex/grok-only receipts) — validate only when
  // present, and reject a malformed one (each entry: id + state + vendor strings).
  if (o.peerReviewers !== undefined) {
    const okArr =
      Array.isArray(o.peerReviewers) &&
      o.peerReviewers.every(
        (p) =>
          p !== null &&
          typeof p === 'object' &&
          !Array.isArray(p) &&
          isStr((p as Record<string, unknown>).id) &&
          isStr((p as Record<string, unknown>).state) &&
          isStr((p as Record<string, unknown>).vendor)
      );
    if (!okArr) errs.push('peerReviewers (PeerReviewerRecord[])');
  }
  // gateDisposition is OPTIONAL (absent on --no-claude receipts + every pre-Phase-2 receipt, so
  // existing verify fixtures pass unchanged). Validate only when present — catch a corrupt one
  // before a reader (analytics / the fix-loop) trusts it; it is never a trust boundary.
  if (o.gateDisposition !== undefined) {
    const g = o.gateDisposition;
    const okDisp =
      g !== null &&
      typeof g === 'object' &&
      !Array.isArray(g) &&
      Array.isArray((g as Record<string, unknown>).dismissedHighIds) &&
      ((g as Record<string, unknown>).dismissedHighIds as unknown[]).every((x) => isStr(x)) &&
      typeof (g as Record<string, unknown>).trailWritten === 'boolean' &&
      (g as Record<string, unknown>).verdictCounts !== null &&
      typeof (g as Record<string, unknown>).verdictCounts === 'object' &&
      !Array.isArray((g as Record<string, unknown>).verdictCounts);
    if (!okDisp) errs.push('gateDisposition (GateDispositionSummary)');
  }
  const c = o.coverage;
  if (c === null || typeof c !== 'object' || Array.isArray(c)) {
    errs.push('coverage (object)');
  } else {
    const cov = c as Record<string, unknown>;
    if (typeof cov.totalFiles !== 'number') errs.push('coverage.totalFiles (number)');
    if (typeof cov.includedFiles !== 'number') errs.push('coverage.includedFiles (number)');
    if (typeof cov.omittedFiles !== 'number') errs.push('coverage.omittedFiles (number)');
    if (!Array.isArray(cov.omitted)) errs.push('coverage.omitted (array)');
  }
  if (errs.length > 0) {
    throw new Error(`malformed receipt — missing/invalid field(s): ${errs.join(', ')}`);
  }
  return value as DiffReviewReceipt;
}

export function readReceipt(
  storeDir: string,
  key: ReceiptKey
): DiffReviewReceipt | null {
  try {
    return validateReceiptShape(
      JSON.parse(fs.readFileSync(receiptPath(storeDir, key), 'utf8'))
    );
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
// 'reviewed' (facts — NO gate) AND coverage has no omitted source file AND the
// diff was NOT truncated to fit the prompt (a truncated payload means the reviewer
// saw only head+tail, so the receipt would over-claim). Builds exactly the receipt
// isDiffReviewed will then accept.
export function buildDiffReceipt(args: {
  baseRef: string | null;
  baseSha: string | null;
  coverage: Coverage;
  coveragePolicy: CoveragePolicy;
  diffDigest: string;
  diffMode: DiffMode;
  // True when the covered diff exceeded the prompt budget and was truncated, so
  // the reviewer did NOT see the whole change → must not qualify a receipt.
  diffTruncated: boolean;
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
  if (args.diffTruncated) {
    return {
      error:
        'coverage incomplete — the diff exceeded the prompt budget and was truncated, so the reviewer saw only its head+tail, not the whole change',
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
