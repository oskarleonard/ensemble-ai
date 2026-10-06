import {
  assertRosterAdvisors,
  loadVoices,
  VOICE_ADAPTERS,
  type VoiceRunResult,
} from '../brainstorm/voices';

import {
  parseDebateReply,
  parseJudgeReply,
  renderDebatePrompt,
  renderJudgePrompt,
  rulingsTally,
  splitsFromSynthesis,
  splitsStillOpen,
} from './debate';
import { parseAnswer, parseConsultSynthesis, parseCritique } from './parse';
import {
  renderAnswerPrompt,
  renderCritiquePrompt,
  renderSynthesisPrompt,
} from './prompt';
import {
  type ConsultResult,
  type ConsultSynthesis,
  type DebateResult,
  type DebateRound,
  type DebateSplit,
  type DebateVoiceRound,
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

// The debate after the synthesis: how many evidence rounds at most (a split stops early once a
// voice moves or nobody brings new evidence), and who judges. The judge is a voice id plus an
// optional model/effort override — the seat that rules should not be the one that argued, so
// a caller normally pins a different model (voices.json `judge`, or --judge). Absent config =
// that voice's own config, which the result then flags as NOT independent.
export interface DebateOptions {
  judge?: VoiceId;
  judgeConfig?: VoiceConfig;
  rounds: number;
}

export const DEFAULT_DEBATE_ROUNDS = 2;
export const MAX_DEBATE_ROUNDS = 4;

export interface ConsultOptions {
  // Injectable for tests — the real adapters spawn vendor CLIs.
  adapters?: Adapters;
  // Argue the divergences with evidence after the synthesis, then have a judge rule (off by
  // default; needs ≥2 healthy voices and ≥1 divergence to run at all).
  debate?: DebateOptions;
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
  log(`  · ${voiceId} (${config.vendor} · ${config.model}${config.web ? ' · web' : ''}) answering…`);
  let res: VoiceRunResult;
  try {
    res = await adapters[voiceId](prompt, config, { timeoutMs });
  } catch (e) {
    log(`  · ${voiceId}: failed to run — ${(e as Error).message}`);
    return { answer: '', error: (e as Error).message, keyPoints: [], ok: false, raw: null, summary: '', voiceId };
  }
  if (!res.raw || res.timedOut) {
    const error = (res.failWhy ?? (res.timedOut ? 'timed out' : 'produced no output'));
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
    const error = (res.failWhy ?? (res.timedOut ? 'timed out' : 'produced no output'));
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

// ── Rounds 4+: argue the splits with evidence, then an independent judge rules ─
async function runDebateVoice(
  voiceId: VoiceId,
  adapters: Adapters,
  configs: Record<VoiceId, VoiceConfig>,
  prompt: string,
  splitIds: readonly string[],
  timeoutMs: number,
  log: (m: string) => void
): Promise<DebateVoiceRound> {
  let res: VoiceRunResult;
  try {
    res = await adapters[voiceId](prompt, configs[voiceId], { timeoutMs });
  } catch (e) {
    log(`  · ${voiceId}: failed to run — ${(e as Error).message}`);
    return { entries: [], error: (e as Error).message, ok: false, raw: null, voiceId };
  }
  if (!res.raw || res.timedOut) {
    const error = res.failWhy ?? (res.timedOut ? 'timed out' : 'produced no output');
    log(`  · ${voiceId}: ${error}`);
    return { entries: [], error, ok: false, raw: res.raw, timedOut: res.timedOut, voiceId };
  }
  const parsed = parseDebateReply(res.raw, splitIds);
  if (parsed.parseError) {
    log(`  · ${voiceId}: ${parsed.parseError}`);
    return { entries: [], error: parsed.parseError, ok: false, raw: res.raw, voiceId };
  }
  const moved = parsed.entries.filter((e) => e.stance !== 'hold').length;
  const evidence = parsed.entries.reduce((n, e) => n + e.evidence.length, 0);
  log(
    `  · ${voiceId}: ${parsed.entries.length} position(s), ${evidence} evidence item(s), moved on ${moved}${
      parsed.downgraded.length ? ` (${parsed.downgraded.length} ungrounded move(s) held)` : ''
    }`
  );
  return { entries: parsed.entries, ok: true, raw: res.raw, voiceId };
}

// A judge is independent when its (voice, model) is not one that argued a side: a different
// model of the same vendor counts — the identical model that argued does not.
export function judgeIsIndependent(
  judgeId: VoiceId,
  judgeModel: string,
  participants: readonly VoiceId[],
  configs: Record<VoiceId, VoiceConfig>
): boolean {
  return !participants.some((id) => id === judgeId && configs[id].model === judgeModel);
}

async function runDebate(
  opts: ConsultOptions,
  debate: DebateOptions,
  adapters: Adapters,
  configs: Record<VoiceId, VoiceConfig>,
  answers: VoiceAnswerResult[],
  participants: VoiceId[],
  synthesis: ConsultSynthesis,
  timeoutMs: number,
  log: (m: string) => void
): Promise<DebateResult | undefined> {
  const splits: DebateSplit[] = splitsFromSynthesis(synthesis);
  if (synthesis.degraded) {
    log('Debate · skipped — the synthesis is the deterministic fallback (no divergences were judged)');
    return undefined;
  }
  if (splits.length === 0) {
    log('Debate · skipped — no divergence to argue');
    return undefined;
  }
  if (participants.length < 2) {
    log(`Debate · skipped — need ≥2 voices with answers (have ${participants.length})`);
    return undefined;
  }
  const maxRounds = Math.max(1, Math.min(MAX_DEBATE_ROUNDS, Math.floor(debate.rounds)));
  const rounds: DebateRound[] = [];
  let open = splits.map((s) => s.id);
  for (let round = 1; round <= maxRounds && open.length > 0; round++) {
    log(`Round ${3 + round} · debate ${round}/${maxRounds} — ${open.length} split(s), ${participants.length} voice(s)`);
    const argued = splits.filter((s) => open.includes(s.id));
    const voices = await Promise.all(
      participants.map((id) =>
        runDebateVoice(
          id,
          adapters,
          configs,
          renderDebatePrompt({
            fileContext: opts.fileContext,
            maxRounds,
            own: answers.find((a) => a.voiceId === id),
            prior: rounds,
            question: opts.question,
            round,
            splits: argued,
            voiceId: id,
          }),
          open,
          timeoutMs,
          log
        )
      )
    );
    const r: DebateRound = { round, splitIds: open, voices };
    rounds.push(r);
    if (voices.filter((v) => v.ok).length < 2) {
      log('  · fewer than two voices argued — no further round');
      break;
    }
    const next = splitsStillOpen(r, open);
    log(`  · ${open.length - next.length} split(s) closed this round, ${next.length} still open`);
    open = next;
  }

  const judgeId = debate.judge ?? pickSynthesizer(participants, undefined, answers) ?? participants[0];
  const judgeCfg = debate.judgeConfig ?? configs[judgeId];
  const independent = judgeIsIndependent(judgeId, judgeCfg.model, participants, configs);
  const judgeBase = { effort: judgeCfg.effort, independent, model: judgeCfg.model, voiceId: judgeId };
  log(
    `Judge · ${judgeId} (${judgeCfg.vendor} · ${judgeCfg.model}@${judgeCfg.effort}${independent ? ' · independent' : ' · ALSO ARGUED A SIDE'}) ruling on ${splits.length} split(s)…`
  );
  const prompt = renderJudgePrompt({ draft: synthesis, fileContext: opts.fileContext, question: opts.question, rounds, splits });
  let res: VoiceRunResult;
  try {
    res = await adapters[judgeId](prompt, judgeCfg, { timeoutMs });
  } catch (e) {
    log(`  · judge failed to run — ${(e as Error).message}`);
    return { judge: { ...judgeBase, error: (e as Error).message, ok: false, raw: null }, recommendation: '', rounds, rulings: [], splits, summary: '' };
  }
  if (!res.raw || res.timedOut) {
    const error = res.failWhy ?? (res.timedOut ? 'judge timed out' : 'judge produced no output');
    log(`  · ${error}`);
    return { judge: { ...judgeBase, error, ok: false, raw: res.raw }, recommendation: '', rounds, rulings: [], splits, summary: '' };
  }
  const parsed = parseJudgeReply(res.raw, splits.map((s) => s.id));
  if (parsed.parseError) {
    log(`  · judge output not parseable — ${parsed.parseError}`);
    return { judge: { ...judgeBase, error: parsed.parseError, ok: false, raw: res.raw }, recommendation: '', rounds, rulings: [], splits, summary: '' };
  }
  log(`  · rulings: ${rulingsTally(parsed.rulings) || 'none'}${parsed.rulings.length < splits.length ? ` (${splits.length - parsed.rulings.length} split(s) left unruled)` : ''}`);
  return {
    judge: { ...judgeBase, ok: true, raw: res.raw },
    recommendation: parsed.recommendation,
    rounds,
    rulings: parsed.rulings,
    splits,
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
  // The roster's advisors, checked before Round 1 spawns anything: an invalid one on a voice this
  // run uses refuses the whole run; a voice outside the roster is never read.
  assertRosterAdvisors(roster, configs, opts.voiceConfigs ? undefined : 'voices.json');
  // The judge's seat is checked the same way, up front — it may spawn a claude the roster does not.
  if (opts.debate?.judge && !roster.includes(opts.debate.judge))
    assertRosterAdvisors([opts.debate.judge], opts.debate.judgeConfig ? { ...configs, [opts.debate.judge]: opts.debate.judgeConfig } : configs, opts.voiceConfigs ? undefined : 'voices.json');
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

  // Rounds 4+ — optional: argue the divergences with evidence, then a judge rules.
  const debate = opts.debate
    ? await runDebate(opts, opts.debate, adapters, configs, answers, participants, synthesis, timeoutMs, log)
    : undefined;

  return { answers, critique, ...(debate ? { debate } : {}), question: opts.question, roster, synthesis };
}
