// ensemble-ai — the library surface.
//
// Consumers (e.g. a dashboard) IMPORT this to run the cross-vendor review engine
// in-process — the SAME engine the `ensemble-ai` CLI runs, so there is ONE engine
// and zero drift. The engine emits FACTS (typed findings + per-reviewer execution
// status + coverage + a content-tied receipt); the gate POLICY is the consumer's.

// ── Contracts (vendor-neutral wire shapes) ──────────────────────────────────
export * from './core/types';

// ── Pure engine (packet · prompt · findings) ────────────────────────────────
export * from './core/findings';
export * from './core/packet';
export * from './core/prompt';

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

// ── The review MODE: diff acquisition · secret-scan · the content-tied receipt ─
export * from './modes/review';
export * from './modes/review/diff';
export * from './modes/review/secret-scan';
export * from './modes/review/receipt';

// ── Mode registry (mode-first) ───────────────────────────────────────────────
export * from './modes';
