import { describe, expect, it } from 'vitest';

import { VOICE_DEFAULTS, type VoiceRunResult } from '../brainstorm/voices';

import { fallbackSynthesis, pickSynthesizer, runConsultMode } from './index';
import type { VoiceAnswerResult, VoiceConfig, VoiceId } from './types';

// A fake voice adapter that branches on the prompt round (answer / critique /
// synthesis) — no real CLI spawned. Records every (voiceId, prompt) call.
type Reply = {
  answer?: string;
  critique?: string;
  synthesis?: string;
  fail?: 'throw' | 'null' | 'timeout';
};

function ok(raw: string): VoiceRunResult {
  return { ok: true, raw, stderrTail: '', timedOut: false };
}

function roundOf(prompt: string): 'answer' | 'critique' | 'synthesis' {
  if (prompt.includes('SYNTHESIZER')) return 'synthesis';
  if (prompt.includes('candid participant')) return 'critique';
  return 'answer';
}

function makeAdapters(
  replies: Partial<Record<VoiceId, Reply>>,
  calls: Array<{ prompt: string; voiceId: VoiceId }>
) {
  const adapter = (voiceId: VoiceId) =>
    async (prompt: string, _c: VoiceConfig): Promise<VoiceRunResult> => {
      calls.push({ prompt, voiceId });
      const r = replies[voiceId] ?? {};
      if (r.fail === 'throw') throw new Error('boom');
      if (r.fail === 'null') return { ok: false, raw: null, stderrTail: '', timedOut: false };
      if (r.fail === 'timeout') return { ok: false, raw: 'partial', stderrTail: '', timedOut: true };
      const raw = r[roundOf(prompt)];
      if (raw === undefined) return { ok: false, raw: null, stderrTail: '', timedOut: false };
      return ok(raw);
    };
  return { claude: adapter('claude'), codex: adapter('codex'), grok: adapter('grok') };
}

const ANS = (summary: string) =>
  `\`\`\`json\n{"summary":"${summary}","answer":"reasoned ${summary}","keyPoints":["kp-a","kp-b"]}\n\`\`\``;
const CRIT = '{"summary":"cs","notes":[{"target":"codex","stance":"concern","assessment":"doubt it"}]}';
const SYNTH =
  '{"summary":"headline","agreements":[{"point":"use X","voices":["codex","grok"]}],"divergences":[{"point":"scale","positions":["codex: now","grok: later"]}],"recommendation":"do X"}';

const configs = VOICE_DEFAULTS;

describe('runConsultMode — answer → synthesize (critique off by default)', () => {
  it('runs answer + synthesis, and NO critique round by default', async () => {
    const calls: Array<{ prompt: string; voiceId: VoiceId }> = [];
    const adapters = makeAdapters(
      {
        claude: { answer: ANS('cl'), synthesis: SYNTH },
        codex: { answer: ANS('co') },
        grok: { answer: ANS('gr') },
      },
      calls
    );
    const r = await runConsultMode({ adapters, question: 'X or Y?', voiceConfigs: configs });

    // Round 1: every voice answered independently.
    expect(r.answers.map((a) => a.voiceId)).toEqual(['codex', 'grok', 'claude']);
    expect(r.answers.every((a) => a.ok && a.keyPoints.length === 2)).toBe(true);

    // No critique round ran (default off).
    expect(r.critique).toEqual([]);
    expect(calls.some((c) => c.prompt.includes('candid participant'))).toBe(false);

    // Synthesis by claude, with agree + diverge separated.
    expect(r.synthesis.by).toBe('claude');
    expect(r.synthesis.degraded).toBe(false);
    expect(r.synthesis.agreements[0].point).toBe('use X');
    expect(r.synthesis.agreements[0].voices.sort()).toEqual(['codex', 'grok']);
    expect(r.synthesis.divergences[0].positions).toContain('codex: now');
    expect(r.synthesis.recommendation).toBe('do X');
  });

  it('runs the optional critique round with --critique, cross-only (no own answer)', async () => {
    const calls: Array<{ prompt: string; voiceId: VoiceId }> = [];
    const adapters = makeAdapters(
      {
        claude: { answer: ANS('cl'), critique: CRIT, synthesis: SYNTH },
        codex: { answer: ANS('co'), critique: CRIT },
        grok: { answer: ANS('gr'), critique: CRIT },
      },
      calls
    );
    const r = await runConsultMode({
      adapters,
      critique: true,
      question: 'X or Y?',
      voiceConfigs: configs,
    });
    expect(r.critique.map((c) => c.voiceId)).toEqual(['codex', 'grok', 'claude']);
    // codex's critique prompt shows the OTHER voices' answers but not its own summary.
    const codexCrit = calls.find(
      (c) => c.voiceId === 'codex' && c.prompt.includes('candid participant')
    )!.prompt;
    expect(codexCrit).toContain('[grok]');
    expect(codexCrit).toContain('[claude]');
    expect(codexCrit).not.toContain('[codex]');
  });

  it('honors a custom roster and picks the first healthy synthesizer when no claude', async () => {
    const calls: Array<{ prompt: string; voiceId: VoiceId }> = [];
    const adapters = makeAdapters(
      { codex: { answer: ANS('co'), synthesis: SYNTH }, grok: { answer: ANS('gr') } },
      calls
    );
    const r = await runConsultMode({
      adapters,
      question: 'q',
      voiceConfigs: configs,
      voices: ['codex', 'grok'],
    });
    expect(r.roster).toEqual(['codex', 'grok']);
    expect(calls.some((c) => c.voiceId === 'claude')).toBe(false);
    expect(r.synthesis.by).toBe('codex');
  });

  it('degrades gracefully when one voice fails — the others still answer', async () => {
    const r = await runConsultMode({
      adapters: makeAdapters(
        {
          claude: { answer: ANS('cl'), synthesis: SYNTH },
          codex: { answer: ANS('co') },
          grok: { fail: 'throw' },
        },
        []
      ),
      question: 'q',
      voiceConfigs: configs,
    });
    const grok = r.answers.find((a) => a.voiceId === 'grok')!;
    expect(grok.ok).toBe(false);
    expect(grok.error).toContain('boom');
    expect(r.synthesis.by).toBe('claude');
  });

  it('skips the critique round when fewer than two voices answered, even with --critique', async () => {
    const r = await runConsultMode({
      adapters: makeAdapters(
        {
          claude: { fail: 'null' },
          codex: { answer: ANS('co'), synthesis: SYNTH },
          grok: { fail: 'timeout' },
        },
        []
      ),
      critique: true,
      question: 'q',
      voiceConfigs: configs,
    });
    expect(r.critique).toEqual([]);
    expect(r.answers.find((a) => a.voiceId === 'grok')!.timedOut).toBe(true);
    expect(r.synthesis.by).toBe('codex');
  });

  it('falls back to the flagged deterministic synthesis when the synthesizer produces nothing', async () => {
    const r = await runConsultMode({
      adapters: makeAdapters(
        { codex: { answer: ANS('co') }, grok: { answer: ANS('gr') } }, // no synthesis reply → null
        []
      ),
      question: 'q',
      synthesizer: 'codex',
      voiceConfigs: configs,
      voices: ['codex', 'grok'],
    });
    expect(r.synthesis.degraded).toBe(true);
    expect(r.synthesis.by).toBeNull();
    expect(r.synthesis.agreements).toEqual([]); // no model → no agreement claim
    expect(r.synthesis.divergences).toHaveLength(2); // each answer shown as-is
    expect(r.synthesis.summary).toContain('NOT compared');
  });

  it('returns the all-failed shape when every voice fails (CLI maps to exit 1)', async () => {
    const r = await runConsultMode({
      adapters: makeAdapters({ codex: { fail: 'throw' }, grok: { fail: 'null' }, claude: { fail: 'timeout' } }, []),
      question: 'q',
      voiceConfigs: configs,
    });
    expect(r.answers.some((a) => a.ok)).toBe(false);
    expect(r.synthesis.degraded).toBe(true);
    expect(r.synthesis.summary).toContain('No answers');
  });
});

describe('pickSynthesizer', () => {
  const ans = (id: VoiceId, isOk: boolean): VoiceAnswerResult => ({
    answer: isOk ? 'a' : '',
    keyPoints: [],
    ok: isOk,
    raw: isOk ? '{}' : null,
    summary: '',
    voiceId: id,
  });
  it('honors an explicit in-roster request', () => {
    expect(pickSynthesizer(['codex', 'grok'], 'grok', [ans('codex', true)])).toBe('grok');
  });
  it('prefers claude when it answered healthily', () => {
    expect(
      pickSynthesizer(['codex', 'grok', 'claude'], undefined, [ans('codex', true), ans('claude', true)])
    ).toBe('claude');
  });
  it('falls to the first healthy voice, else null', () => {
    expect(pickSynthesizer(['codex', 'grok'], undefined, [ans('codex', false), ans('grok', true)])).toBe('grok');
    expect(pickSynthesizer(['codex'], undefined, [ans('codex', false)])).toBeNull();
  });
});

describe('fallbackSynthesis', () => {
  it('shows each healthy answer as a flagged, uncompared divergence', () => {
    const answers: VoiceAnswerResult[] = [
      { answer: 'full a', keyPoints: [], ok: true, raw: '{}', summary: 'A', voiceId: 'codex' },
      { answer: 'full b', keyPoints: [], ok: false, raw: null, summary: '', voiceId: 'grok' },
    ];
    const s = fallbackSynthesis(answers);
    expect(s.degraded).toBe(true);
    expect(s.agreements).toEqual([]);
    expect(s.divergences).toHaveLength(1); // only the healthy one
    expect(s.divergences[0].positions[0]).toContain('codex:');
  });
  it('handles the empty case', () => {
    const s = fallbackSynthesis([]);
    expect(s.divergences).toEqual([]);
    expect(s.summary).toContain('No answers');
  });
});
