import { parseCritique, parseIdeas, parseSynthesis } from './parse';
import {
  renderCritiquePrompt,
  renderGeneratePrompt,
  renderSynthesisPrompt,
} from './prompt';
import {
  type BrainstormResult,
  type Idea,
  type RankedIdea,
  type SynthesisResult,
  type VoiceConfig,
  type VoiceCritiqueResult,
  type VoiceGenerateResult,
  VOICE_IDS,
  type VoiceId,
} from './types';
import { loadVoices, VOICE_ADAPTERS, type VoiceRunResult } from './voices';

// Default per-voice timeout for a brainstorm round (ideation is lighter than an
// xhigh code audit; the CLI can override). The shared spawn watchdog enforces it.
export const DEFAULT_VOICE_TIMEOUT_MS = 300_000; // 5 min

type Adapters = Record<
  VoiceId,
  (
    prompt: string,
    config: VoiceConfig,
    opts?: { onSpawn?: (kill: () => void) => void; timeoutMs?: number }
  ) => Promise<VoiceRunResult>
>;

export interface BrainstormOptions {
  // Injectable for tests — the real adapters spawn vendor CLIs.
  adapters?: Adapters;
  fileContext?: string;
  onProgress?: (msg: string) => void;
  // Which voice runs round 3 (default: claude if present + healthy, else the first
  // healthy generator).
  synthesizer?: VoiceId;
  timeoutMs?: number;
  topic: string;
  voiceConfigs?: Record<VoiceId, VoiceConfig>;
  voices?: VoiceId[];
  voicesFile?: string;
}

// ── Round 1: each voice generates ideas INDEPENDENTLY ────────────────────────
async function runGenerate(
  voiceId: VoiceId,
  adapters: Adapters,
  configs: Record<VoiceId, VoiceConfig>,
  prompt: string,
  timeoutMs: number,
  log: (m: string) => void
): Promise<VoiceGenerateResult> {
  const config = configs[voiceId];
  log(`  · ${voiceId} (${config.vendor} · ${config.model}) generating…`);
  let res: VoiceRunResult;
  try {
    res = await adapters[voiceId](prompt, config, { timeoutMs });
  } catch (e) {
    log(`  · ${voiceId}: failed to run — ${(e as Error).message}`);
    return { error: (e as Error).message, ideas: [], ok: false, raw: null, summary: '', voiceId };
  }
  if (!res.raw || res.timedOut) {
    const error = res.timedOut ? 'timed out' : 'produced no output';
    log(`  · ${voiceId}: ${error}`);
    return { error, ideas: [], ok: false, raw: res.raw, summary: '', timedOut: res.timedOut, voiceId };
  }
  const parsed = parseIdeas(res.raw);
  if (parsed.parseError || parsed.ideas.length === 0) {
    const error = parsed.parseError ?? 'no ideas in the output';
    log(`  · ${voiceId}: ${error}`);
    return { error, ideas: [], ok: false, raw: res.raw, summary: parsed.summary, voiceId };
  }
  // Assign stable ids (`codex-1`, …) + author so critique/synthesis can reference them.
  const ideas: Idea[] = parsed.ideas.map((i, n) => ({
    body: i.body,
    id: `${voiceId}-${n + 1}`,
    title: i.title,
    voiceId,
  }));
  log(`  · ${voiceId}: ${ideas.length} idea(s)`);
  return { ideas, ok: true, raw: res.raw, summary: parsed.summary, voiceId };
}

// ── Round 2: each voice critiques + extends the OTHER voices' ideas ──────────
async function runCritique(
  voiceId: VoiceId,
  adapters: Adapters,
  configs: Record<VoiceId, VoiceConfig>,
  topic: string,
  allIdeas: Idea[],
  fileContext: string | undefined,
  timeoutMs: number,
  log: (m: string) => void
): Promise<VoiceCritiqueResult> {
  const config = configs[voiceId];
  const peerIdeas = allIdeas.filter((i) => i.voiceId !== voiceId);
  const prompt = renderCritiquePrompt(topic, peerIdeas, fileContext);
  log(`  · ${voiceId} critiquing ${peerIdeas.length} peer idea(s)…`);
  let res: VoiceRunResult;
  try {
    res = await adapters[voiceId](prompt, config, { timeoutMs });
  } catch (e) {
    return { critiques: [], error: (e as Error).message, extensions: [], ok: false, raw: null, summary: '', voiceId };
  }
  if (!res.raw || res.timedOut) {
    const error = res.timedOut ? 'timed out' : 'produced no output';
    return { critiques: [], error, extensions: [], ok: false, raw: res.raw, summary: '', timedOut: res.timedOut, voiceId };
  }
  const parsed = parseCritique(res.raw);
  if (parsed.parseError) {
    return { critiques: [], error: parsed.parseError, extensions: [], ok: false, raw: res.raw, summary: parsed.summary, voiceId };
  }
  log(`  · ${voiceId}: ${parsed.critiques.length} critique(s), ${parsed.extensions.length} extension(s)`);
  return {
    critiques: parsed.critiques,
    extensions: parsed.extensions,
    ok: true,
    raw: res.raw,
    summary: parsed.summary,
    voiceId,
  };
}

// Normalize a title for dedupe (lowercase, alnum-collapsed). Two voices proposing
// the "same" idea under slightly different wording collapse into one fallback entry.
function dedupeKey(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Deterministic synthesis when the synthesizer voice is unavailable: dedupe ideas by
// normalized title, credit every contributing voice, present them UNRANKED-by-merit
// (degraded=true) so a reader knows it is not a model judgement.
export function fallbackSynthesis(allIdeas: Idea[]): SynthesisResult {
  const seen = new Map<string, RankedIdea>();
  for (const idea of allIdeas) {
    const key = dedupeKey(idea.title) || idea.id;
    const existing = seen.get(key);
    if (existing) {
      if (idea.voiceId && !existing.contributors.includes(idea.voiceId)) {
        existing.contributors.push(idea.voiceId);
      }
      continue;
    }
    seen.set(key, {
      contributors: idea.voiceId ? [idea.voiceId] : [],
      rank: 0,
      title: idea.title,
      why: idea.body,
    });
  }
  const ranked = [...seen.values()].map((r, i) => ({ ...r, rank: i + 1 }));
  return {
    by: null,
    degraded: true,
    ok: false,
    ranked,
    raw: null,
    summary:
      ranked.length > 0
        ? `Synthesis voice unavailable — ${ranked.length} de-duplicated idea(s) from the voices, not ranked by merit.`
        : 'No ideas were generated.',
  };
}

// ── Round 3: one voice converges everything into a ranked recommendation ─────
async function runSynthesis(
  synthId: VoiceId | null,
  adapters: Adapters,
  configs: Record<VoiceId, VoiceConfig>,
  topic: string,
  allIdeas: Idea[],
  critiqueResults: VoiceCritiqueResult[],
  timeoutMs: number,
  log: (m: string) => void
): Promise<SynthesisResult> {
  if (!synthId || allIdeas.length === 0) return fallbackSynthesis(allIdeas);
  const prompt = renderSynthesisPrompt(topic, allIdeas, critiqueResults);
  log(`Round 3 · synthesizing with ${synthId}…`);
  let res: VoiceRunResult;
  try {
    res = await adapters[synthId](prompt, configs[synthId], { timeoutMs });
  } catch (e) {
    log(`  · synthesis failed (${synthId}) — using the deterministic fallback`);
    return { ...fallbackSynthesis(allIdeas), error: (e as Error).message };
  }
  if (!res.raw || res.timedOut) {
    log(`  · synthesis produced no usable output — using the deterministic fallback`);
    return {
      ...fallbackSynthesis(allIdeas),
      error: res.timedOut ? 'synthesis timed out' : 'synthesis produced no output',
    };
  }
  const parsed = parseSynthesis(res.raw);
  if (parsed.parseError || parsed.ranked.length === 0) {
    log(`  · synthesis output not parseable — using the deterministic fallback`);
    return {
      ...fallbackSynthesis(allIdeas),
      error: parsed.parseError ?? 'no ranked ideas parsed',
      raw: res.raw,
    };
  }
  log(`  · synthesis: ${parsed.ranked.length} ranked recommendation(s)`);
  return { by: synthId, degraded: false, ok: true, ranked: parsed.ranked, raw: res.raw, summary: parsed.summary };
}

// Pick the round-3 synthesizer: an explicit request that's in the roster wins; else
// prefer Claude if it generated healthily (the natural synthesizer voice); else the
// first healthy generator; else null (→ deterministic fallback).
export function pickSynthesizer(
  roster: VoiceId[],
  requested: VoiceId | undefined,
  generate: VoiceGenerateResult[]
): VoiceId | null {
  if (requested && roster.includes(requested)) return requested;
  const healthy = generate.filter((g) => g.ok).map((g) => g.voiceId);
  if (healthy.includes('claude')) return 'claude';
  return healthy[0] ?? null;
}

// The brainstorm MODE end-to-end: (1) every voice generates ideas INDEPENDENTLY (no
// anchoring), (2) each voice critiques + extends the OTHERS' ideas, (3) one voice
// synthesizes a ranked, de-duplicated recommendation. Emits FACTS (the three rounds)
// — no gate/verdict. Each voice failure degrades gracefully (the others still run);
// an unavailable synthesizer degrades to a deterministic dedupe.
export async function runBrainstormMode(
  opts: BrainstormOptions
): Promise<BrainstormResult> {
  const log = opts.onProgress ?? (() => {});
  const roster =
    opts.voices && opts.voices.length > 0 ? opts.voices : [...VOICE_IDS];
  const adapters = opts.adapters ?? VOICE_ADAPTERS;
  const configs = opts.voiceConfigs ?? loadVoices(opts.voicesFile);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS;

  // Round 1 — independent generation (parallel; one voice's failure is isolated).
  log(`Round 1 · independent ideation — ${roster.length} voice(s): ${roster.join(', ')}`);
  const genPrompt = renderGeneratePrompt(opts.topic, opts.fileContext);
  const generate = await Promise.all(
    roster.map((id) => runGenerate(id, adapters, configs, genPrompt, timeoutMs, log))
  );

  const allIdeas: Idea[] = generate.flatMap((g) => g.ideas);
  const participants = generate.filter((g) => g.ok).map((g) => g.voiceId);

  // Round 2 — cross-critique (needs ≥2 voices with ideas; else there's nothing to
  // cross-critique). Each critic sees ONLY the others' ideas.
  let critique: VoiceCritiqueResult[] = [];
  if (participants.length >= 2) {
    log(`Round 2 · cross-critique — ${participants.length} voice(s)`);
    critique = await Promise.all(
      participants.map((id) =>
        runCritique(id, adapters, configs, opts.topic, allIdeas, opts.fileContext, timeoutMs, log)
      )
    );
  } else {
    log(`Round 2 · skipped — need ≥2 voices with ideas (have ${participants.length})`);
  }

  // Round 3 — converge.
  const synthId = pickSynthesizer(roster, opts.synthesizer, generate);
  const synthesis = await runSynthesis(
    synthId,
    adapters,
    configs,
    opts.topic,
    allIdeas,
    critique,
    timeoutMs,
    log
  );

  return { critique, generate, roster, synthesis, topic: opts.topic };
}
