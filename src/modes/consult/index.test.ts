import { describe, expect, it } from 'vitest';

import { VOICE_DEFAULTS, type VoiceRunResult } from '../brainstorm/voices';

import { fallbackSynthesis, pickSynthesizer, runConsultMode } from './index';
import type { VoiceAnswerResult, VoiceConfig, VoiceId } from './types';

// A fake voice adapter that branches on the prompt round (answer / critique /
// synthesis) — no real CLI spawned. Records every (voiceId, prompt) call.
type Reply = {
  answer?: string;
  critique?: string;
  // A debate reply may depend on the round — a function gets the prompt.
  debate?: string | ((prompt: string) => string);
  judge?: string;
  synthesis?: string;
  fail?: 'throw' | 'null' | 'timeout';
};

function ok(raw: string): VoiceRunResult {
  return { ok: true, raw, stderrTail: '', timedOut: false };
}

function roundOf(prompt: string): 'answer' | 'critique' | 'synthesis' | 'debate' | 'judge' {
  if (prompt.includes('SYNTHESIZER')) return 'synthesis';
  if (prompt.includes('candid participant')) return 'critique';
  if (prompt.includes('You are the JUDGE')) return 'judge';
  if (prompt.includes('evidence DEBATE')) return 'debate';
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
      const pick = r[roundOf(prompt)];
      const raw = typeof pick === 'function' ? pick(prompt) : pick;
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

// ── --debate: argue the splits with evidence, then a judge rules ──────────────
const SYNTH2 =
  '{"summary":"headline","agreements":[{"point":"use X","voices":["codex","claude"]}],"divergences":[{"point":"how long","positions":["codex: 15","claude: 13"]},{"point":"key","positions":["codex: contract","claude: symbol"]}],"recommendation":"draft"}';
const ev = (src: string) => `[{"source":"${src}","quote":"q","bearing":"b"}]`;
const debateReply = (s1: string, s2: string) => `{"splits":[${s1},${s2}]}`;
const JUDGE =
  '{"summary":"after debate","rulings":[{"splitId":"split-1","outcome":"settled","direction":"claude: 13","why":"spec","evidenceCited":["claude: doc §1"]},{"splitId":"split-2","outcome":"converged","direction":"contract","why":"claude conceded","evidenceCited":["codex: doc §3"]}],"recommendation":"Final.\n\n1. do\n\nSure."}';

describe('runConsultMode — --debate', () => {
  it('runs rounds only while evidence is on the table, closes a conceded split, then the judge rules', async () => {
    const calls: Array<{ prompt: string; voiceId: VoiceId }> = [];
    const adapters = makeAdapters(
      {
        claude: {
          answer: ANS('c'),
          // round 1: holds split-1 with evidence, concedes split-2 (grounded)
          debate: (p) =>
            p.includes('Round 1 of')
              ? debateReply(
                  `{"id":"split-1","position":"13","stance":"hold","evidence":${ev('doc §1')},"rebuttal":"r"}`,
                  `{"id":"split-2","position":"contract","stance":"concede","evidence":[],"rebuttal":"ok","movedBecause":"their §3 quote"}`
                )
              : debateReply(`{"id":"split-1","position":"13","stance":"hold","evidence":${ev('web https://x')},"rebuttal":"still"}`, '{"id":"split-2","position":"n/a","stance":"hold","evidence":[],"rebuttal":""}'),
          judge: JUDGE,
          synthesis: SYNTH2,
        },
        codex: {
          answer: ANS('x'),
          debate: (p) =>
            p.includes('Round 1 of')
              ? debateReply(`{"id":"split-1","position":"15","stance":"hold","evidence":[],"rebuttal":"r"}`, `{"id":"split-2","position":"contract","stance":"hold","evidence":${ev('doc §3')},"rebuttal":"r"}`)
              : debateReply(`{"id":"split-1","position":"15","stance":"hold","evidence":[],"rebuttal":"r"}`, '{"id":"split-2","position":"n/a","stance":"hold","evidence":[],"rebuttal":""}'),
        },
      },
      calls
    );
    const r = await runConsultMode({
      adapters,
      debate: { judge: 'claude', judgeConfig: { ...VOICE_DEFAULTS.claude, model: 'other-model' }, rounds: 3 },
      question: 'Q?',
      voiceConfigs: VOICE_DEFAULTS,
      voices: ['codex', 'claude'],
    });
    expect(r.debate).toBeDefined();
    const d = r.debate!;
    expect(d.splits.map((s) => s.id)).toEqual(['split-1', 'split-2']);
    // round 1 argued both; split-2 closed (conceded), split-1 stayed open (evidence, both hold);
    // round 2 brought evidence again (claude's web source) with both holding → a third round
    // for split-1 alone, the cap.
    expect(d.rounds.map((x) => x.splitIds)).toEqual([['split-1', 'split-2'], ['split-1'], ['split-1']]);
    // the judge ran once, through claude, on a different model → independent
    const judgeCalls = calls.filter((c) => c.prompt.includes('You are the JUDGE'));
    expect(judgeCalls.length).toBe(1);
    expect(d.judge).toMatchObject({ independent: true, model: 'other-model', ok: true, voiceId: 'claude' });
    expect(d.rulings.map((x) => [x.splitId, x.outcome])).toEqual([
      ['split-1', 'settled'],
      ['split-2', 'converged'],
    ]);
    expect(d.recommendation).toContain('1. do');
    // the synthesizer's draft stays on the synthesis
    expect(r.synthesis.recommendation).toBe('draft');
    // the judge prompt carried every round for split-1
    expect(judgeCalls[0].prompt).toMatch(/round 3, Voice [A-C]/);
  });

  it('stops after one round when nobody brings evidence, and flags a judge that argued a side', async () => {
    const calls: Array<{ prompt: string; voiceId: VoiceId }> = [];
    const noEvidence = debateReply(
      '{"id":"split-1","position":"a","stance":"hold","evidence":[],"rebuttal":"r"}',
      '{"id":"split-2","position":"b","stance":"hold","evidence":[],"rebuttal":"r"}'
    );
    const adapters = makeAdapters(
      {
        claude: { answer: ANS('c'), debate: noEvidence, judge: JUDGE, synthesis: SYNTH2 },
        codex: { answer: ANS('x'), debate: noEvidence },
      },
      calls
    );
    const r = await runConsultMode({ adapters, debate: { rounds: 2 }, question: 'Q?', voiceConfigs: VOICE_DEFAULTS, voices: ['codex', 'claude'] });
    expect(r.debate!.rounds.length).toBe(1);
    // default judge = the synthesizer (claude) on its own model → NOT independent, and said so
    expect(r.debate!.judge).toMatchObject({ independent: false, voiceId: 'claude' });
  });

  it('skips the debate with no divergence, and survives a failed judge', async () => {
    const calls: Array<{ prompt: string; voiceId: VoiceId }> = [];
    const noSplit = '{"summary":"h","agreements":[{"point":"p","voices":["codex","claude"]}],"divergences":[],"recommendation":"r"}';
    const a1 = makeAdapters({ claude: { answer: ANS('c'), synthesis: noSplit }, codex: { answer: ANS('x') } }, calls);
    const r1 = await runConsultMode({ adapters: a1, debate: { rounds: 2 }, question: 'Q?', voiceConfigs: VOICE_DEFAULTS, voices: ['codex', 'claude'] });
    expect(r1.debate).toBeUndefined();
    expect(calls.some((c) => c.prompt.includes('evidence DEBATE'))).toBe(false);

    const ev1 = debateReply(`{"id":"split-1","position":"a","stance":"hold","evidence":${ev('doc §1')},"rebuttal":"r"}`, '{"id":"split-2","position":"b","stance":"hold","evidence":[],"rebuttal":"r"}');
    const a2 = makeAdapters({ claude: { answer: ANS('c'), debate: ev1, synthesis: SYNTH2 }, codex: { answer: ANS('x'), debate: ev1 } }, []);
    const r2 = await runConsultMode({ adapters: a2, debate: { rounds: 1 }, question: 'Q?', voiceConfigs: VOICE_DEFAULTS, voices: ['codex', 'claude'] });
    expect(r2.debate!.judge.ok).toBe(false);
    expect(r2.debate!.rulings).toEqual([]);
    expect(r2.debate!.recommendation).toBe('');
    expect(r2.debate!.rounds.length).toBe(1);
  });
});
