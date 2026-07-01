import { describe, expect, it } from 'vitest';

import { parseAnswer, parseConsultSynthesis, parseCritique } from './parse';

describe('parseAnswer', () => {
  it('parses a fenced answer with key points', () => {
    const raw = 'chatter\n```json\n{"summary":"use X","answer":"because X","keyPoints":["p1","p2","p2"]}\n```\ntrailing';
    const p = parseAnswer(raw);
    expect(p.parseError).toBeUndefined();
    expect(p.summary).toBe('use X');
    expect(p.answer).toBe('because X');
    expect(p.keyPoints).toEqual(['p1', 'p2']); // deduped
  });
  it('accepts an answer with only a summary (no body)', () => {
    const p = parseAnswer('{"summary":"just this"}');
    expect(p.parseError).toBeUndefined();
    expect(p.summary).toBe('just this');
  });
  it('flags a reply with neither answer nor summary as a parse error', () => {
    expect(parseAnswer('{"keyPoints":["x"]}').parseError).toContain('no "answer" or "summary"');
    expect(parseAnswer('{"error":"quota"}').parseError).toContain('no "answer" or "summary"');
  });
  it('flags non-JSON prose as a parse error (voice recorded as failed)', () => {
    expect(parseAnswer('I think you should use X.').parseError).toContain('no parseable JSON');
  });
});

describe('parseCritique', () => {
  it('parses notes and defaults an unknown stance to concern', () => {
    const raw = '{"summary":"s","notes":[{"target":"codex","stance":"bogus","assessment":"weak"}]}';
    const p = parseCritique(raw);
    expect(p.parseError).toBeUndefined();
    expect(p.notes[0].stance).toBe('concern');
    expect(p.notes[0].target).toBe('codex');
  });
  it('accepts an empty notes array (nothing to add)', () => {
    const p = parseCritique('{"summary":"s","notes":[]}');
    expect(p.parseError).toBeUndefined();
    expect(p.notes).toEqual([]);
  });
  it('flags a reply with no notes array as a parse error', () => {
    expect(parseCritique('{"summary":"s"}').parseError).toContain('no "notes" array');
  });
});

describe('parseConsultSynthesis', () => {
  it('parses agreements + divergences + recommendation', () => {
    const raw =
      '{"summary":"h","agreements":[{"point":"X","voices":["codex","grok","grok"]}],"divergences":[{"point":"when","positions":["codex: now","grok: later"]}],"recommendation":"do X"}';
    const p = parseConsultSynthesis(raw);
    expect(p.parseError).toBeUndefined();
    expect(p.agreements[0].voices).toEqual(['codex', 'grok']); // deduped
    expect(p.divergences[0].positions).toHaveLength(2);
    expect(p.recommendation).toBe('do X');
  });
  it('drops malformed agreement/divergence entries but keeps the good ones', () => {
    const raw =
      '{"summary":"h","agreements":[{"voices":["codex"]},{"point":"keep"}],"divergences":"nope","recommendation":"r"}';
    const p = parseConsultSynthesis(raw);
    expect(p.agreements).toHaveLength(1); // the point-less one dropped
    expect(p.agreements[0].point).toBe('keep');
    expect(p.divergences).toEqual([]); // non-array → empty
  });
  it('accepts empty agree/diverge lists as long as a summary or recommendation exists', () => {
    const p = parseConsultSynthesis('{"summary":"just a summary"}');
    expect(p.parseError).toBeUndefined();
    expect(p.agreements).toEqual([]);
  });
  it('flags a reply with neither summary nor recommendation as a parse error (→ fallback)', () => {
    expect(parseConsultSynthesis('{"agreements":[]}').parseError).toContain('no "recommendation" or "summary"');
    expect(parseConsultSynthesis('not json').parseError).toContain('no parseable JSON');
  });
});
