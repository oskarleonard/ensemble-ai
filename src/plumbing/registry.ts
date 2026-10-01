// The `reviewers` (alias `config`) plumbing command's PURE renderer — a read-only
// view of the configured cross-vendor registry. It reuses the engine's own config
// loaders (core/reviewers listReviewers · brainstorm/voices listVoices), so what it
// prints is EXACTLY what the modes run; there is no second source of truth and no
// mutation. The CLI does the file I/O (which config files exist) and hands the
// resolved rosters + paths here.

import { REVIEWER_IDS, type ReviewerConfig, type ReviewerId } from '../core/types';
import type { VoiceConfig } from '../modes/brainstorm/types';
import type { SeatSource } from '../modes/review/gate-seat';

// The review-synthesis GATE seat, resolved for display: model/effort + where each came from
// (flag/file/default). Always a `claude -p` spawn, so no cmd/sandbox/vendor variance to show.
export interface GateSeatView {
  // The anthropic gate's own advisor (a model id or "off"); absent = inherits the operator's
  // ~/.claude/settings.json. Same field the claude reviewer/voice rows carry.
  advisor?: string;
  effort: string;
  effortSource: SeatSource;
  model: string;
  modelSource: SeatSource;
  // The gate's resolved vendor (the sol-gate axis). Optional so pre-vendor callers/tests keep
  // rendering; absent renders as anthropic — the only vendor that existed before the axis.
  vendor?: string;
  vendorSource?: SeatSource;
}

export interface RegistryView {
  // The seats that are ON right now — `enabledReviewerIds` resolved at print time, the ONE
  // owner of the off-switch rule, so a consumer that fans out through the CLI (rather than the
  // library) can read the roster here instead of re-deriving it from `disabledUntil` itself.
  enabledReviewerIds: ReviewerId[];
  // The review-synthesis GATE (resolved from the voices.json `gate` seat → claude voice → Opus).
  gate: GateSeatView;
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
  const offNote = off ? (off.until ? ` · OFF until ${off.until}` : ' · OFF (enabled: false)') : '';
  return `    ${c.id.padEnd(7)} ${c.vendor} · ${c.model} @ ${c.effort}${advisorNote(c.advisor)}${sandbox}${offNote}`;
}

// ` · advisor <model|off>` when a Claude seat states one; nothing when it inherits the operator's
// settings (absent), so an unconfigured registry renders exactly as before.
function advisorNote(advisor: string | undefined): string {
  return advisor === undefined ? '' : ` · advisor ${advisor}`;
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
  // The GATE (synthesis) seat — always claude -p; {model, effort} from the voices.json `gate`
  // entry → the claude voice → the built-in Opus default. Sources shown so it's clear WHERE the
  // resolved model/effort came from (flag/file/default) — the standing "which config" legibility.
  out.push('  review synthesis  (the verified GATE — always claude -p; {model,effort} only)');
  out.push(
    `    ${'gate'.padEnd(7)} ${view.gate.vendor ?? 'anthropic'} · ${view.gate.model} @ ${view.gate.effort}${advisorNote(view.gate.advisor)}  · source model:${view.gate.modelSource} · effort:${view.gate.effortSource}${view.gate.vendor && view.gate.vendor !== 'anthropic' ? ` · vendor:${view.gate.vendorSource ?? 'default'}` : ''}`
  );
  out.push('');
  return out.join('\n');
}
