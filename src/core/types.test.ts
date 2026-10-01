import { describe, expect, it } from 'vitest';

import { isReviewerId, parseReviewerIds, parseSeatAdvisor, parseSeatWindow, titleCase } from './types';

describe('isReviewerId', () => {
  it('accepts a known id and rejects everything else', () => {
    expect(isReviewerId('codex')).toBe(true);
    expect(isReviewerId('grok')).toBe(true);
    expect(isReviewerId('gemini')).toBe(false); // not registered yet
    expect(isReviewerId('')).toBe(false);
    expect(isReviewerId(null)).toBe(false);
    expect(isReviewerId(42)).toBe(false);
  });
});

describe('parseReviewerIds', () => {
  it('keeps known ids', () => {
    expect(parseReviewerIds(['codex'])).toEqual(['codex']);
  });

  it('dedups repeated ids', () => {
    expect(parseReviewerIds(['codex', 'codex'])).toEqual(['codex']);
  });

  it('drops unknown ids, keeping the known ones', () => {
    expect(parseReviewerIds(['codex', 'gemini', 7])).toEqual(['codex']);
  });

  it('returns undefined (the field is dropped) when nothing valid survives', () => {
    // A junk array degrades to "no cross-vendor reviewer" — never poisons gating.
    expect(parseReviewerIds(['nope', 5, null])).toBeUndefined();
    expect(parseReviewerIds([])).toBeUndefined();
  });

  it('returns undefined for a non-array', () => {
    expect(parseReviewerIds(undefined)).toBeUndefined();
    expect(parseReviewerIds('codex')).toBeUndefined(); // a bare string is not a list
    expect(parseReviewerIds({ 0: 'codex' })).toBeUndefined();
  });
});

describe('titleCase', () => {
  it('upper-cases the first letter of a reviewer id', () => {
    expect(titleCase('codex')).toBe('Codex');
    expect(titleCase('grok')).toBe('Grok');
  });

  it('is a no-op on an empty string', () => {
    expect(titleCase('')).toBe('');
  });
});

describe('parseSeatWindow — the one parse of a disabledUntil window', () => {
  it('keeps an instant that carries its zone, verbatim', () => {
    expect(parseSeatWindow('2026-09-29T00:00:00Z')).toBe('2026-09-29T00:00:00Z');
    expect(parseSeatWindow('  2026-09-29T02:00:00+02:00  ')).toBe(
      '2026-09-29T02:00:00+02:00' // trimmed, never rewritten into Z
    );
    expect(parseSeatWindow('2026-09-29T00:00Z')).toBe('2026-09-29T00:00Z');
    expect(parseSeatWindow('2026-09-29T00:00:00.500Z')).toBe('2026-09-29T00:00:00.500Z');
  });

  it('drops a date-time with NO zone — it is not an instant, it is host-local', () => {
    // Date.parse would read this in the host's timezone, so the same reviewers.json
    // would end the window at a different moment on a dashboard than on a laptop.
    expect(parseSeatWindow('2026-09-29T00:00:00')).toBeUndefined();
  });

  it('drops the loose forms Date.parse would otherwise accept', () => {
    expect(parseSeatWindow('2027')).toBeUndefined(); // a bare year: a year of seat-off
    expect(parseSeatWindow('2026-09-29')).toBeUndefined(); // date-only: no clock, no zone
    expect(parseSeatWindow('9/29/2026')).toBeUndefined();
    expect(parseSeatWindow('Sep 29 2026')).toBeUndefined();
    expect(parseSeatWindow('next tuesday')).toBeUndefined();
  });

  it('drops a date that does not exist (Date.parse would roll it over)', () => {
    // 2027-02-30 parses as 2027-03-02 — two days of seat-off nobody asked for.
    expect(parseSeatWindow('2027-02-30T00:00:00Z')).toBeUndefined();
    expect(parseSeatWindow('2026-02-29T00:00:00Z')).toBeUndefined(); // 2026 is not a leap year
    expect(parseSeatWindow('2028-02-29T00:00:00Z')).toBe('2028-02-29T00:00:00Z'); // 2028 is
    expect(parseSeatWindow('2026-09-29T25:00:00Z')).toBeUndefined(); // no 25th hour
  });

  it('drops anything that is not a string', () => {
    expect(parseSeatWindow(undefined)).toBeUndefined();
    expect(parseSeatWindow(null)).toBeUndefined();
    expect(parseSeatWindow(1790000000000)).toBeUndefined();
    expect(parseSeatWindow('')).toBeUndefined();
  });
});

describe('parseSeatAdvisor — a Claude seat\'s advisor: a model id, "off", or absent', () => {
  it('absent (undefined) is the inherit state — no value', () => {
    expect(parseSeatAdvisor(undefined, 'voices.json claude')).toBeUndefined();
  });

  it('accepts "off" and model ids (full ids and the CLI aliases alike)', () => {
    expect(parseSeatAdvisor('off', 's')).toBe('off');
    expect(parseSeatAdvisor('claude-fable-5-1', 's')).toBe('claude-fable-5-1');
    expect(parseSeatAdvisor('claude-opus-5-5', 's')).toBe('claude-opus-5-5');
    expect(parseSeatAdvisor('fable', 's')).toBe('fable');
    expect(parseSeatAdvisor('opus-4.8', 's')).toBe('opus-4.8');
  });

  it('rejects everything else with an error NAMING THE SEAT — null included (null would inherit)', () => {
    for (const bad of [null, '', ' off', 'OFF', 'Claude-Opus', 'claude opus', '-opus', '.opus', 'opus"}', 'a/b', 42, true, {}, []]) {
      expect(() => parseSeatAdvisor(bad, 'voices.json gate')).toThrow(/voices\.json gate seat: `advisor` must be "off" or a model id/);
    }
  });
});
