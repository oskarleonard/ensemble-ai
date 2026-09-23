import { describe, expect, it } from 'vitest';

import { enabledReviewerIds, listReviewers, parseReviewers } from './reviewers';

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

  it('includes the baked Grok default (grok-4.6 · xhigh · xai · ensemble-review sandbox)', () => {
    expect(parseReviewers(null).grok).toEqual({
      cmd: 'grok',
      effort: 'xhigh',
      id: 'grok',
      model: 'grok-4.6',
      sandbox: 'ensemble-review',
      vendor: 'xai',
    });
  });

  it('falls back to the baked Grok default for a malformed grok entry', () => {
    const r = parseReviewers({ grok: { effort: '', model: 123 } });
    expect(r.grok.model).toBe('grok-4.6');
    expect(r.grok.effort).toBe('xhigh');
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

describe('parseReviewers — the seat off-switches', () => {
  it('keeps enabled:false and a parseable disabledUntil', () => {
    const r = parseReviewers({
      codex: { disabledUntil: '2026-09-29T00:00:00Z', enabled: false },
    });
    expect(r.codex.enabled).toBe(false);
    expect(r.codex.disabledUntil).toBe('2026-09-29T00:00:00Z');
  });

  it('leaves both fields absent when config says nothing (default: on)', () => {
    expect(parseReviewers(null).codex.enabled).toBeUndefined();
    expect(parseReviewers(null).codex.disabledUntil).toBeUndefined();
  });

  it('drops a non-boolean enabled and an unparseable disabledUntil (junk never disables)', () => {
    const r = parseReviewers({
      codex: { disabledUntil: 'next tuesday', enabled: 'no' },
    });
    expect(r.codex.enabled).toBeUndefined();
    expect(r.codex.disabledUntil).toBeUndefined();
    expect(enabledReviewerIds(r)).toContain('codex');
  });

  it('keeps enabled:true explicitly (an operator switching a seat back on)', () => {
    expect(parseReviewers({ grok: { enabled: true } }).grok.enabled).toBe(true);
  });
});

describe('enabledReviewerIds — the one owner of which seats are on', () => {
  const now = new Date('2026-09-23T12:00:00Z');

  it('returns every seat when nothing is switched off', () => {
    expect(enabledReviewerIds(parseReviewers(null), now)).toEqual([
      'codex',
      'grok',
      'claude',
    ]);
  });

  it('drops a seat switched off indefinitely (enabled:false)', () => {
    const r = parseReviewers({ codex: { enabled: false } });
    expect(enabledReviewerIds(r, now)).toEqual(['grok', 'claude']);
  });

  it('drops a seat inside its disabledUntil window', () => {
    const r = parseReviewers({ codex: { disabledUntil: '2026-09-29T00:00:00Z' } });
    expect(enabledReviewerIds(r, now)).toEqual(['grok', 'claude']);
  });

  it('brings the seat back BY ITSELF once disabledUntil has passed — no restore step', () => {
    const r = parseReviewers({ codex: { disabledUntil: '2026-09-29T00:00:00Z' } });
    expect(enabledReviewerIds(r, new Date('2026-09-29T00:00:01Z'))).toEqual([
      'codex',
      'grok',
      'claude',
    ]);
  });

  it('treats the instant disabledUntil names as already back on (now < until, exclusive)', () => {
    const r = parseReviewers({ codex: { disabledUntil: '2026-09-29T00:00:00Z' } });
    expect(
      enabledReviewerIds(r, new Date('2026-09-29T00:00:00Z'))
    ).toContain('codex');
  });

  it('keeps enabled:false off even after the window expires (it does not expire)', () => {
    const r = parseReviewers({
      codex: { disabledUntil: '2026-09-20T00:00:00Z', enabled: false },
    });
    expect(enabledReviewerIds(r, now)).toEqual(['grok', 'claude']);
  });

  it('can switch off more than one seat', () => {
    const r = parseReviewers({
      codex: { enabled: false },
      grok: { disabledUntil: '2026-09-29T00:00:00Z' },
    });
    expect(enabledReviewerIds(r, now)).toEqual(['claude']);
  });
});
