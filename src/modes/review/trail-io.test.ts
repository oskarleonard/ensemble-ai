import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reviewDir } from '../../core/artifacts';

import { reviewJsonFromTrail } from './trail-io';

let base: string;
beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-trailio-'));
});
afterEach(() => fs.rmSync(base, { force: true, recursive: true }));

function write(runId: string, name: string, content: string): void {
  const dir = reviewDir(base, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

describe('reviewJsonFromTrail — defensive round-trip read of a persisted VoiceReview', () => {
  it('reads a well-formed review file back', () => {
    write('r1', 'review.claude.json', JSON.stringify({
      findings: [{ body: 'b', confidence: 'high', evidence: { file: 'x.ts' }, id: 'f1', severity: 'high', title: 't' }],
      ok: true,
      summary: 's',
      voiceId: 'claude',
    }));
    const v = reviewJsonFromTrail(base, 'r1', 'review.claude.json');
    expect(v).toMatchObject({ ok: true, voiceId: 'claude' });
    expect(v?.findings).toHaveLength(1);
  });

  it('returns null for a missing or unparseable file', () => {
    expect(reviewJsonFromTrail(base, 'nope', 'review.claude.json')).toBeNull();
    write('r2', 'review.claude.json', 'not json');
    expect(reviewJsonFromTrail(base, 'r2', 'review.claude.json')).toBeNull();
  });

  it('drops a junk finding rather than trusting a corrupted trail', () => {
    write('r3', 'review.claude.json', JSON.stringify({
      findings: [{ nope: 1 }, { body: 'b', confidence: 'low', evidence: {}, id: 'f1', severity: 'low', title: 'ok' }],
      ok: true,
      summary: 's',
      voiceId: 'claude',
    }));
    const v = reviewJsonFromTrail(base, 'r3', 'review.claude.json');
    expect(v?.findings).toHaveLength(1);
    expect(v?.findings[0].title).toBe('ok');
  });

  it('returns null when voiceId is absent', () => {
    write('r4', 'review.claude.json', JSON.stringify({ findings: [], ok: true, summary: 's' }));
    expect(reviewJsonFromTrail(base, 'r4', 'review.claude.json')).toBeNull();
  });
});
