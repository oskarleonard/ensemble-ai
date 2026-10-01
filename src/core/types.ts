// The typed contracts for the cross-vendor review primitive (v1: code diffs).
// Vendor-agnostic BY CONSTRUCTION: a Reviewer is config (add a third vendor later
// = a registry entry, not a rewrite), findings are a typed wire shape (never
// freeform markdown), and an arbiter's dispositions are a separate typed layer
// over them. No node imports — this is shared by consumers (UIs that render the
// reviewer ids), CLIs, and the unit tests.

// The CROSS-VENDOR core: the seats that mint the content-tied receipt and that a
// review cannot run without (self-contained.ts's roster rule). Kept separate from
// REVIEWER_IDS so the registry can carry same-vendor-as-the-author reviewers
// (claude) without weakening the receipt's cross-vendor meaning.
export const CORE_REVIEWER_IDS = ['codex', 'grok'] as const;
export type CoreReviewerId = (typeof CORE_REVIEWER_IDS)[number];

// EVERY registry reviewer a consumer can run — the cross-vendor core plus the
// capability-fenced Anthropic peer (spec 2026-07-09 §3's ONE Claude producer,
// promoted to a first-class registry seat so library consumers key artifacts,
// dispositions, and UI by one id space). The CLI's default roster stays the
// core (claude remains its ADDITIVE layer); only explicit requests run claude.
export const REVIEWER_IDS = ['codex', 'grok', 'claude'] as const;
export type ReviewerId = (typeof REVIEWER_IDS)[number];

export function isReviewerId(v: unknown): v is ReviewerId {
  return (REVIEWER_IDS as readonly string[]).includes(v as string);
}

export function isCoreReviewerId(v: unknown): v is CoreReviewerId {
  return (CORE_REVIEWER_IDS as readonly string[]).includes(v as string);
}

// The display label for a reviewer id ("codex" → "Codex"). One source so every
// surface (a checkbox row, a results panel) renders a reviewer's name the same way.
export function titleCase(id: string): string {
  return id ? id[0].toUpperCase() + id.slice(1) : id;
}

// Validate an untrusted reviewers array (e.g. a request-body field) to the
// canonical set of known ids — deduped, with the field DROPPED (→ undefined) when
// nothing valid survives, so a junk array degrades to "no cross-vendor reviewer"
// rather than poisoning a run's gating. The one place the {reviewers} wire-field
// is parsed, so the leniency rule can't drift between callers.
export function parseReviewerIds(raw: unknown): ReviewerId[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = [...new Set(raw.filter(isReviewerId))];
  return ids.length > 0 ? ids : undefined;
}

// A reviewer = its CLI command + the model/effort it runs at. The whole point of
// keeping this as data is swap-without-code-edit. `vendor` is informational,
// surfaced in a UI ("OpenAI · gpt-5.5"). `sandbox` is the OS-enforced read-only
// profile name a CLI-sandboxing reviewer runs under (grok's `--sandbox`); the
// boundary is the kernel, not tool-denial (a reviewer must provably never mutate
// the work). Codex bakes its own `-s read-only` and ignores this field.
export interface ReviewerConfig {
  // The Claude seat's ADVISOR model — a model id, or "off". Absent = the seat inherits
  // whatever the operator's ~/.claude/settings.json says. PROGRAMMATIC ONLY: a consumer that
  // runs the claude adapter (reviewers/claude runClaudeReview) sets it; reviewers.json never
  // carries it, because no CLI spawn reads the registry claude entry (the CLI's claude seats
  // resolve from voices.json). Checked at the spawn by claudeAdvisorArgs (parseSeatAdvisor).
  advisor?: string;
  cmd: string;
  // An ISO instant this seat stays switched OFF until — a QUOTA WINDOW. The seat is
  // off while now < disabledUntil and comes back BY ITSELF once it passes, so an
  // operator who loses a vendor to a usage limit writes one date and never has to
  // remember a restore step. Absent = no window.
  disabledUntil?: string;
  effort: string;
  // Is this seat switched on? Absent = true (the default for every seat). `false` is
  // the INDEFINITE switch-off — it stays off until an operator edits the file back.
  // The two off-switches are independent: a seat is off when `enabled === false` OR
  // it is inside its `disabledUntil` window. enabledReviewerIds (just below) is the
  // ONE owner of that rule; nothing else may re-derive it.
  enabled?: boolean;
  id: ReviewerId;
  model: string;
  sandbox?: string;
  vendor: string;
}

// ── The seat off-switches ────────────────────────────────────────────────────
// Both predicates are PURE, so they live beside the type they read instead of in the
// fs-backed core/reviewers: a UI that greys a switched-off seat imports
// `ensemble-ai/contracts`, which must never pull `node:fs` into a bundle — and a second
// copy of the rule, written to keep a bundler happy, is exactly the drift the one-owner
// rule exists to stop.

// The shape of an INSTANT: a full ISO 8601 date-time carrying its zone (`Z` or ±HH:MM).
// A zone-less date-time is NOT an instant — Date.parse reads it in the HOST's timezone,
// so a dashboard and a CLI on two machines would disagree about when a seat comes back —
// and the looser forms Date.parse also takes (a bare `2027`, `9/29/2026`, `Sep 29 2026`)
// are junk that must never switch a seat off.
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

// The ONE parse of a seat's `disabledUntil` window: the instant as the operator wrote
// it, or undefined for anything else. Kept VERBATIM rather than canonicalized — an
// explicit zone already pins the instant, so rewriting `+02:00` into `Z` would only cost
// a surface the string it was given. Exported so an operator-facing field can validate a
// typed window with the SAME rule the config file gets.
export function parseSeatWindow(v: unknown): string | undefined {
  const value = typeof v === 'string' ? v.trim() : '';
  if (!ISO_INSTANT.test(value) || Number.isNaN(Date.parse(value))) return undefined;
  // Date.parse range-checks the month and the clock but ROLLS an impossible day over
  // (2027-02-30 reads as 2027-03-02 — two days of seat-off nobody asked for), so the
  // calendar day is checked here: a date that does not exist is junk, and junk may not
  // disable a seat.
  const [year, month, day] = value.slice(0, 10).split('-').map(Number);
  const asWritten = new Date(Date.UTC(year, month - 1, day));
  return asWritten.getUTCMonth() === month - 1 && asWritten.getUTCDate() === day
    ? value
    : undefined;
}

// ── The Claude seat's advisor ────────────────────────────────────────────────
// A headless `claude -p` seat silently inherits `advisorModel` from the operator's
// ~/.claude/settings.json. The `advisor` field makes it explicit config, in exactly
// three states: a model id (that advisor), "off" (no advisor, even when the operator's
// settings enable one), or ABSENT (inherit — the key omitted, never null). Probed on
// Claude Code 2.1.286 (2026-10-01): a `--settings` advisorModel overrides the user
// setting, the empty string disables it, and null falls back to the user setting —
// so null is not a spelling of any state here, and is rejected.
export const ADVISOR_OFF = 'off';
export const ADVISOR_MODEL_RE = /^[a-z0-9][a-z0-9.-]*$/;

// THE rule: is `v` a stated advisor — "off" or a model id? (Absent is not a stated advisor; it
// inherits.) Non-throwing, so a display (`ensemble-ai config`) can mark an invalid value.
export function isSeatAdvisor(v: unknown): v is string {
  return v === ADVISOR_OFF || (typeof v === 'string' && ADVISOR_MODEL_RE.test(v));
}

// The ONE parse of a seat's `advisor`, applied only where a seat is about to SPAWN (its up-front
// seat resolution, then claudeAdvisorArgs at the spawn) — never in a whole-file config parse, so
// an unused seat's typo cannot break a command that does not run it. Undefined when absent, the
// value when isSeatAdvisor, and a THROW naming the seat for anything else. Unlike the other seat
// fields, junk does not fall back to a default: the only fallback is "inherit the operator's
// setting", which is exactly the accident this field exists to end. Pure and exported on both
// entries, so a UI validates a typed value with the same rule.
export function parseSeatAdvisor(v: unknown, seat: string): string | undefined {
  if (v === undefined) return undefined;
  if (isSeatAdvisor(v)) return v;
  throw new Error(
    `ensemble-ai: ${seat} seat: \`advisor\` must be "${ADVISOR_OFF}" or a model id matching ${ADVISOR_MODEL_RE.source} (omit the key to inherit the operator's setting) — got ${JSON.stringify(v) ?? String(v)}`
  );
}

// Is ONE seat switched off at `now`? The rule, in one place: a seat is off when it is
// explicitly `enabled: false` (the indefinite switch) OR it is inside its
// `disabledUntil` quota window. The window expiring turns the seat back on with no
// restore step; `enabled: false` does not expire.
function seatOff(config: ReviewerConfig | undefined, now: Date): boolean {
  if (config?.enabled === false) return true;
  // The window goes through the SAME parse the config file gets, so a config built by
  // hand cannot disable a seat with a string reviewers.json would have dropped. An
  // absent or rejected window parses to NaN, and every comparison against NaN is false.
  return now.getTime() < Date.parse(parseSeatWindow(config?.disabledUntil) ?? '');
}

// THE ONE OWNER of "which reviewer seats are on". Every fan-out, every required-seat
// set, and every UI that greys a seat reads this — a second predicate anywhere would
// let a fired review and the gate that grades it disagree about who was supposed to
// run. Returns ids in canonical REVIEWER_IDS order. An operator switching a seat off
// is NOT a missing reviewer: the set this returns IS the roster the run is judged by.
//
// EMPTY IS A REAL ANSWER: switch every seat off and this returns `[]` — the FACT that
// no seat is on, never a clean bill. A consumer whose required-seat set is this list
// MUST treat an empty one as fail-closed (no reviewer looked at the diff), the way an
// empty `--reviewers` list is refused outright rather than read as "nothing required".
export function enabledReviewerIds(
  config: Record<ReviewerId, ReviewerConfig>,
  now: Date = new Date()
): ReviewerId[] {
  return REVIEWER_IDS.filter((id) => !seatOff(config[id], now));
}

export const SEVERITIES = ['high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

// Is `severity` at least as severe as `floor`? SEVERITIES is ordered most-severe-first, so a
// LOWER index is MORE severe. The ONE home for the severity-floor comparison — shared by the
// posting floor (posting-config `meetsInlineFloor`) and the premise-cluster ≥medium bar
// (gate-prompt), so the "lower index = more severe" invariant lives in a single place.
export function severityAtLeast(severity: Severity, floor: Severity): boolean {
  const s = SEVERITIES.indexOf(severity);
  const f = SEVERITIES.indexOf(floor);
  // A value outside the enum (an unchecked JS caller or deserialized JSON, past the type boundary)
  // meets NO floor: a bare `indexOf(x) <= indexOf(floor)` would rank an unknown severity (-1) ABOVE
  // 'high', since -1 ≤ every valid index (codex#f3).
  return s >= 0 && f >= 0 && s <= f;
}

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

// Where a finding points. An uncited finding (no file) is downgraded — the
// arbiter rule weighs cited evidence at face value, uncited at a discount.
export interface Evidence {
  detail?: string;
  file?: string;
  line?: number;
}

// One reviewer finding — a TYPED contract. `id` is assigned at parse time (f1,
// f2, …) so dispositions can reference it stably across the artifact boundary.
export interface ReviewFinding {
  body: string;
  confidence: Confidence;
  evidence: Evidence;
  id: string;
  severity: Severity;
  title: string;
  uncited?: boolean;
}

// NOTE: an arbiter's dispositions + a "gate" (surface-to-a-human) are HOST
// POLICY, deliberately NOT modeled here — the core emits FACTS (findings +
// per-reviewer execution status + coverage), and each consuming host computes its
// own gate from those facts (spec §Scope-OUT / f3). So there is no Disposition /
// ReviewGate / gate verdict in this portable contract.

// One assembled+bounded section of the review packet, carrying its own manifest
// line: WHY it's here and whether it was truncated, so a UI can prove what the
// reviewer actually saw.
export interface PacketSection {
  body: string;
  included: boolean;
  note: string;
  title: string;
  truncated: boolean;
}

// The full context handed to the reviewer. `complete` is false when a REQUIRED
// item (the diff) was missing or hard-truncated — a blind review is not
// trustworthy, so the host's gate surfaces it. `pr`/`repo` describe the subject;
// a non-PR subject can leave them 0/'' and label itself via `subject`.
export interface ReviewPacket {
  complete: boolean;
  objective: string;
  pr: number;
  repo: string;
  sections: PacketSection[];
  // Human label of what is under review when it is not a PR. Absent for the
  // code/PR profile (pr/repo say it).
  subject?: string;
}

// The reviewer-phase outcome. `reviewed` = ran and produced (possibly zero)
// findings; `failed-reviewer` = wedged / no parseable output. A "needs human"
// decision is the host gate's, not a terminal state (v1 is one round).
export const TERMINAL_STATES = ['reviewed', 'failed-reviewer'] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

// One packet-section's manifest line (no body): enough for a UI to PROVE what the
// reviewer saw without re-shipping the whole packet.
export interface ManifestEntry {
  included: boolean;
  note: string;
  title: string;
  truncated: boolean;
}

// The review index a host serves + a UI renders — the FACTS shape. A PURE shape
// (lives here, not in the node-only artifacts module) so any consumer can import
// it. A host MAY extend it with its own arbitration fields (dispositions / a gate)
// — those are host policy, not part of this portable contract. ONE StoredReview
// per (runId, reviewerId) — a run fans out to N reviewers, each writing its own
// independent artifact, so a codex-`f1` never collides with a grok-`f1`.
// `reviewerId` is optional only for back-compat reads of pre-fan-out artifacts;
// new writes always set it.
export interface StoredReview {
  // How the seat ended, beyond its terminal state: wall-clock, which watchdog fired, the stderr
  // tail. Written for every seat so a timeout is diagnosable from the trail instead of reading
  // only "it timed out". Absent on artifacts written before it existed.
  diagnostics?: SeatDiagnostics;
  findings: ReviewFinding[];
  packet: { complete: boolean; manifest: ManifestEntry[] };
  // `advisor` is a Claude seat's stated advisor (a model id or "off"), recorded beside the model
  // it advised when the reviewer config carried one (ReviewerConfig.advisor — programmatic); absent
  // when the seat inherited the operator's settings.
  reviewer: { advisor?: string; effort: string; model: string; vendor: string };
  reviewerId?: ReviewerId;
  runId: string;
  summary: string;
  terminalState: TerminalState;
}

// The FACTS of one seat's run that the reply alone cannot carry. `stderrTail` is bounded (a noise
// channel); `timedOutReason` says which watchdog reclaimed the seat — the absolute backstop (it was
// still working) or the liveness one (it went silent) — which is the difference between "give it
// more time" and "it wedged". A seat that produced a reply still records its wall-clock.
export interface SeatDiagnostics {
  elapsedMs: number;
  endedAt: string;
  failWhy?: string;
  // The seat's pre-flight warnings (today: grok's login pre-flight), kept apart from `stderrTail`.
  preflightWarnings?: string[];
  startedAt: string;
  stderrTail: string;
  timedOutReason?: 'absolute' | 'inactivity';
}
