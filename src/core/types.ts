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
  cmd: string;
  effort: string;
  id: ReviewerId;
  model: string;
  sandbox?: string;
  vendor: string;
}

export const SEVERITIES = ['high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

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
  findings: ReviewFinding[];
  packet: { complete: boolean; manifest: ManifestEntry[] };
  reviewer: { effort: string; model: string; vendor: string };
  reviewerId?: ReviewerId;
  runId: string;
  summary: string;
  terminalState: TerminalState;
}
