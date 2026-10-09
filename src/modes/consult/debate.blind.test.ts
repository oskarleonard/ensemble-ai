import { describe, expect, it } from 'vitest';

import { anonymizeVoiceText, deanonymizeJudgeText, renderJudgePrompt, voiceAliases } from './debate';

describe('the blind judge', () => {
  const alias = voiceAliases(['codex', 'grok', 'claude']);
  it('labels are deterministic letters carrying no vendor', () => {
    expect(alias).toEqual({ claude: 'Voice C', codex: 'Voice A', grok: 'Voice B' });
  });
  it('anonymize replaces whole-word ids any case; deanonymize restores them', () => {
    const t = 'codex: now · Grok: later · claude.ts is a file · encodex stays';
    const a = anonymizeVoiceText(t, alias);
    expect(a).toBe('Voice A: now · Voice B: later · Voice C.ts is a file · encodex stays');
    expect(deanonymizeJudgeText('Voice A stands; voice b conceded', alias)).toBe('codex stands; grok conceded');
  });
  it('the judge prompt carries labels and never a voice id in the splits/rounds/draft', () => {
    const prompt = renderJudgePrompt({
      alias,
      draft: { summary: 'codex and grok split', agreements: [], divergences: [], recommendation: 'ask claude' } as never,
      question: 'X?',
      rounds: [{ round: 1, splitIds: ['split-1'], voices: [{ voiceId: 'codex', ok: true, raw: '', entries: [{ splitId: 'split-1', position: 'now', stance: 'hold', evidence: [{ source: 'doc §1', quote: 'q', bearing: 'b' }], rebuttal: 'grok is wrong' }] }] }] as never,
      splits: [{ id: 'split-1', point: 'scale', positions: ['codex: now', 'grok: later'] }],
    });
    const body = prompt.split('## The splits')[1];
    expect(body).not.toMatch(/\bcodex\b|\bgrok\b|\bclaude\b/i);
    expect(body).toContain('Voice A: now');
    expect(prompt).toContain('you are not told which model is which');
  });
});
