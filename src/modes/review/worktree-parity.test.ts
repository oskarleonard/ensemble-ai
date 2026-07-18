import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  acquireRepoLock,
  acquireRepoLockAsync,
  type GitRun,
  type GitRunAsync,
  materializeWorktree,
  materializeWorktreeAsync,
  resolveRepoLocation,
  resolveRepoLocationAsync,
  WORKTREE_LOCK_ERROR,
  type Worktree,
} from './worktree';

// THE PARITY PIN. The async twins exist so a server consumer can materialize without freezing
// its event loop (lived 2026-07-17: a sync 760-file checkout on a request path took a prod
// dashboard dark for ~5 minutes). The design promise is "one protocol, two waiting styles —
// NOT a fork": same git argv, same step order, same error taxonomy, same lock file. Prose
// promised concurrency properties in this file before and was WRONG twice; this suite makes
// the no-drift claim a test failure instead. Every scenario runs the sync twin and the async
// twin against ONE scripted git and asserts the recorded argv sequences and outcomes are
// identical.

type Scripted = { error?: string; match: (args: string[]) => boolean; text?: string };

// One script, two runners, two logs — the logs must come out equal.
function scriptedGit(script: Scripted[]) {
  const run = (args: string[], log: string[][]) => {
    log.push(args);
    const hit = script.find((s) => s.match(args));
    if (!hit) return { ok: true as const, text: '' };
    if (hit.error !== undefined) return { error: hit.error, ok: false as const };
    return { ok: true as const, text: hit.text ?? '' };
  };
  const syncLog: string[][] = [];
  const asyncLog: string[][] = [];
  const sync: GitRun = (args) => run(args, syncLog);
  // A microtask-yielding async runner: awaiting it exercises the real interleave points the
  // async twin introduces, which a resolve-inline stub would hide.
  const async_: GitRunAsync = async (args) => {
    await Promise.resolve();
    return run(args, asyncLog);
  };
  return { async_, asyncLog, sync, syncLog };
}

// Token containment, not position: real invocations are prefixed with the INERT_GIT_CONFIG
// `-c` pairs, so positional matching silently misses them (which this suite's first run proved
// by "passing" the wrong branches).
const is = (...toks: string[]) => (args: string[]) => toks.every((t) => args.includes(t));

const HEAD_SHA = 'a'.repeat(40);
const LOCATION = {
  fetchUrl: 'git@github.com:o/r.git',
  repoRoot: '/repo',
  slug: 'o/r',
};

// Normalize the one legitimately-divergent value (each run mkdtemps its own parent) so the
// rest of the outcome can be compared byte-for-byte.
function normalize(v: ReturnType<typeof materializeWorktree>): unknown {
  if (v && typeof v === 'object' && 'dir' in v) {
    const w = v as Worktree;
    return { ...w, dir: '<dir>' };
  }
  return v;
}

function normalizeArgv(log: string[][]): string[][] {
  return log.map((args) =>
    args.map((a) => (a.includes('ensemble-worktree-') ? '<dir>' : a))
  );
}

async function runBoth(script: Scripted[], worktreeRoot: string) {
  const { async_, asyncLog, sync, syncLog } = scriptedGit(script);
  const noLock = () => () => {};
  const syncOut = materializeWorktree(
    { headSha: HEAD_SHA, location: LOCATION, pr: 7, worktreeRoot },
    { git: sync, lock: noLock }
  );
  const asyncOut = await materializeWorktreeAsync(
    { headSha: HEAD_SHA, location: LOCATION, pr: 7, worktreeRoot },
    { git: async_, lock: noLock }
  );
  return { asyncLog, asyncOut, syncLog, syncOut };
}

describe('materializeWorktree twins — identical argv + outcome on every branch', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));

  it('success + strip: same sequence, same result shape', async () => {
    const script: Scripted[] = [
      { match: is('rev-parse', '--git-common-dir'), text: '.git' },
      { match: is('rev-parse', 'HEAD'), text: HEAD_SHA },
    ];
    const { asyncLog, asyncOut, syncLog, syncOut } = await runBoth(script, tmp());
    expect(normalize(syncOut)).toEqual(normalize(asyncOut));
    expect(normalizeArgv(asyncLog)).toEqual(normalizeArgv(syncLog));
    // The sequence itself, pinned once: common-dir → fetch → add → HEAD assert.
    const flat = syncLog.map((a) => a.join(' '));
    expect(flat).toHaveLength(4);
    expect(flat[0]).toBe('rev-parse --git-common-dir');
    expect(flat[1]).toContain('fetch');
    expect(flat[2]).toContain('worktree add');
    expect(flat[3]).toBe('rev-parse HEAD');
  });

  it('fetch failure: same error kind, and NEITHER twin reaches worktree add', async () => {
    const script: Scripted[] = [
      { match: is('rev-parse', '--git-common-dir'), text: '.git' },
      { error: 'fatal: unable to access: Could not resolve host', match: is('fetch') },
    ];
    const { asyncLog, asyncOut, syncLog, syncOut } = await runBoth(script, tmp());
    expect(syncOut).toEqual(asyncOut);
    expect(syncOut).toMatchObject({ kind: 'network' });
    for (const log of [syncLog, asyncLog]) {
      expect(log.some((a) => a.includes('worktree') && a.includes('add'))).toBe(false);
    }
    expect(normalizeArgv(asyncLog)).toEqual(normalizeArgv(syncLog));
  });

  it('add failure: same taxonomy mapping', async () => {
    const script: Scripted[] = [
      { match: is('rev-parse', '--git-common-dir'), text: '.git' },
      { error: 'fatal: invalid reference: aaaa', match: is('worktree', 'add') },
    ];
    const { asyncLog, asyncOut, syncOut } = await runBoth(script, tmp());
    expect(syncOut).toEqual(asyncOut);
    expect(syncOut).toMatchObject({ kind: 'no-such-pr' });
    expect(normalizeArgv(asyncLog).length).toBeGreaterThan(0);
  });

  it('sha-mismatch: both ABORT and both run the full reap sequence', async () => {
    const script: Scripted[] = [
      { match: is('rev-parse', '--git-common-dir'), text: '.git' },
      { match: is('rev-parse', 'HEAD'), text: 'b'.repeat(40) },
    ];
    const { asyncLog, asyncOut, syncLog, syncOut } = await runBoth(script, tmp());
    expect(syncOut).toEqual(asyncOut);
    expect(syncOut).toMatchObject({ kind: 'sha-mismatch' });
    for (const log of [syncLog, asyncLog]) {
      const flat = log.map((a) => a.join(' '));
      expect(flat.some((s) => s.includes('worktree remove --force'))).toBe(true);
      expect(flat.some((s) => s.includes('worktree prune'))).toBe(true);
    }
    expect(normalizeArgv(asyncLog)).toEqual(normalizeArgv(syncLog));
  });
});

describe('resolveRepoLocation twins', () => {
  it('same happy path and same wrong-repo refusal', async () => {
    const script: Scripted[] = [
      { match: is('rev-parse', '--show-toplevel'), text: '/repo' },
      { match: is('remote'), text: 'origin' },
      { match: is('remote', 'get-url'), text: 'git@github.com:o/r.git' },
    ];
    const { async_, asyncLog, sync, syncLog } = scriptedGit(script);
    const argsOk = { prSlug: 'o/r', repoPath: '/repo' };
    const argsWrong = { prSlug: 'x/y', repoPath: '/repo' };
    expect(
      await resolveRepoLocationAsync(argsOk, { allowedRoots: null, git: async_ })
    ).toEqual(resolveRepoLocation(argsOk, { allowedRoots: null, git: sync }));
    expect(
      await resolveRepoLocationAsync(argsWrong, { allowedRoots: null, git: async_ })
    ).toEqual(resolveRepoLocation(argsWrong, { allowedRoots: null, git: sync }));
    expect(asyncLog).toEqual(syncLog);
  });
});

describe('acquireRepoLockAsync — same file, same protocol, loop-friendly wait', () => {
  const lockDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'lock-parity-'));

  it('holds across awaits: a contender still loses while the holder is mid-await', async () => {
    const dir = lockDir();
    const release = await acquireRepoLockAsync(dir, { retries: 2, sleepMs: 5 });
    // The holder now awaits — the exact window the old comment claimed was unsafe.
    await new Promise((r) => setTimeout(r, 20));
    await expect(
      acquireRepoLockAsync(dir, { retries: 2, sleepMs: 5 })
    ).rejects.toThrow(WORKTREE_LOCK_ERROR);
    // And the SYNC acquire loses to an async holder the same way — mixed holders interoperate.
    expect(() => acquireRepoLock(dir, { retries: 2, sleepMs: 5 })).toThrow(WORKTREE_LOCK_ERROR);
    release();
    // Released → immediately acquirable again, by either style.
    (await acquireRepoLockAsync(dir, { retries: 0, sleepMs: 1 }))();
    acquireRepoLock(dir, { retries: 0, sleepMs: 1 })();
  });

  it('reclaims a stale holder exactly like the sync acquire', async () => {
    const dir = lockDir();
    const lock = path.join(dir, 'ensemble-ai-worktree.lock');
    fs.writeFileSync(lock, 'dead-holder');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, past, past);
    const release = await acquireRepoLockAsync(dir, { retries: 3, sleepMs: 5, staleMs: 1000 });
    expect(fs.readFileSync(lock, 'utf8')).not.toBe('dead-holder');
    release();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('token-owned release: never deletes a lock it no longer owns', async () => {
    const dir = lockDir();
    const lock = path.join(dir, 'ensemble-ai-worktree.lock');
    const release = await acquireRepoLockAsync(dir, { retries: 0, sleepMs: 1 });
    fs.writeFileSync(lock, 'someone-else'); // simulate a reclaim-and-replace
    release();
    expect(fs.readFileSync(lock, 'utf8')).toBe('someone-else');
  });

  it('waits its turn without blocking: acquires after the holder releases mid-wait', async () => {
    const dir = lockDir();
    const release = await acquireRepoLockAsync(dir, { retries: 0, sleepMs: 1 });
    const contender = acquireRepoLockAsync(dir, { retries: 40, sleepMs: 10 });
    // Release while the contender is between attempts — only possible to observe because its
    // wait yields the loop (the sync acquire could never run this timer from the same thread).
    setTimeout(() => release(), 30);
    const release2 = await contender;
    release2();
  });
});
