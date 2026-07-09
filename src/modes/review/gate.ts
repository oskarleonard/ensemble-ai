import { writeTrailFile } from '../../core/artifacts';
import { evidenceRef, extractJsonBlock } from '../../core/findings';
import { SEVERITIES, type Severity } from '../../core/types';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';
import { type RunReviewOpts } from '../../reviewers/codex';

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
  type PostableOp,
  type PostableStatus,
  derivePostable,
  parseFixStatus,
  parsePostableOps,
  parseSeverity,
} from './gate-postable';
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
] as const;
export type DowngradeReason = (typeof DOWNGRADE_REASONS)[number];

// The composite envelope schema the gate prompt pins + the model must echo. A missing /
// different value fails the whole envelope closed (all-`unverified`) — the host never
// interprets verdicts under semantics it doesn't recognize.
export const GATE_ENVELOPE_SCHEMA_VERSION = 1;
// The durable trail-artifact schema. Bumped independently if the record shape changes.
// v2: adds the postable-text fields (postableBody / postableFix / rescoredSeverity /
// postableStatus) the LLM-free posting step consumes — see gate-postable.ts.
export const GATE_TRAIL_SCHEMA_VERSION = 2;

const REASON_CAP = 700;
const CITATION_CAP = 500;
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
export interface GateFinding {
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
  findingId: string;
  fixStatus?: FixStatus; // disposition the gate assigned the reviewer's suggested fix
  ops?: PostableOp[]; // minimal edit-ops narrowing the body (partial only)
  reason: string;
  rescoredSeverity?: Severity; // gate's down-scored severity (host clamps: never higher)
  verdict: unknown;
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
    out.push({
      citation: typeof e.citation === 'string' ? capStr(e.citation, CITATION_CAP) : undefined,
      findingId,
      reason: capStr(e.reason, REASON_CAP),
      verdict: e.verdict,
      // conditional so an old-shape (no-ops) entry parses to the exact prior shape
      ...(ops.length ? { ops } : {}),
      ...(typeof e.cause === 'string' && e.cause.trim() ? { cause: e.cause.trim() } : {}),
      ...(fixStatus ? { fixStatus } : {}),
      ...(rescoredSeverity ? { rescoredSeverity } : {}),
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

export interface GateVerdictRecord {
  citation?: string;
  cluster?: ClusterInfo; // cross-reviewer cluster (postable records only); absent ⇒ singleton / not clustered
  downgradeReason: DowngradeReason | null;
  effectiveVerdict: GateVerdict;
  file: string;
  findingId: string;
  line: number | null;
  postableBody: string | null; // EXACT text to post (verbatim for agree, narrowed for partial); null ⇒ do not post
  postableFix: FixStatus | null; // disposition of the reviewer's suggested fix
  postableNote?: string; // escalation / audit note when postableStatus is 'escalated'
  postableStatus: PostableStatus; // postable | escalated (couldn't safely narrow) | not-postable (false/unverified)
  rawVerdict: string | null; // exactly what the model returned (may be an invalid enum), null if none
  reason: string;
  rescoredSeverity: Severity | null; // gate's down-scored severity for a partial; null ⇒ unchanged
  reviewer: string;
  severity: Severity;
  title: string;
}

// A non-agree/partial finding never posts — false/unverified/downgraded all resolve here. The
// postable-text pass below overwrites these for the agree/partial pass-through only.
const NOT_POSTABLE = {
  postableBody: null,
  postableFix: null,
  postableStatus: 'not-postable' as const,
  rescoredSeverity: null,
};

// The record BEFORE the postable-text pass — every reconcile branch builds one of these; the
// postable fields are attached once, afterward, so the branch logic stays untouched.
type BaseRecord = Omit<
  GateVerdictRecord,
  'postableBody' | 'postableFix' | 'postableNote' | 'postableStatus' | 'rescoredSeverity'
>;

function recordBase(f: GateFinding): Omit<
  BaseRecord,
  'citation' | 'downgradeReason' | 'effectiveVerdict' | 'rawVerdict' | 'reason'
> {
  return {
    file: f.file,
    findingId: f.findingId,
    line: f.line,
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
  opts: { gateEvidence?: EvidenceClass } = {}
): { records: GateVerdictRecord[]; warnings: string[] } {
  const gateEvidence: EvidenceClass = opts.gateEvidence ?? 'packet';
  if ('failure' in parsed) {
    const reason = FAILURE_REASON[parsed.failure];
    return {
      records: findings.map((f) => ({
        ...recordBase(f),
        ...NOT_POSTABLE,
        downgradeReason: parsed.failure,
        effectiveVerdict: 'unverified',
        rawVerdict: null,
        reason,
      })),
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
    // `unverified` + an explicit `reference-not-found` cause: the gate says the thing this
    // finding POINTS AT does not exist at headSha. Honored ONLY on worktree evidence (gate-r3
    // pin 1). On a packet-fed gate the claim is unsound — the gate saw a ±25-line window, so
    // "not found" is indistinguishable from `truncated` — and it is DROPPED to a plain
    // unverified with a warning, never laundered into the stronger cause.
    if (e.verdict === 'unverified' && e.cause === 'reference-not-found') {
      if (gateEvidence === 'worktree') {
        return { ...base, citation, downgradeReason: 'reference-not-found', effectiveVerdict: 'unverified', rawVerdict, reason: e.reason || 'the gate could not locate what this finding references at headSha' };
      }
      warnings.push(
        `gate: "reference-not-found" claimed for ${f.findingId} on PACKET evidence — dropped (a packet-fed gate cannot distinguish it from a truncated window)`
      );
    }
    // agree / partial / unverified pass through — not dismissals, so truncation does not force them.
    return { ...base, citation, downgradeReason: null, effectiveVerdict: e.verdict, rawVerdict, reason: e.reason };
  });

  // Postable-text pass: agree/partial derive their exact PR text (verbatim / narrowed) from the
  // reviewer body + the gate's ops; everything else is not-postable. One place → one source of
  // truth for what may cross to a PR.
  const records = baseRecords.map((r): GateVerdictRecord => {
    if (r.effectiveVerdict !== 'agree' && r.effectiveVerdict !== 'partial') return { ...r, ...NOT_POSTABLE };
    const f = findingById.get(r.findingId);
    const e = (byId.get(r.findingId) ?? [])[0];
    if (!f) return { ...r, ...NOT_POSTABLE };
    return {
      ...r,
      ...derivePostable({
        body: f.body,
        fixStatus: e?.fixStatus,
        hunkCode: f.hunkCode,
        ops: e?.ops ?? [],
        rescoredSeverity: e?.rescoredSeverity,
        severity: f.severity,
        verdict: r.effectiveVerdict,
      }),
    };
  });
  return { records, warnings };
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
    .filter((r) => r.severity === 'high' && r.effectiveVerdict === 'false')
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

export function resolveHighGate(
  records: GateVerdictRecord[],
  trailWritten: boolean,
  authorityActive: boolean
): HighGateDecision {
  const highIds = records.filter((r) => r.severity === 'high').map((r) => r.findingId);
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
  const highs = records.filter((r) => r.severity === 'high');
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
      out.push(
        `     [${r.effectiveVerdict}] ${r.findingId} [${r.severity}] ${where}  ${s(r.title).slice(0, 120)}${reason}${dg}`
      );
    }
  }
  const c = verdictCounts(records);
  out.push(
    `  gate — ${c.agree} agree · ${c.partial} partial · ${c.false} false (dismissed) · ${c.unverified} unverified`
  );
  // The gate is toothless when findings exist but nothing was groundable — a capability-floor
  // signal (a weak gate model mostly yields unverified). Deterministic, from the counts.
  if (records.length > 0 && c.agree + c.partial + c.false === 0) {
    out.push('  gate teeth did not engage — consider a stronger gate model');
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
  log?: (m: string) => void;
  reviews: VoiceReview[];
  run: GateRunner;
  runId: string;
  timeoutMs?: number;
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
    parsed: ParsedGateEnvelope | WholeEnvelopeFailure
  ): GateRunResult => {
    const { records: reconciled, warnings } = reconcileGateVerdicts(findings, parsed, {
      gateEvidence: opts.gateEvidence,
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
    return { gateTrailWritten, synthesis, verdicts: records };
  };

  // Every FAIL-CLOSED spawn/parse exit shares one shape: log, then finalize the deterministic
  // fallback synthesis (carrying the error string, and the raw gate output when we have it) as a
  // whole-envelope failure. One closure so the three failure branches can't drift on that shape.
  const bail = (
    logMsg: string,
    error: string,
    failure: WholeEnvelopeFailure['failure'],
    raw?: string
  ): GateRunResult => {
    log(logMsg);
    return finalize(
      { ...fallbackReviewSynthesis(opts.reviews), error, ...(raw !== undefined ? { raw } : {}) },
      { failure }
    );
  };

  // No healthy reviewer ⇒ nothing to verdict; still emit the deterministic fallback synthesis
  // and a (probably empty) trail so the artifact always exists.
  if (healthy.length === 0) {
    return finalize(fallbackReviewSynthesis(opts.reviews), { failure: 'gate-failed' });
  }

  // The prompt teaches `cause: reference-not-found` ONLY when the gate's realized evidence is
  // worktree — the same fact reconcileGateVerdicts requires to HONOR it. Teach and honor together,
  // or the cause is either unreachable (never taught) or unsound (taught to a packet-fed gate).
  const prompt = renderGatePrompt(findings, injections, opts.gateEvidence ?? 'packet');
  log('Gate: grounding findings against the pinned diff hunks — verdict tags…');
  let res: VoiceRunResult;
  try {
    res = await opts.run(prompt, opts.config, { timeoutMs: opts.timeoutMs });
  } catch (e) {
    return bail(
      `  · gate failed (${(e as Error).message}) — deterministic fallback + all unverified`,
      (e as Error).message,
      'gate-failed'
    );
  }
  if (!res.raw || res.timedOut) {
    return bail(
      '  · gate produced no usable output — deterministic fallback + all unverified',
      res.timedOut ? 'gate timed out' : 'gate produced no output',
      'gate-failed'
    );
  }

  const parsed = parseGateEnvelope(res.raw);
  if ('failure' in parsed) {
    return bail(
      `  · gate envelope not usable (${parsed.failure}) — deterministic fallback + all unverified`,
      parsed.failure,
      parsed.failure,
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
  return finalize(synthesis, packetFail ? { failure: 'packet-fail' } : parsed);
}
