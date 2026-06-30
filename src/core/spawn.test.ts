import { afterEach, describe, expect, it, vi } from 'vitest';

import { killTree, makeEscalatingKill } from './spawn';

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
