import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { VOICE_IDS } from './types';
import { assertRosterAdvisors, loadVoices, parseVoices, VOICE_ADAPTERS, VOICE_DEFAULTS } from './voices';

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

describe('parseVoices / loadVoices — the claude voice\'s advisor', () => {
  it('carries a model id or "off" on the claude voice; absent stays absent', () => {
    expect(parseVoices({ claude: { advisor: 'claude-opus-5-5' } }).claude.advisor).toBe('claude-opus-5-5');
    expect(parseVoices({ claude: { advisor: 'off' } }).claude.advisor).toBe('off');
    expect(parseVoices({ claude: { model: 'opus' } }).claude).not.toHaveProperty('advisor');
    expect(parseVoices({ codex: { advisor: 'off' } }).codex).not.toHaveProperty('advisor');
  });

  it('NEVER throws: an invalid advisor is carried as-is (null stays null — never read as inherit)', () => {
    expect(parseVoices({ claude: { advisor: null } }).claude.advisor).toBeNull();
    expect(parseVoices({ claude: { advisor: 7 } }).claude.advisor).toBe(7);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-advisor-'));
    const file = path.join(dir, 'voices.json');
    try {
      fs.writeFileSync(file, JSON.stringify({ claude: { advisor: 'OFF', model: 'opus' } }));
      const loaded = loadVoices(file);
      expect(loaded.claude.advisor).toBe('OFF');
      expect(loaded.claude.model).toBe('opus');
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe('assertRosterAdvisors — the up-front check of the voices a run will spawn', () => {
  const configs = parseVoices({ claude: { advisor: 'Opus 5' } });

  it('an invalid advisor on a roster voice throws naming the seat', () => {
    expect(() => assertRosterAdvisors(['claude', 'codex'], configs, 'voices.json')).toThrow(
      /voices\.json claude seat: `advisor`.*got "Opus 5"/
    );
    // Programmatic configs (no file) are labelled by the voice id alone.
    expect(() => assertRosterAdvisors(['claude'], configs)).toThrow(/ensemble-ai: claude seat: `advisor`/);
  });

  it('a voice OUTSIDE the roster is never read — its typo breaks nothing', () => {
    expect(() => assertRosterAdvisors(['codex', 'grok'], configs, 'voices.json')).not.toThrow();
  });

  it('valid and absent advisors pass', () => {
    expect(() => assertRosterAdvisors(['claude'], parseVoices({ claude: { advisor: 'off' } }))).not.toThrow();
    expect(() => assertRosterAdvisors(['claude'], parseVoices({}))).not.toThrow();
  });
});
