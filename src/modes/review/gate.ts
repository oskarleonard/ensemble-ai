import { writeTrailFile } from '../../core/artifacts';
import { evidenceRef, extractJsonBlock } from '../../core/findings';
import { SEVERITIES, type Severity } from '../../core/types';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';
import { type RunReviewOpts } from '../../reviewers/codex';

import { isUsageLimitFailure } from './claude';
import type { EvidenceClass } from './evidence';
import { type ClusterInfo, clusterPostable } from './gate-dedup';
import { renderGatePrompt } from './gate-prompt';
import {
  type Hunk,
  type ResolvedHunk,
  hunkCodeLines,
  hunkRangeKey,
  parsePacketHunks,
  readGatePacket,
  resolveFindingHunk,
  windowHunk,
} from './gate-hunks';
import {
  type FixStatus,
  type PostableClass,
  type PostableOp,
  type PostableStatus,
  type PostableSuggestion,
  derivePostable,
  parseFixStatus,
  parsePostableClass,
  parsePostableOps,
  parseSeverity,
  parseSuggestion,
} from './gate-postable';
import {
  type ConventionCitation,
  type HolisticEntry,
  type HolisticPolicyDeps,
  type HolisticProvenance,
  type HolisticSite,
  applyHolisticPolicy,
  capHolisticSeverity,
  holisticCapWasLifted,
  isHolisticRecord,
  parseConventionCitation,
  parseHolisticSites,
} from './holistic-gate';
import {
  fallbackReviewSynthesis,
  parseAgreements,
  parseDisagreements,
  reconcileSynthesis,
  type ReviewSynthesis,
  type VoiceReview,
} from './synthesis';

// The VERIFIED GATE — the (renamed) synthesis pass with grounded, per-finding verdict TAGS.
// It is fed each finding's CITED diff hunk from the pinned packet, tags EVERY finding
// agree/partial/false/unverified (never removes one), records a durable schema-versioned
// `gate-verdicts.json` trail (raw model verdict + host EFFECTIVE verdict + a machine-readable
// downgrade reason), and renders the tags to stdout. Phase 2 adds the DISMISS-ONLY exit authority
// below (`gateAuthorityActive` · `resolveHighGate`, consumed by cli.ts): under active authority a
// citation-validated `false` on a HIGH may drop it from the exit-4 gate — dismiss-only, never a
// promotion, and every host-forced downgrade still gates.
// Everything here is a pure function of its inputs except runGate's spawn + the trail write.

// The verdict taxonomy that replaces likely-real/look-closer/likely-false. `agree` = real;
// `partial` = real but overstated; `false` = a refuted finding (a dismissal — REQUIRES a
// grounded citation); `unverified` = the gate could not ground it (the safe default — an
// unverified HIGH still gates).
export const GATE_VERDICTS = ['agree', 'partial', 'false', 'unverified'] as const;
export type GateVerdict = (typeof GATE_VERDICTS)[number];
export function isGateVerdict(v: unknown): v is GateVerdict {
  return (GATE_VERDICTS as readonly string[]).includes(v as string);
}

// Why a host EFFECTIVE verdict differs from the raw model verdict — machine-readable so the
// trail can be retro-scored (codex-f3 / constraint #1) and a downgraded dismissal is never
// confused with a genuine `unverified`.
export const DOWNGRADE_REASONS = [
  'truncated', // the cited hunk hit the per-finding window or the byte budget → dismissal-ineligible
  'invalid-citation', // a `false` whose citation is missing / out-of-hunk / under-anchor
  'duplicate', // >1 verdict for one findingId → all discarded
  'missing', // no verdict returned for this finding
  'bad-enum', // an unrecognized verdict string
  'packet-fail', // the pinned packet was missing / corrupt / head-SHA-mismatched
  'gate-failed', // the gate spawn errored / timed out / produced unparseable output
  'unknown-schema', // a missing / unsupported envelope schemaVersion (fail-closed)
  'trail-write-failed', // gate-verdicts.json did not durably write → dismissals not honored
  // ADDITIVE (spec §5, ruled 2026-07-09): the gate could not locate what the finding REFERENCES
  // at headSha — a hallucinated reference, a red flag distinct from "I couldn't see far enough".
  // Emitted ONLY when the gate's REALIZED evidence is `worktree` (gate-r3 pin 1): a packet-fed
  // gate sees ±25-line hunks, so it structurally cannot tell "this does not exist" from
  // `truncated`, and asserting the stronger cause on weaker evidence would be a lie.
  'reference-not-found',
  // ADDITIVE (premise provenance, 2026-08-25): the gate sent "agree" while ALSO flagging the
  // finding's load-bearing premise as an EXTERNAL system's runtime behavior supported only by
  // in-repo TESTIMONY (a comment / doc / type-escape test fixture). A confirmed-as-fact verdict
  // cannot rest on testimony — the agree fails closed to unverified so the claim never posts as
  // fact. Proven on a live run: a stale repo comment ("the backend emits free-text labels")
  // corroborated by an `as never` fixture led the gate to confirm a finding the backend's own
  // contract (a closed DB/API enum) refutes.
  'external-testimony',
] as const;
export type DowngradeReason = (typeof DOWNGRADE_REASONS)[number];

// What to tell an operator staring at an all-unverified run, per whole-envelope failure. These
// kill every verdict at once (rather than one finding's), so every record carries the same reason —
// which is what lets the renderer say something true instead of the capability-floor line below.
// They do NOT share a recovery, and getting that wrong wastes the operator's next move: a `regate`
// re-reads the SAME persisted packet, so it recovers a gate that came back empty and re-fails
// identically on a packet that was unusable.
const WHOLE_ENVELOPE_ADVICE: Partial<Record<DowngradeReason, string>> = {
  'gate-failed':
    '  the gate never returned usable output — nothing here was ground-checked; re-run it (`regate`) before trusting or dismissing any finding',
  'packet-fail':
    '  the pinned packet was unusable, so nothing could be ground-checked — a `regate` reads that same packet and fails the same way; re-run the REVIEW to pin a fresh one',
  'unknown-schema':
    '  the gate replied under an envelope schema this engine does not recognize — nothing was ground-checked; a `regate` may recover a one-off, otherwise the engine and the gate prompt have drifted apart',
};

// The capability-floor signal this line was originally written for: the gate DID reason, and could
// still ground nothing (a weak gate model mostly yields unverified).
const TOOTHLESS_GATE_ADVICE = '  gate teeth did not engage — consider a stronger gate model';

// The composite envelope schema the gate prompt pins + the model must echo. A missing /
// different value fails the whole envelope closed (all-`unverified`) — the host never
// interprets verdicts under semantics it doesn't recognize.
export const GATE_ENVELOPE_SCHEMA_VERSION = 1;
// The durable trail-artifact schema. Bumped independently if the record shape changes.
// v2: adds the postable-text fields (postableBody / postableFix / rescoredSeverity /
// postableStatus) the LLM-free posting step consumes — see gate-postable.ts.
// v3: adds the PLACEMENT fields (postableClass / postableSuggestion) the staged-review tail
// consumes — where a finding lands (inline vs the collapsed quality section) and the gate-verified
// one-click replacement, both decided HERE so the posting path never runs a model. Additive: a v2
// reader that ignores unknown keys reads a v3 record unchanged.
// v4: adds `anchorSide` — WHICH line space the cite resolved in. A deletion-only hunk resolves on
// the OLD side, so its line number names a line that exists only on the diff's LEFT; posting it as
// a RIGHT anchor is a 422 that fails the whole staged review. Additive, same as v3.
// v5: adds `tldr` — additive, same contract as v3/v4. A v4 reader that ignores unknown keys reads a
// v5 record unchanged, and a v4 trail read by a v5 consumer simply has no `tldr` (⇒ null). NOTHING
// in this engine reads a trail's schemaVersion back — writeGateVerdictsTrail is the only toucher,
// and a regate REWRITES the file from a fresh gate run rather than loading the old one — so every
// bump is a CONSUMER contract: a host reading gate-verdicts.json must accept 4 and 5 alike (and
// treat an absent `tldr` as null), never equality-check against the current constant.
// v6: adds `settlement` — the EXECUTION SETTLER's verdict-by-running for a finding the gate tagged
// `execution-decidable:` (settler.ts). Additive like v5; absent on every record the settler did not
// touch, and on every run where it did not fire. NOTE: a regate rewrites this trail from a fresh
// gate run, so settlements are dropped by a regate (the settler runs in the full pipeline only).
// v7: adds `verifyRequested` — the gate's opt-in ask to upgrade a CONFIRMED finding to an executed
// receipt (honored by the settler under --verify-confirmed). Additive, same contract as v5/v6.
// v8: adds `duplicateOf` / `duplicates` — the gate's mechanized cross-reviewer duplicate pointer
// and the host-threaded echoes it produces. Additive like v5/v6/v7: absent everywhere the gate
// sent no pointer. Exists because prose dedup ("same defect as X, post it once there") silently
// sheds the duplicate's framing — proven on a real run where the duplicate held the ONE sentence
// naming the dangerous direction of a half-open guard, and triage read only the survivor.
// v9: adds `premise` — the gate's premise-provenance flag ('external-testimony'): the finding's
// load-bearing premise asserts an external system's runtime behavior and its only support is
// in-repo testimony (comments/docs/type-escape fixtures). Additive like v5-v8: absent everywhere
// the gate sent no flag. An "agree" carrying it is host-downgraded to unverified under
// downgradeReason 'external-testimony' so testimony never posts as fact; on partial/unverified it
// is advisory — trail consumers should render the weaker premise class (e.g. an amber chip)
// instead of presenting the claim as ground truth.
export const GATE_TRAIL_SCHEMA_VERSION = 9;

const REASON_CAP = 700;
const CITATION_CAP = 500;
// The gate's plain-English summary of a confirmed finding. 280 chars is the CONTRACT (the prompt
// asks for ≤280), enforced here so a chatty model can't push an essay into the trail or onto a PR.
const TLDR_CAP = 280;
// Cap a display string to n chars. When it overflows, mark the cut with an ellipsis so a
// clipped value reads as deliberate rather than a mid-word glitch (the '…' counts toward n).
function capStr(s: unknown, n: number): string {
  const t = typeof s === 'string' ? s.trim() : '';
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

// ── The authoritative, host-owned finding set ─────────────────────────────────────────

// One finding as the HOST owns it — its stable cross-reviewer id, immutable severity, and
// its resolved+windowed cited hunk. Nothing the gate returns can alter these (exit keys off
// the STORED reviewer severity, never a gate echo).
// WHICH line space a cite resolved in. `new` ⇒ `line` names a line on the diff's RIGHT (added or
// context) and may be anchored there. `old` ⇒ the cite landed in a deletion-only hunk, so `line`
// names a line that exists only on the LEFT — real, citable, but NOT a RIGHT anchor. `null` ⇒ the
// cite resolved to no hunk at all. See resolveFindingHunk in gate-hunks.ts, whose second pass is
// exactly the old-side branch.
export type AnchorSide = 'new' | 'old' | null;

export interface GateFinding {
  // The line space `line` was resolved in — see AnchorSide. null when `resolved` is false.
  anchorSide: AnchorSide;
  body: string;
  file: string;
  findingId: string; // `${voiceId}#${n}` — unique across all three reviewers
  hunkCode: string[]; // normalized code lines of the FULL resolved hunk (citation basis; [] if unresolved)
  hunkLabel: string | null; // the injected-hunk label shown in the prompt (null: unresolved or budget-dropped)
  line: number | null;
  resolved: boolean; // a hunk was found for the cite
  reviewer: string; // voiceId
  severity: Severity;
  title: string;
  truncated: boolean; // window OR byte-budget truncation → dismissal-INELIGIBLE
}

// One deduped hunk injected into the gate prompt, labeled H1.. in budget order.
export interface GateInjection {
  label: string;
  rangeKey: string;
  text: string;
  truncated: boolean;
}

// The total UTF-8 byte budget for injected hunk text in ONE gate prompt. Bounds token cost;
// over-budget hunks are NAMED as truncated (never silently dropped) and their findings are
// dismissal-ineligible — a known, safe, host-enforced degradation at high finding counts.
export const GATE_HUNK_BYTE_BUDGET = 40_960;

interface RawFinding {
  body: string;
  file: string;
  findingId: string;
  index: number;
  line: number | null;
  reviewerRank: number;
  reviewer: string;
  severity: Severity;
  title: string;
}

// Flatten the three reviewers' findings into the host-owned set with stable `voiceId#n` ids.
function flattenFindings(reviews: VoiceReview[]): RawFinding[] {
  const out: RawFinding[] = [];
  reviews.forEach((r, reviewerRank) => {
    r.findings.forEach((f, i) => {
      out.push({
        body: f.body,
        file: f.evidence.file ?? '',
        findingId: `${r.voiceId}#${i + 1}`,
        index: i,
        line: f.evidence.line ?? null,
        reviewer: r.voiceId,
        reviewerRank,
        severity: f.severity,
        title: f.title,
      });
    });
  });
  return out;
}

// Assemble the authoritative GateFindings + the deduped, budgeted injection list. Allocation
// is DETERMINISTIC: severity-first (HIGH → MED → LOW — HIGHs are the only exit-relevant
// dismissals), then reviewer rank, then finding index; identical (file, hunk-range) hunks are
// injected once (charged once); each hunk is windowed to ±25 lines; the first hunk always
// fits, thereafter a hunk that would exceed the byte budget is NAMED-truncated (its finding
// dismissal-ineligible). Reads ONLY the passed packet hunks — never the working tree.
export function prepareGateFindings(
  reviews: VoiceReview[],
  packetHunks: Map<string, Hunk[]>
): { findings: GateFinding[]; injections: GateInjection[] } {
  const raw = flattenFindings(reviews);
  const resolved = new Map<string, ResolvedHunk | null>();
  for (const rf of raw) {
    const fileHunks = rf.file && rf.line !== null ? packetHunks.get(rf.file) : undefined;
    resolved.set(
      rf.findingId,
      fileHunks && rf.line !== null ? resolveFindingHunk(fileHunks, rf.line) : null
    );
  }

  // Budget order: severity → reviewer rank → finding index (stable).
  const order = [...raw].sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      a.reviewerRank - b.reviewerRank ||
      a.index - b.index
  );

  const injections: GateInjection[] = [];
  const byKey = new Map<string, GateInjection & { admitted: boolean }>();
  const truncatedById = new Set<string>();
  const labelById = new Map<string, string | null>();
  let usedBytes = 0;
  for (const rf of order) {
    const res = resolved.get(rf.findingId) ?? null;
    if (!res) {
      labelById.set(rf.findingId, null);
      continue;
    }
    const key = hunkRangeKey(rf.file, res.hunk);
    const existing = byKey.get(key);
    if (existing) {
      if (existing.truncated || !existing.admitted) truncatedById.add(rf.findingId);
      labelById.set(rf.findingId, existing.admitted ? existing.label : null);
      continue;
    }
    const win = windowHunk(res.hunk, res.bodyIndex);
    const bytes = Buffer.byteLength(win.text, 'utf8');
    // The first admitted hunk always goes in (mirrors coverage's includedBytes>0 rule) so a
    // lone over-budget hunk is still shown; subsequent over-budget hunks are truncated out.
    const admitted = injections.length === 0 || usedBytes + bytes <= GATE_HUNK_BYTE_BUDGET;
    const label = admitted ? `H${injections.length + 1}` : '';
    const injection: GateInjection = { label, rangeKey: key, text: win.text, truncated: win.truncated };
    byKey.set(key, { ...injection, admitted });
    if (admitted) {
      usedBytes += bytes;
      injections.push(injection);
      labelById.set(rf.findingId, label);
      if (win.truncated) truncatedById.add(rf.findingId);
    } else {
      labelById.set(rf.findingId, null);
      truncatedById.add(rf.findingId); // budget-dropped → dismissal-ineligible
    }
  }

  const findings: GateFinding[] = raw.map((rf) => {
    const res = resolved.get(rf.findingId) ?? null;
    return {
      // resolveFindingHunk matches the new side first and only falls to the old side for a
      // deletion-only hunk (newCount === 0), so the hunk's own newCount names the side.
      anchorSide: res ? (res.hunk.newCount > 0 ? 'new' : 'old') : null,
      body: rf.body,
      file: rf.file,
      findingId: rf.findingId,
      hunkCode: res ? hunkCodeLines(res.hunk) : [],
      hunkLabel: labelById.get(rf.findingId) ?? null,
      line: rf.line,
      resolved: res !== null,
      reviewer: rf.reviewer,
      severity: rf.severity,
      title: rf.title,
      truncated: truncatedById.has(rf.findingId),
    };
  });
  return { findings, injections };
}

// ── Grounded-citation validation ──────────────────────────────────────────────────────

// A `false` dismissal must QUOTE the finding's own cited hunk — proof the gate read the
// disputed code. Validated by whitespace-normalized substring match against ONLY the pinned
// packet's hunk (own-hunk-scoped, never the repo), with a deterministic MINIMUM-ANCHOR
// predicate: the citation must contain at least one COMPLETE hunk code line that (a) has ≥16
// non-whitespace chars AND (b) occurs exactly once within that hunk. `}`-only / short idiom
// lines fail (a); repeated boilerplate fails (b). The match GROUNDS the dismissal in read
// code — it does not prove falsity (the verdict stays the gate's judgment).
export const MIN_ANCHOR_NONWS = 16;

export function validateCitation(
  citation: string,
  hunkCode: string[]
): { reason?: string; valid: boolean } {
  const normCite = citation.replace(/\s+/g, ' ').trim();
  if (!normCite) return { reason: 'empty citation', valid: false };
  const counts = new Map<string, number>();
  for (const l of hunkCode) counts.set(l, (counts.get(l) ?? 0) + 1);
  for (const l of hunkCode) {
    if (l.replace(/\s/g, '').length < MIN_ANCHOR_NONWS) continue; // (a) substantial
    if (counts.get(l) !== 1) continue; // (b) unique within the hunk
    if (normCite.includes(l)) return { valid: true };
  }
  return {
    reason: 'citation contains no unique ≥16-non-whitespace-char line from the finding\'s own hunk',
    valid: false,
  };
}

// ── Envelope parse ────────────────────────────────────────────────────────────────────

export interface RawVerdictEntry {
  // The gate's stated CAUSE for an `unverified`. Only 'reference-not-found' is meaningful today;
  // the host honors it solely on worktree evidence (see reconcileGateVerdicts).
  cause?: string;
  citation?: string;
  // Honored on `unverified` only: this finding describes the SAME defect as another reviewer's
  // finding (typically because this one's hunk is unavailable while the other's is shown). The
  // host validates the pointer and threads this finding's claim onto the primary's record.
  duplicateOf?: string;
  // Where this finding may land on a foreign PR: `bug` (inline) or `quality` (collapsed section).
  // Absent / unrecognized ⇒ the host defaults to `bug`.
  class?: PostableClass;
  // HOLISTIC-lens verdicts only (spec §4): the conventions-doc citation that may lift the MED
  // severity cap, and the two sites an `agree` must quote. Both are re-verified against the tree
  // at headSha by the HOST (holistic-gate.ts) — the model's say-so grounds nothing.
  conventionCitation?: ConventionCitation;
  findingId: string;
  fixStatus?: FixStatus; // disposition the gate assigned the reviewer's suggested fix
  ops?: PostableOp[]; // minimal edit-ops narrowing the body (partial only)
  reason: string;
  rescoredSeverity?: Severity; // gate's down-scored severity (host clamps: never higher)
  // A gate-verified small replacement for the finding's own cited line (agree + fixStatus keep).
  suggestion?: PostableSuggestion;
  sites?: HolisticSite[]; // holistic only — the reinvention in the diff + the pattern's home
  // Premise-provenance flag: the finding's load-bearing premise is an EXTERNAL-system runtime
  // claim whose only support is in-repo testimony (a comment / doc / type-escape fixture). Only
  // the literal 'external-testimony' is honored. Carried on partial/unverified; an "agree"
  // bearing it is host-downgraded (see reconcileGateVerdicts).
  premise?: string;
  // The plain-English, user-visible summary of a CONFIRMED finding (agree/partial). Asked for at
  // ≤280 chars; host-capped. Absent ⇒ the model omitted it, which never invalidates the verdict.
  tldr?: string;
  verdict: unknown;
  // Optional gate request: upgrade this CONFIRMED finding to an executed receipt (the settler
  // runs it under --verify-confirmed). Only the literal 'run' is honored.
  verify?: string;
}

export interface ParsedGateEnvelope {
  agreements: ReturnType<typeof parseAgreements>;
  bottomLine: string;
  disagreements: ReturnType<typeof parseDisagreements>;
  verdicts: RawVerdictEntry[];
}

export type EnvelopeFailure = { failure: 'gate-failed' | 'unknown-schema' };

// Every way the WHOLE envelope fails closed — the parse-time EnvelopeFailure plus the
// runtime-only `packet-fail`. Each member is a DowngradeReason stamped on every finding.
export type WholeEnvelopeFailure = {
  failure: Extract<DowngradeReason, 'gate-failed' | 'unknown-schema' | 'packet-fail'>;
};

function parseVerdicts(v: unknown): RawVerdictEntry[] {
  if (!Array.isArray(v)) return [];
  const out: RawVerdictEntry[] = [];
  for (const rv of v) {
    if (!rv || typeof rv !== 'object') continue;
    const e = rv as Record<string, unknown>;
    const findingId = typeof e.findingId === 'string' ? e.findingId.trim() : '';
    if (!findingId) continue;
    const ops = parsePostableOps(e.ops);
    const fixStatus = parseFixStatus(e.fixStatus);
    const rescoredSeverity = parseSeverity(e.rescoredSeverity);
    const postableClass = parsePostableClass(e.class);
    const suggestion = parseSuggestion(e.suggestion);
    const sites = parseHolisticSites(e.sites);
    const conventionCitation = parseConventionCitation(e.conventionCitation);
    const tldr = capStr(e.tldr, TLDR_CAP);
    out.push({
      citation: typeof e.citation === 'string' ? capStr(e.citation, CITATION_CAP) : undefined,
      findingId,
      reason: capStr(e.reason, REASON_CAP),
      verdict: e.verdict,
      // conditional so an old-shape (no-ops) entry parses to the exact prior shape
      ...(ops.length ? { ops } : {}),
      ...(typeof e.cause === 'string' && e.cause.trim() ? { cause: e.cause.trim() } : {}),
      ...(typeof e.duplicateOf === 'string' && e.duplicateOf.trim()
        ? { duplicateOf: e.duplicateOf.trim() }
        : {}),
      ...(postableClass ? { class: postableClass } : {}),
      ...(fixStatus ? { fixStatus } : {}),
      ...(rescoredSeverity ? { rescoredSeverity } : {}),
      ...(suggestion ? { suggestion } : {}),
      ...(conventionCitation ? { conventionCitation } : {}),
      ...(sites ? { sites } : {}),
      ...(tldr ? { tldr } : {}),
      ...(e.verify === 'run' ? { verify: 'run' } : {}),
      // Only the literal value is honored — an unrecognized premise class parses to absent, so a
      // creative model cannot mint new provenance semantics the host has never reasoned about.
      ...(e.premise === 'external-testimony' ? { premise: 'external-testimony' } : {}),
    });
  }
  return out;
}

// Parse the composite envelope. Unparseable ⇒ gate-failed; a missing / unsupported
// schemaVersion ⇒ unknown-schema (constraint #2) — both degrade the WHOLE envelope closed.
export function parseGateEnvelope(raw: string): EnvelopeFailure | ParsedGateEnvelope {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== 'object') return { failure: 'gate-failed' };
  const o = obj as Record<string, unknown>;
  if (o.schemaVersion !== GATE_ENVELOPE_SCHEMA_VERSION) return { failure: 'unknown-schema' };
  const synth =
    o.synthesis && typeof o.synthesis === 'object'
      ? (o.synthesis as Record<string, unknown>)
      : {};
  return {
    agreements: parseAgreements(synth.agreements),
    bottomLine: capStr(synth.bottomLine, 1000),
    disagreements: parseDisagreements(synth.disagreements),
    verdicts: parseVerdicts(o.verdicts),
  };
}

// ── Host-owned reconciliation → the durable records ───────────────────────────────────

// The EXECUTION SETTLER's verdict for one finding — a verdict-by-RUNNING, never by reading
// (settler.ts owns the seat; this type lives here because GateVerdictRecord carries it and the
// settler already imports the record type — the reverse import would be a cycle).
export const SETTLEMENT_OUTCOMES = ['confirmed', 'refuted', 'inconclusive'] as const;
export type SettlementOutcome = (typeof SETTLEMENT_OUTCOMES)[number];
export interface SettlementRecord {
  // The decisive command, verbatim — enough for a human to re-run the experiment.
  command: string;
  findingId: string;
  outcome: SettlementOutcome;
  // One line: what the experiment showed (or why none was possible, on inconclusive).
  reason: string;
  // The trimmed DECISIVE output lines the verdict rests on.
  receipt: string;
}

// A duplicate finding's claim, threaded onto its primary (trail v8). Carries the duplicate's
// host-owned attribution plus its UNTRUSTED reviewer text — triage/trail context ONLY, never
// posted. Exists so the posted survivor cannot silently shed a sharper framing: two reviewers
// describing one defect routinely emphasize different halves of it, and the half that names the
// dangerous direction may live in the finding the gate deferred.
export interface DuplicateEcho {
  claim: string; // the duplicate's reviewer body, capped — data for the human, never PR text
  findingId: string;
  reviewer: string;
  severity: Severity;
  title: string;
}

export interface GateVerdictRecord {
  // The line space `line` resolved in (see AnchorSide). Only `new` may be anchored as an inline
  // RIGHT comment; `old` names a deleted line, which GitHub rejects on the RIGHT.
  anchorSide: AnchorSide;
  citation?: string;
  cluster?: ClusterInfo; // cross-reviewer cluster (postable records only); absent ⇒ singleton / not clustered
  downgradeReason: DowngradeReason | null;
  // Trail v8 (additive): set on an UNVERIFIED record the gate pointed at another reviewer's
  // finding as the same defect. Host-validated: the id exists and differs from this record's.
  duplicateOf?: string;
  // Trail v8 (additive): the claims of every finding the gate marked a duplicate of THIS one,
  // sorted by findingId. Read by trail consumers and triage; the posting path never touches it.
  duplicates?: DuplicateEcho[];
  effectiveVerdict: GateVerdict;
  file: string;
  findingId: string;
  // HOLISTIC-lens records only: single-seat provenance + what the host verified (the MED cap it
  // applied, the conventions citation that lifted it, the two sites it located at headSha).
  // Additive + optional — a v2 consumer reads these records exactly as before.
  holistic?: HolisticProvenance;
  line: number | null;
  postableBody: string | null; // EXACT text to post (verbatim for agree, narrowed for partial); null ⇒ do not post
  // Where this finding lands on a foreign PR (spec §6). null ⇒ not postable. Decided by the gate,
  // defaulted to `bug` — the posting path reads it and never re-judges.
  postableClass: PostableClass | null;
  postableFix: FixStatus | null; // disposition of the reviewer's suggested fix
  postableNote?: string; // escalation / audit note when postableStatus is 'escalated'
  postableStatus: PostableStatus; // postable | escalated (couldn't safely narrow) | not-postable (false/unverified)
  // A gate-verified one-click replacement for `line`; null ⇒ none. The per-review CAP is applied
  // by the posting path (consumer config), not here.
  postableSuggestion: PostableSuggestion | null;
  // Trail v9 (additive): the gate's premise-provenance flag. Present when the finding's
  // load-bearing premise is an external-system runtime claim resting on in-repo testimony alone.
  // On what the gate sent as "agree" the host has already fail-closed the verdict (see
  // downgradeReason 'external-testimony'); on partial/unverified it is advisory — consumers
  // should surface the weaker premise class rather than presenting the claim as fact.
  premise?: 'external-testimony';
  rawVerdict: string | null; // exactly what the model returned (may be an invalid enum), null if none
  reason: string;
  rescoredSeverity: Severity | null; // gate's down-scored severity for a partial; null ⇒ unchanged
  // The execution settler's verdict-by-running (trail schema v6). Present ONLY on a finding the
  // gate tagged `execution-decidable:` that the settler then ran an experiment for. ADDITIVE and
  // ADVISORY: it never alters effectiveVerdict, posting, or the HIGH exit gate — the receipts are
  // for the operator, who decides. (A refuted HIGH therefore still gates; dismissal authority
  // stays citation-based.)
  settlement?: SettlementRecord;
  // Trail v7 (additive like v5/v6): the gate asked for this CONFIRMED finding to be upgraded to
  // an executed receipt. Honored by the settler only under --verify-confirmed (cost knob).
  verifyRequested?: boolean;
  // Did this finding's cite RESOLVE to a hunk of the reviewed diff? The posting path needs it: a
  // GitHub review comment on a line outside the diff is a 422 that fails the whole staged review,
  // so only a resolved cite may be anchored inline.
  resolved: boolean;
  reviewer: string;
  severity: Severity;
  title: string;
  // A LABELED ADDITIVE summary of a confirmed finding, in plain conversational English: what the
  // user hits + the suggested fix. Generated by the GATE at grounding time — the same seat that
  // verified the finding — so it ships inside the verified trail and no downstream step ever runs a
  // model over the postable text. Hosts post it as its own `TLDR:` line ALONGSIDE the grounded
  // body; it never replaces or rewords it. null ⇒ not a confirmed verdict, or the gate omitted it
  // (a missing tldr never invalidates a verdict — trail schema v5; a v4 trail reads as null).
  tldr: string | null;
}

// A non-agree/partial finding never posts — false/unverified/downgraded all resolve here. The
// postable-text pass below overwrites these for the agree/partial pass-through only.
const NOT_POSTABLE = {
  postableBody: null,
  postableClass: null,
  postableFix: null,
  postableStatus: 'not-postable' as const,
  postableSuggestion: null,
  rescoredSeverity: null,
};

// The record BEFORE the postable-text pass — every reconcile branch builds one of these; the
// postable fields are attached once, afterward, so the branch logic stays untouched.
type BaseRecord = Omit<
  GateVerdictRecord,
  | 'postableBody'
  | 'postableClass'
  | 'postableFix'
  | 'postableNote'
  | 'postableStatus'
  | 'postableSuggestion'
  | 'rescoredSeverity'
  // Attached in the same pass as the postable fields: only a CONFIRMED verdict carries one, so the
  // per-entry branches below never have to think about it.
  | 'tldr'
>;

function recordBase(f: GateFinding): Omit<
  BaseRecord,
  'citation' | 'downgradeReason' | 'effectiveVerdict' | 'rawVerdict' | 'reason'
> {
  return {
    anchorSide: f.anchorSide,
    file: f.file,
    findingId: f.findingId,
    line: f.line,
    resolved: f.resolved,
    reviewer: f.reviewer,
    severity: f.severity,
    title: f.title,
  };
}

const FAILURE_REASON: Record<WholeEnvelopeFailure['failure'], string> = {
  'gate-failed': 'gate produced no usable verdicts — fail-closed to unverified',
  'packet-fail': 'pinned packet unavailable at gate time — verdicts cannot be grounded',
  'unknown-schema': 'gate envelope had a missing/unsupported schemaVersion — fail-closed',
};

// Reconcile the parsed envelope against the authoritative finding set — the HOST owns ids,
// reviewer attribution, and severity; nothing the gate returns can alter them. Per-entry
// policy: no entry ⇒ unverified(missing); duplicate ids ⇒ all discarded ⇒ unverified;
// unknown id ⇒ ignored+warned; bad enum ⇒ unverified; a truncated finding's `false` ⇒
// host-forced unverified(truncated) regardless of citation (constraint #3/#4 · DC12); a
// `false` ⇒ unverified unless its citation validates against its own hunk. A whole-envelope
// failure ⇒ every finding unverified with that machine-readable reason.
export function reconcileGateVerdicts(
  findings: GateFinding[],
  parsed: ParsedGateEnvelope | WholeEnvelopeFailure,
  // The gate's REALIZED evidence class. Defaults to 'packet' — the pre-worktree behavior.
  // `holistic` supplies the worktree-backed verification the lens's own guardrails need; absent
  // ⇒ any holistic record present is fail-closed (it cannot be verified against anything).
  opts: { gateEvidence?: EvidenceClass; holistic?: HolisticPolicyDeps } = {}
): { records: GateVerdictRecord[]; warnings: string[] } {
  const gateEvidence: EvidenceClass = opts.gateEvidence ?? 'packet';
  if ('failure' in parsed) {
    const reason = FAILURE_REASON[parsed.failure];
    return {
      // Nothing here is postable, but the lens's MED cap is a HOST guarantee on every path: a
      // failed gate must not leave the lens's own model-asserted `high` standing in the trail or
      // on stdout. The full policy cannot run — there are no verdict entries to read sites off.
      records: findings.map((f) =>
        capHolisticSeverity({
          ...recordBase(f),
          ...NOT_POSTABLE,
          downgradeReason: parsed.failure,
          effectiveVerdict: 'unverified',
          rawVerdict: null,
          reason,
          tldr: null, // no envelope ⇒ no confirmed verdict ⇒ nothing to summarize
        })
      ),
      warnings: [],
    };
  }

  const known = new Set(findings.map((f) => f.findingId));
  const byId = new Map<string, RawVerdictEntry[]>();
  const warnings: string[] = [];
  for (const v of parsed.verdicts) {
    if (!known.has(v.findingId)) {
      warnings.push(`gate: verdict for unknown findingId "${v.findingId}" ignored`);
      continue;
    }
    const list = byId.get(v.findingId) ?? [];
    list.push(v);
    byId.set(v.findingId, list);
  }

  const findingById = new Map(findings.map((f) => [f.findingId, f]));
  const baseRecords: BaseRecord[] = findings.map((f): BaseRecord => {
    const base = recordBase(f);
    const entries = byId.get(f.findingId) ?? [];
    if (entries.length === 0) {
      return { ...base, downgradeReason: 'missing', effectiveVerdict: 'unverified', rawVerdict: null, reason: 'no gate verdict returned for this finding' };
    }
    if (entries.length > 1) {
      return { ...base, downgradeReason: 'duplicate', effectiveVerdict: 'unverified', rawVerdict: null, reason: `gate returned ${entries.length} verdicts for this finding — all discarded` };
    }
    const e = entries[0];
    const rawVerdict = typeof e.verdict === 'string' ? e.verdict : null;
    if (!isGateVerdict(e.verdict)) {
      return { ...base, downgradeReason: 'bad-enum', effectiveVerdict: 'unverified', rawVerdict, reason: e.reason || 'gate returned an unrecognized verdict' };
    }
    const citation = e.citation;
    if (e.verdict === 'false') {
      // Truncation ineligibility is host-forced BEFORE citation — a dismissal on partial
      // context is never honored, regardless of what the gate cited (DC12).
      if (f.truncated) {
        return { ...base, citation, downgradeReason: 'truncated', effectiveVerdict: 'unverified', rawVerdict, reason: e.reason || 'cited hunk was truncated — dismissal ineligible' };
      }
      const cv = validateCitation(citation ?? '', f.hunkCode);
      if (!f.resolved || !cv.valid) {
        return { ...base, citation, downgradeReason: 'invalid-citation', effectiveVerdict: 'unverified', rawVerdict, reason: e.reason || cv.reason || 'no valid citation' };
      }
      return { ...base, citation, downgradeReason: null, effectiveVerdict: 'false', rawVerdict, reason: e.reason };
    }
    // PREMISE PROVENANCE (trail v9): "agree" asserts every material claim is grounded FACT, but
    // the gate itself flagged the load-bearing premise as in-repo TESTIMONY about an external
    // system — a contradiction the host resolves fail-closed, mirroring invalid-citation: the
    // verdict drops to unverified under its own machine-readable reason and never posts. On
    // partial/unverified the flag rides along as data (carried below); on a validated "false" it
    // is meaningless — the finding is dismissed regardless — so the false branch above ignores it.
    const premise = e.premise === 'external-testimony' ? ('external-testimony' as const) : undefined;
    if (premise && e.verdict === 'agree') {
      return {
        ...base,
        citation,
        downgradeReason: 'external-testimony',
        effectiveVerdict: 'unverified',
        premise,
        rawVerdict,
        reason: e.reason || 'confirmed on in-repo testimony about an external system — fail-closed to unverified',
      };
    }
    // `unverified` + an explicit `reference-not-found` cause: the gate says the thing this
    // finding POINTS AT does not exist at headSha. Honored ONLY on worktree evidence (gate-r3
    // pin 1). On a packet-fed gate the claim is unsound — the gate saw a ±25-line window, so
    // "not found" is indistinguishable from `truncated` — and it is DROPPED to a plain
    // unverified with a warning, never laundered into the stronger cause.
    if (e.verdict === 'unverified' && e.cause === 'reference-not-found') {
      if (gateEvidence === 'worktree') {
        return { ...base, citation, downgradeReason: 'reference-not-found', effectiveVerdict: 'unverified', rawVerdict, reason: e.reason || 'the gate could not locate what this finding references at headSha', ...(premise ? { premise } : {}) };
      }
      warnings.push(
        `gate: "reference-not-found" claimed for ${f.findingId} on PACKET evidence — dropped (a packet-fed gate cannot distinguish it from a truncated window)`
      );
    }
    // `duplicateOf` is honored on UNVERIFIED only — a defect the gate itself confirmed is not a
    // deferral — and only when the pointer names a DIFFERENT, known finding. An invalid pointer
    // degrades to a plain unverified with a warning: threading to a nonexistent primary would
    // fabricate provenance.
    let duplicateOf: string | undefined;
    if (typeof e.duplicateOf === 'string') {
      if (e.verdict === 'unverified' && known.has(e.duplicateOf) && e.duplicateOf !== f.findingId) {
        duplicateOf = e.duplicateOf;
      } else {
        warnings.push(
          `gate: "duplicateOf" on ${f.findingId} dropped — ${
            e.verdict !== 'unverified'
              ? 'only an unverified verdict may defer to a duplicate'
              : `"${e.duplicateOf}" is not a different, known findingId`
          }`
        );
      }
    }
    // agree / partial / unverified pass through — not dismissals, so truncation does not force them.
    return {
      ...base,
      citation,
      downgradeReason: null,
      effectiveVerdict: e.verdict,
      rawVerdict,
      reason: e.reason,
      ...(duplicateOf ? { duplicateOf } : {}),
      ...(premise ? { premise } : {}),
      // verify-by-run rides only a CONFIRMED verdict — a hedge on unverified is what the
      // execution-decidable tag is for, and honoring it here would blur the two channels.
      ...(e.verify === 'run' && (e.verdict === 'agree' || e.verdict === 'partial')
        ? { verifyRequested: true }
        : {}),
    };
  });

  // Postable-text pass: agree/partial derive their exact PR text (verbatim / narrowed) from the
  // reviewer body + the gate's ops; everything else is not-postable. One place → one source of
  // truth for what may cross to a PR.
  const postableRecords = baseRecords.map((r): GateVerdictRecord => {
    // false / unverified / every host-forced downgrade: not confirmed, so no TLDR is carried even
    // if the model volunteered one — a plain-English summary of a finding the host did NOT confirm
    // is exactly the un-grounded sentence this whole layer exists to keep off a PR.
    if (r.effectiveVerdict !== 'agree' && r.effectiveVerdict !== 'partial')
      return { ...r, ...NOT_POSTABLE, tldr: null };
    const f = findingById.get(r.findingId);
    const e = (byId.get(r.findingId) ?? [])[0];
    if (!f) return { ...r, ...NOT_POSTABLE, tldr: null };
    // A CONFIRMED verdict carries the gate's summary. Absent ⇒ null: the prompt asks for one on
    // every agree/partial, but a model that forgets it must never cost the verdict itself.
    const tldr = e?.tldr ?? null;
    const derived = derivePostable({
      body: f.body,
      fixStatus: e?.fixStatus,
      hunkCode: f.hunkCode,
      ops: e?.ops ?? [],
      rescoredSeverity: e?.rescoredSeverity,
      severity: f.severity,
      suggestion: e?.suggestion,
      verdict: r.effectiveVerdict,
    });
    // A finding that failed to derive postable text has no placement — `bug` would advertise an
    // inline comment for a body that will never be posted. The class is RE-VALIDATED here rather
    // than trusted off the entry: reconcile is exported and callable with a hand-built envelope, and
    // an unrecognized class must land on the loud default (`bug`), never leak through as itself.
    const postableClass: PostableClass | null =
      derived.postableStatus === 'postable' ? (parsePostableClass(e?.class) ?? 'bug') : null;
    return { ...r, ...derived, postableClass, tldr };
  });

  // The HOLISTIC pass (spec §4). Skipped ENTIRELY when the lens produced no findings, so the
  // default-off path — every packet-mode run — is byte-identical to before: same records, same
  // object identities, no branch taken. When the lens IS on, its records are the only ones this
  // touches: MED cap unless a conventions citation verifies, agree-only posting, both sites
  // located in the tree at headSha.
  const records = postableRecords.some(isHolisticRecord)
    ? applyHolisticPolicy(
        postableRecords,
        new Map<string, HolisticEntry | undefined>(
          findings.map((f) => [f.findingId, (byId.get(f.findingId) ?? [])[0]])
        ),
        opts.holistic ?? null
      )
    : postableRecords;
  return { records: threadDuplicateEchoes(records, findingById), warnings };
}

// The duplicate's threaded claim is trail/triage context, so it gets the same generous bound as
// the gate's own view of a body — enough that the sharper sentence is never the one cut.
const DUPLICATE_CLAIM_CAP = 1500;

// Thread each duplicate's claim onto the record it points at (trail v8), so a triager reading
// the primary sees the UNION of framings, not only the survivor's. Deterministic (echoes sorted
// by findingId); chains are NOT resolved — an echo lands exactly on the finding the gate named,
// even if that finding is itself a duplicate. No-op (same array identity) when the gate sent no
// pointers, so the default path is byte-identical to pre-v8.
function threadDuplicateEchoes(
  records: GateVerdictRecord[],
  findingById: Map<string, GateFinding>
): GateVerdictRecord[] {
  const echoesByPrimary = new Map<string, DuplicateEcho[]>();
  for (const r of records) {
    if (!r.duplicateOf) continue;
    const f = findingById.get(r.findingId);
    if (!f) continue;
    const list = echoesByPrimary.get(r.duplicateOf) ?? [];
    list.push({
      claim: capStr(f.body, DUPLICATE_CLAIM_CAP),
      findingId: r.findingId,
      reviewer: r.reviewer,
      severity: r.severity,
      title: r.title,
    });
    echoesByPrimary.set(r.duplicateOf, list);
  }
  if (echoesByPrimary.size === 0) return records;
  for (const list of echoesByPrimary.values())
    list.sort((a, b) => (a.findingId < b.findingId ? -1 : 1));
  return records.map((r) => {
    const duplicates = echoesByPrimary.get(r.findingId);
    return duplicates ? { ...r, duplicates } : r;
  });
}

// The dismissals the exit gate MAY honor (Phase 2 consumes this; Phase 1 only records +
// renders). A `false` counts ONLY for a HIGH AND ONLY after the trail durably wrote — a
// trail-write/finalize failure means dismissals are not honored (the audit trail the
// traceability goal rests on can never be skipped).
export function honoredHighDismissals(
  records: GateVerdictRecord[],
  trailWritten: boolean
): string[] {
  if (!trailWritten) return [];
  return records
    .filter((r) => r.severity === 'high' && r.effectiveVerdict === 'false' && !isHolisticRecord(r))
    .map((r) => r.findingId);
}

// ── Exit authority (Phase 2 — dismiss-only) ────────────────────────────────────────────

// Whether the gate's DISMISS-ONLY exit authority is IN EFFECT for this run. ON by default for
// LOCAL provenance (the diff is the cwd repo's own working-tree/--staged/branch state — the
// trusted self-review case this feature was ratified for); STRICT for FOREIGN provenance
// (--pr / URL / stdin / --diff-file) unless `--gate-dismissals` explicitly opts in; `--strict-high`
// forces STRICT everywhere. STRICT = the gate's verdicts stay advisory and EVERY HIGH gates
// (exactly today's behavior). Pure — the CLI resolves `localProvenance` from the diff source.
export interface GateAuthorityInputs {
  gateDismissals: boolean; // --gate-dismissals: opt FOREIGN provenance INTO authority
  localProvenance: boolean; // the diff is the cwd repo's own local state (trusted)
  strictHigh: boolean; // --strict-high: force STRICT anywhere
}

// The ONE precedence ladder both the boolean and the label derive from — strict-high wins, then
// local provenance is trusted-on, then foreign is on ONLY if explicitly opted in, else foreign is
// strict. Resolving it once means the exit decision and the user-facing "why" can never disagree
// (the label is the stdout explanation of that exact decision).
type GateAuthorityMode = 'strict-forced' | 'local-on' | 'foreign-opted-in' | 'foreign-strict';

function gateAuthorityMode(i: GateAuthorityInputs): GateAuthorityMode {
  if (i.strictHigh) return 'strict-forced'; // strict everywhere — no dismissals honored
  if (i.localProvenance) return 'local-on'; // trusted self-review — authority ON
  if (i.gateDismissals) return 'foreign-opted-in'; // foreign, explicitly opted in — authority ON
  return 'foreign-strict'; // foreign, not opted in — strict
}

export function gateAuthorityActive(i: GateAuthorityInputs): boolean {
  const mode = gateAuthorityMode(i);
  return mode === 'local-on' || mode === 'foreign-opted-in';
}

// A one-line human label for the resolved authority mode (stdout legibility).
export function gateAuthorityLabel(i: GateAuthorityInputs): string {
  switch (gateAuthorityMode(i)) {
    case 'strict-forced':
      return 'STRICT (--strict-high — every HIGH gates)';
    case 'local-on':
      return 'ON (local provenance — dismiss-only)';
    case 'foreign-opted-in':
      return 'ON (--gate-dismissals — foreign provenance opted in)';
    case 'foreign-strict':
      return 'STRICT (foreign provenance — every HIGH gates; pass --gate-dismissals to enable)';
  }
}

// The exit decision over HIGH findings: which HIGHs still GATE (force exit 4) vs which the gate
// HONORED-dismissed. Under STRICT authority EVERY HIGH gates (dismissed set empty). Under active
// authority a HIGH is dismissed ONLY when it is a citation-validated `false` AND the trail durably
// wrote (honoredHighDismissals). The Phase-1 host-forced downgrades — truncation-ineligible,
// invalid citation, packet/parse/schema failure, trail-write failure — never yield an
// effectiveVerdict `false`, so they can never enter the dismissed set: a downgraded HIGH always
// gates. Pure — the CLI keeps exit precedence (2 > 1 > 4 > 0) and never lets this trip exit 1.
export interface HighGateDecision {
  dismissedHighIds: string[]; // HONORED dismissals — rendered loudly, dropped from the gate
  gatingHighIds: string[]; // HIGHs that still gate → exit 4
}

// The records the HIGH gate considers. The holistic lens is EXCLUDED by construction: its findings
// are suggestions from one seat, so they may never flip the exit contract in either direction — not
// gate a run (an uncapped HIGH is still advice about architecture, not a defect in the change) and
// not be dismissed as if a reviewer had raised them. With the lens off this set is every record, so
// the exit contract is bit-for-bit the pre-lens one.
function highGateRecords(records: GateVerdictRecord[]): GateVerdictRecord[] {
  return records.filter((r) => r.severity === 'high' && !isHolisticRecord(r));
}

export function resolveHighGate(
  records: GateVerdictRecord[],
  trailWritten: boolean,
  authorityActive: boolean
): HighGateDecision {
  const highIds = highGateRecords(records).map((r) => r.findingId);
  if (!authorityActive) return { dismissedHighIds: [], gatingHighIds: highIds };
  const dismissed = new Set(honoredHighDismissals(records, trailWritten));
  return {
    dismissedHighIds: highIds.filter((id) => dismissed.has(id)),
    gatingHighIds: highIds.filter((id) => !dismissed.has(id)),
  };
}

// The exit-authority block for stdout: the resolved mode, each HONORED-dismissed HIGH rendered
// LOUDLY as `HIGH (dismissed by gate — reason)`, any advisory-only gate-`false` HIGHs that STRICT
// did NOT honor (surfaced, never silently gated), and the HIGHs that still gate. Returns [] when
// there are no HIGH findings at all (nothing authority-relevant to say). Pure.
export function renderHighGate(
  records: GateVerdictRecord[],
  decision: HighGateDecision,
  opts: { authorityActive: boolean; authorityLabel: string; scrub: (s: string) => string }
): string[] {
  const s = opts.scrub;
  const highs = highGateRecords(records); // the lens is advisory — never part of the HIGH gate
  if (highs.length === 0) return [];
  const byId = new Map(records.map((r) => [r.findingId, r]));
  const out: string[] = ['', `  ── gate authority — ${opts.authorityLabel} ──`];
  for (const id of decision.dismissedHighIds) {
    const r = byId.get(id);
    const reason = r?.reason ? s(r.reason).slice(0, 200) : 'grounded false verdict';
    const where = r?.file ? ` · ${s(r.file)}${r.line ? `:${r.line}` : ''}` : '';
    out.push(`     HIGH (dismissed by gate — ${reason}) · ${id}${where}`);
  }
  // A gate `false` on a HIGH that authority did NOT honor (a STRICT run) — advisory only, surfaced
  // so the user sees the dismiss path exists (and how to enable it) rather than silently gating.
  if (!opts.authorityActive) {
    const advisory = highs.filter((r) => r.effectiveVerdict === 'false').map((r) => r.findingId);
    if (advisory.length > 0) {
      out.push(
        `     gate marked ${advisory.length} HIGH(s) \`false\` (advisory — authority STRICT, NOT dismissed): ${advisory.join(', ')}`
      );
    }
  }
  if (decision.gatingHighIds.length > 0) {
    out.push(
      `     ${decision.gatingHighIds.length} HIGH(s) gate → exit 4: ${decision.gatingHighIds.join(', ')}`
    );
  } else if (decision.dismissedHighIds.length > 0) {
    out.push('     every HIGH dismissed by the gate — no HIGH gates this run');
  }
  return out;
}

// The gate-disposition summary the receipt carries (spec §Design 2). Verdict counts + the HONORED
// dismissed HIGH ids + the trail-failed marker (trailWritten=false means dismissals were NOT
// honored). Additive on the receipt — `receipt verify` never reads it, so its semantics are
// unchanged. `verdictCounts` keys are the GateVerdict enum, JSON-serialized as strings.
export interface GateDispositionSummary {
  dismissedHighIds: string[];
  trailWritten: boolean;
  verdictCounts: Record<string, number>;
}

export function gateDispositionSummary(
  records: GateVerdictRecord[],
  dismissedHighIds: string[],
  trailWritten: boolean
): GateDispositionSummary {
  return { dismissedHighIds, trailWritten, verdictCounts: verdictCounts(records) };
}

// ── Durable trail ──────────────────────────────────────────────────────────────────────

export interface GateVerdictsTrail {
  runId: string;
  schemaVersion: number;
  verdicts: GateVerdictRecord[];
}

// Write gate-verdicts.json atomically. Returns whether it DURABLY wrote — the caller gates
// dismissal-honoring on this (spec fail-closed matrix). Never throws.
export function writeGateVerdictsTrail(
  baseDir: string,
  runId: string,
  records: GateVerdictRecord[]
): boolean {
  const trail: GateVerdictsTrail = {
    runId,
    schemaVersion: GATE_TRAIL_SCHEMA_VERSION,
    verdicts: records,
  };
  try {
    writeTrailFile(baseDir, runId, 'gate-verdicts.json', JSON.stringify(trail, null, 2));
    return true;
  } catch {
    return false;
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────────────

export function verdictCounts(records: GateVerdictRecord[]): Record<GateVerdict, number> {
  const c: Record<GateVerdict, number> = { agree: 0, false: 0, partial: 0, unverified: 0 };
  for (const r of records) c[r.effectiveVerdict]++;
  return c;
}

// The gate block for stdout: every finding's tag inline (with its downgrade reason when the
// host overrode the model), the summary counts line, the LOUD trail marker, and the
// "teeth did not engage" notice when findings exist but zero verdicts landed.
export function renderGateVerdicts(
  records: GateVerdictRecord[],
  opts: { scrub: (s: string) => string; trailWritten: boolean }
): string[] {
  const s = opts.scrub;
  const out: string[] = ['', '  ── gate — grounded verdicts ──'];
  if (records.length === 0) {
    out.push('     no findings to verdict');
  } else {
    for (const r of records) {
      const where = evidenceRef(r.file, r.line, s);
      const dg = r.downgradeReason ? `  (host: ${r.downgradeReason})` : '';
      const reason = r.reason ? ` — ${s(r.reason).slice(0, 200)}` : '';
      // A holistic record NAMES its lens inline. Its provenance is one seat that read the whole
      // tree — never the cross-reviewer corroboration the other records may carry. The cap is
      // reported as LIFTED only when the severity actually sits above it: a LOW finding may carry
      // a verified citation too, and claiming it uncapped anything would be a false claim.
      const lens = r.holistic
        ? `  [holistic lens · single seat${r.holistic.cappedFrom ? ` · severity capped from ${r.holistic.cappedFrom}` : ''}${holisticCapWasLifted(r) ? ' · MED cap lifted by a verified conventions citation' : ''}]`
        : '';
      out.push(
        `     [${r.effectiveVerdict}] ${r.findingId} [${r.severity}] ${where}  ${s(r.title).slice(0, 120)}${reason}${dg}${lens}`
      );
      // A duplicate's threaded claim renders UNDER its primary — the whole point of trail v8 is
      // that a triager reading this line never has to open the duplicate's raw findings file to
      // see the framing the survivor's body lacks.
      for (const d of r.duplicates ?? []) {
        out.push(
          `        ↳ duplicate ${d.findingId} (${d.reviewer}, ${d.severity}) adds: ${s(d.claim).slice(0, 200)}`
        );
      }
    }
  }
  const c = verdictCounts(records);
  out.push(
    `  gate — ${c.agree} agree · ${c.partial} partial · ${c.false} false (dismissed) · ${c.unverified} unverified`
  );
  // The gate is toothless when findings exist but nothing was groundable — a capability-floor
  // signal (a weak gate model mostly yields unverified). Deterministic, from the counts.
  //
  // But a gate that never got to reason is not a weak gate, and telling the operator to raise the
  // model sends them to tune a seat that never ran (the run that prompted this was already
  // opus@max). A whole-envelope failure marks EVERY record with the same host reason, so the cases
  // are separable from the records alone — and they do NOT share a recovery, which is why each says
  // its own thing rather than sharing one "re-run it" line.
  if (records.length > 0 && c.agree + c.partial + c.false === 0) {
    const shared = records.every((r) => r.downgradeReason === records[0].downgradeReason)
      ? records[0].downgradeReason
      : undefined;
    out.push(WHOLE_ENVELOPE_ADVICE[shared as DowngradeReason] ?? TOOTHLESS_GATE_ADVICE);
  }
  // Say the honest thing about the lens wherever its findings are shown (spec §4): one seat, no
  // corroboration signal, and silence proves nothing about the architecture.
  if (records.some((r) => r.holistic)) {
    out.push(
      '  holistic lens: ONE seat that read the whole tree — its findings never carry the cross-reviewer "flagged by N of M" signal, post agree-only as suggestions, and cap at MED unless a conventions doc is cited and verified. A clean holistic pass is NOT an architecture certification (whole-repo search varies run to run).'
    );
  }
  out.push(
    opts.trailWritten
      ? '  gate trail: gate-verdicts.json written'
      : '  gate trail: FAILED — dismissals not honored (audit trail not durably written)'
  );
  return out;
}

// ── The gate run (spawn + reconcile + trail) ──────────────────────────────────────────

export type GateRunner = (
  prompt: string,
  config: VoiceConfig,
  opts?: RunReviewOpts
) => Promise<VoiceRunResult>;

export interface GateRunResult {
  // Did the gate SEAT actually spawn and return? False when no healthy reviewer gave it anything
  // to judge, or when the spawn itself threw — in both cases the seat never existed, so it read
  // nothing. This is what the run's REALIZED evidence for the `gate` seat is derived from: a gate
  // that never ran cannot have realized `worktree` evidence, and a receipt must not attest that it
  // did. A seat that ran but timed out, produced no output, or returned an unparseable envelope
  // DID spawn in the worktree — it could read the tree, so its realized class is honest.
  gateSpawned: boolean;
  gateTrailWritten: boolean;
  synthesis: ReviewSynthesis;
  verdicts: GateVerdictRecord[];
}

export interface RunGateOptions {
  baseDir: string;
  config: VoiceConfig;
  expectedHeadSha: string;
  // The gate's REALIZED evidence (default 'packet'). The gate is an EVIDENCE-BEARING ACTOR, not a
  // neutral judge (gate-r3 pin 1): worktree ⇒ it read the PR head and may emit
  // `reference-not-found`; packet ⇒ it structurally cannot, and the cause is dropped.
  gateEvidence?: EvidenceClass;
  // Worktree-backed verification for the holistic lens's guardrails (spec §4). `diffFiles` is
  // derived HERE from the pinned packet (the one source of "what this PR changes"), so a caller
  // supplies only the tree reader + the run's gathered conventions paths.
  holistic?: Omit<HolisticPolicyDeps, 'diffFiles'>;
  log?: (m: string) => void;
  reviews: VoiceReview[];
  run: GateRunner;
  runId: string;
  timeoutMs?: number;
  // The detached read-only worktree of the PR head — the gate's spawn cwd when it is worktree-fed.
  // Reading the tree is what lets it locate a holistic finding's pattern site (and tell a missing
  // reference from a truncated window). BORROWED: the run owns and reaps it.
  worktree?: string;
}

// Run the gate end-to-end: read the pinned packet → resolve+budget each finding's hunk →
// render the hunk-fed prompt → spawn the gate voice → parse the composite envelope →
// host-reconcile the verdicts → write the durable trail. FAIL-CLOSED throughout: a packet
// read failure ⇒ all-`unverified`(packet-fail) (prose kept); a spawn error/timeout/
// unparseable/unknown-schema ⇒ deterministic fallback synthesis + all-`unverified`; the trail
// write result flows out so the caller can withhold dismissal-honoring on a write failure.
export async function runGate(opts: RunGateOptions): Promise<GateRunResult> {
  const log = opts.log ?? (() => {});
  const healthy = opts.reviews.filter((r) => r.ok);

  const packet = readGatePacket(opts.baseDir, opts.runId, opts.expectedHeadSha);
  const packetFail = !packet.ok;
  if (packetFail) {
    log(`  · gate: pinned packet unusable (${packet.reason}) — verdicts cannot be grounded`);
  }
  const packetHunks = packet.ok ? parsePacketHunks(packet.diff) : new Map<string, Hunk[]>();
  // Tag only COMPLETED (ok) reviewers' findings. A cut-off / failed reviewer's findings are
  // untrusted — they are excluded from the exit gate (cli.ts `hasHighFinding` requires
  // terminalState === 'reviewed') and were never synthesized, so the gate must not launder
  // them into the verdict set either.
  const { findings, injections } = prepareGateFindings(healthy, packetHunks);

  const finalize = (
    synthesis: ReviewSynthesis,
    parsed: ParsedGateEnvelope | WholeEnvelopeFailure,
    gateSpawned: boolean
  ): GateRunResult => {
    const { records: reconciled, warnings } = reconcileGateVerdicts(findings, parsed, {
      gateEvidence: opts.gateEvidence,
      // The pinned packet's file set IS "what this PR changes" — the same bytes the reviewers saw.
      // A holistic `agree` must cite its reinvention inside it.
      ...(opts.holistic
        ? { holistic: { ...opts.holistic, diffFiles: new Set(packetHunks.keys()) } }
        : {}),
    });
    for (const w of warnings) log(`  · ${w}`);
    // Cross-reviewer dedup by selection — one representative per cluster posts; corroboration
    // recorded. Runs AFTER reconcile (needs the full postable set) and BEFORE the trail write
    // (so cluster provenance is durable).
    const records = clusterPostable(reconciled);
    const gateTrailWritten = writeGateVerdictsTrail(opts.baseDir, opts.runId, records);
    if (!gateTrailWritten) {
      log('  · gate: gate-verdicts.json FAILED to write — dismissals not honored (trail loss is LOUD)');
    }
    return { gateSpawned, gateTrailWritten, synthesis, verdicts: records };
  };

  // Every FAIL-CLOSED spawn/parse exit shares one shape: log, then finalize the deterministic
  // fallback synthesis (carrying the error string, and the raw gate output when we have it) as a
  // whole-envelope failure. One closure so the three failure branches can't drift on that shape.
  // `gateSpawned` is passed per-branch: a spawn that THREW never reached the worktree, while a
  // seat that ran and returned an unusable envelope did.
  const bail = (
    logMsg: string,
    error: string,
    failure: WholeEnvelopeFailure['failure'],
    gateSpawned: boolean,
    raw?: string
  ): GateRunResult => {
    log(logMsg);
    return finalize(
      { ...fallbackReviewSynthesis(opts.reviews), error, ...(raw !== undefined ? { raw } : {}) },
      { failure },
      gateSpawned
    );
  };

  // No healthy reviewer ⇒ nothing to verdict; still emit the deterministic fallback synthesis
  // and a (probably empty) trail so the artifact always exists. The seat is never spawned.
  if (healthy.length === 0) {
    return finalize(fallbackReviewSynthesis(opts.reviews), { failure: 'gate-failed' }, false);
  }

  // The prompt teaches `cause: reference-not-found` ONLY when the gate's realized evidence is
  // worktree — the same fact reconcileGateVerdicts requires to HONOR it. Teach and honor together,
  // or the cause is either unreachable (never taught) or unsound (taught to a packet-fed gate).
  const prompt = renderGatePrompt(findings, injections, opts.gateEvidence ?? 'packet');
  log('Gate: grounding findings against the pinned diff hunks — verdict tags…');
  const spawn = async (): Promise<VoiceRunResult | { threw: Error }> => {
    try {
      return await opts.run(prompt, opts.config, {
        timeoutMs: opts.timeoutMs,
        ...(opts.worktree ? { worktree: opts.worktree } : {}),
      });
    } catch (e) {
      return { threw: e as Error };
    }
  };
  let attempt = await spawn();
  // The first attempt's named cause, kept because the SECOND can be the less informative of the
  // two: a bare empty reply after a named 529 would otherwise erase the 529 — the exact
  // information loss the rest of this change exists to stop.
  let firstEmptyWhy: string | null = null;
  // ONE re-spawn on a seat that came back empty without timing out. Losing the gate costs the
  // whole run — every reviewer's findings drop to unverified, and the operator is left grounding
  // them by hand — while a second gate costs one seat. Evidence that this is worth paying: the
  // 2026-08-19 lisk-backend#738 gate returned nothing after 13 minutes, and a `regate` over the
  // byte-identical packet with the same model landed 4 agree / 2 partial / 0 unverified.
  // Deliberately NOT retried: a spawn that threw (no seat ever existed — a different fault), a
  // timeout (it was working and too slow; a re-spawn just spends the budget twice), and an
  // operator usage limit (the window is closed until its reset time, so a retry burns nothing but
  // wall clock).
  if (
    !('threw' in attempt) &&
    !attempt.raw &&
    !attempt.timedOut &&
    !isUsageLimitFailure(attempt.failWhy)
  ) {
    firstEmptyWhy = attempt.failWhy ?? 'gate produced no output';
    log(`  · gate returned nothing (${firstEmptyWhy}) — re-spawning once before falling back`);
    const second = await spawn();
    // A throw on the RETRY keeps the first attempt's named failure: it is the more informative of
    // the two, and reporting the retry's spawn error would bury why the gate was retried at all.
    if (!('threw' in second)) attempt = second;
  }
  if ('threw' in attempt) {
    // The spawn itself threw — no seat ever existed, so it read nothing (gateSpawned: false).
    return bail(
      `  · gate failed (${attempt.threw.message}) — deterministic fallback + all unverified`,
      attempt.threw.message,
      'gate-failed',
      false
    );
  }
  const res: VoiceRunResult = attempt;
  if (!res.raw || res.timedOut) {
    // The RUNNER already named the cause — a persistent transient API error, an operator usage
    // limit, an error result, a wedged seat reclaimed by the liveness watchdog. Collapsing all of
    // those into "produced no output" (what this said until 2026-08-19) leaves the operator with a
    // dead run and no way to tell a retryable 529 from a wedged seat, and the reply is not
    // persisted anywhere either. Prefer failWhy, and carry the stderr tail into the log + the
    // synthesis error so the trail keeps the evidence. Same precedent as probe-gate.
    const last = res.failWhy ?? (res.timedOut ? 'gate timed out' : 'gate produced no output');
    // Both attempts down: report both causes, since they can differ and the earlier one is often
    // the specific one.
    const why =
      firstEmptyWhy && firstEmptyWhy !== last ? `${last} (first attempt: ${firstEmptyWhy})` : last;
    const tail = res.stderrTail?.trim();
    return bail(
      `  · ${why} — deterministic fallback + all unverified${tail ? ` [${tail.slice(0, 200)}]` : ''}`,
      tail ? `${why} — ${tail.slice(0, 200)}` : why,
      'gate-failed',
      true
    );
  }

  // The gate's reply is the only record of how it reasoned about every finding, and a run whose
  // verdicts look wrong is un-diagnosable without it. Persist BEFORE parsing so an unparseable
  // envelope — the case that most needs reading — is kept too. Best-effort: losing the transcript
  // must never cost the verdicts it describes.
  try {
    writeTrailFile(opts.baseDir, opts.runId, 'gate.raw.md', res.raw);
  } catch {
    /* best-effort — the verdicts below do not depend on the transcript landing */
  }

  const parsed = parseGateEnvelope(res.raw);
  if ('failure' in parsed) {
    return bail(
      `  · gate envelope not usable (${parsed.failure}) — deterministic fallback + all unverified`,
      parsed.failure,
      parsed.failure,
      true,
      res.raw
    );
  }

  // Prose synthesis (agreements/disagreements/bottomLine) survives even a packet-fail — only
  // the grounded VERDICTS are killed there. Reconcile the prose against the real reviews (the
  // unchanged corroboration guard) so the gate can't fabricate confident consensus.
  const { synthesis, demoted } = reconcileSynthesis(
    {
      agreements: parsed.agreements,
      bottomLine: parsed.bottomLine,
      by: 'claude',
      degraded: false,
      disagreements: parsed.disagreements,
      ok: true,
      raw: res.raw,
      summary: '',
    },
    // Corroborate against the SAME completed (ok) reviewers the verdict half tags — reconcile
    // self-filters ok, so this is behavior-identical, but keeps the "only completed reviewers"
    // property uniform across the prose and verdict halves.
    healthy
  );
  // Surface the anti-fabrication guard firing: an "agreement" no ≥2 real voices corroborate is
  // demoted to look-closer. Silent demotion would hide a caught fabricated-consensus attempt.
  if (demoted > 0) {
    log(`  · synthesis: ${demoted} unverifiable "agreement(s)" demoted to look-closer (not corroborated by ≥2 real voices)`);
  }
  return finalize(synthesis, packetFail ? { failure: 'packet-fail' } : parsed, true);
}
