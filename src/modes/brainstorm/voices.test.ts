import { describe, expect, it } from 'vitest';

import { VOICE_IDS } from './types';
import { loadVoices, parseVoices, VOICE_ADAPTERS, VOICE_DEFAULTS } from './voices';

describe('VOICE_ADAPTERS / VOICE_DEFAULTS', () => {
  it('have an entry for every voice id (exhaustive)', () => {
    for (const id of VOICE_IDS) {
      expect(typeof VOICE_ADAPTERS[id]).toBe('function');
      expect(VOICE_DEFAULTS[id].id).toBe(id);
    }
  });
  it('keep grok under the deny-by-default ensemble-review sandbox', () => {
    expect(VOICE_DEFAULTS.grok.sandbox).toBe('ensemble-review');
    // codex/claude carry no sandbox field (codex bakes its own -s read-only).
    expect(VOICE_DEFAULTS.codex.sandbox).toBeUndefined();
    expect(VOICE_DEFAULTS.claude.sandbox).toBeUndefined();
  });
});

describe('parseVoices', () => {
  it('applies well-formed overrides and falls back per-field on junk', () => {
    const out = parseVoices({
      codex: { model: 'gpt-6', effort: 'low' },
      grok: { model: 42 }, // junk → keep default model
      bogus: { model: 'x' }, // unknown id ignored
    });
    expect(out.codex.model).toBe('gpt-6');
    expect(out.codex.effort).toBe('low');
    expect(out.codex.vendor).toBe('openai'); // untouched default
    expect(out.grok.model).toBe(VOICE_DEFAULTS.grok.model); // junk ignored
    expect(out.grok.sandbox).toBe('ensemble-review'); // preserved
  });
  it('returns the baked defaults for a non-object', () => {
    expect(parseVoices(null)).toEqual(VOICE_DEFAULTS);
    expect(parseVoices('nope')).toEqual(VOICE_DEFAULTS);
  });
});

describe('loadVoices', () => {
  it('falls back to defaults when the file is missing/unreadable', () => {
    expect(loadVoices('/no/such/voices.json')).toEqual(VOICE_DEFAULTS);
  });
});
