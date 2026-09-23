import { describe, expect, it } from 'vitest';

import { listReviewers, parseReviewers, REVIEWER_DEFAULTS } from './reviewers';
// The seat-switch predicate lives on the PURE contracts module (a UI imports it without
// pulling node:fs); this file exercises it over configs the file parse produced.
import {
  enabledReviewerIds,
  type ReviewerConfig,
  type ReviewerId,
} from './types';

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

  it('drops a window that is not an instant, so it cannot mean two things on two hosts', () => {
    // A zone-less date-time is read in the HOST's timezone by Date.parse — the same
    // file would end the window at a different moment on the dashboard than on a laptop.
    const r = parseReviewers({
      codex: { disabledUntil: '2026-09-29T00:00:00' },
      grok: { disabledUntil: '2027' },
    });
    expect(r.codex.disabledUntil).toBeUndefined();
    expect(r.grok.disabledUntil).toBeUndefined();
    expect(enabledReviewerIds(r)).toEqual(['codex', 'grok', 'claude']);
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

  it('reads a window with an explicit offset as the INSTANT it names', () => {
    // 02:00+02:00 IS 00:00Z — the seat is back on at that instant and not a moment before,
    // on every host, because the offset (not the host's timezone) pins it.
    const r = parseReviewers({ codex: { disabledUntil: '2026-09-29T02:00:00+02:00' } });
    expect(enabledReviewerIds(r, new Date('2026-09-28T23:59:59Z'))).not.toContain('codex');
    expect(enabledReviewerIds(r, new Date('2026-09-29T00:00:00Z'))).toContain('codex');
  });

  it('can switch off more than one seat', () => {
    const r = parseReviewers({
      codex: { enabled: false },
      grok: { disabledUntil: '2026-09-29T00:00:00Z' },
    });
    expect(enabledReviewerIds(r, now)).toEqual(['claude']);
  });

  it('returns [] when every seat is off — the FACT of no seats, never a clean bill', () => {
    // A consumer whose required-seat set is this list must treat [] as fail-closed: no
    // reviewer looked at the diff. Pinned so the empty case can never arrive unnoticed.
    const r = parseReviewers({
      claude: { enabled: false },
      codex: { enabled: false },
      grok: { disabledUntil: '2026-09-29T00:00:00Z' },
    });
    expect(enabledReviewerIds(r, now)).toEqual([]);
  });

  // The shapes parseReviewers can never produce — only a consumer that hand-builds a
  // config reaches them. Pinned here because the predicate leans on it: neither a window
  // the file parse would have dropped nor a missing entry may read as an off-switch.
  it('ignores a disabledUntil a hand-built config carried that the file parse would drop', () => {
    const hand = (disabledUntil: string): Record<ReviewerId, ReviewerConfig> => ({
      ...REVIEWER_DEFAULTS,
      codex: { ...REVIEWER_DEFAULTS.codex, disabledUntil },
    });
    expect(enabledReviewerIds(hand('next tuesday'), now)).toContain('codex');
    expect(enabledReviewerIds(hand('2026-09-29T00:00:00'), now)).toContain('codex');
    expect(enabledReviewerIds(hand('2027'), now)).toContain('codex');
  });

  it('reads a seat a hand-built config omits entirely as on, not a crash', () => {
    const r = { ...REVIEWER_DEFAULTS, codex: undefined } as unknown as Record<
      ReviewerId,
      ReviewerConfig
    >;
    expect(enabledReviewerIds(r, now)).toEqual(['codex', 'grok', 'claude']);
  });
});
