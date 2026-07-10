import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTURE,
  loadPostingPosture,
  meetsInlineFloor,
  resolvePosture,
  SUGGESTION_HARD_CAP,
} from './posting-config';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-posture-'));
afterAll(() => fs.rmSync(tmp, { force: true, recursive: true }));

function writeConfig(name: string, contents: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, contents);
  return p;
}

describe('posting posture — consumer-tunable thresholds, engine-owned HARD CAPS', () => {
  it('no config file ⇒ the built-in defaults (an ensemble-ai user with no config can still stage)', () => {
    expect(loadPostingPosture('code', path.join(tmp, 'nope.json'))).toEqual(DEFAULT_POSTURE);
  });

  it('malformed JSON ⇒ the defaults, never a crash', () => {
    expect(loadPostingPosture('code', writeConfig('bad.json', '{ not json'))).toEqual(DEFAULT_POSTURE);
  });

  it('reads a PER-PROFILE posture — code and security tune independently', () => {
    const p = writeConfig(
      'per-profile.json',
      JSON.stringify({ posting: { code: { suggestionCap: 1 }, security: { suggestionCap: 0 } } })
    );
    expect(loadPostingPosture('code', p).suggestionCap).toBe(1);
    expect(loadPostingPosture('security', p).suggestionCap).toBe(0);
  });

  it('a profile absent from the config falls back to the defaults', () => {
    const p = writeConfig('code-only.json', JSON.stringify({ posting: { code: { suggestionCap: 1 } } }));
    expect(loadPostingPosture('security', p)).toEqual(DEFAULT_POSTURE);
  });

  it('CLAMPS suggestionCap to the engine hard cap — config can lower it, never raise it', () => {
    expect(resolvePosture({ suggestionCap: 99 }).suggestionCap).toBe(SUGGESTION_HARD_CAP);
    expect(resolvePosture({ suggestionCap: 2 }).suggestionCap).toBe(2);
    expect(resolvePosture({ suggestionCap: -5 }).suggestionCap).toBe(0);
  });

  it('clamps maxSuggestionLines into a sane band and ignores junk', () => {
    expect(resolvePosture({ maxSuggestionLines: 500 }).maxSuggestionLines).toBe(10);
    expect(resolvePosture({ maxSuggestionLines: 0 }).maxSuggestionLines).toBe(1);
    expect(resolvePosture({ maxSuggestionLines: 'many' }).maxSuggestionLines).toBe(DEFAULT_POSTURE.maxSuggestionLines);
    expect(resolvePosture({ suggestionCap: NaN }).suggestionCap).toBe(DEFAULT_POSTURE.suggestionCap);
  });

  it('an unknown inlineSeverityFloor falls back rather than silencing every finding', () => {
    expect(resolvePosture({ inlineSeverityFloor: 'critical' }).inlineSeverityFloor).toBe('low');
    expect(resolvePosture({ inlineSeverityFloor: 'high' }).inlineSeverityFloor).toBe('high');
  });

  it('meetsInlineFloor treats a MORE severe finding as clearing the floor', () => {
    expect(meetsInlineFloor('high', 'medium')).toBe(true);
    expect(meetsInlineFloor('medium', 'medium')).toBe(true);
    expect(meetsInlineFloor('low', 'medium')).toBe(false);
    expect(meetsInlineFloor('low', 'low')).toBe(true); // the default floor admits everything
  });
});
