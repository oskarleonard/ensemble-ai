import { sha256Hex } from '../../core/hash';

import type { DiffMode } from './diff';
import type { CoveragePolicy } from './receipt';

// EVIDENCE IDENTITY — what each seat could actually READ, as a first-class part of the
// review's policy identity. Two classes today:
//
//   packet   — the seat saw the bounded prompt packet (diff + conventions). The v1 default.
//   worktree — the seat additionally had read access to a detached worktree of the PR head,
//              under a deny-by-default sandbox (spec §2: a seat gets the worktree IFF it
//              runs under a repo-rooted, secret-denied sandbox).
//
// Two properties this module exists to make MECHANICAL rather than asserted:
//
//  1. The GATE IS AN EVIDENCE-BEARING ACTOR (gate-r3 pin 1). It reads cited hunks and, in
//     worktree mode, the referenced files — so it is a seat in BOTH maps, with its own
//     sandbox profile. A packet-fed gate structurally cannot tell "this reference does not
//     exist at headSha" from "the cited hunk was truncated out of my window", which is why
//     `reference-not-found` may only be emitted when the gate's REALIZED evidence is worktree.
//
//  2. Evidence assignment is PER SEAT and INTENT ≠ FACT. §2 permits per-seat fail-closed
//     fallback at runtime (a seat whose sandbox can't be established keeps the packet), so a
//     receipt records the INTENDED map (policy) and the REALIZED map (fact) separately. A
//     degraded mixed run is never receipt-equivalent to a full-worktree run.

export const EVIDENCE_CLASSES = ['packet', 'worktree'] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];

// Every actor whose evidence class is part of the identity — INCLUDING the gate.
export const EVIDENCE_SEATS = ['codex', 'grok', 'claude', 'gate'] as const;
export type EvidenceSeat = (typeof EVIDENCE_SEATS)[number];

export function isEvidenceSeat(v: unknown): v is EvidenceSeat {
  return (EVIDENCE_SEATS as readonly string[]).includes(v as string);
}

export function isEvidenceClass(v: unknown): v is EvidenceClass {
  return (EVIDENCE_CLASSES as readonly string[]).includes(v as string);
}

// A per-seat evidence map. PARTIAL by construction — a seat absent from the map did not run
// (`--no-claude`, a `--reviewers` subset). Absence is NOT "packet"; see evidenceShortfall.
export type EvidenceMap = Partial<Record<EvidenceSeat, EvidenceClass>>;

// The identity of the sandbox a worktree seat ran under. `version` is bumped by the profile's
// own authors whenever its rules change, so a receipt minted under a weaker profile can never
// verify as equivalent to one minted under the current, tighter profile.
export interface SandboxProfileRef {
  id: string;
  version: number;
}

export type SandboxProfileMap = Partial<Record<EvidenceSeat, SandboxProfileRef>>;

// Evidence strength, for the realized-vs-intended comparison.
//
// A seat MISSING from the realized map is `unknown` — a receipt issued before evidence identity
// existed. What is the honest reading? Such a receipt PROVABLY had packet evidence: the packet is
// all that existed, and a receipt is only ever written after every required reviewer completed.
// So `unknown` is exactly as strong as `packet`, and strictly weaker than `worktree`. That is
// what gate-r3 pin 2 asks for — an absent realized map fails "only when the caller requests
// worktree evidence" — and treating unknown as weaker than EVERYTHING would break the engine
// against its own receipts: an all-packet run mints a v1 receipt with no realized map (see
// buildDiffReceipt), which a caller verifying with an explicit `{codex: 'packet'}` intent would
// then reject as `evidence-degraded`. The gap still REPORTS `unknown`, so the message never
// pretends to know a class the receipt did not record.
const STRENGTH: Record<EvidenceClass, number> = { packet: 1, worktree: 2 };
const UNKNOWN_STRENGTH = STRENGTH.packet;

function strengthOf(c: EvidenceClass | undefined): number {
  return c ? STRENGTH[c] : UNKNOWN_STRENGTH;
}

// ── Versioned policy identity ─────────────────────────────────────────────────────────

// The schema of the inputs hashed into `policyHash`. VERSIONED, not asserted-stable
// (gate-r3 pin 2 · spec §8): `computePolicyHash` is recomputed LIVE at verify time, so growing
// its inputs unconditionally would silently stale every receipt on disk — the re-review wave
// the spec forbids. Instead the receipt records the version it was ISSUED under and the
// verifier computes the comparison hash under THAT version.
//
//   v1 (legacy) — { coveragePolicy, diffMode, reviewerPolicy }. Byte-for-byte what shipped
//                 before evidence identity existed. Every receipt on disk today is a v1.
//   v2          — v1 + { intendedEvidence, sandboxProfiles, seatSet }.
//
// A run whose seats are ALL packet-evidenced hashes under v1, so the packet path is
// byte-compatible: worktree mode OFF changes no receipt identity anywhere.
export const POLICY_VERSION_LEGACY = 1;
export const POLICY_VERSION_EVIDENCE = 2;
export const POLICY_VERSIONS = [POLICY_VERSION_LEGACY, POLICY_VERSION_EVIDENCE] as const;

// A type predicate, like its siblings isEvidenceSeat/isEvidenceClass — so a caller narrows
// instead of casting.
export function isPolicyVersion(v: unknown): v is (typeof POLICY_VERSIONS)[number] {
  return (POLICY_VERSIONS as readonly unknown[]).includes(v);
}

// A receipt with no `policyVersion` field was issued before evidence identity existed → v1.
export function receiptPolicyVersion(v: unknown): number {
  return isPolicyVersion(v) ? v : POLICY_VERSION_LEGACY;
}

// The version a CALLER's intent implies. Any worktree seat ⇒ v2; an all-packet run stays v1 so
// its receipts keep verifying under the identity they were minted with.
export function resolvePolicyVersion(intended: EvidenceMap): number {
  return Object.values(intended).some((c) => c === 'worktree')
    ? POLICY_VERSION_EVIDENCE
    : POLICY_VERSION_LEGACY;
}

// Canonicalize a partial seat-keyed map: sorted keys, absent seats omitted. Sorting is what
// makes the hash independent of insertion order.
function canonicalMap<T>(m: Partial<Record<EvidenceSeat, T>>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const seat of [...EVIDENCE_SEATS].sort()) {
    const v = m[seat];
    if (v !== undefined) out[seat] = v;
  }
  return out;
}

export interface PolicyHashInputs {
  coveragePolicy: CoveragePolicy;
  diffMode: DiffMode;
  // v2 only — omitted from the v1 preimage entirely (not hashed as `undefined`).
  intendedEvidence?: EvidenceMap;
  reviewerPolicy: string[];
  sandboxProfiles?: SandboxProfileMap;
}

// THE VERSIONED HASHER. `version` selects the PREIMAGE — never a "same inputs, new salt" bump.
// v1's preimage is reproduced EXACTLY (same key order, same fields) so a v1 hash computed today
// equals one computed by the pre-evidence code. Pinned by a contract test (gate-r3 pin 2).
export function computePolicyHashAt(
  inputs: PolicyHashInputs,
  version: number
): string {
  if (version === POLICY_VERSION_LEGACY) {
    const canonical = JSON.stringify({
      coveragePolicy: inputs.coveragePolicy,
      diffMode: inputs.diffMode,
      reviewerPolicy: [...inputs.reviewerPolicy].sort(),
    });
    return `sha256:${sha256Hex(canonical)}`;
  }
  if (version !== POLICY_VERSION_EVIDENCE) {
    throw new Error(
      `ensemble-ai: unknown policyVersion ${version} — cannot compute a policy hash under a schema this build does not define`
    );
  }
  const intendedEvidence = canonicalMap(inputs.intendedEvidence ?? {});
  const canonical = JSON.stringify({
    coveragePolicy: inputs.coveragePolicy,
    diffMode: inputs.diffMode,
    intendedEvidence,
    policyVersion: POLICY_VERSION_EVIDENCE,
    reviewerPolicy: [...inputs.reviewerPolicy].sort(),
    sandboxProfiles: canonicalMap(inputs.sandboxProfiles ?? {}),
    // Redundant with intendedEvidence's keys, but part of the FROZEN v2 preimage: once a v2
    // receipt exists on disk its hash cannot be renegotiated. canonicalMap already sorts.
    seatSet: Object.keys(intendedEvidence),
  });
  return `sha256:${sha256Hex(canonical)}`;
}

// ── Realized-vs-intended comparison (the teeth of `receipt verify`, and the run-time
//    fail-closed check: a seat whose realized class is weaker than intent fell back) ────

export interface EvidenceGap {
  intended: EvidenceClass;
  // 'unknown' when the receipt carries no realized class for this seat (a legacy receipt).
  realized: EvidenceClass | 'unknown';
  seat: EvidenceSeat;
}

// Which seats did the review REALIZE more weakly than the caller now INTENDS? Empty = the
// receipt's evidence is at least as strong as the request. Only seats the caller actually
// asks for are compared: a receipt that ALSO ran a seat the caller doesn't want is not weaker.
export function evidenceShortfall(
  intended: EvidenceMap,
  realized: EvidenceMap | undefined
): EvidenceGap[] {
  const gaps: EvidenceGap[] = [];
  for (const seat of EVIDENCE_SEATS) {
    const want = intended[seat];
    if (!want) continue;
    const got = realized?.[seat];
    if (strengthOf(got) < strengthOf(want)) {
      gaps.push({ intended: want, realized: got ?? 'unknown', seat });
    }
  }
  return gaps;
}

// The LEGIBLE, ACTIONABLE failure line (gate-r3 pin 2: "name the weaker seat, point at the
// flag" — never a mystery miss).
export function formatEvidenceShortfall(gaps: EvidenceGap[]): string {
  const named = gaps
    .map((g) => `${g.seat} realized ${g.realized}, intended ${g.intended}`)
    .join('; ');
  return `evidence degraded — ${named}. This receipt does not prove the worktree-evidence review you are asking for. Re-run the review with the repo location, or pass --accept-degraded to accept the weaker evidence.`;
}
