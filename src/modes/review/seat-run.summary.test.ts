import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReviewerConfig, ReviewPacket } from '../../core/types';
import { codexRetryNote, type CodexReviewResult } from '../../reviewers/codex';

import { attemptFailureWhy, CODEX_STDIN_BANNER, RETRIES_ON_PACKET, runCoreSeat } from './seat-run';

// The stored summary goes through ONE path per terminal state (#143 round 1, failure-why-derivation-
// paths): a reviewed seat keeps its own summary, a failed one gets attemptFailureWhy — never a
// failWhy that skips it.
const PACKET: ReviewPacket = { complete: true, objective: 'o', pr: 0, repo: 'r', sections: [] };
const CODEX: ReviewerConfig = { cmd: 'codex', effort: 'xhigh', id: 'codex', model: 'm', vendor: 'openai' };

let out: string;
beforeEach(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-seatsummary-'));
});
afterEach(() => {
  fs.rmSync(out, { force: true, recursive: true });
});

const seatWith = async (result: CodexReviewResult) =>
  (
    await runCoreSeat({
      adapter: async () => result,
      log: () => {},
      out,
      packet: PACKET,
      packetComplete: true,
      packetPrompt: 'P',
      retryOnPacket: RETRIES_ON_PACKET.codex,
      reviewer: CODEX,
      runId: 'r1',
    })
  ).review;

describe('the stored summary', () => {
  it('a valid review without a summary is reviewed, with an empty summary — never "did not parse"', async () => {
    const review = await seatWith({ ok: true, raw: '```json\n{"findings":[]}\n```', stderrTail: CODEX_STDIN_BANNER, timedOut: false });
    expect(review.terminalState).toBe('reviewed');
    expect(review.summary).toBe('');
  });

  it('a failed seat names its cause through attemptFailureWhy — a blank failWhy falls through, a long one is capped', async () => {
    const blank = await seatWith({ failWhy: '   ', ok: false, raw: null, stderrTail: 'boom', timedOut: false });
    expect(blank.terminalState).toBe('failed-reviewer');
    expect(blank.summary).toBe('The codex reviewer produced no parseable findings: boom');
    const long = await seatWith({ failWhy: 'x'.repeat(900), ok: false, raw: null, stderrTail: '', timedOut: false });
    expect(long.summary).toBe(`The codex reviewer produced no parseable findings: ${'x'.repeat(300)}`);
  });
});

describe("codex's retry note is context, never the cause", () => {
  it('is dropped with the banner; a real line after them still names the cause', () => {
    const tail = `${codexRetryNote(1)}\n${CODEX_STDIN_BANNER}`;
    expect(attemptFailureWhy({ raw: null, stderrTail: tail })).toBe('no output');
    expect(attemptFailureWhy({ raw: 'prose', stderrTail: tail })).toBe('the reply did not parse as a review');
    expect(attemptFailureWhy({ raw: null, stderrTail: `${tail}\nsandbox: write denied` })).toBe('sandbox: write denied');
  });
});
