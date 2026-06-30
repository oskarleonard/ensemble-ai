import { describe, expect, it } from 'vitest';

import {
  fallbackSynthesis,
  pickSynthesizer,
  runBrainstormMode,
} from './index';
import type { Idea, VoiceConfig, VoiceGenerateResult, VoiceId } from './types';
import { VOICE_DEFAULTS, type VoiceRunResult } from './voices';

// A fake voice adapter that branches on the prompt round (generate / critique /
// synthesis) — so no real CLI is spawned. Records every (voiceId, prompt) call.
type Reply = { critique?: string; generate?: string; synthesis?: string; fail?: 'throw' | 'null' | 'timeout' };

function ok(raw: string): VoiceRunResult {
  return { ok: true, raw, stderrTail: '', timedOut: false };
}

function makeAdapters(
  replies: Partial<Record<VoiceId, Reply>>,
  calls: Array<{ prompt: string; voiceId: VoiceId }>
) {
  const adapter = (voiceId: VoiceId) =>
    async (prompt: string, _c: VoiceConfig): Promise<VoiceRunResult> => {
      calls.push({ prompt, voiceId });
      const r = replies[voiceId] ?? {};
      const round = prompt.includes('SYNTHESIZER')
        ? 'synthesis'
        : prompt.includes('constructive critic')
          ? 'critique'
          : 'generate';
      if (r.fail === 'throw') throw new Error('boom');
      if (r.fail === 'null') return { ok: false, raw: null, stderrTail: '', timedOut: false };
      if (r.fail === 'timeout') return { ok: false, raw: 'partial', stderrTail: '', timedOut: true };
      const raw = r[round];
      if (raw === undefined) return { ok: false, raw: null, stderrTail: '', timedOut: false };
      return ok(raw);
    };
  return {
    claude: adapter('claude'),
    codex: adapter('codex'),
    grok: adapter('grok'),
  };
}

const GEN = (a: string, b: string) =>
  `\`\`\`json\n{"summary":"sum","ideas":[{"title":"${a}","body":"b1"},{"title":"${b}","body":"b2"}]}\n\`\`\``;
const CRIT = '{"summary":"cs","critiques":[{"target":"x","stance":"concern","assessment":"weak"}],"extensions":[]}';
const SYNTH = '{"summary":"final","ranked":[{"title":"Winner","why":"best","contributors":["codex","grok"]}]}';

const configs = VOICE_DEFAULTS;

describe('runBrainstormMode — generate → critique → converge', () => {
  it('runs all three rounds with the full roster', async () => {
    const calls: Array<{ prompt: string; voiceId: VoiceId }> = [];
    const adapters = makeAdapters(
      {
        claude: { generate: GEN('Cl1', 'Cl2'), critique: CRIT, synthesis: SYNTH },
        codex: { generate: GEN('Co1', 'Co2'), critique: CRIT },
        grok: { generate: GEN('Gr1', 'Gr2'), critique: CRIT },
      },
      calls
    );
    const r = await runBrainstormMode({ adapters, topic: 'name it', voiceConfigs: configs });

    // Round 1: every voice generated, with stable per-voice ids.
    expect(r.generate.map((g) => g.voiceId)).toEqual(['codex', 'grok', 'claude']);
    expect(r.generate.every((g) => g.ok && g.ideas.length === 2)).toBe(true);
    expect(r.generate[0].ideas[0].id).toBe('codex-1');

    // Round 2: each critic ran, and NEVER saw its own ideas (cross-critique).
    expect(r.critique.map((c) => c.voiceId)).toEqual(['codex', 'grok', 'claude']);
    const codexCritiquePrompt = calls.find(
      (c) => c.voiceId === 'codex' && c.prompt.includes('constructive critic')
    )!.prompt;
    expect(codexCritiquePrompt).not.toContain('[codex-1]');
    expect(codexCritiquePrompt).toContain('[grok-1]');

    // Round 3: claude synthesized (default synthesizer), ranked + non-degraded.
    expect(r.synthesis.by).toBe('claude');
    expect(r.synthesis.degraded).toBe(false);
    expect(r.synthesis.ranked[0].title).toBe('Winner');
    expect(r.synthesis.ranked[0].rank).toBe(1);
  });

  it('honors a custom roster (codex+grok only) and picks the first healthy synthesizer', async () => {
    const calls: Array<{ prompt: string; voiceId: VoiceId }> = [];
    const adapters = makeAdapters(
      {
        codex: { generate: GEN('Co1', 'Co2'), critique: CRIT, synthesis: SYNTH },
        grok: { generate: GEN('Gr1', 'Gr2'), critique: CRIT },
      },
      calls
    );
    const r = await runBrainstormMode({
      adapters,
      topic: 't',
      voiceConfigs: configs,
      voices: ['codex', 'grok'],
    });
    expect(r.roster).toEqual(['codex', 'grok']);
    expect(r.generate.map((g) => g.voiceId)).toEqual(['codex', 'grok']);
    expect(calls.some((c) => c.voiceId === 'claude')).toBe(false);
    expect(r.synthesis.by).toBe('codex'); // no claude in roster → first healthy
  });

  it('degrades gracefully when one voice fails — the others still run', async () => {
    const adapters = makeAdapters(
      {
        claude: { generate: GEN('Cl1', 'Cl2'), critique: CRIT, synthesis: SYNTH },
        codex: { generate: GEN('Co1', 'Co2'), critique: CRIT },
        grok: { fail: 'throw' },
      },
      []
    );
    const r = await runBrainstormMode({ adapters, topic: 't', voiceConfigs: configs });
    const grok = r.generate.find((g) => g.voiceId === 'grok')!;
    expect(grok.ok).toBe(false);
    expect(grok.error).toContain('boom');
    // critique only includes the healthy participants
    expect(r.critique.map((c) => c.voiceId).sort()).toEqual(['claude', 'codex']);
    expect(r.synthesis.by).toBe('claude');
  });

  it('skips round 2 when fewer than two voices produced ideas', async () => {
    const adapters = makeAdapters(
      {
        claude: { fail: 'null' },
        codex: { generate: GEN('Co1', 'Co2'), synthesis: SYNTH },
        grok: { fail: 'timeout' },
      },
      []
    );
    const r = await runBrainstormMode({ adapters, topic: 't', voiceConfigs: configs });
    expect(r.critique).toEqual([]);
    expect(r.generate.find((g) => g.voiceId === 'grok')!.timedOut).toBe(true);
    expect(r.synthesis.by).toBe('codex'); // only healthy voice
  });

  it('falls back to deterministic synthesis when the synthesizer fails', async () => {
    const adapters = makeAdapters(
      {
        codex: { generate: GEN('Dup', 'Co2') }, // no synthesis reply → null
        grok: { generate: GEN('Dup', 'Gr2'), critique: CRIT },
      },
      []
    );
    const r = await runBrainstormMode({
      adapters,
      synthesizer: 'codex',
      topic: 't',
      voiceConfigs: configs,
      voices: ['codex', 'grok'],
    });
    expect(r.synthesis.degraded).toBe(true);
    expect(r.synthesis.by).toBeNull();
    // "Dup" appeared from both voices → deduped to one entry crediting both.
    const dup = r.synthesis.ranked.find((x) => x.title === 'Dup')!;
    expect(dup.contributors.sort()).toEqual(['codex', 'grok']);
  });
});

describe('pickSynthesizer', () => {
  const gen = (id: VoiceId, ok: boolean): VoiceGenerateResult => ({
    ideas: ok ? [{ body: 'b', id: `${id}-1`, title: 't', voiceId: id }] : [],
    ok,
    raw: ok ? '{}' : null,
    summary: '',
    voiceId: id,
  });
  it('honors an explicit in-roster request', () => {
    expect(pickSynthesizer(['codex', 'grok'], 'grok', [gen('codex', true)])).toBe('grok');
  });
  it('prefers claude when it generated healthily', () => {
    expect(
      pickSynthesizer(['codex', 'grok', 'claude'], undefined, [
        gen('codex', true),
        gen('claude', true),
      ])
    ).toBe('claude');
  });
  it('falls to the first healthy voice, else null', () => {
    expect(pickSynthesizer(['codex', 'grok'], undefined, [gen('codex', false), gen('grok', true)])).toBe('grok');
    expect(pickSynthesizer(['codex'], undefined, [gen('codex', false)])).toBeNull();
  });
});

describe('fallbackSynthesis', () => {
  it('dedupes ideas by normalized title and merges contributors', () => {
    const ideas: Idea[] = [
      { body: 'a', id: 'codex-1', title: 'Shared Idea', voiceId: 'codex' },
      { body: 'b', id: 'grok-1', title: 'shared  idea!', voiceId: 'grok' },
      { body: 'c', id: 'grok-2', title: 'Unique', voiceId: 'grok' },
    ];
    const s = fallbackSynthesis(ideas);
    expect(s.degraded).toBe(true);
    expect(s.ranked).toHaveLength(2);
    expect(s.ranked[0].contributors.sort()).toEqual(['codex', 'grok']);
    expect(s.ranked[1].title).toBe('Unique');
  });
  it('handles the empty case', () => {
    const s = fallbackSynthesis([]);
    expect(s.ranked).toEqual([]);
    expect(s.summary).toContain('No ideas');
  });
});
