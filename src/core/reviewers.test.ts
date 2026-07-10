import { describe, expect, it } from 'vitest';

import { listReviewers, parseReviewers } from './reviewers';

describe('parseReviewers', () => {
  it('returns the baked default (codex · gpt-5.5 · xhigh) when config is absent', () => {
    expect(parseReviewers(null).codex).toEqual({
      cmd: 'codex',
      effort: 'xhigh',
      id: 'codex',
      model: 'gpt-5.5',
      vendor: 'openai',
    });
  });

  it('applies a per-field override, keeping defaults for the rest', () => {
    const r = parseReviewers({ codex: { effort: 'high', model: 'gpt-6' } });
    expect(r.codex.model).toBe('gpt-6');
    expect(r.codex.effort).toBe('high');
    expect(r.codex.cmd).toBe('codex'); // untouched default
    expect(r.codex.id).toBe('codex'); // id is never taken from config
  });

  it('falls back to defaults for malformed field values (junk can’t break it)', () => {
    const r = parseReviewers({ codex: { effort: '', model: 123 } });
    expect(r.codex.model).toBe('gpt-5.5');
    expect(r.codex.effort).toBe('xhigh');
  });

  it('ignores a non-object reviewer entry', () => {
    expect(parseReviewers({ codex: 'nope' }).codex.model).toBe('gpt-5.5');
  });

  it('includes the baked Grok default (grok-build · high · xai · ensemble-review sandbox)', () => {
    expect(parseReviewers(null).grok).toEqual({
      cmd: 'grok',
      effort: 'high',
      id: 'grok',
      model: 'grok-build',
      sandbox: 'ensemble-review',
      vendor: 'xai',
    });
  });

  it('falls back to the baked Grok default for a malformed grok entry', () => {
    const r = parseReviewers({ grok: { effort: '', model: 123 } });
    expect(r.grok.model).toBe('grok-build');
    expect(r.grok.effort).toBe('high');
    expect(r.grok.sandbox).toBe('ensemble-review'); // junk can't weaken the sandbox
  });

  it('applies a grok sandbox override but never lets it become empty', () => {
    expect(parseReviewers({ grok: { sandbox: 'strict' } }).grok.sandbox).toBe(
      'strict'
    );
    // an empty/junk override falls back to the baked default, not undefined.
    expect(parseReviewers({ grok: { sandbox: '' } }).grok.sandbox).toBe(
      'ensemble-review'
    );
  });

  it('omits sandbox for codex (it bakes its own -s read-only, no sandbox field)', () => {
    expect(parseReviewers(null).codex.sandbox).toBeUndefined();
  });
});

describe('listReviewers', () => {
  it('returns every registry reviewer in id order (codex, grok, claude)', () => {
    // grok always resolves (baked default), independent of the on-disk file.
    expect(listReviewers().map((r) => r.id)).toEqual(['codex', 'grok', 'claude']);
  });
});
