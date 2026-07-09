import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCodexReviewArgs, runCodexReview } from './codex';
import type { ReviewerConfig } from '../core/types';

const CONFIG: ReviewerConfig = {
  cmd: 'codex',
  effort: 'xhigh',
  id: 'codex',
  model: 'gpt-5.5',
  vendor: 'openai',
};

// Mock just `spawn` (keep the rest of child_process real for bin resolution),
// and stub resolveCodexBin so the test never shells out to find codex. The real
// watchdog (makeEscalatingKill) stays — we're asserting runCodexReview WIRES it.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('../core/spawn', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/spawn')>()),
  resolveCodexBin: () => 'codex',
}));

type FakeChild = EventEmitter & {
  kill: (sig: string) => void;
  kills: string[];
  stderr: EventEmitter;
};

let child: FakeChild | null = null;
let lastArgs: string[] = [];
let lastStdio: unknown[] = [];
let lastOpts: { detached?: boolean; stdio: unknown[] } = { stdio: [] };

beforeEach(() => {
  child = null;
  vi.mocked(spawn).mockImplementation(((
    _bin: string,
    args: string[],
    opts: { detached?: boolean; stdio: unknown[] }
  ) => {
    const c = new EventEmitter() as FakeChild;
    c.kills = [];
    c.kill = (sig: string) => {
      c.kills.push(sig);
    };
    c.stderr = new EventEmitter();
    child = c;
    lastArgs = args;
    lastStdio = opts.stdio;
    lastOpts = opts;
    return c;
  }) as unknown as typeof spawn);
});

describe('buildCodexReviewArgs', () => {
  it('pins read-only, the configured model+effort, skip-git, and the -o file', () => {
    const args = buildCodexReviewArgs(CONFIG, '/tmp/out.md', 'PROMPT');
    expect(args[0]).toBe('exec');
    expect(args).toContain('--skip-git-repo-check');
    // read-only: the reviewer can NEVER mutate the work.
    expect(args.join(' ')).toContain('-s read-only');
    // the CONFIGURED strong model + effort, not the account default.
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.5');
    expect(args).toContain('model_reasoning_effort="xhigh"');
    // reply comes from the -o file; the prompt is the final positional arg.
    expect(args[args.indexOf('-o') + 1]).toBe('/tmp/out.md');
    expect(args.at(-1)).toBe('PROMPT');
    // no stdin flag — stdin is closed via the spawn stdio, not an arg.
    expect(args.join(' ')).not.toMatch(/stdin/i);
  });
});

describe('runCodexReview', () => {
  it('closes stdin and kills the child when the watchdog fires', async () => {
    const p = runCodexReview('PROMPT', CONFIG, { timeoutMs: 20 });
    // The lived lesson: stdin MUST be closed (an open stdin wedges codex).
    expect(lastStdio[0]).toBe('ignore');
    await new Promise((r) => setTimeout(r, 45)); // let the watchdog fire
    expect(child?.kills[0]).toBe('SIGTERM');
    child?.emit('close');
    const result = await p;
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.raw).toBeNull();
  });

  it('returns the reviewer reply read from the -o file on a clean close', async () => {
    const p = runCodexReview('PROMPT', CONFIG, { timeoutMs: 10_000 });
    const outFile = lastArgs[lastArgs.indexOf('-o') + 1];
    fs.writeFileSync(outFile, 'CODEX REVIEW BODY');
    child?.emit('close');
    const result = await p;
    expect(result.ok).toBe(true);
    expect(result.raw).toBe('CODEX REVIEW BODY');
    expect(result.timedOut).toBe(false);
  });

  it('spawns detached so the watchdog can reap codex’s whole process group', () => {
    runCodexReview('PROMPT', CONFIG, { timeoutMs: 10_000 });
    // a NEGATIVE-pid signal only reaps the tree when the child is a group leader.
    expect(lastOpts.detached).toBe(true);
  });

  it('settles on `exit` even when `close` never fires (the rmcp-grandchild wedge)', async () => {
    // The bug class: an orphaned codex subprocess holds the inherited stderr
    // pipe, so `close` never arrives. Pre-fix this hung forever (only `close`
    // was wired); now `exit` alone settles the promise.
    const p = runCodexReview('PROMPT', CONFIG, { timeoutMs: 10_000 });
    child?.emit('exit', null, 'SIGKILL'); // process died; stdio streams never EOF
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.raw).toBeNull();
  });

  it('the absolute backstop resolves the promise even if neither exit nor close ever fires', async () => {
    vi.useFakeTimers();
    try {
      const p = runCodexReview('PROMPT', CONFIG, { timeoutMs: 20 });
      // Never emit exit/close/error — a fully wedged tree we somehow can't reap.
      // Backstop = timeoutMs + KILL_GRACE_MS(3000) + slack(5000).
      await vi.advanceTimersByTimeAsync(20 + 3000 + 5000 + 1);
      const result = await p;
      expect(result.ok).toBe(false);
      expect(result.timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The shared RunReviewOpts carries `worktree`, but codex cannot honor it until its external
// sandbox-exec wrapper is wired. Accepting-and-ignoring it would let a receipt attest worktree
// evidence codex never had — the exact silent downgrade the realized-evidence map exists to
// prevent. It must fail CLOSED, and it must RESOLVE (every reviewer path settles to a result;
// throwing would surface as an unhandled rejection in an adapter caller that does not catch).
describe('runCodexReview — worktree evidence is refused, not silently downgraded', () => {
  it('returns a failed seat without spawning codex', async () => {
    const spawned = vi.mocked(spawn);
    spawned.mockClear();
    const result = await runCodexReview('p', CONFIG, { worktree: '/private/tmp/wt' });
    expect(result.ok).toBe(false);
    expect(result.raw).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderrTail).toMatch(/cannot run against a worktree yet/);
    expect(spawned).not.toHaveBeenCalled();
  });

  it('resolves rather than rejects', async () => {
    await expect(
      runCodexReview('p', CONFIG, { worktree: '/private/tmp/wt' })
    ).resolves.toMatchObject({ ok: false });
  });

  it('the packet path is untouched when no worktree is requested', async () => {
    const spawned = vi.mocked(spawn);
    spawned.mockClear();
    void runCodexReview('p', CONFIG, {});
    expect(spawned).toHaveBeenCalled();
  });
});
