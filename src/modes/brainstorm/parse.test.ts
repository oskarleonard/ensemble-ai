import { describe, expect, it } from 'vitest';

import { parseCritique, parseIdeas, parseSynthesis } from './parse';

describe('parseIdeas', () => {
  it('pulls a fenced JSON block of ideas', () => {
    const raw = 'thinking…\n```json\n{"summary":"s","ideas":[{"title":"A","body":"ba"},{"title":"B","body":"bb"}]}\n```';
    const out = parseIdeas(raw);
    expect(out.parseError).toBeUndefined();
    expect(out.summary).toBe('s');
    expect(out.ideas).toEqual([
      { body: 'ba', title: 'A' },
      { body: 'bb', title: 'B' },
    ]);
  });
  it('flags a reply with no parseable JSON', () => {
    expect(parseIdeas('just prose, no json').parseError).toBeTruthy();
  });
  it('flags a JSON object with no ideas array (e.g. an error blob)', () => {
    const out = parseIdeas('{"error":"quota"}');
    expect(out.parseError).toBeTruthy();
    expect(out.ideas).toEqual([]);
  });
  it('drops wholly-empty idea entries but keeps a body-only idea', () => {
    const out = parseIdeas('{"ideas":[{},{"body":"only body"}]}');
    expect(out.ideas).toEqual([{ body: 'only body', title: 'Idea 2' }]);
  });
});

describe('parseCritique', () => {
  it('parses critiques + extensions and coerces an unknown stance', () => {
    const raw = '{"summary":"cs","critiques":[{"target":"g1","stance":"bogus","assessment":"weak"}],"extensions":[{"title":"X","body":"bx"}]}';
    const out = parseCritique(raw);
    expect(out.critiques).toEqual([{ assessment: 'weak', stance: 'concern', target: 'g1' }]);
    expect(out.extensions).toEqual([{ body: 'bx', title: 'X' }]);
  });
  it('flags a reply with NEITHER a critiques nor an extensions array (e.g. {} or an error blob)', () => {
    const out = parseCritique('{"summary":"only"}');
    expect(out.parseError).toBeTruthy();
    expect(out.critiques).toEqual([]);
    expect(out.extensions).toEqual([]);
    // an error blob that parses to an object is a FAILED critique, not an empty success
    expect(parseCritique('{"error":"quota"}').parseError).toBeTruthy();
  });
  it('accepts a reply with only ONE of the two arrays (extensions present, no critiques)', () => {
    const out = parseCritique('{"extensions":[{"title":"X","body":"bx"}]}');
    expect(out.parseError).toBeUndefined();
    expect(out.critiques).toEqual([]);
    expect(out.extensions).toEqual([{ body: 'bx', title: 'X' }]);
  });
  it('accepts a conforming "nothing to add" reply (both arrays present but empty)', () => {
    const out = parseCritique('{"critiques":[],"extensions":[]}');
    expect(out.parseError).toBeUndefined();
    expect(out.critiques).toEqual([]);
    expect(out.extensions).toEqual([]);
  });
});

describe('parseSynthesis', () => {
  it('ranks by ARRAY ORDER, ignoring any model-supplied rank', () => {
    const raw = '{"summary":"final","ranked":[{"title":"A","why":"best","rank":99,"contributors":["codex","grok","codex"]},{"title":"B","why":"next"}]}';
    const out = parseSynthesis(raw);
    expect(out.summary).toBe('final');
    expect(out.ranked[0]).toEqual({ contributors: ['codex', 'grok'], rank: 1, title: 'A', why: 'best' });
    expect(out.ranked[1].rank).toBe(2);
    expect(out.ranked[1].contributors).toEqual([]);
  });
  it('keeps risks when present', () => {
    const out = parseSynthesis('{"ranked":[{"title":"A","why":"w","risks":"r"}]}');
    expect(out.ranked[0].risks).toBe('r');
  });
  it('flags missing ranked array', () => {
    expect(parseSynthesis('{"summary":"x"}').parseError).toBeTruthy();
  });
});
