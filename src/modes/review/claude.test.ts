import { describe, expect, it } from 'vitest';

import type { VoiceConfig } from '../brainstorm/types';

import {
  buildClaudeReviewArgs,
  CLAUDE_REVIEW_DENIED_TOOLS,
  extractStreamResult,
  isTransientApiErrorReply,
  type ReviewerExec,
  runClaudeReviewVoice,
} from './claude';

const CFG = (over: Partial<VoiceConfig> = {}): VoiceConfig => ({
  cmd: 'claude', effort: 'default', id: 'claude', model: 'default', vendor: 'anthropic', ...over,
});

describe('buildClaudeReviewArgs — the capability fence (pinned as data)', () => {
  it('always headless, plain output, plan-mode + the execution/egress deny-list', () => {
    const args = buildClaudeReviewArgs('THE PROMPT', CFG());
    expect(args.slice(0, 5)).toEqual(['-p', 'THE PROMPT', '--output-format', 'stream-json', '--verbose']);
    // Plan mode alone is NOT a fence — it still executes Bash. Removing the tools is.
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(args).toContain('--disallowedTools');
    for (const t of CLAUDE_REVIEW_DENIED_TOOLS) expect(args).toContain(t);
    expect([...CLAUDE_REVIEW_DENIED_TOOLS]).toEqual([
      'Bash', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
    ]);
  });

  it('omits --model/--effort at the "default" sentinel, includes them when configured', () => {
    expect(buildClaudeReviewArgs('p', CFG())).not.toContain('--model');
    expect(buildClaudeReviewArgs('p', CFG())).not.toContain('--effort');
    const args = buildClaudeReviewArgs('p', CFG({ model: 'claude-opus-4-8', effort: 'high' }));
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-8');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });

  it('rejects an invalid effort (leaves it to the CLI default)', () => {
    expect(buildClaudeReviewArgs('p', CFG({ effort: 'bogus' }))).not.toContain('--effort');
  });
});

describe('isTransientApiErrorReply — the 529/429 fast-fail predicate', () => {
  it('matches the observed CLI error lines (529 overloaded, 429, other 5xx)', () => {
    expect(
      isTransientApiErrorReply(
        'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.'
      )
    ).toBe(true);
    expect(isTransientApiErrorReply('API Error: 429 Too Many Requests')).toBe(true);
    expect(isTransientApiErrorReply('API Error: 503 Service Unavailable')).toBe(true);
    expect(isTransientApiErrorReply('  the server is overloaded, try later  ')).toBe(true);
  });

  it('never classes a real review as transient (length guard + no error line)', () => {
    expect(isTransientApiErrorReply('')).toBe(false);
    expect(isTransientApiErrorReply('{"findings": [], "summary": "clean"}')).toBe(false);
    // A long reply that merely QUOTES an error string is a review, not a transport error.
    const review = `The retry handler mishandles API Error: 529 responses. ${'x'.repeat(1600)}`;
    expect(isTransientApiErrorReply(review)).toBe(false);
    // 4xx that are NOT rate limits are never transient.
    expect(isTransientApiErrorReply('API Error: 401 Unauthorized')).toBe(false);
  });
});

describe('runClaudeReviewVoice — transient API error retry', () => {
  const API_529 = 'API Error: 529 Overloaded. This is a server-side issue, usually temporary.';
  const GOOD = '```json\n{"findings": [], "summary": "clean"}\n```';
  const execReturning = (replies: string[]) => {
    const calls: unknown[] = [];
    const exec: ReviewerExec = (req) => {
      calls.push(req);
      const raw = replies[Math.min(calls.length - 1, replies.length - 1)];
      return Promise.resolve({ raw, stderrTail: '', timedOut: false });
    };
    return { calls, exec };
  };

  it('retries a fast 529 and returns the eventual real reply, noting the retries', async () => {
    const { calls, exec } = execReturning([API_529, API_529, GOOD]);
    const res = await runClaudeReviewVoice('p', CFG(), {}, { exec, retryDelaysMs: [0, 0] });
    expect(calls).toHaveLength(3);
    expect(res.ok).toBe(true);
    expect(res.raw).toBe(GOOD);
    expect(res.stderrTail).toContain('[retried 2x on transient API error]');
  });

  it('exhausted retries fail with the REAL cause, never a parse-shaped failure', async () => {
    const { calls, exec } = execReturning([API_529]);
    const res = await runClaudeReviewVoice('p', CFG(), {}, { exec, retryDelaysMs: [0, 0] });
    expect(calls).toHaveLength(3);
    expect(res.ok).toBe(false);
    expect(res.raw).toBeNull();
    expect(res.failWhy).toContain('persistent transient API error after 3 attempts');
    expect(res.stderrTail).toContain('API Error: 529');
  });

  it('a SLOW attempt that replies with an error string is returned as-is, never retried', async () => {
    const { calls, exec } = execReturning([API_529]);
    const res = await runClaudeReviewVoice('p', CFG(), {}, { exec, fastFailMs: 0, retryDelaysMs: [0, 0] });
    expect(calls).toHaveLength(1);
    expect(res.raw).toBe(API_529);
    expect(res.failWhy).toBeUndefined();
  });

  it('a timeout is never retried', async () => {
    const calls: unknown[] = [];
    const exec: ReviewerExec = (req) => {
      calls.push(req);
      return Promise.resolve({ raw: null, stderrTail: '', timedOut: true });
    };
    const res = await runClaudeReviewVoice('p', CFG(), {}, { exec, retryDelaysMs: [0, 0] });
    expect(calls).toHaveLength(1);
    expect(res.timedOut).toBe(true);
    expect(res.ok).toBe(false);
  });
});

describe('extractStreamResult — the stream-json result event', () => {
  const RESULT = JSON.stringify({
    is_error: false, result: '```json\n{"findings": [], "summary": "clean"}\n```',
    subtype: 'success', type: 'result',
  });
  const HEARTBEAT = JSON.stringify({ subtype: 'thinking_tokens', type: 'system' });

  it('finds the last result event among heartbeats and junk lines', () => {
    const out = extractStreamResult([HEARTBEAT, 'not json', HEARTBEAT, RESULT].join('\n'));
    expect(out.found).toBe(true);
    expect(out.isError).toBe(false);
    expect(out.text).toContain('"findings"');
  });

  it('carries the error fields of an error-shaped result', () => {
    const err = JSON.stringify({
      api_error_status: 529, is_error: true, result: 'API Error: 529 Overloaded', type: 'result',
    });
    const out = extractStreamResult([HEARTBEAT, err].join('\n'));
    expect(out).toEqual({ apiErrorStatus: 529, found: true, isError: true, text: 'API Error: 529 Overloaded' });
  });

  it('a stream with NO result event (killed mid-run) reports found:false', () => {
    const out = extractStreamResult([HEARTBEAT, HEARTBEAT].join('\n'));
    expect(out.found).toBe(false);
  });
});

describe('runClaudeReviewVoice — stream-json integration', () => {
  const GOOD_STREAM = [
    JSON.stringify({ subtype: 'init', type: 'system' }),
    JSON.stringify({ is_error: false, result: 'FINAL REVIEW TEXT', subtype: 'success', type: 'result' }),
  ].join('\n');

  it('returns the result event text as raw, not the stream transcript', async () => {
    const exec: ReviewerExec = () => Promise.resolve({ raw: GOOD_STREAM, stderrTail: '', timedOut: false });
    const res = await runClaudeReviewVoice('p', CFG(), {}, { exec, retryDelaysMs: [0, 0] });
    expect(res.ok).toBe(true);
    expect(res.raw).toBe('FINAL REVIEW TEXT');
  });

  it('retries a fast error-shaped result event (529 via api_error_status)', async () => {
    const errStream = JSON.stringify({ api_error_status: 529, is_error: true, result: 'boom', type: 'result' });
    const calls: unknown[] = [];
    const exec: ReviewerExec = () => {
      calls.push(1);
      return Promise.resolve({
        raw: calls.length < 3 ? errStream : GOOD_STREAM, stderrTail: '', timedOut: false,
      });
    };
    const res = await runClaudeReviewVoice('p', CFG(), {}, { exec, retryDelaysMs: [0, 0] });
    expect(calls).toHaveLength(3);
    expect(res.ok).toBe(true);
    expect(res.raw).toBe('FINAL REVIEW TEXT');
  });

  it('an inactivity kill reports a STALL, never a generic timeout', async () => {
    const exec: ReviewerExec = () =>
      Promise.resolve({ raw: null, stderrTail: '', timedOut: true, timedOutReason: 'inactivity' });
    const res = await runClaudeReviewVoice('p', CFG(), {}, { exec, retryDelaysMs: [0, 0] });
    expect(res.ok).toBe(false);
    expect(res.timedOut).toBe(true);
    expect(res.failWhy).toContain('stalled: no stream output for 10 min');
  });
});
