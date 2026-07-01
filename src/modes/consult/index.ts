import {
  loadVoices,
  VOICE_ADAPTERS,
  type VoiceRunResult,
} from '../brainstorm/voices';

import { parseAnswer, parseConsultSynthesis, parseCritique } from './parse';
import {
  renderAnswerPrompt,
  renderCritiquePrompt,
  renderSynthesisPrompt,
} from './prompt';
import {
  type ConsultResult,
  type ConsultSynthesis,
  type VoiceAnswerResult,
  type VoiceConfig,
  type VoiceCritiqueResult,
  VOICE_IDS,
  type VoiceId,
} from './types';

// Default per-voice timeout for a consult round (a reasoned answer is heavier than a
// brainstorm idea but lighter than an xhigh code audit; the CLI can override). The
// shared spawn watchdog enforces it.
export const DEFAULT_VOICE_TIMEOUT_MS = 300_000; // 5 min

type Adapters = Record<
  VoiceId,
  (
    prompt: string,
    config: VoiceConfig,
    opts?: { onSpawn?: (kill: () => void) => void; timeoutMs?: number }
  ) => Promise<VoiceRunResult>
>;

export interface ConsultOptions {
  // Injectable for tests — the real adapters spawn vendor CLIs.
  adapters?: Adapters;
  // Enable the optional round-2 cross-critique (default: false — consult is
  // answer→synthesize; the critique round is opt-in).
  critique?: boolean;
  fileContext?: string;
  onProgress?: (msg: string) => void;
  question: string;
  // Which voice runs the synthesis (default: claude if present + healthy, else the
  // first healthy answerer).
  synthesizer?: VoiceId;
  timeoutMs?: number;
  voiceConfigs?: Record<VoiceId, VoiceConfig>;
  voices?: VoiceId[];
  voicesFile?: string;
}

// ── Round 1: each voice answers the question INDEPENDENTLY ────────────────────
async function runAnswer(
  voiceId: VoiceId,
  adapters: Adapters,
  configs: Record<VoiceId, VoiceConfig>,
  prompt: string,
  timeoutMs: number,
  log: (m: string) => void
): Promise<VoiceAnswerResult> {
  const config = configs[voiceId];
  log(`  · ${voiceId} (${config.vendor} · ${config.model}) answering…`);
  let res: VoiceRunResult;
  try {
    res = await adapters[voiceId](prompt, config, { timeoutMs });
  } catch (e) {
    log(`  · ${voiceId}: failed to run — ${(e as Error).message}`);
    return { answer: '', error: (e as Error).message, keyPoints: [], ok: false, raw: null, summary: '', voiceId };
  }
  if (!res.raw || res.timedOut) {
    const error = res.timedOut ? 'timed out' : 'produced no output';
    log(`  · ${voiceId}: ${error}`);
    return { answer: '', error, keyPoints: [], ok: false, raw: res.raw, summary: '', timedOut: res.timedOut, voiceId };
  }
  const parsed = parseAnswer(res.raw);
  if (parsed.parseError) {
    log(`  · ${voiceId}: ${parsed.parseError}`);
    return { answer: '', error: parsed.parseError, keyPoints: [], ok: false, raw: res.raw, summary: parsed.summary, voiceId };
  }
  log(`  · ${voiceId}: answered (${parsed.keyPoints.length} key point(s))`);
  return {
    answer: parsed.answer,
    keyPoints: parsed.keyPoints,
    ok: true,
    raw: res.raw,
    summary: parsed.summary,
    voiceId,
  };
}

// ── Optional round 2: each voice critiques the OTHER voices' answers ──────────
async function runCritique(
  voiceId: VoiceId,
  adapters: Adapters,
  configs: Record<VoiceId, VoiceConfig>,
  question: string,
  answers: VoiceAnswerResult[],
  fileContext: string | undefined,
  timeoutMs: number,
  log: (m: string) => void
): Promise<VoiceCritiqueResult> {
  const config = configs[voiceId];
  const peers = answers.filter((a) => a.ok && a.voiceId !== voiceId);
  const prompt = renderCritiquePrompt(question, peers, fileContext);
  log(`  · ${voiceId} reviewing ${peers.length} peer answer(s)…`);
  let res: VoiceRunResult;
  try {
    res = await adapters[voiceId](prompt, config, { timeoutMs });
  } catch (e) {
    return { error: (e as Error).message, notes: [], ok: false, raw: null, summary: '', voiceId };
  }
  if (!res.raw || res.timedOut) {
    const error = res.timedOut ? 'timed out' : 'produced no output';
    return { error, notes: [], ok: false, raw: res.raw, summary: '', timedOut: res.timedOut, voiceId };
  }
  const parsed = parseCritique(res.raw);
  if (parsed.parseError) {
    return { error: parsed.parseError, notes: [], ok: false, raw: res.raw, summary: parsed.summary, voiceId };
  }
  log(`  · ${voiceId}: ${parsed.notes.length} note(s)`);
  return { notes: parsed.notes, ok: true, raw: res.raw, summary: parsed.summary, voiceId };
}

// Deterministic synthesis when the synthesizer voice is unavailable: present each
// answer's summary as its own point, credited to its voice, and make NO agreement /
// divergence claim (degraded=true) — separating signal needs a model, and a reader
// must not read confidence into a mechanical list.
export function fallbackSynthesis(answers: VoiceAnswerResult[]): ConsultSynthesis {
  const ok = answers.filter((a) => a.ok);
  return {
    agreements: [],
    by: null,
    degraded: true,
    divergences: ok.map((a) => ({
      point: a.summary || `${a.voiceId}'s answer`,
      positions: [`${a.voiceId}: ${(a.summary || a.answer).slice(0, 200)}`],
    })),
    ok: false,
    raw: null,
    recommendation: '',
    summary:
      ok.length > 0
        ? `Synthesizer unavailable — ${ok.length} answer(s) shown as-is, NOT compared for agreement.`
        : 'No answers were produced.',
  };
}

// ── Round 3: one voice converges — AGREE (confident) vs DIVERGE (look closer) ─
async function runSynthesis(
  synthId: VoiceId | null,
  adapters: Adapters,
  configs: Record<VoiceId, VoiceConfig>,
  question: string,
  answers: VoiceAnswerResult[],
  critique: VoiceCritiqueResult[],
  timeoutMs: number,
  log: (m: string) => void
): Promise<ConsultSynthesis> {
  const okAnswers = answers.filter((a) => a.ok);
  if (!synthId || okAnswers.length === 0) return fallbackSynthesis(answers);
  const prompt = renderSynthesisPrompt(question, answers, critique);
  log(`Synthesizing with ${synthId} — agreement vs divergence…`);
  let res: VoiceRunResult;
  try {
    res = await adapters[synthId](prompt, configs[synthId], { timeoutMs });
  } catch (e) {
    log(`  · synthesis failed (${synthId}) — using the deterministic fallback`);
    return { ...fallbackSynthesis(answers), error: (e as Error).message };
  }
  if (!res.raw || res.timedOut) {
    log(`  · synthesis produced no usable output — using the deterministic fallback`);
    return {
      ...fallbackSynthesis(answers),
      error: res.timedOut ? 'synthesis timed out' : 'synthesis produced no output',
    };
  }
  const parsed = parseConsultSynthesis(res.raw);
  if (parsed.parseError) {
    log(`  · synthesis output not parseable — using the deterministic fallback`);
    return { ...fallbackSynthesis(answers), error: parsed.parseError, raw: res.raw };
  }
  log(
    `  · synthesis: ${parsed.agreements.length} agreement(s), ${parsed.divergences.length} divergence(s)`
  );
  return {
    agreements: parsed.agreements,
    by: synthId,
    degraded: false,
    divergences: parsed.divergences,
    ok: true,
    raw: res.raw,
    recommendation: parsed.recommendation,
    summary: parsed.summary,
  };
}

// Pick the synthesizer: an explicit request that's in the roster wins; else prefer
// Claude if it answered healthily (the natural synthesizer voice); else the first
// healthy answerer; else null (→ deterministic fallback). Mirrors brainstorm.
export function pickSynthesizer(
  roster: VoiceId[],
  requested: VoiceId | undefined,
  answers: VoiceAnswerResult[]
): VoiceId | null {
  if (requested && roster.includes(requested)) return requested;
  const healthy = answers.filter((a) => a.ok).map((a) => a.voiceId);
  if (healthy.includes('claude')) return 'claude';
  return healthy[0] ?? null;
}

// The consult MODE end-to-end: (1) every voice answers the question INDEPENDENTLY (no
// anchoring — so agreement across voices is a real signal), (2) OPTIONALLY each voice
// critiques the others' answers (off by default), (3) one voice synthesizes, calling
// out where the voices AGREE (confident) vs DIVERGE (look closer). Emits FACTS — no
// gate/verdict. Each voice failure degrades gracefully (the others still run); an
// unavailable synthesizer degrades to a deterministic, clearly-flagged fallback.
export async function runConsultMode(opts: ConsultOptions): Promise<ConsultResult> {
  const log = opts.onProgress ?? (() => {});
  const roster = opts.voices && opts.voices.length > 0 ? opts.voices : [...VOICE_IDS];
  const adapters = opts.adapters ?? VOICE_ADAPTERS;
  const configs = opts.voiceConfigs ?? loadVoices(opts.voicesFile);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS;

  // Round 1 — independent answers (parallel; one voice's failure is isolated).
  log(`Round 1 · independent answers — ${roster.length} voice(s): ${roster.join(', ')}`);
  const answerPrompt = renderAnswerPrompt(opts.question, opts.fileContext);
  const answers = await Promise.all(
    roster.map((id) => runAnswer(id, adapters, configs, answerPrompt, timeoutMs, log))
  );
  const participants = answers.filter((a) => a.ok).map((a) => a.voiceId);

  // Round 2 — optional cross-critique (needs ≥2 healthy answers; there is nothing to
  // cross-critique otherwise). Off by default.
  let critique: VoiceCritiqueResult[] = [];
  if (opts.critique && participants.length >= 2) {
    log(`Round 2 · cross-critique — ${participants.length} voice(s)`);
    critique = await Promise.all(
      participants.map((id) =>
        runCritique(id, adapters, configs, opts.question, answers, opts.fileContext, timeoutMs, log)
      )
    );
  } else if (opts.critique) {
    log(`Round 2 · skipped — need ≥2 voices with answers (have ${participants.length})`);
  }

  // Round 3 — converge.
  const synthId = pickSynthesizer(roster, opts.synthesizer, answers);
  const synthesis = await runSynthesis(
    synthId,
    adapters,
    configs,
    opts.question,
    answers,
    critique,
    timeoutMs,
    log
  );

  return { answers, critique, question: opts.question, roster, synthesis };
}
