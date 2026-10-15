import { describe, expect, it } from 'vitest';

import { parseSynthesis } from '../modes/brainstorm/parse';
import { parseJudgeReply } from '../modes/consult/debate';
import { parseConsultSynthesis } from '../modes/consult/parse';
import { LEAD_MAX, capLead } from './lead-contract';

// The lead is ADDITIVE on every synthesizer shape: present ⇒ carried (capped), absent ⇒ the
// output is byte-identical to before, so an old trail and a model that forgets both read fine.
describe('lead — additive on the three synthesizer outputs', () => {
  it('capLead normalizes whitespace and caps at LEAD_MAX; non-strings are absent', () => {
    expect(capLead('  two   words ')).toBe('two words');
    expect(capLead('x'.repeat(400))?.length).toBe(LEAD_MAX);
    expect(capLead('x'.repeat(400))?.endsWith('…')).toBe(true);
    expect(capLead(42)).toBeUndefined();
    expect(capLead('')).toBeUndefined();
  });

  it('brainstorm ranked: lead carried when present, absent otherwise', () => {
    const withLead = parseSynthesis('```json\n{"summary":"s","ranked":[{"title":"t","why":"w","lead":"Plain line."},{"title":"u","why":"v"}]}\n```');
    expect(withLead.ranked[0].lead).toBe('Plain line.');
    expect('lead' in withLead.ranked[1]).toBe(false);
  });

  it('consult agreements: lead carried when present, absent otherwise', () => {
    const s = parseConsultSynthesis('```json\n{"summary":"s","agreements":[{"point":"p","voices":["a"],"lead":"Plain."},{"point":"q"}],"divergences":[],"recommendation":"r"}\n```');
    expect(s.agreements[0].lead).toBe('Plain.');
    expect('lead' in s.agreements[1]).toBe(false);
  });

  it('judge rulings: lead carried when present, absent otherwise', () => {
    const j = parseJudgeReply(
      '```json\n{"summary":"s","rulings":[{"splitId":"split-1","outcome":"converged","direction":"d","why":"w","evidenceCited":["a: x"],"lead":"Plain ruling."},{"splitId":"split-2","outcome":"judgement","direction":"d2","why":"w2","evidenceCited":[]}],"recommendation":"r"}\n```',
      ['split-1', 'split-2'],
    );
    expect(j.rulings[0].lead).toBe('Plain ruling.');
    expect('lead' in j.rulings[1]).toBe(false);
  });
});
