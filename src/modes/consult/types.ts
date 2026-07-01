// Consult mode — pose a QUESTION to the ensemble, each voice answers
// INDEPENDENTLY, then one voice synthesizes: what they AGREE on (confident) vs
// where they DIVERGE (look closer). The simpler sibling of brainstorm: a single
// answer round → synthesis (an optional cross-critique round sits between them,
// OFF by default). Reuses brainstorm's roster + spawn + config plumbing — this
// file adds only the consult-specific typed wire shapes. NO node imports.

import { type CritiqueStance } from '../brainstorm/types';

// Consult reuses the brainstorm ROSTER (codex + grok + claude) verbatim — the same
// voices.json config, the same VoiceId/VoiceConfig, the same adapters. Re-exported
// here so consult callers never reach across into brainstorm's module for them.
export {
  CRITIQUE_STANCES,
  type CritiqueStance,
  isVoiceId,
  parseVoiceIds,
  type VoiceConfig,
  VOICE_IDS,
  type VoiceId,
} from '../brainstorm/types';
import type { VoiceId } from '../brainstorm/types';

// Round 1 — one voice's INDEPENDENT answer to the question. `keyPoints` are the
// discrete claims the synthesizer aligns across voices to find agreement/divergence.
// `ok` = ran and produced a parseable answer; a failure degrades to ok:false with
// the reason, never taking down the other voices.
export interface VoiceAnswerResult {
  answer: string;
  error?: string;
  keyPoints: string[];
  ok: boolean;
  raw: string | null;
  summary: string;
  timedOut?: boolean;
  voiceId: VoiceId;
}

// Optional round 2 — one voice's notes on the OTHER voices' answers (agree /
// push-back / refine). Off by default; enabled with --critique. `target` is free
// text (the voice id or claim referenced) — the model is not forced to echo ids.
export interface AnswerNote {
  assessment: string;
  stance: CritiqueStance;
  target: string;
}

export interface VoiceCritiqueResult {
  error?: string;
  notes: AnswerNote[];
  ok: boolean;
  raw: string | null;
  summary: string;
  timedOut?: boolean;
  voiceId: VoiceId;
}

// One consensus point — a claim the synthesizer judged the voices AGREE on, with
// the voices that backed it. High-agreement points are the confident answer.
export interface AgreementPoint {
  point: string;
  voices: string[];
}

// One divergence — a question the voices answered DIFFERENTLY. `positions` records
// who-said-what so a reader can see the split and look closer.
export interface DivergencePoint {
  point: string;
  positions: string[];
}

// Round 3 — the converged answer. `agreements` = confident (voices concur);
// `divergences` = look closer (they split). `degraded` = the synthesizer voice was
// unavailable and a DETERMINISTIC fallback assembled this from the raw answers (no
// model judgement of agreement) — a reader must not read confidence into it.
export interface ConsultSynthesis {
  agreements: AgreementPoint[];
  by: VoiceId | null;
  degraded: boolean;
  divergences: DivergencePoint[];
  error?: string;
  ok: boolean;
  raw: string | null;
  recommendation: string;
  summary: string;
}

// The whole consult — FACTS only (the rounds that ran), no gate/verdict.
export interface ConsultResult {
  answers: VoiceAnswerResult[];
  critique: VoiceCritiqueResult[];
  question: string;
  roster: VoiceId[];
  synthesis: ConsultSynthesis;
}
