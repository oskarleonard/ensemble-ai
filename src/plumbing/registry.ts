// The `reviewers` (alias `config`) plumbing command's PURE renderer — a read-only
// view of the configured cross-vendor registry. It reuses the engine's own config
// loaders (core/reviewers listReviewers · brainstorm/voices listVoices), so what it
// prints is EXACTLY what the modes run; there is no second source of truth and no
// mutation. The CLI does the file I/O (which config files exist) and hands the
// resolved rosters + paths here.

import type { ReviewerConfig } from '../core/types';
import type { VoiceConfig } from '../modes/brainstorm/types';
import type { SeatSource } from '../modes/review/gate-seat';

// The review-synthesis GATE seat, resolved for display: model/effort + where each came from
// (flag/file/default). Always a `claude -p` spawn, so no cmd/sandbox/vendor variance to show.
export interface GateSeatView {
  effort: string;
  effortSource: SeatSource;
  model: string;
  modelSource: SeatSource;
}

export interface RegistryView {
  // The review-synthesis GATE (resolved from the voices.json `gate` seat → claude voice → Opus).
  gate: GateSeatView;
  // The review/security reviewer roster (from reviewers.json or baked defaults).
  reviewers: ReviewerConfig[];
  reviewersFile: string;
  reviewersFileExists: boolean;
  // The brainstorm/consult voice roster (from voices.json or baked defaults).
  voices: VoiceConfig[];
  voicesFile: string;
  voicesFileExists: boolean;
}

// One agent row: `id     vendor · model @ effort[ · sandbox <name>]`. Shared by the
// reviewer + voice sections so both render identically (a VoiceConfig is
// structurally a ReviewerConfig — same fields).
function agentLine(c: ReviewerConfig | VoiceConfig): string {
  const sandbox = c.sandbox ? ` · sandbox ${c.sandbox}` : '';
  return `    ${c.id.padEnd(7)} ${c.vendor} · ${c.model} @ ${c.effort}${sandbox}`;
}

function sourceNote(file: string, exists: boolean): string {
  return exists ? file : `${file} — not present, using baked defaults`;
}

// The formatted, human-readable registry. PURE (a function of the view), so it is
// unit-tested directly with synthetic rosters — no filesystem needed.
export function renderRegistry(view: RegistryView): string {
  const out: string[] = [];
  out.push('');
  out.push('ensemble-ai registry — the configured cross-vendor agents (read-only)');
  out.push('');
  out.push('  review · security  (reviewers — the other vendor arbitrated by Munin)');
  out.push(`    config: ${sourceNote(view.reviewersFile, view.reviewersFileExists)}`);
  for (const r of view.reviewers) out.push(agentLine(r));
  out.push('');
  out.push('  brainstorm · consult  (voices — Claude joins; no independence concern)');
  out.push(`    config: ${sourceNote(view.voicesFile, view.voicesFileExists)}`);
  for (const v of view.voices) out.push(agentLine(v));
  out.push('');
  // The GATE (synthesis) seat — always claude -p; {model, effort} from the voices.json `gate`
  // entry → the claude voice → the built-in Opus default. Sources shown so it's clear WHERE the
  // resolved model/effort came from (flag/file/default) — the standing "which config" legibility.
  out.push('  review synthesis  (the verified GATE — always claude -p; {model,effort} only)');
  out.push(
    `    ${'gate'.padEnd(7)} anthropic · ${view.gate.model} @ ${view.gate.effort}  · source model:${view.gate.modelSource} · effort:${view.gate.effortSource}`
  );
  out.push('');
  return out.join('\n');
}
