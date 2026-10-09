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
  it('maps bare letters back only where the context makes them a voice (run b27c794b leaks)', () => {
    const cases: Array<[string, string]> = [
      ["codex's position stands, supported by C and conceded by B", "codex's position stands, supported by claude and conceded by grok"],
      ['A moved toward B/C on that point; B/C\u2019s proposed empty-list semantics remain unapproved', 'codex moved toward grok/claude on that point; grok/claude\u2019s proposed empty-list semantics remain unapproved'],
      ["A/C's distinction stands, and B concedes: intent creation already checks ownership", "codex/claude's distinction stands, and grok concedes: intent creation already checks ownership"],
      ["A's position stands, B moves to it and C agrees", "codex's position stands, grok moves to it and claude agrees"],
      ['A/B\u2019s rejection stands, and C concedes', 'codex/grok\u2019s rejection stands, and claude concedes'],
      ['C demonstrates incompatibility in the inspected 0.6.2 source', 'claude demonstrates incompatibility in the inspected 0.6.2 source'],
      ['between A and B, with C (initially) holding', 'between codex and grok, with claude (initially) holding'],
      ['A, B and C all cite doc.md', 'codex, grok and claude all cite doc.md'],
      ['evidenceCited: ["A: code/x.go:1", "voice b: doc.md"]', 'evidenceCited: ["codex: code/x.go:1", "grok: doc.md"]'],
    ];
    for (const [input, want] of cases) expect(deanonymizeJudgeText(input, alias)).toBe(want);
  });
  it('leaves the article, initials and identifiers alone', () => {
    const keep = [
      'A separate portfolio-send guard runs on save. A Bridge USDC-on-Ethereum method becomes a refund path.',
      'Plan B is the manual procedure; Appendix C lists the hosts; see §3.4/§5.2 and PLAT-757.',
      'A zero-row database query alone does not prove coverage. A later replay must not duplicate it.',
    ];
    for (const t of keep) expect(deanonymizeJudgeText(t, alias)).toBe(t);
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
    expect(prompt).toContain('never a bare letter');
  });
});
