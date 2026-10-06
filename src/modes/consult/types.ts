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

// ── Optional rounds 4+ — DEBATE the divergences with EVIDENCE (off by default) ──
// Once the synthesis has named the splits, each diverging voice argues ITS side of every
// split with proof — a quote from the shared document, a web source, or a mechanism argument
// marked as reasoning — answers the other side, and may MOVE only by naming the evidence that
// moved it (agreeing to be agreeable is the failure mode of model debate; so is holding
// without proof). A split goes to another round only while new evidence is on the table.
// Then a JUDGE that took no part rules on each split BY THE EVIDENCE and writes the final
// recommendation. A split the evidence cannot decide is handed back to the human as a
// judgement call with the trade-off stated — never a coin flip dressed as a verdict.
export const DEBATE_STANCES = ['hold', 'move', 'concede'] as const;
export type DebateStance = (typeof DEBATE_STANCES)[number];

export interface DebateEvidence {
  // What it shows for this split.
  bearing: string;
  // The quoted or paraphrased content.
  quote: string;
  // "doc §3.2" · "web <url>" · "reasoning" — the kind of proof and where it is.
  source: string;
}

// One voice's entry on one split in one round.
export interface DebateEntry {
  evidence: DebateEvidence[];
  // Required when stance is move/concede: the evidence (theirs or own) that moved the voice.
  // A move without it is downgraded to a hold at parse time — the guard IS the feature.
  movedBecause?: string;
  // The voice's position after this round, one or two sentences.
  position: string;
  // The reply to the other side's position and evidence (not its wording).
  rebuttal: string;
  splitId: string;
  stance: DebateStance;
  // What would change the voice's mind (a hold), or what it could not verify.
  wouldChangeMind?: string;
}

export interface DebateVoiceRound {
  entries: DebateEntry[];
  error?: string;
  ok: boolean;
  raw: string | null;
  timedOut?: boolean;
  voiceId: VoiceId;
}

export interface DebateRound {
  round: number;
  // The splits argued this round — those still open with evidence on the table.
  splitIds: string[];
  voices: DebateVoiceRound[];
}

export const RULING_OUTCOMES = ['settled', 'converged', 'judgement', 'unverified'] as const;
export type RulingOutcome = (typeof RULING_OUTCOMES)[number];

export interface SplitRuling {
  // The default to take if the human does not decide (judgement / unverified).
  defaultIfUndecided?: string;
  // settled / converged: the position that stands (whose, and what). judgement: the trade-off
  // in one line. unverified: the fact nobody could check.
  direction: string;
  // The evidence the ruling rests on, as "<voice>: <source>".
  evidenceCited: string[];
  outcome: RulingOutcome;
  splitId: string;
  // What would settle it (unverified): data, an author's answer, a test.
  whatWouldSettle?: string;
  why: string;
}

export interface DebateSplit {
  id: string;
  point: string;
  positions: string[];
}

export interface DebateJudge {
  effort: string;
  error?: string;
  // true = the judge's (voice, model) is not one of the debating voices' — a different model
  // of the same vendor counts; the identical model that argued a side does not.
  independent: boolean;
  model: string;
  ok: boolean;
  raw: string | null;
  voiceId: VoiceId;
}

export interface DebateResult {
  judge: DebateJudge;
  // The judge's recommendation in light of the rulings — the reader's final word. The
  // synthesizer's draft stays on synthesis.recommendation. Empty when the judge failed.
  recommendation: string;
  rounds: DebateRound[];
  rulings: SplitRuling[];
  splits: DebateSplit[];
  summary: string;
}

// The whole consult — FACTS only (the rounds that ran), no gate/verdict.
export interface ConsultResult {
  answers: VoiceAnswerResult[];
  critique: VoiceCritiqueResult[];
  // Present only when --debate ran (needs ≥2 healthy voices and ≥1 divergence).
  debate?: DebateResult;
  question: string;
  roster: VoiceId[];
  synthesis: ConsultSynthesis;
}
