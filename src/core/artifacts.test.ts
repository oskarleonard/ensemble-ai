import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { persistReview, readReview, readReviewsForRun } from './artifacts';
import type { ReviewerConfig, ReviewFinding, ReviewPacket } from './types';

// baseDir is now an explicit first arg (no env-driven path) — give every test a
// fresh tmp dir to write artifacts into, and clean it up.
let baseDir: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-artifacts-'));
});

afterEach(() => {
  fs.rmSync(baseDir, { force: true, recursive: true });
});

const cfg = (id: 'codex' | 'grok'): ReviewerConfig =>
  id === 'grok'
    ? {
        cmd: 'grok',
        effort: 'high',
        id: 'grok',
        model: 'grok-build',
        sandbox: 'ensemble-review',
        vendor: 'xai',
      }
    : { cmd: 'codex', effort: 'xhigh', id: 'codex', model: 'gpt-5.5', vendor: 'openai' };

const finding = (id: string): ReviewFinding => ({
  body: '',
  confidence: 'high',
  evidence: { file: 'x.ts' },
  id,
  severity: 'high',
  title: id,
});

const packet = (): ReviewPacket => ({
  complete: true,
  objective: 'o',
  pr: 1,
  repo: 'r',
  sections: [],
});

describe('per-reviewer artifacts', () => {
  it('keys by (runId, reviewerId) so a codex-f1 and a grok-f1 never collide', () => {
    const runId = 'run-1';
    for (const id of ['codex', 'grok'] as const) {
      persistReview(baseDir, {
        findings: [finding('f1')],
        packet: packet(),
        prompt: 'p',
        raw: 'raw',
        reviewer: cfg(id),
        runId,
        summary: id,
        terminalState: 'reviewed',
      });
    }
    // SAME findingId f1 in both, written to SEPARATE per-reviewer artifacts — so a
    // codex finding never overwrites a grok one (the (runId, reviewerId) key holds).
    const reviews = readReviewsForRun(baseDir, runId);
    expect(reviews.map((r) => r.reviewerId)).toEqual(['codex', 'grok']);
    const codex = reviews.find((r) => r.reviewerId === 'codex');
    const grok = reviews.find((r) => r.reviewerId === 'grok');
    expect(codex?.findings[0]?.id).toBe('f1');
    expect(grok?.findings[0]?.id).toBe('f1');
    expect(codex?.summary).toBe('codex');
    expect(grok?.summary).toBe('grok');
    // each reviewer wrote its OWN review.<id>.json (no shared review.json)
    expect(fs.existsSync(path.join(baseDir, runId, 'review.codex.json'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, runId, 'review.grok.json'))).toBe(true);
  });

  it('backfills reviewerId from a legacy bare review.json (pre-fan-out run)', () => {
    const runId = 'legacy-1';
    const dir = path.join(baseDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'review.json'),
      JSON.stringify({
        findings: [],
        packet: { complete: true, manifest: [] },
        reviewer: { effort: 'xhigh', model: 'gpt-5.5', vendor: 'openai' },
        runId,
        summary: 'old',
        terminalState: 'reviewed',
      })
    );
    expect(readReview(baseDir, runId, 'codex')?.reviewerId).toBe('codex');
    expect(readReviewsForRun(baseDir, runId).map((r) => r.reviewerId)).toEqual(
      ['codex']
    );
  });
});
