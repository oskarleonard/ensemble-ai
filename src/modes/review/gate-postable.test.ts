import { describe, expect, it } from 'vitest';

import { derivePostable, parseFixStatus, parsePostableOps, parseSeverity } from './gate-postable';

const BODY =
  'The KYB draft is written to localStorage via JSON.stringify with no encryption, and it is stored indefinitely across all sessions.';
const HUNK = ['localStorage.setItem(getStorageKey(workspaceKey), JSON.stringify(next));'];

describe('derivePostable — agree posts the body VERBATIM (byte-equal)', () => {
  it('agree with no ops ⇒ postableBody === body, postable', () => {
    const r = derivePostable({ body: BODY, fixStatus: undefined, hunkCode: HUNK, ops: [], rescoredSeverity: undefined, severity: 'high', verdict: 'agree' });
    expect(r.postableStatus).toBe('postable');
    expect(r.postableBody).toBe(BODY);
    expect(r.postableFix).toBe('keep');
    expect(r.rescoredSeverity).toBeNull();
  });

  it('agree carrying edit-ops is a contradiction ⇒ escalated (never posts)', () => {
    const r = derivePostable({ body: BODY, fixStatus: undefined, hunkCode: HUNK, ops: [{ op: 'strike', quote: 'indefinitely' }], rescoredSeverity: undefined, severity: 'high', verdict: 'agree' });
    expect(r.postableStatus).toBe('escalated');
    expect(r.postableBody).toBeNull();
  });
});

describe('derivePostable — partial narrows the body via ops', () => {
  it('strike removes the overstated span; kept text stays byte-identical', () => {
    const r = derivePostable({
      body: BODY, fixStatus: undefined, hunkCode: HUNK, rescoredSeverity: 'medium', severity: 'high', verdict: 'partial',
      ops: [{ op: 'strike', quote: ', and it is stored indefinitely across all sessions', why: 'lifetime not shown in hunk' }],
    });
    expect(r.postableStatus).toBe('postable');
    expect(r.postableBody).toBe('The KYB draft is written to localStorage via JSON.stringify with no encryption.');
    expect(r.postableFix).toBe('narrow');
    expect(r.rescoredSeverity).toBe('medium'); // down-scored high→medium honored
  });

  it('replace with an entity NOT in body/hunk is rejected ⇒ escalated', () => {
    const r = derivePostable({
      body: BODY, fixStatus: undefined, hunkCode: HUNK, rescoredSeverity: undefined, severity: 'high', verdict: 'partial',
      ops: [{ op: 'replace', quote: 'localStorage', with: 'sessionStorage' }], // sessionStorage is a new symbol
    });
    expect(r.postableStatus).toBe('escalated');
    expect(r.postableNote).toContain('new entity');
  });

  it('replace reusing an entity present in the hunk is allowed', () => {
    const r = derivePostable({
      body: BODY, fixStatus: 'strike', hunkCode: HUNK, rescoredSeverity: undefined, severity: 'high', verdict: 'partial',
      ops: [{ op: 'replace', quote: 'JSON.stringify with no encryption', with: 'JSON.stringify' }],
    });
    expect(r.postableStatus).toBe('postable');
    expect(r.postableBody).toContain('JSON.stringify');
    expect(r.postableFix).toBe('strike');
  });

  it('partial with NO ops ⇒ escalated (posting verbatim would re-inject the overstatement)', () => {
    const r = derivePostable({ body: BODY, fixStatus: undefined, hunkCode: HUNK, ops: [], rescoredSeverity: undefined, severity: 'high', verdict: 'partial' });
    expect(r.postableStatus).toBe('escalated');
  });

  it('an op quote absent from the body ⇒ escalated (fail closed, no guessing)', () => {
    const r = derivePostable({ body: BODY, fixStatus: undefined, hunkCode: HUNK, rescoredSeverity: undefined, severity: 'high', verdict: 'partial', ops: [{ op: 'strike', quote: 'this text is not in the body' }] });
    expect(r.postableStatus).toBe('escalated');
    expect(r.postableNote).toContain('not found');
  });

  it('striking >60% of the body ⇒ escalated (that is unverified, not a narrowing)', () => {
    const r = derivePostable({ body: BODY, fixStatus: undefined, hunkCode: HUNK, rescoredSeverity: undefined, severity: 'high', verdict: 'partial', ops: [{ op: 'strike', quote: BODY.slice(0, Math.floor(BODY.length * 0.7)) }] });
    expect(r.postableStatus).toBe('escalated');
  });

  it('rescoredSeverity may only LOWER severity — an inflation is ignored', () => {
    const r = derivePostable({
      body: BODY, fixStatus: undefined, hunkCode: HUNK, rescoredSeverity: 'high', severity: 'low', verdict: 'partial',
      ops: [{ op: 'strike', quote: ' indefinitely' }],
    });
    expect(r.rescoredSeverity).toBeNull(); // low→high refused
  });
});

describe('parse helpers — tolerant of shape, cap hostile input', () => {
  it('parsePostableOps keeps only well-formed strike/replace entries', () => {
    const ops = parsePostableOps([
      { op: 'strike', quote: 'x' },
      { op: 'replace', quote: 'y', with: 'z' },
      { op: 'replace', quote: 'no-with' }, // dropped: replace needs `with`
      { op: 'bogus', quote: 'q' }, // dropped: unknown op
      { op: 'strike' }, // dropped: no quote
      'not an object',
    ]);
    expect(ops).toEqual([{ op: 'strike', quote: 'x', why: undefined }, { op: 'replace', quote: 'y', why: undefined, with: 'z' }]);
  });

  it('parseFixStatus / parseSeverity reject junk', () => {
    expect(parseFixStatus('narrow')).toBe('narrow');
    expect(parseFixStatus('nope')).toBeUndefined();
    expect(parseSeverity('medium')).toBe('medium');
    expect(parseSeverity('critical')).toBeUndefined();
  });
});
