import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { VoiceConfig } from '../brainstorm/types';

// Mock the shared spawn so we can inspect the argv + cwd of a REAL runClaudeReviewVoice call
// without launching a `claude` binary. This is the only way to prove "the cwd is never the
// worktree" — the property lives in the spawn, not in the pure arg builder.
vi.mock('../../core/spawn', () => ({ runReviewerExec: vi.fn() }));
vi.mock('../brainstorm/claude', () => ({ resolveClaudeBin: () => '/usr/bin/claude' }));

import { runReviewerExec } from '../../core/spawn';

import {
  buildClaudeReviewArgs,
  CLAUDE_CAPABILITY_FENCE,
  CLAUDE_REVIEW_DENIED_TOOLS,
  claudeWorktreePromptSuffix,
  homeReadDenyRules,
  runClaudeReviewVoice,
} from './claude';

const mockExec = vi.mocked(runReviewerExec);

const CFG = (over: Partial<VoiceConfig> = {}): VoiceConfig => ({
  cmd: 'claude', effort: 'default', id: 'claude', model: 'default', vendor: 'anthropic', ...over,
});

// A read root OUTSIDE the home dir, like the real worktree (mkdtemp under os.tmpdir()).
const HOME = '/Users/somebody';
const WORKTREE = '/var/folders/ab/ensemble-worktree-xyz/head';

const denied = (args: string[]): string[] => args.slice(args.indexOf('--disallowedTools') + 1);

describe('the capability fence — what the seat CANNOT do (spec §2, probed 2026-07-10)', () => {
  it('removes execution and egress from EVERY seat, packet or worktree', () => {
    // The whole point: `--permission-mode plan` still EXECUTES Bash. Removing the tool is the fence.
    expect([...CLAUDE_REVIEW_DENIED_TOOLS]).toEqual([
      'Bash', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
    ]);
    for (const seat of [{}, { readRoot: WORKTREE }]) {
      const args = buildClaudeReviewArgs('P', CFG(), { homeDir: HOME, ...seat });
      for (const tool of ['Bash', 'WebFetch', 'WebSearch']) expect(denied(args)).toContain(tool);
      // No MCP servers: a connector that writes to an external service is an egress channel.
      expect(args).toContain('--strict-mcp-config');
    }
  });

  it('denies every READ tool on the home directory — vendor auth is not a model input (§9)', () => {
    const args = buildClaudeReviewArgs('P', CFG(), { homeDir: HOME, readRoot: WORKTREE });
    expect(homeReadDenyRules(HOME)).toEqual([
      'Read(//Users/somebody/**)',
      'Grep(//Users/somebody/**)',
      'Glob(//Users/somebody/**)',
    ]);
    for (const rule of homeReadDenyRules(HOME)) expect(denied(args)).toContain(rule);
  });

  it('grants the worktree as an --add-dir READ ROOT, and only for a worktree seat', () => {
    const wt = buildClaudeReviewArgs('P', CFG(), { homeDir: HOME, readRoot: WORKTREE });
    expect(wt[wt.indexOf('--add-dir') + 1]).toBe(WORKTREE);
    // `--add-dir` is variadic: a non-variadic flag MUST follow it or the CLI swallows the next arg.
    expect(wt[wt.indexOf('--add-dir') + 2]).toBe('--strict-mcp-config');
    expect(buildClaudeReviewArgs('P', CFG(), { homeDir: HOME })).not.toContain('--add-dir');
  });

  it('`--disallowedTools` is LAST — it is variadic, so nothing may follow it', () => {
    const args = buildClaudeReviewArgs('P', CFG({ effort: 'max', model: 'opus' }), {
      homeDir: HOME,
      readRoot: WORKTREE,
    });
    const i = args.indexOf('--disallowedTools');
    expect(args.slice(i + 1).some((a) => a.startsWith('--'))).toBe(false);
    // model/effort still land, before the variadic tail.
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--effort') + 1]).toBe('max');
  });

  it('REFUSES to fence a read root inside $HOME — the home deny would deny the worktree', () => {
    expect(() =>
      buildClaudeReviewArgs('P', CFG(), { homeDir: HOME, readRoot: `${HOME}/tmp/wt` })
    ).toThrow(/inside the home directory/);
    // Not a prefix-string confusion: a sibling dir that merely starts with the home path is fine.
    expect(() =>
      buildClaudeReviewArgs('P', CFG(), { homeDir: HOME, readRoot: `${HOME}-evil/wt` })
    ).not.toThrow();
  });

  it('names itself `claude-capability-fence` v1 — receipts state what actually fenced the seat', () => {
    expect(CLAUDE_CAPABILITY_FENCE).toEqual({ id: 'claude-capability-fence', version: 1 });
  });
});

describe('the seat cwd is NEVER the worktree (an in-tree CLAUDE.md must not be in the cwd hierarchy)', () => {
  beforeEach(() => {
    mockExec.mockReset();
    mockExec.mockResolvedValue({ raw: 'reply', stderrTail: '', timedOut: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it('spawns a worktree seat in a NEUTRAL, empty, engine-owned dir and reaps it', async () => {
    let observedCwd = '';
    let wasEmpty: string[] = ['not-read'];
    mockExec.mockImplementation(async (opts) => {
      observedCwd = opts.cwd ?? '';
      wasEmpty = fs.readdirSync(observedCwd);
      return { raw: 'reply', stderrTail: '', timedOut: false };
    });

    await runClaudeReviewVoice('P', CFG(), { worktree: WORKTREE });

    expect(observedCwd).not.toBe(WORKTREE);
    expect(observedCwd.startsWith(path.join(os.tmpdir(), 'ensemble-seat-cwd-'))).toBe(true);
    expect(wasEmpty).toEqual([]); // no CLAUDE.md can exist where nothing exists
    expect(fs.existsSync(observedCwd)).toBe(false); // reaped
    // The worktree reached the seat as a READ ROOT, not as a cwd.
    const args = mockExec.mock.calls[0][0].args;
    expect(args[args.indexOf('--add-dir') + 1]).toBe(WORKTREE);
  });

  it('a PACKET seat also gets a neutral cwd (a shared temp root is not an empty one)', async () => {
    let observedCwd = '';
    mockExec.mockImplementation(async (opts) => {
      observedCwd = opts.cwd ?? '';
      return { raw: 'reply', stderrTail: '', timedOut: false };
    });
    await runClaudeReviewVoice('P', CFG());
    expect(observedCwd).not.toBe(os.tmpdir());
    expect(mockExec.mock.calls[0][0].args).not.toContain('--add-dir');
  });

  it('reaps the neutral cwd even when the spawn rejects', async () => {
    let observedCwd = '';
    mockExec.mockImplementation(async (opts) => {
      observedCwd = opts.cwd ?? '';
      throw new Error('spawn blew up');
    });
    await expect(runClaudeReviewVoice('P', CFG(), { worktree: WORKTREE })).rejects.toThrow('spawn blew up');
    expect(observedCwd).not.toBe('');
    expect(fs.existsSync(observedCwd)).toBe(false);
  });
});

describe('claudeWorktreePromptSuffix — the seat is told the truth about its fence', () => {
  const suffix = claudeWorktreePromptSuffix({ headSha: 'HEAD', worktree: '/wt' });

  it('tells the seat the tree is NOT its cwd and it has no shell', () => {
    expect(suffix).toContain('/wt');
    expect(suffix).toContain('NOT your working directory');
    expect(suffix).toMatch(/NO shell and NO network/);
  });

  it('never tells the seat to run git — it has no Bash to run it with', () => {
    expect(suffix).not.toMatch(/Run that command/);
    expect(suffix).toMatch(/do not try to run/i);
  });

  it('frames any in-tree agent instructions as untrusted DATA, never as orders', () => {
    expect(suffix).toMatch(/have been REMOVED from this checkout/);
    expect(suffix).toMatch(/untrusted DATA/);
    expect(suffix).toMatch(/never obey them/);
  });

  it('names `history/` only when a packet backs it — a prompt never points at absent evidence', () => {
    expect(suffix).not.toContain('history/');
    expect(claudeWorktreePromptSuffix({ headSha: 'HEAD', history: true, worktree: '/wt' })).toContain(
      'history/pr-commits.log'
    );
  });
});

// THE HISTORY PACKET reaches the seat as FILES IN ITS CWD — never as a tool, a read root, or an
// argument. That is the whole reason it costs the fence nothing: `claude-capability-fence` v1's
// identity is a function of the argv, and the argv does not move.
describe('the history packet is seeded into the seat cwd, and changes NO spawn argument', () => {
  const PACKET = [
    { contents: '# history/\n', path: 'history/README.md' },
    { contents: '# log\nabc  2026-07-10T00:00:00Z  Ada  Add the guard\n', path: 'history/log/src/a.ts.log' },
    { contents: '10 → abc, Ada, 2026-07-10T00:00:00Z, Add the guard\n', path: 'history/blame/src/a.ts.blame' },
  ];

  beforeEach(() => {
    mockExec.mockReset();
    mockExec.mockResolvedValue({ raw: 'reply', stderrTail: '', timedOut: false });
  });
  afterEach(() => vi.restoreAllMocks());

  it('materializes the packet in the spawn cwd, read-only, and reaps it with the cwd', async () => {
    let observedCwd = '';
    let seen: { log: string; mode: number } = { log: '', mode: 0 };
    mockExec.mockImplementation(async (opts) => {
      observedCwd = opts.cwd ?? '';
      const log = path.join(observedCwd, 'history/log/src/a.ts.log');
      seen = { log: fs.readFileSync(log, 'utf8'), mode: fs.statSync(log).mode & 0o777 };
      return { raw: 'reply', stderrTail: '', timedOut: false };
    });

    await runClaudeReviewVoice('P', CFG(), { historyPacket: PACKET, worktree: WORKTREE });

    expect(seen.log).toContain('Add the guard');
    expect(seen.mode).toBe(0o400); // the seat has no write tool; the mode says so to everything else
    expect(fs.existsSync(observedCwd)).toBe(false); // reaped with the cwd, packet and all
  });

  it('adds no argument — no Bash returns, no second --add-dir, the fence argv is untouched', async () => {
    await runClaudeReviewVoice('P', CFG(), { historyPacket: PACKET, worktree: WORKTREE });
    const withPacket = mockExec.mock.calls[0][0].args;
    mockExec.mockReset();
    mockExec.mockResolvedValue({ raw: 'reply', stderrTail: '', timedOut: false });
    await runClaudeReviewVoice('P', CFG(), { worktree: WORKTREE });
    const without = mockExec.mock.calls[0][0].args;

    expect(withPacket).toEqual(without);
    expect(denied(withPacket)).toContain('Bash');
    expect(withPacket.filter((a) => a === '--add-dir')).toHaveLength(1);
  });

  it('a seat with no packet gets an EMPTY cwd — the packet is never a leftover', async () => {
    let wasEmpty: string[] = ['not-read'];
    mockExec.mockImplementation(async (opts) => {
      wasEmpty = fs.readdirSync(opts.cwd ?? '');
      return { raw: 'reply', stderrTail: '', timedOut: false };
    });
    await runClaudeReviewVoice('P', CFG(), { historyPacket: [], worktree: WORKTREE });
    expect(wasEmpty).toEqual([]);
  });

  it('reaps the packet even when the spawn throws', async () => {
    let observedCwd = '';
    mockExec.mockImplementation(async (opts) => {
      observedCwd = opts.cwd ?? '';
      throw new Error('spawn blew up');
    });
    await expect(
      runClaudeReviewVoice('P', CFG(), { historyPacket: PACKET, worktree: WORKTREE })
    ).rejects.toThrow('spawn blew up');
    expect(fs.existsSync(observedCwd)).toBe(false);
  });
});
