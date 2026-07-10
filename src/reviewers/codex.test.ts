import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildCodexReviewArgs, runCodexReview } from './codex';
import { codexSandboxSupported } from './codex-sandbox';
import { resolveCodexBin } from '../core/spawn';
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
  resolveCodexBin: vi.fn(() => 'codex'),
}));

type FakeChild = EventEmitter & {
  kill: (sig: string) => void;
  kills: string[];
  stderr: EventEmitter;
};

let child: FakeChild | null = null;
let lastArgs: string[] = [];
let lastStdio: unknown[] = [];
let lastOpts: { cwd?: string; detached?: boolean; stdio: unknown[] } = { stdio: [] };

beforeEach(() => {
  child = null;
  vi.mocked(spawn).mockImplementation(((
    _bin: string,
    args: string[],
    opts: { cwd?: string; detached?: boolean; stdio: unknown[] }
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

// WORKTREE EVIDENCE (§2): codex takes the worktree ONLY inside the ensemble-owned external
// Seatbelt wrapper — `sandbox-exec -f <profile> codex exec … --dangerously-bypass-approvals-and-
// sandbox`, cwd = the worktree. Anything that would make it review the packet while a receipt
// attests worktree evidence must fail CLOSED, and it must RESOLVE (every reviewer path settles to
// a result; throwing would surface as an unhandled rejection in an adapter caller that does not
// catch).
describe('runCodexReview — worktree evidence runs under the external sandbox wrapper', () => {
  const realWorktree = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'codex-wt-'));

  // `spawn` is MOCKED, so runReviewerExec's promise never settles and the `.finally(cleanup)` in
  // runCodexWorktreeReview never fires. The two owner-only temp dirs the call created (the sandbox
  // profile, and the seat's reply dir) are the test's to reap, or every run strands a pair.
  const reapSpawnDirs = (args: string[]): void => {
    for (const file of [args[1], args[args.indexOf('-o') + 1]]) {
      fs.rmSync(path.dirname(file), { force: true, recursive: true });
    }
  };

  it('wraps codex in sandbox-exec, disables its internal sandbox, and cds into the worktree', async () => {
    if (!codexSandboxSupported()) return; // Seatbelt is macOS-only; the fallback is asserted below
    const wt = realWorktree();
    const spawned = vi.mocked(spawn);
    spawned.mockClear();
    void runCodexReview('p', CONFIG, { timeoutMs: 10_000, worktree: wt });

    expect(spawned).toHaveBeenCalled();
    const [bin, args] = spawned.mock.calls[0] as unknown as [string, string[]];
    expect(bin).toBe('/usr/bin/sandbox-exec');
    expect(args[0]).toBe('-f');
    expect(fs.readFileSync(args[1], 'utf8')).toContain('(deny default)');
    expect(args[2]).toBe('codex'); // the wrapped binary, from resolveCodexBin
    // The INTERNAL sandbox is off (nested Seatbelt does not compose) — the external profile governs.
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args).not.toContain('read-only');
    // cwd = the worktree, so codex's file tools reach the project. Seatbelt matches resolved paths.
    expect(fs.realpathSync(String(lastOpts.cwd))).toBe(fs.realpathSync(wt));
    reapSpawnDirs(args);
    fs.rmSync(wt, { force: true, recursive: true });
  });

  // The seat WRITES its `-o` reply from inside the profile, whose only writable roots are
  // `~/.codex`, `/private/tmp` and `/dev`. `os.tmpdir()` realpaths under `/private/var/folders/…`
  // — readable, NEVER writable — so a reply file there makes codex die on "Failed to write last
  // message file … Operation not permitted" AFTER a full review, and the seat scores
  // failed-reviewer on every single worktree run. Pin the writable root.
  it('puts the `-o` reply under a writable sandbox root, never the unwritable $TMPDIR', () => {
    if (!codexSandboxSupported()) return;
    const wt = realWorktree();
    const spawned = vi.mocked(spawn);
    spawned.mockClear();
    void runCodexReview('p', CONFIG, { timeoutMs: 10_000, worktree: wt });

    const [, args] = spawned.mock.calls[0] as unknown as [string, string[]];
    const outFile = args[args.indexOf('-o') + 1];
    expect(outFile.startsWith('/private/tmp/')).toBe(true);
    expect(outFile.startsWith(fs.realpathSync(os.tmpdir()))).toBe(false);
    // Owner-only, because /private/tmp is world-shared.
    expect(fs.statSync(path.dirname(outFile)).mode & 0o777).toBe(0o700);
    reapSpawnDirs(args);
    fs.rmSync(wt, { force: true, recursive: true });
  });

  // resolveCodexBin THROWS when codex is not installed. If it is called after the profile is
  // written, its owner-only temp dir is stranded — and mkdtemp names are random, so nothing can
  // ever find it again. Resolve the binary first.
  it('leaks no sandbox temp dir when the codex binary cannot be resolved', async () => {
    if (!codexSandboxSupported()) return;
    const wt = realWorktree();
    const spawned = vi.mocked(spawn);
    spawned.mockClear();
    const strays = (): string[] =>
      fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ensemble-sb-'));
    const before = strays();
    vi.mocked(resolveCodexBin).mockImplementationOnce(() => {
      throw new Error('codex binary not found');
    });

    const result = await runCodexReview('p', CONFIG, { worktree: wt });
    expect(result.ok).toBe(false);
    expect(result.stderrTail).toContain('codex binary not found');
    expect(spawned).not.toHaveBeenCalled();
    expect(strays()).toEqual(before);
    fs.rmSync(wt, { force: true, recursive: true });
  });

  it('fails CLOSED (never spawns, never rejects) when the profile cannot be built', async () => {
    const spawned = vi.mocked(spawn);
    spawned.mockClear();
    // A worktree path that does not exist: the profile's realpath resolution throws, so no naked
    // codex is ever spawned against a tree it would read unfenced.
    const result = await runCodexReview('p', CONFIG, { worktree: '/private/tmp/does-not-exist-wt' });
    expect(result.ok).toBe(false);
    expect(result.raw).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderrTail).toMatch(/^ensemble-ai:/);
    expect(spawned).not.toHaveBeenCalled();
  });

  it('the packet path is untouched when no worktree is requested', async () => {
    const spawned = vi.mocked(spawn);
    spawned.mockClear();
    void runCodexReview('p', CONFIG, {});
    expect(spawned).toHaveBeenCalled();
    const [bin, args] = spawned.mock.calls[0] as unknown as [string, string[]];
    expect(bin).toBe('codex');
    expect(args).toContain('read-only'); // codex's own `-s read-only`, as before
  });
});
