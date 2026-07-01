import { describe, expect, it } from 'vitest';

import { isVoiceId, parseVoiceIds, VOICE_IDS } from './types';

describe('VOICE_IDS', () => {
  it('includes claude as a brainstorm-only third voice', () => {
    expect(VOICE_IDS).toContain('claude');
    expect(VOICE_IDS).toContain('codex');
    expect(VOICE_IDS).toContain('grok');
  });
});

describe('isVoiceId', () => {
  it('accepts known ids and rejects everything else', () => {
    expect(isVoiceId('codex')).toBe(true);
    expect(isVoiceId('claude')).toBe(true);
    expect(isVoiceId('gemini')).toBe(false);
    expect(isVoiceId(42)).toBe(false);
    expect(isVoiceId(undefined)).toBe(false);
  });
});

describe('parseVoiceIds', () => {
  it('parses a comma string, deduping and preserving order', () => {
    expect(parseVoiceIds('grok, codex ,grok')).toEqual(['grok', 'codex']);
  });
  it('parses an array, dropping unknowns', () => {
    expect(parseVoiceIds(['codex', 'nope', 'claude'])).toEqual(['codex', 'claude']);
  });
  it('returns undefined when nothing valid survives (→ default roster)', () => {
    expect(parseVoiceIds('nope,123')).toBeUndefined();
    expect(parseVoiceIds(42)).toBeUndefined();
    expect(parseVoiceIds([])).toBeUndefined();
  });
});
