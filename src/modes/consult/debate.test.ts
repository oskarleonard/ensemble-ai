import { describe, expect, it } from 'vitest';

import {
  parseDebateReply,
  parseJudgeReply,
  renderDebatePrompt,
  renderJudgePrompt,
  rulingsTally,
  splitsFromSynthesis,
  splitsStillOpen,
} from './debate';
import type { ConsultSynthesis, DebateRound } from './types';

const IDS = ['split-1', 'split-2'];

const SYN: ConsultSynthesis = {
  agreements: [{ point: 'use X', voices: ['codex', 'claude'] }],
  by: 'claude',
  degraded: false,
  divergences: [
    { point: 'how long is safe', positions: ['codex: 15 min', 'claude: 13 min worst case'] },
    { point: 'key by symbol or contract', positions: ['codex: contract', 'claude: symbol'] },
  ],
  ok: true,
  raw: null,
  recommendation: 'draft',
  summary: 'headline',
};

describe('parseDebateReply', () => {
  it('keeps grounded moves, downgrades an ungrounded move to a hold, drops unknown ids', () => {
    const raw = JSON.stringify({
      splits: [
        {
          id: 'split-1',
          position: 'safe is 12.8 min worst case',
          stance: 'move',
          evidence: [{ source: 'web https://example.org/finality', quote: 'two epochs', bearing: 'bounds the lag' }],
          rebuttal: 'their 15 is a round-up',
          movedBecause: 'the spec text they quoted',
        },
        { id: 'split-2', position: 'contract', stance: 'concede', evidence: [], rebuttal: 'fine' },
        { id: 'split-9', position: 'made up', stance: 'hold', evidence: [], rebuttal: '' },
      ],
    });
    const p = parseDebateReply(raw, IDS);
    expect(p.parseError).toBeUndefined();
    expect(p.entries.map((e) => [e.splitId, e.stance])).toEqual([
      ['split-1', 'move'],
      ['split-2', 'hold'],
    ]);
    expect(p.downgraded).toEqual(['split-2']);
    expect(p.entries[0].evidence[0].source).toBe('web https://example.org/finality');
    expect(p.entries[0].movedBecause).toBe('the spec text they quoted');
    expect(p.entries[1].movedBecause).toBeUndefined();
  });

  it('fails closed on no splits array / none of the listed ids', () => {
    expect(parseDebateReply('{"x":1}', IDS).parseError).toMatch(/no "splits"/);
    expect(parseDebateReply('{"splits":[{"id":"nope","position":"p"}]}', IDS).parseError).toMatch(/none of the splits/);
    expect(parseDebateReply('prose only', IDS).parseError).toMatch(/no parseable JSON/);
  });
});

describe('parseJudgeReply', () => {
  it('parses rulings, turns a "settled" with no evidence into a judgement call, drops unknown ids', () => {
    const raw = JSON.stringify({
      summary: 'two settled',
      rulings: [
        { splitId: 'split-1', outcome: 'settled', direction: 'claude: 12.8 min', why: 'the spec says so', evidenceCited: ['claude: web https://example.org/finality'] },
        { splitId: 'split-2', outcome: 'settled', direction: 'contract', why: 'I prefer it', evidenceCited: [] },
        { splitId: 'split-3', outcome: 'settled', direction: 'x', why: 'y', evidenceCited: ['a'] },
      ],
      recommendation: 'Verdict.\n\n1. do it\n\nConfident.',
    });
    const p = parseJudgeReply(raw, IDS);
    expect(p.parseError).toBeUndefined();
    expect(p.rulings.map((r) => [r.splitId, r.outcome])).toEqual([
      ['split-1', 'settled'],
      ['split-2', 'judgement'],
    ]);
    expect(p.recommendation).toContain('1. do it');
    expect(rulingsTally(p.rulings)).toBe('1 settled, 1 judgement');
  });

  it('fails closed when nothing usable is there', () => {
    expect(parseJudgeReply('{"rulings":[]}', IDS).parseError).toMatch(/no "rulings"/);
  });
});

describe('splitsStillOpen', () => {
  const round = (entries: Record<string, { stance: 'hold' | 'move' | 'concede'; ev: number }[]>): DebateRound => ({
    round: 1,
    splitIds: IDS,
    voices: (['codex', 'claude'] as const).map((voiceId, vi) => ({
      entries: Object.entries(entries).map(([splitId, per]) => ({
        evidence: Array.from({ length: per[vi].ev }, () => ({ bearing: 'b', quote: 'q', source: 'doc §1' })),
        position: 'p',
        rebuttal: '',
        splitId,
        stance: per[vi].stance,
        ...(per[vi].stance !== 'hold' ? { movedBecause: 'm' } : {}),
      })),
      ok: true,
      raw: '',
      voiceId,
    })),
  });

  it('keeps a split open only while both hold AND someone brought evidence', () => {
    const r = round({
      'split-1': [{ stance: 'hold', ev: 1 }, { stance: 'hold', ev: 0 }], // evidence on the table → argue on
      'split-2': [{ stance: 'hold', ev: 0 }, { stance: 'hold', ev: 0 }], // nothing new → rhetoric, close
    });
    expect(splitsStillOpen(r, IDS)).toEqual(['split-1']);
  });

  it('closes a split once a voice moves or concedes', () => {
    const r = round({
      'split-1': [{ stance: 'concede', ev: 0 }, { stance: 'hold', ev: 2 }],
      'split-2': [{ stance: 'hold', ev: 1 }, { stance: 'move', ev: 1 }],
    });
    expect(splitsStillOpen(r, IDS)).toEqual([]);
  });
});

describe('prompts', () => {
  const splits = splitsFromSynthesis(SYN);

  it('debate prompt names the voice, lists every split id, carries the own answer and the evidence rules', () => {
    const p = renderDebatePrompt({
      maxRounds: 2,
      own: { answer: 'a', keyPoints: ['kp-1'], ok: true, raw: '', summary: 'my summary', voiceId: 'codex' },
      prior: [],
      question: 'Q?',
      round: 1,
      splits,
      voiceId: 'codex',
    });
    expect(p).toContain('You are [codex]');
    expect(p).toContain('[split-1] how long is safe');
    expect(p).toContain('[split-2] key by symbol or contract');
    expect(p).toContain('my summary');
    expect(p).toContain('"movedBecause"');
    expect(p).toContain('Round 1 of 2');
    expect(p).not.toContain('Last round');
  });

  it('round 2 shows the OTHER side\'s last entry in full and own last position only', () => {
    const prior: DebateRound[] = [
      {
        round: 1,
        splitIds: ['split-1'],
        voices: [
          { entries: [{ evidence: [{ bearing: 'b', quote: 'two epochs', source: 'web https://x' }], position: 'codex pos', rebuttal: 'r', splitId: 'split-1', stance: 'hold' }], ok: true, raw: '', voiceId: 'codex' },
          { entries: [{ evidence: [], position: 'claude pos', rebuttal: 'r2', splitId: 'split-1', stance: 'hold' }], ok: true, raw: '', voiceId: 'claude' },
        ],
      },
    ];
    const p = renderDebatePrompt({ maxRounds: 2, own: undefined, prior, question: 'Q?', round: 2, splits: [splits[0]], voiceId: 'claude' });
    expect(p).toContain('Last round (round 1)');
    expect(p).toContain('codex, last round:');
    expect(p).toContain('two epochs');
    expect(p).toContain('you, last round: claude pos (hold)');
  });

  it('judge prompt carries every round, the draft, and the four outcomes', () => {
    const p = renderJudgePrompt({ draft: SYN, question: 'Q?', rounds: [], splits });
    expect(p).toContain('You are the JUDGE');
    expect(p).toContain('[split-1] how long is safe');
    expect(p).toContain('draft recommendation:\ndraft');
    for (const o of ['"settled"', '"converged"', '"judgement"', '"unverified"']) expect(p).toContain(o);
  });
});
