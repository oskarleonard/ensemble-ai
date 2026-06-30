import { describe, expect, it } from 'vitest';

import { isReviewerId, parseReviewerIds, titleCase } from './types';

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
