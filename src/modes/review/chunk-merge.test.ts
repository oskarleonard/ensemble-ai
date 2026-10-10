import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reviewDir } from '../../core/artifacts';
import type { ReviewerConfig, ReviewPacket, StoredReview } from '../../core/types';

import { mergeChunkSeatRuns } from './chunk-merge';
import type { SeatRunResult } from './seat-run';

const GROK: ReviewerConfig = { cmd: 'grok', effort: 'xhigh', id: 'grok', model: 'grok-x', vendor: 'xai' };
const PACKET: ReviewPacket = { complete: true, objective: 'o', pr: 0, repo: 'r', sections: [] };

function stored(over: Partial<StoredReview>): StoredReview {
  return {
    findings: [],
    packet: { complete: true, manifest: [] },
    reviewer: { effort: 'xhigh', model: 'grok-x', vendor: 'xai' },
    reviewerId: 'grok',
    runId: 'r',
    summary: 's',
    terminalState: 'reviewed',
    ...over,
  };
}
function seat(review: StoredReview, over: Partial<SeatRunResult> = {}): SeatRunResult {
  return { egressDenials: [], fallbackReason: null, realized: 'worktree', review, ...over };
}
const finding = (file: string) => ({ body: 'b', confidence: 'high' as const, evidence: { file, line: 1 }, id: 'f1', severity: 'low' as const, title: file });

describe('mergeChunkSeatRuns — one review of record from a seat’s parts', () => {
  let out: string;
  beforeEach(() => { out = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-merge-')); });
  afterEach(() => fs.rmSync(out, { force: true, recursive: true }));

  it('renumbers findings in part order with their part, sums the clock, keeps the weakest evidence and every fallback', () => {
    fs.mkdirSync(reviewDir(out, 'r'), { recursive: true });
    fs.writeFileSync(path.join(reviewDir(out, 'r'), 'grok-review.c2.raw.md'), 'RAW TWO');
    const merged = mergeChunkSeatRuns({
      out, packet: PACKET, prompt: 'P', reviewer: GROK, runId: 'r',
      runs: [
        { index: 2, label: 'web', seat: seat(stored({ diagnostics: { elapsedMs: 20, endedAt: '2026-10-10T02:00:00.000Z', startedAt: '2026-10-10T01:00:00.000Z', stderrTail: 'two' }, findings: [finding('web/c.ts')], summary: 'two' }), { fallbackReason: 'fell back', realized: 'packet' }) },
        { index: 1, label: 'backend', seat: seat(stored({ diagnostics: { elapsedMs: 10, endedAt: '2026-10-10T01:00:00.000Z', startedAt: '2026-10-10T00:00:00.000Z', stderrTail: 'one' }, findings: [finding('backend/a.go'), finding('backend/b.go')], summary: 'one' })) },
      ],
    });
    expect(merged.review.terminalState).toBe('reviewed');
    expect(merged.review.findings.map((f) => [f.id, f.chunk, f.evidence.file])).toEqual([
      ['f1', 1, 'backend/a.go'], ['f2', 1, 'backend/b.go'], ['f3', 2, 'web/c.ts'],
    ]);
    expect(merged.review.summary).toBe('Part 1/2 (backend): one\nPart 2/2 (web): two');
    expect(merged.review.diagnostics).toMatchObject({ elapsedMs: 30, endedAt: '2026-10-10T02:00:00.000Z', startedAt: '2026-10-10T00:00:00.000Z', stderrTail: 'two' });
    expect(merged.realized).toBe('packet');
    expect(merged.fallbackReason).toBe('part 2/2: fell back');
    // the merged raw carries the part that had a reply on disk; the missing one is simply absent
    expect(fs.readFileSync(path.join(reviewDir(out, 'r'), 'grok-review.raw.md'), 'utf8')).toBe('## Part 2 of 2 — web\n\nRAW TWO');
  });

  it('a failed part makes the seat INCOMPLETE and names it, keeping the failed part’s stderr and watchdog', () => {
    const merged = mergeChunkSeatRuns({
      out, packet: PACKET, prompt: 'P', reviewer: GROK, runId: 'r',
      runs: [
        { index: 1, label: 'backend', seat: seat(stored({ diagnostics: { elapsedMs: 5, endedAt: 'b', startedAt: 'a', stderrTail: 'fine' }, findings: [finding('backend/a.go')] })) },
        { index: 2, label: 'web', seat: seat(stored({ diagnostics: { elapsedMs: 7, endedAt: 'd', startedAt: 'c', stderrTail: 'boom', timedOutReason: 'absolute' }, summary: 'timed out', terminalState: 'failed-reviewer' })) },
      ],
    });
    expect(merged.review.terminalState).toBe('failed-reviewer');
    expect(merged.review.summary).toContain('1 part(s) did not complete');
    expect(merged.review.summary).toContain('Part 2/2 (web) FAILED: timed out');
    expect(merged.review.findings).toHaveLength(1);
    expect(merged.review.diagnostics).toMatchObject({ stderrTail: 'boom', timedOutReason: 'absolute' });
  });
});
