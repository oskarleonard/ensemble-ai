import { describe, expect, it } from 'vitest';

import * as engine from '../../index';
import type { ReviewerConfig } from '../../core/types';
import { toCodexResult } from '../../reviewers/codex';
import { runClaudeVoice } from '../brainstorm/claude';

import { type ReviewerExec, runClaudeReviewVoice } from './claude';
import { runClaudeExecVoice } from './exec-voice';
import { isSettledApiFailure, packetRetryAfterWorktree, RETRIES_ON_PACKET } from './seat-run';

// The packet-retry rule runCoreSeat applies after a failed worktree attempt, exported for a
// consumer that composes its own seats (munin-dashboard#315): one rule, no host mirror.
describe('packetRetryAfterWorktree', () => {
  const failed = { raw: null, timedOut: false };

  it('re-runs only a seat whose sandbox is the unproven mechanism (codex), after a plain failure', () => {
    expect(packetRetryAfterWorktree(failed, RETRIES_ON_PACKET.codex)).toBe(true);
    expect(packetRetryAfterWorktree(failed, RETRIES_ON_PACKET.grok)).toBe(false);
    expect(packetRetryAfterWorktree(failed, RETRIES_ON_PACKET.claude)).toBe(false);
    expect(packetRetryAfterWorktree({ ...failed, failKind: 'api-error' }, true)).toBe(true);
  });

  it('only after a FAILED attempt — the terminal state the seat records, never `ok`', () => {
    const review = '```json\n{"summary":"s","findings":[]}\n```';
    expect(packetRetryAfterWorktree({ raw: review, timedOut: false }, true)).toBe(false);
    // A reply that does not parse failed the seat, whatever `ok` said: the CLI retries it.
    expect(packetRetryAfterWorktree({ raw: 'no json here', timedOut: false }, true)).toBe(true);
    // A review cut off by the watchdog is a failed attempt, and a timeout never retries.
    expect(packetRetryAfterWorktree({ raw: review, timedOut: true }, true)).toBe(false);
  });

  it('never after a timeout or a failure the adapter settled', () => {
    expect(packetRetryAfterWorktree({ raw: null, timedOut: true }, true)).toBe(false);
    expect(packetRetryAfterWorktree({ ...failed, failKind: 'transient-api' }, true)).toBe(false);
    expect(packetRetryAfterWorktree({ ...failed, failKind: 'usage-limit' }, true)).toBe(false);
    expect(isSettledApiFailure({ failKind: 'transient-api' })).toBe(true);
    expect(isSettledApiFailure({ failKind: 'usage-limit' })).toBe(true);
    expect(isSettledApiFailure({ failKind: 'stalled' })).toBe(false);
    expect(isSettledApiFailure({})).toBe(false);
  });

  it("classifies the Claude seat's settled failures (an exhausted transient, a usage limit) as settled", async () => {
    const CFG: ReviewerConfig = { cmd: 'claude', effort: 'high', id: 'claude', model: 'm', vendor: 'anthropic' };
    const replying =
      (raw: string): ReviewerExec =>
      () =>
        Promise.resolve({ raw, stderrTail: '', timedOut: false });
    const transient = await runClaudeReviewVoice('p', CFG, {}, {
      exec: replying('API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'),
      retryDelaysMs: [0, 0],
    });
    const limit = await runClaudeReviewVoice('p', CFG, {}, {
      exec: replying("You've hit your session limit · resets 5:10pm (Europe/Stockholm)"),
      retryDelaysMs: [0, 0],
    });
    expect(transient.failWhy).toContain('persistent transient API error');
    expect(limit.failWhy).toContain('operator usage limit reached');
    for (const settled of [transient, limit]) {
      expect(isSettledApiFailure(settled)).toBe(true);
      expect(packetRetryAfterWorktree(settled, true)).toBe(false);
    }
  });

  it('gives codex and every Claude runner the SAME answer on the same API death, however late it came', async () => {
    const CFG: ReviewerConfig = { cmd: 'claude', effort: 'high', id: 'claude', model: 'm', vendor: 'anthropic' };
    const errorResult = (status: number, text: string) =>
      JSON.stringify({ api_error_status: status, is_error: true, result: text, type: 'result' });
    // fastFailMs 0: every death arrives AFTER the fast-fail window, so no runner retries it — the
    // error-result branch alone names it (a 529 after a slow start, the case codex names untimed).
    const claudeRunners = (raw: string) => {
      const exec = () => Promise.resolve({ raw, stderrTail: '', timedOut: false });
      const seams = { exec, fastFailMs: 0, retryDelaysMs: [] };
      return Promise.all([
        runClaudeReviewVoice('p', CFG, {}, seams),
        runClaudeVoice('p', CFG, {}, seams),
        runClaudeExecVoice('p', CFG, { timeoutMs: 1000, worktree: '/nonexistent' }, seams),
      ]);
    };
    const codexDeath = (message: string) =>
      toCodexResult({ raw: null, stderrTail: '', streamTail: JSON.stringify({ error: { message }, type: 'turn.failed' }), timedOut: false });

    const overloaded = await claudeRunners(errorResult(529, 'API Error: 529 Overloaded'));
    const codexOverloaded = codexDeath('exceeded retry limit, last status: 529 Overloaded');
    expect(isSettledApiFailure(codexOverloaded)).toBe(true);
    for (const seat of overloaded) {
      expect(seat.failKind).toBe('transient-api');
      expect(isSettledApiFailure(seat)).toBe(isSettledApiFailure(codexOverloaded));
      expect(packetRetryAfterWorktree(seat, true)).toBe(false);
    }

    // A permanent error (auth) is not settled on either side: it may be the sandbox's doing.
    const auth = await claudeRunners(errorResult(401, 'Invalid API key'));
    const codexAuth = codexDeath('unexpected status 401 Unauthorized');
    expect(codexAuth.failKind).toBe('api-error');
    for (const seat of auth) {
      expect(seat.failKind).toBe('api-error');
      expect(isSettledApiFailure(seat)).toBe(false);
      expect(packetRetryAfterWorktree(seat, true)).toBe(true);
    }
  });

  it('is reachable through the library entry, with the table — frozen, so no consumer rewrites it', () => {
    expect(engine.packetRetryAfterWorktree).toBe(packetRetryAfterWorktree);
    expect(engine.isSettledApiFailure).toBe(isSettledApiFailure);
    expect(engine.RETRIES_ON_PACKET).toEqual({ claude: false, codex: true, grok: false });
    expect(Object.isFrozen(engine.RETRIES_ON_PACKET)).toBe(true);
    expect(() => {
      (engine.RETRIES_ON_PACKET as Record<string, boolean>).claude = true;
    }).toThrow(TypeError);
    expect(RETRIES_ON_PACKET.claude).toBe(false);
  });
});
