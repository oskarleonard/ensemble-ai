import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sanitizePathSegment } from '../../core/artifacts';
import { sha256Hex } from '../../core/hash';
import type { ReviewerId, StoredReview, TerminalState } from '../../core/types';

import type { Coverage, DiffMode } from './diff';
import {
  computePolicyHashAt,
  type EvidenceMap,
  evidenceShortfall,
  isEvidenceClass,
  isEvidenceSeat,
  isPolicyVersion,
  POLICY_VERSION_LEGACY,
  resolvePolicyVersion,
  type SandboxProfileMap,
} from './evidence';
import { GATE_VERDICTS } from './gate';
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
  // The per-seat evidence the POLICY asked for. Absent on a legacy (v1) receipt.
  intendedEvidence?: EvidenceMap;
  // A digest of the gating policy. v1: { reviewerPolicy, diffMode, coveragePolicy }.
  // v2 additionally binds the intended evidence map + the sandbox profile identities.
  policyHash: string;
  // The SCHEMA VERSION of the inputs hashed into policyHash. Absent ⇒ 1 (legacy). The verifier
  // computes its comparison hash under THIS version, so growing the hasher never stales an
  // already-issued receipt (spec §8's upgrade note).
  policyVersion?: number;
  // The per-seat evidence the run ACTUALLY realized — FACT, not intent. §2 permits per-seat
  // fail-closed fallback (a seat without a qualifying sandbox keeps the packet), so a degraded
  // mixed run is never receipt-equivalent to a full-worktree one. Absent on a legacy receipt,
  // which `receipt verify` reads as `unknown` = weaker (gate-r3 pin 2).
  realizedEvidence?: EvidenceMap;
  repo: string | null;
  reviewerPolicy: ReviewerId[];
  runId: string;
  // The sandbox profile id + version each worktree seat ran under (hashed into a v2 policyHash).
  sandboxProfiles?: SandboxProfileMap;
  vendors: string[];
}

export interface CoveragePolicy {
  ceilingBytes: number;
}

// The legacy-schema policy hash. PRESERVED as the v1 entry point so every existing caller and
// every receipt on disk keeps its identity; new callers pass evidence through computePolicyHashAt.
export function computePolicyHash(args: {
  coveragePolicy: CoveragePolicy;
  diffMode: DiffMode;
  reviewerPolicy: ReviewerId[];
}): string {
  return computePolicyHashAt(args, POLICY_VERSION_LEGACY);
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

// verdictCounts must be an object with EXACTLY the GateVerdict taxonomy keys, each a finite
// non-negative integer — not merely "a non-array object" (the prior check). A malformed count
// ({ agree: "many" }, negatives, non-integers, unknown or missing keys) would otherwise pass and
// mislead an analytics / fix-loop reader (codex-f3). Never a trust boundary; it just fails a corrupt
// receipt closed, like the sibling field checks. Keyed off GATE_VERDICTS so it can never drift.
function isVerdictCounts(v: unknown): boolean {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const rec = v as Record<string, unknown>;
  // length === taxonomy AND every taxonomy key valid ⇒ no missing and no extra keys.
  return (
    Object.keys(rec).length === GATE_VERDICTS.length &&
    GATE_VERDICTS.every((k) => {
      const n = rec[k];
      return typeof n === 'number' && Number.isInteger(n) && n >= 0;
    })
  );
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
      isVerdictCounts((g as Record<string, unknown>).verdictCounts);
    if (!okDisp) errs.push('gateDisposition (GateDispositionSummary)');
  }
  // The evidence-identity fields are OPTIONAL (absent on every pre-worktree receipt, so existing
  // fixtures parse unchanged). Validate only when present — a corrupt evidence map must fail the
  // receipt closed rather than be read as "no gap".
  if (o.policyVersion !== undefined && !isPolicyVersion(o.policyVersion)) {
    errs.push('policyVersion (a known policy schema version)');
  }
  for (const field of ['intendedEvidence', 'realizedEvidence'] as const) {
    const m = o[field];
    if (m === undefined) continue;
    const okMap =
      m !== null &&
      typeof m === 'object' &&
      !Array.isArray(m) &&
      Object.entries(m as Record<string, unknown>).every(
        ([k, v]) => isEvidenceSeat(k) && isEvidenceClass(v)
      );
    if (!okMap) errs.push(`${field} (EvidenceMap)`);
  }
  if (o.sandboxProfiles !== undefined) {
    const sp = o.sandboxProfiles;
    const okSp =
      sp !== null &&
      typeof sp === 'object' &&
      !Array.isArray(sp) &&
      Object.entries(sp as Record<string, unknown>).every(([k, v]) => {
        if (!isEvidenceSeat(k) || v === null || typeof v !== 'object' || Array.isArray(v)) {
          return false;
        }
        const r = v as Record<string, unknown>;
        return isStr(r.id) && typeof r.version === 'number' && Number.isInteger(r.version);
      });
    if (!okSp) errs.push('sandboxProfiles (SandboxProfileMap)');
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
  // The evidence the policy asked for. Omitted ⇒ an all-packet run ⇒ a v1 (legacy) receipt,
  // byte-identical to what shipped before evidence identity existed.
  intendedEvidence?: EvidenceMap;
  // What the run actually realized, per seat (fail-closed fallbacks included).
  realizedEvidence?: EvidenceMap;
  repo: string | null;
  required: ReviewerId[];
  reviews: StoredReview[];
  runId: string;
  sandboxProfiles?: SandboxProfileMap;
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
  // An all-packet run hashes under the LEGACY schema, so worktree mode OFF changes no receipt
  // identity anywhere (the packet path stays byte-compatible). Any worktree seat ⇒ v2.
  const intendedEvidence = args.intendedEvidence ?? {};
  const policyVersion = resolvePolicyVersion(intendedEvidence);
  const isLegacy = policyVersion === POLICY_VERSION_LEGACY;
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
      ...(isLegacy
        ? {}
        : {
            intendedEvidence,
            policyVersion,
            realizedEvidence: args.realizedEvidence ?? {},
            ...(args.sandboxProfiles ? { sandboxProfiles: args.sandboxProfiles } : {}),
          }),
      policyHash: computePolicyHashAt(
        {
          coveragePolicy: args.coveragePolicy,
          diffMode: args.diffMode,
          intendedEvidence,
          reviewerPolicy: args.required,
          sandboxProfiles: args.sandboxProfiles,
        },
        policyVersion
      ),
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
  | 'evidence-degraded'
  | 'artifact-missing';

export interface DiffReviewState {
  // The seats whose REALIZED evidence was weaker than the caller's intent — set only for
  // 'evidence-degraded', so the CLI can name them (never a mystery miss).
  evidenceGaps?: ReturnType<typeof evidenceShortfall>;
  reason: DiffReviewReason;
  receipt: DiffReviewReceipt | null;
  reviewed: boolean;
}

// SCHEMA-COMPATIBILITY lookup, the ONE place it lives. Find a receipt whose identity this build
// can interpret: a v2 caller falls back to the v1 key so a legacy receipt is FOUND rather than
// reported missing — it then fails on EVIDENCE QUALITY, which can name the weaker seat and point
// at the flag, instead of a blunt `no-receipt` that hides WHY (gate-r3 pin 2).
export function resolveReceipt(
  readReceipt: (key: ReceiptKey) => DiffReviewReceipt | null,
  key: ReceiptKey,
  legacyKey?: ReceiptKey
): DiffReviewReceipt | null {
  return readReceipt(key) ?? (legacyKey ? readReceipt(legacyKey) : null);
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
    // Accept a receipt whose realized evidence is WEAKER than the caller's intent
    // (`--accept-degraded`). Never the default: silently accepting weaker evidence is the
    // exact fail-open the realized map exists to close.
    acceptDegraded?: boolean;
    coverage: Coverage;
    // What THIS caller is asking to have been evidenced. Absent ⇒ a packet-mode caller ⇒ the
    // evidence check is a no-op, so the legacy path is behavior-identical.
    intendedEvidence?: EvidenceMap;
    key: ReceiptKey;
    // The SAME identity hashed under the legacy (v1) schema. Consulted ONLY when the primary
    // (v2) key misses — see resolveReceipt.
    legacyKey?: ReceiptKey;
    required: ReviewerId[];
  },
  deps: {
    readReceipt: (key: ReceiptKey) => DiffReviewReceipt | null;
    readReview: (runId: string, reviewerId: ReviewerId) => StoredReview | null;
  }
): DiffReviewState {
  // SCHEMA-COMPATIBILITY first, EVIDENCE-QUALITY second (below).
  const receipt = resolveReceipt(deps.readReceipt, live.key, live.legacyKey);
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
  // EVIDENCE-QUALITY second, and only when the caller REQUESTS worktree evidence. A legacy
  // receipt carries no realized map: unknown = weaker. It fails here, not at lookup — so the
  // error can name the seat and point at the flag. A packet-mode caller intends nothing
  // stronger than packet, so every receipt passes and v1 semantics are untouched.
  if (live.intendedEvidence && !live.acceptDegraded) {
    const gaps = evidenceShortfall(live.intendedEvidence, receipt.realizedEvidence);
    if (gaps.length > 0) {
      return { evidenceGaps: gaps, reason: 'evidence-degraded', receipt, reviewed: false };
    }
  }
  for (const id of live.required) {
    const r = deps.readReview(receipt.runId, id);
    if (!r || r.terminalState !== 'reviewed') {
      return { reason: 'artifact-missing', receipt, reviewed: false };
    }
  }
  return { reason: 'reviewed', receipt, reviewed: true };
}
