// The `reviewers` (alias `config`) plumbing command's PURE renderer — a read-only
// view of the configured cross-vendor registry. It reuses the engine's own config
// loaders (core/reviewers listReviewers · brainstorm/voices listVoices), so what it
// prints is EXACTLY what the modes run; there is no second source of truth and no
// mutation. The CLI does the file I/O (which config files exist) and hands the
// resolved rosters + paths here.

import { isSeatAdvisor, REVIEWER_IDS, type ReviewerConfig, type ReviewerId } from '../core/types';
import type { VoiceConfig } from '../modes/brainstorm/types';
import type { SeatSource } from '../modes/review/gate-seat';

// The review-synthesis GATE seat, resolved for display: model/effort + where each came from
// (flag/file/default). Always a `claude -p` spawn, so no cmd/sandbox/vendor variance to show.
export interface GateSeatView {
  // The anthropic gate's own advisor AS WRITTEN (a model id or "off"; absent = inherits the
  // operator's ~/.claude/settings.json). Carried like the claude voice row's: a value the rule
  // rejects is kept and the row marks it, beside the seat's other resolved fields.
  advisor?: unknown;
  effort: string;
  effortSource: SeatSource;
  model: string;
  modelSource: SeatSource;
  // The gate's resolved vendor (the sol-gate axis). Optional so pre-vendor callers/tests keep
  // rendering; absent renders as anthropic — the only vendor that existed before the axis.
  vendor?: string;
  vendorSource?: SeatSource;
}

// The holistic LENS seat (`review --holistic --repo`), resolved for display: model/effort through
// its own chain, and its advisor carried as written the same way. Always a `claude -p` spawn.
export interface HolisticSeatView {
  advisor?: unknown;
  effort: string;
  model: string;
}

export interface RegistryView {
  // The seats that are ON right now — `enabledReviewerIds` resolved at print time, the ONE
  // owner of the off-switch rule, so a consumer that fans out through the CLI (rather than the
  // library) can read the roster here instead of re-deriving it from `disabledUntil` itself.
  enabledReviewerIds: ReviewerId[];
  // The review-synthesis GATE (resolved from the voices.json `gate` seat → claude voice → Opus).
  gate: GateSeatView;
  // The holistic lens (from the voices.json `holistic` entry → the built-in opus @ high).
  holistic: HolisticSeatView;
  // Every seat that is OFF, with its quota window when that is what holds it off. `until` is
  // null for an indefinite `enabled: false` (an `enabled: false` seat that also carries a date
  // reports null too — the date is not what the switch honours). Same rule as the fan-out.
  offSeats: OffSeat[];
  // The review/security reviewer roster (from reviewers.json or baked defaults) — EVERY
  // configured seat, on or off; `enabledReviewerIds` is what tells the two apart.
  reviewers: ReviewerConfig[];
  reviewersFile: string;
  reviewersFileExists: boolean;
  // The brainstorm/consult voice roster (from voices.json or baked defaults).
  voices: VoiceConfig[];
  voicesFile: string;
  voicesFileExists: boolean;
}

export interface OffSeat {
  id: ReviewerId;
  until: string | null;
}

// The off seats, derived from ONE parsed config by the same predicate the fan-out uses —
// never a second reading of `enabled`/`disabledUntil`.
export function offSeatsOf(
  config: Record<ReviewerId, ReviewerConfig>,
  enabled: readonly ReviewerId[]
): OffSeat[] {
  const on = new Set<ReviewerId>(enabled);
  return REVIEWER_IDS.filter((id) => !on.has(id)).map((id) => {
    const c = config[id];
    const until = c?.enabled === false ? null : (c?.disabledUntil ?? null);
    return { id, until };
  });
}

// One agent row: `id     vendor · model @ effort[ · advisor <x>][ · sandbox <name>][ · OFF …]`.
// Shared by the reviewer + voice sections so both render identically (a VoiceConfig is
// structurally a ReviewerConfig — same fields). Only reviewer rows can carry an OFF note.
function agentLine(c: ReviewerConfig | VoiceConfig, off?: OffSeat): string {
  const sandbox = c.sandbox ? ` · sandbox ${c.sandbox}` : '';
  // Voices only (ReviewerConfig has no `web`): the claude voice's web research opt-in.
  const web = 'web' in c && c.web === true ? ' · web' : '';
  const offNote = off ? (off.until ? ` · OFF until ${off.until}` : ' · OFF (enabled: false)') : '';
  return `    ${c.id.padEnd(7)} ${c.vendor} · ${c.model} @ ${c.effort}${advisorNote(c.advisor)}${web}${sandbox}${offNote}`;
}

// ` · advisor <model|off>` when a Claude seat states one; nothing when it inherits the operator's
// settings (absent), so an unconfigured registry renders exactly as before. A value the rule
// rejects is shown as-is (JSON, so `null` is visibly not "null") and marked: the config parse
// carries it, and only a command that spawns the seat refuses it.
function advisorNote(advisor: unknown): string {
  if (advisor === undefined) return '';
  if (isSeatAdvisor(advisor)) return ` · advisor ${advisor}`;
  return ` · advisor ${JSON.stringify(advisor)} (INVALID — a command that runs this seat refuses it)`;
}

function gateLine(gate: GateSeatView): string {
  return `    ${'gate'.padEnd(7)} ${gate.vendor ?? 'anthropic'} · ${gate.model} @ ${gate.effort}${advisorNote(gate.advisor)}  · source model:${gate.modelSource} · effort:${gate.effortSource}${gate.vendor && gate.vendor !== 'anthropic' ? ` · vendor:${gate.vendorSource ?? 'default'}` : ''}`;
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
  for (const r of view.reviewers)
    out.push(agentLine(r, view.offSeats.find((o) => o.id === r.id)));
  if (view.offSeats.length > 0)
    out.push(
      `    on right now: ${view.enabledReviewerIds.length > 0 ? view.enabledReviewerIds.join(', ') : 'NONE — every seat is switched off'}`
    );
  out.push('');
  out.push('  brainstorm · consult  (voices — Claude joins; no independence concern)');
  out.push(`    config: ${sourceNote(view.voicesFile, view.voicesFileExists)}`);
  for (const v of view.voices) out.push(agentLine(v));
  out.push('');
  // The GATE (synthesis) seat — claude -p unless `gate.vendor` says codex; {model, effort} from the
  // voices.json `gate` entry → the claude voice → the built-in Opus default, and its own `advisor`.
  // Sources shown so it's clear WHERE the resolved model/effort came from (flag/file/default) — the
  // standing "which config" legibility.
  out.push('  review synthesis  (the verified GATE — claude -p unless gate.vendor is codex; {model,effort,advisor})');
  out.push(gateLine(view.gate));
  out.push('');
  out.push('  holistic lens  (review --holistic --repo — always claude -p; {model,effort,advisor})');
  out.push(
    `    holistic anthropic · ${view.holistic.model} @ ${view.holistic.effort}${advisorNote(view.holistic.advisor)}`
  );
  out.push('');
  return out.join('\n');
}
