import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reviewDir } from '../../core/artifacts';
import type { ReviewerConfig, ReviewPacket } from '../../core/types';
import type { CodexReviewResult, RunReviewOpts } from '../../reviewers/codex';
import { CODEX_SANDBOX_PROFILE } from '../../reviewers/codex-sandbox';
import { GROK_SANDBOX_PROFILE } from '../../reviewers/grok';

import { RETRIES_ON_PACKET, runCoreSeat } from './seat-run';

const PACKET: ReviewPacket = { complete: true, objective: 'o', pr: 0, repo: 'r', sections: [] };
const CODEX: ReviewerConfig = { cmd: 'codex', effort: 'xhigh', id: 'codex', model: 'm', vendor: 'openai' };
const GROK: ReviewerConfig = { cmd: 'grok', effort: 'high', id: 'grok', model: 'g', sandbox: 'ensemble-review', vendor: 'xai' };

const REVIEW = '```json\n{"summary":"s","findings":[]}\n```';

interface Call {
  prompt: string;
  worktree?: string;
}

// A stub adapter: records every invocation, replies from a queue. The queue is what lets one test
// say "the worktree attempt produced nothing, the packet attempt reviewed".
function stubAdapter(replies: CodexReviewResult[]): {
  adapter: (p: string, c: ReviewerConfig, o?: RunReviewOpts) => Promise<CodexReviewResult>;
  calls: Call[];
} {
  const calls: Call[] = [];
  const queue = [...replies];
  return {
    adapter: async (prompt, _config, opts) => {
      calls.push({ prompt, worktree: opts?.worktree });
      return queue.shift() ?? { ok: false, raw: null, stderrTail: 'exhausted', timedOut: false };
    },
    calls,
  };
}

const reviewed = (): CodexReviewResult => ({ ok: true, raw: REVIEW, stderrTail: '', timedOut: false });
const empty = (why = 'killed'): CodexReviewResult => ({ ok: false, raw: null, stderrTail: why, timedOut: false });
const timedOut = (): CodexReviewResult => ({ ok: false, raw: null, stderrTail: '', timedOut: true });

let out: string;
beforeEach(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-seatrun-'));
});
afterEach(() => {
  fs.rmSync(out, { force: true, recursive: true });
});

const base = {
  log: () => {},
  packet: PACKET,
  packetComplete: true,
  packetPrompt: 'PACKET PROMPT',
  runId: 'r1',
  worktreePrompt: 'PACKET PROMPT + WORKTREE',
};

describe('a QUALIFIED seat runs in the worktree and realizes worktree evidence', () => {
  it('passes the worktree as the spawn cwd and sends it the worktree prompt', async () => {
    const { adapter, calls } = stubAdapter([reviewed()]);
    const seat = await runCoreSeat({
      ...base,
      adapter,
      out,
      qualification: { profile: GROK_SANDBOX_PROFILE, qualified: true, reason: null },
      retryOnPacket: RETRIES_ON_PACKET.grok,
      reviewer: GROK,
      worktree: '/tmp/wt',
    });
    expect(calls).toEqual([{ prompt: 'PACKET PROMPT + WORKTREE', worktree: '/tmp/wt' }]);
    expect(seat.realized).toBe('worktree');
    expect(seat.fallbackReason).toBeNull();
    expect(seat.review.terminalState).toBe('reviewed');
  });
});

describe('an UNQUALIFIED seat keeps the packet, LOUDLY (spec §2 — fail closed per seat)', () => {
  it('never sends the worktree prompt, never passes a cwd, and carries the reason forward', async () => {
    const { adapter, calls } = stubAdapter([reviewed()]);
    const logged: string[] = [];
    const seat = await runCoreSeat({
      ...base,
      adapter,
      log: (m) => logged.push(m),
      out,
      qualification: { profile: CODEX_SANDBOX_PROFILE, qualified: false, reason: 'codex: no qualifying sandbox on linux' },
      retryOnPacket: RETRIES_ON_PACKET.codex,
      reviewer: CODEX,
      worktree: '/tmp/wt',
    });
    expect(calls).toEqual([{ prompt: 'PACKET PROMPT', worktree: undefined }]);
    expect(seat.realized).toBe('packet');
    expect(seat.fallbackReason).toContain('no qualifying sandbox');
    expect(logged.join('\n')).toContain('no qualifying sandbox');
  });
});

describe('the codex WRAPPER VIABILITY CHECK is a real review, and its failure falls back LOUDLY', () => {
  it('a worktree attempt that produces nothing re-runs on the packet and realizes `packet`', async () => {
    const { adapter, calls } = stubAdapter([empty('sandbox-exec: operation not permitted'), reviewed()]);
    const logged: string[] = [];
    const seat = await runCoreSeat({
      ...base,
      adapter,
      log: (m) => logged.push(m),
      out,
      qualification: { profile: CODEX_SANDBOX_PROFILE, qualified: true, reason: null },
      retryOnPacket: RETRIES_ON_PACKET.codex,
      reviewer: CODEX,
      worktree: '/tmp/wt',
    });
    expect(calls).toEqual([
      { prompt: 'PACKET PROMPT + WORKTREE', worktree: '/tmp/wt' },
      { prompt: 'PACKET PROMPT', worktree: undefined },
    ]);
    expect(seat.realized).toBe('packet');
    expect(seat.review.terminalState).toBe('reviewed'); // the PACKET review is the one that counted
    expect(seat.fallbackReason).toContain('ensemble-review-codex');
    expect(seat.fallbackReason).toContain('FELL BACK');
    expect(logged.join('\n')).toContain('FELL BACK');
    // The trail records the review that COUNTED (the packet re-run), not the failed attempt.
    expect(fs.readFileSync(path.join(reviewDir(out, 'r1'), 'prompt.codex.md'), 'utf8')).toBe('PACKET PROMPT');
  });

  it('a TIMED-OUT worktree attempt is NOT a viability signal — no second 12-minute review', async () => {
    const { adapter, calls } = stubAdapter([timedOut(), reviewed()]);
    const seat = await runCoreSeat({
      ...base,
      adapter,
      out,
      qualification: { profile: CODEX_SANDBOX_PROFILE, qualified: true, reason: null },
      retryOnPacket: RETRIES_ON_PACKET.codex,
      reviewer: CODEX,
      worktree: '/tmp/wt',
    });
    expect(calls).toHaveLength(1);
    expect(seat.realized).toBe('worktree');
    expect(seat.review.terminalState).toBe('failed-reviewer');
    expect(seat.fallbackReason).toBeNull();
  });

  it('grok does NOT retry — its profile is proven, so a failure there is a reviewer failure', async () => {
    expect(RETRIES_ON_PACKET).toEqual({ claude: false, codex: true, grok: false });
    const { adapter, calls } = stubAdapter([empty(), reviewed()]);
    const seat = await runCoreSeat({
      ...base,
      adapter,
      out,
      qualification: { profile: GROK_SANDBOX_PROFILE, qualified: true, reason: null },
      retryOnPacket: RETRIES_ON_PACKET.grok,
      reviewer: GROK,
      worktree: '/tmp/wt',
    });
    expect(calls).toHaveLength(1);
    expect(seat.realized).toBe('worktree');
    expect(seat.review.terminalState).toBe('failed-reviewer');
  });
});

describe('the packet path is untouched', () => {
  it('no worktree ⇒ packet prompt, no cwd, no fallback reason', async () => {
    const { adapter, calls } = stubAdapter([reviewed()]);
    const seat = await runCoreSeat({
      ...base,
      adapter,
      out,
      retryOnPacket: RETRIES_ON_PACKET.codex,
      reviewer: CODEX,
    });
    expect(calls).toEqual([{ prompt: 'PACKET PROMPT', worktree: undefined }]);
    expect(seat.realized).toBe('packet');
    expect(seat.fallbackReason).toBeNull();
  });

  it('an incomplete packet never spawns the seat (a blind review can never qualify a receipt)', async () => {
    const { adapter, calls } = stubAdapter([reviewed()]);
    const seat = await runCoreSeat({
      ...base,
      adapter,
      out,
      packet: { ...PACKET, complete: false },
      packetComplete: false,
      retryOnPacket: RETRIES_ON_PACKET.codex,
      reviewer: CODEX,
      worktree: '/tmp/wt',
    });
    expect(calls).toEqual([]);
    expect(seat.realized).toBe('packet');
    expect(seat.review.terminalState).toBe('failed-reviewer');
  });

  it('an adapter that THROWS is recorded as a failed seat, never a rejected fan-out', async () => {
    const seat = await runCoreSeat({
      ...base,
      adapter: () => Promise.reject(new Error('codex binary not found')),
      out,
      retryOnPacket: RETRIES_ON_PACKET.codex,
      reviewer: CODEX,
    });
    expect(seat.review.terminalState).toBe('failed-reviewer');
    expect(seat.review.summary).toContain('codex binary not found');
  });
});
