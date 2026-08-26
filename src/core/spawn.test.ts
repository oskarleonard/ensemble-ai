import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { killTree, makeEscalatingKill, runReviewerExec } from './spawn';

afterEach(() => {
  vi.useRealTimers();
});

describe('makeEscalatingKill', () => {
  const sigkills = (kill: { mock: { calls: unknown[][] } }) =>
    kill.mock.calls.filter((c) => c[0] === 'SIGKILL');

  it('SIGTERMs immediately, then SIGKILLs after the grace period', () => {
    vi.useFakeTimers();
    const child = { kill: vi.fn() };
    makeEscalatingKill(child, 3000).kill();
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenLastCalledWith('SIGTERM');
    vi.advanceTimersByTime(2999);
    expect(child.kill).toHaveBeenCalledTimes(1); // not yet
    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenLastCalledWith('SIGKILL');
  });

  it('does not schedule a second SIGKILL on repeated kill()', () => {
    vi.useFakeTimers();
    const child = { kill: vi.fn() };
    const k = makeEscalatingKill(child, 3000);
    k.kill();
    k.kill();
    vi.advanceTimersByTime(3000);
    expect(sigkills(child.kill)).toHaveLength(1);
  });

  it('clear() cancels the pending SIGKILL (the child closed in time)', () => {
    vi.useFakeTimers();
    const child = { kill: vi.fn() };
    const k = makeEscalatingKill(child, 3000);
    k.kill();
    k.clear();
    vi.advanceTimersByTime(10_000);
    expect(sigkills(child.kill)).toHaveLength(0);
  });
});

describe('killTree', () => {
  it('signals the whole process GROUP (negative pid), never just the direct child', () => {
    const child = { kill: vi.fn(), pid: 4242 };
    const signalGroup = vi.fn();
    killTree(child, 'SIGKILL', signalGroup);
    // the real default is process.kill(-pid, sig) — the group, so the reviewer's
    // rmcp subprocesses die too and can't keep the stderr pipe open past `exit`.
    expect(signalGroup).toHaveBeenCalledWith(4242, 'SIGKILL');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('falls back to a direct kill when the child has no pid (a mock / never-spawned child)', () => {
    const child = { kill: vi.fn() };
    const signalGroup = vi.fn();
    killTree(child, 'SIGTERM', signalGroup);
    expect(signalGroup).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('falls back to a direct kill when the group is already gone (ESRCH)', () => {
    const child = { kill: vi.fn(), pid: 99 };
    const signalGroup = vi.fn(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    killTree(child, 'SIGKILL', signalGroup);
    expect(signalGroup).toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });
});

describe('runReviewerExec — liveness (inactivity) watchdog', () => {
  it('reclaims a silent seat with timedOutReason inactivity, fast', async () => {
    const res = await runReviewerExec({
      args: ['-c', 'sleep 5'],
      bin: '/bin/sh',
      capture: 'stdout',
      inactivityTimeoutMs: 200,
      stderrLimit: 500,
      timeoutMs: 20_000,
    });
    expect(res.timedOut).toBe(true);
    expect(res.timedOutReason).toBe('inactivity');
  });

  it('a seat that keeps emitting never trips the liveness bar', async () => {
    const res = await runReviewerExec({
      args: ['-c', 'for i in 1 2 3 4; do echo beat$i; sleep 0.15; done'],
      bin: '/bin/sh',
      capture: 'stdout',
      inactivityTimeoutMs: 400,
      stderrLimit: 500,
      timeoutMs: 20_000,
    });
    expect(res.timedOut).toBe(false);
    expect(res.raw).toContain('beat4');
  });

  it('the absolute backstop still reports absolute', async () => {
    const res = await runReviewerExec({
      args: ['-c', 'while true; do echo beat; sleep 0.05; done'],
      bin: '/bin/sh',
      capture: 'stdout',
      inactivityTimeoutMs: 1_000,
      stderrLimit: 500,
      timeoutMs: 400,
    });
    expect(res.timedOut).toBe(true);
    expect(res.timedOutReason).toBe('absolute');
  });
});

// An outfile seat that ALSO streams progress on stdout (codex `--json` + `-o`): the stream drives
// the liveness watchdog and is kept as a bounded diagnostic tail; the reply still comes from -o.
describe('runReviewerExec — stream liveness beside an outfile reply', () => {
  const outFile = () =>
    path.join(os.tmpdir(), `spawn-stream-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);

  it('events keep the seat alive, the reply still comes from -o, and the stream tail is returned', async () => {
    const out = outFile();
    const res = await runReviewerExec({
      args: ['-c', `for i in 1 2 3 4; do echo "{\\"beat\\":$i}"; sleep 0.15; done; echo REPLY > "${out}"`],
      bin: '/bin/sh',
      inactivityTimeoutMs: 400,
      outFile: out,
      stderrLimit: 500,
      streamStdout: true,
      timeoutMs: 20_000,
    });
    expect(res.timedOut).toBe(false);
    expect(res.raw).toBe('REPLY');
    expect(res.streamTail).toContain('{"beat":4}');
    expect(fs.existsSync(out)).toBe(false); // the -o file is consumed, as on the plain outfile path
  });

  it('a silent streaming seat is reclaimed by the liveness watchdog, not the absolute one', async () => {
    const res = await runReviewerExec({
      args: ['-c', 'sleep 5'],
      bin: '/bin/sh',
      inactivityTimeoutMs: 200,
      outFile: outFile(),
      stderrLimit: 500,
      streamStdout: true,
      timeoutMs: 20_000,
    });
    expect(res.timedOut).toBe(true);
    expect(res.timedOutReason).toBe('inactivity');
    expect(res.raw).toBeNull();
  });

  it('without streamStdout an outfile seat is silent by construction, so the liveness bar is NOT armed', async () => {
    const out = outFile();
    const res = await runReviewerExec({
      args: ['-c', `sleep 0.5; echo REPLY > "${out}"`],
      bin: '/bin/sh',
      inactivityTimeoutMs: 100, // shorter than the run — would reclaim it if armed
      outFile: out,
      stderrLimit: 500,
      timeoutMs: 20_000,
    });
    expect(res.timedOut).toBe(false);
    expect(res.raw).toBe('REPLY');
    expect(res.streamTail).toBeUndefined();
  });

  it('the stream tail is bounded by streamLimit (a chatty seat cannot grow the parent heap)', async () => {
    const out = outFile();
    const res = await runReviewerExec({
      args: ['-c', `for i in $(seq 1 200); do echo "event-$i-xxxxxxxxxxxxxxxxxxxx"; done; echo REPLY > "${out}"`],
      bin: '/bin/sh',
      outFile: out,
      stderrLimit: 500,
      streamLimit: 120,
      streamStdout: true,
      timeoutMs: 20_000,
    });
    expect(res.raw).toBe('REPLY');
    expect(res.streamTail?.length).toBeLessThanOrEqual(120);
    expect(res.streamTail).toContain('event-200');
  });
});
