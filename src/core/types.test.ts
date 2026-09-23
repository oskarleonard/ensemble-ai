import { describe, expect, it } from 'vitest';

import { isReviewerId, parseReviewerIds, parseSeatWindow, titleCase } from './types';

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
