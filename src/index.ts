// ensemble-ai — the library surface.
//
// Consumers (e.g. a dashboard) IMPORT this to run the cross-vendor review engine
// in-process — the SAME engine the `ensemble-ai` CLI runs, so there is ONE engine
// and zero drift. The engine emits FACTS (typed findings + per-reviewer execution
// status + coverage + a content-tied receipt); the gate POLICY is the consumer's.

// ── Contracts (vendor-neutral wire shapes) ──────────────────────────────────
export * from './core/types';

// ── Pure engine (packet · prompt · findings · conventions gatherer) ──────────
export * from './core/findings';
export * from './core/packet';
export * from './core/prompt';
// The conventions gatherer (the repo's linked md web) — consumed by BOTH the CLI
// and the dashboard so there is ONE gatherer, no drift. Node-backed (fs reader),
// so it lives on the main entry, not the browser-safe ./contracts.
export * from './core/conventions';

// ── Reviewer config + persistence ───────────────────────────────────────────
export * from './core/reviewers';
export * from './core/artifacts';

// ── Spawn primitive + bin resolution (the watchdog'd, group-killed contract) ──
export * from './core/spawn';
export * from './core/bin';
export * from './core/hash';

// ── Reviewer adapters (codex · grok) + the adapter registry ──────────────────
export * from './reviewers/codex';
export * from './reviewers/grok';
export * from './reviewers/registry';
// The ensemble-owned codex sandbox wrapper (worktree evidence, macOS Seatbelt).
export * from './reviewers/codex-sandbox';

// ── The review MODE: diff acquisition · secret-scan · the content-tied receipt ─
export * from './modes/review';
export * from './modes/review/diff';
export * from './modes/review/secret-scan';
export * from './modes/review/receipt';
// ── Worktree evidence mode: identity · lifecycle · manifest · the Claude producer ─
// Exported so a consumer (the dashboard) drives the SAME lifecycle the CLI does —
// one engine, no drift. Evidence identity is what makes a receipt mean what it says.
export * from './modes/review/evidence';
export * from './modes/review/evidence-manifest';
export * from './modes/review/worktree';
export * from './modes/review/code-review-seat';
// ── The foreign tail: posting posture · the staged PENDING review · the push fence ─
// Exported so a consumer (the Hugin dashboard's "Review & stage" button) drives the SAME
// placement + staging the CLI does. `--stage` is the thin CLI over exactly these.
export * from './modes/review/ensemble-config';
export * from './modes/review/posting-config';
export * from './modes/review/push-fence';
export * from './modes/review/stage';
export * from './modes/review/stage-plan';
// ── The HOLISTIC lens: the seat · its host-verified guardrails · the acceptance fixture ─
// Default off. Worktree evidence or it does not run. Its findings post agree-only, cap at MED
// unless a conventions doc is cited AND verified, and never borrow a corroboration signal.
export * from './modes/review/holistic';
export * from './modes/review/holistic-gate';
export * from './modes/review/holistic-fixture';
// ── Review PROFILES (code · security) + the security dependency-surface flag ──
export * from './modes/review/profile';
export * from './modes/review/dep-surface';

// ── The brainstorm MODE: roster · voices · prompts · parse · orchestration ────
export * from './modes/brainstorm';
export * from './modes/brainstorm/types';
export * from './modes/brainstorm/voices';
export * from './modes/brainstorm/claude';
export * from './modes/brainstorm/prompt';
export * from './modes/brainstorm/parse';

// ── The consult MODE (Q&A: independent answers → agree/diverge synthesis) ──────
// Namespaced (`export * as`) because it deliberately mirrors brainstorm's shape and
// shares exported names (pickSynthesizer · fallbackSynthesis · DEFAULT_VOICE_TIMEOUT_MS);
// a flat re-export would make those ambiguous at the root. Reach them as `consult.*`.
// Its consumer-facing result types are re-exported directly (no collision).
export * as consult from './modes/consult';
export type {
  AgreementPoint,
  ConsultResult,
  ConsultSynthesis,
  DivergencePoint,
  VoiceAnswerResult,
} from './modes/consult/types';

// ── Mode registry (mode-first) ───────────────────────────────────────────────
export * from './modes';
