import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  acquireRepoLock,
  acquireRepoLockAsync,
  type GitRun,
  type GitRunAsync,
  materializeWorktree,
  materializeWorktreeAsync,
  resolveRepoLocation,
  resolveRepoLocationAsync,
  stripAgentInstructions,
  stripAgentInstructionsAsync,
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

// A logged call carries args AND the cwd/env the runner was handed — the first cut logged
// args only, which left half the twin contract untestable: an INERT_ENV drift or a HEAD
// assert run from the wrong cwd would both have stayed green (cross-vendor review of this
// diff, claude-f1). env is logged as the one load-bearing marker rather than the whole
// object, so an unrelated process.env difference can't flake the equality.
type LoggedCall = { args: string[]; cwd: string; lfsSkip: boolean };

// One script, two runners, two logs — the logs must come out equal.
function scriptedGit(script: Scripted[]) {
  const run = (
    args: string[],
    opts: { cwd?: string; env?: Record<string, string> } | undefined,
    log: LoggedCall[]
  ) => {
    log.push({
      args,
      cwd: opts?.cwd ?? '',
      lfsSkip: opts?.env?.GIT_LFS_SKIP_SMUDGE === '1',
    });
    const hit = script.find((s) => s.match(args));
    if (!hit) return { ok: true as const, text: '' };
    if (hit.error !== undefined) return { error: hit.error, ok: false as const };
    return { ok: true as const, text: hit.text ?? '' };
  };
  const syncLog: LoggedCall[] = [];
  const asyncLog: LoggedCall[] = [];
  const sync: GitRun = (args, opts) => run(args, opts, syncLog);
  // A microtask-yielding async runner: awaiting it exercises the real interleave points the
  // async twin introduces, which a resolve-inline stub would hide.
  const async_: GitRunAsync = async (args, opts) => {
    await Promise.resolve();
    return run(args, opts, asyncLog);
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
function normalize(v: Awaited<ReturnType<typeof materializeWorktreeAsync>>): unknown {
  if (v && typeof v === 'object' && 'dir' in v) {
    const w = v as Worktree;
    return { ...w, dir: '<dir>' };
  }
  return v;
}

function normalizeArgv(log: LoggedCall[]): LoggedCall[] {
  const scrub = (s: string) => (s.includes('ensemble-worktree-') ? '<dir>' : s);
  return log.map((c) => ({
    args: c.args.map(scrub),
    cwd: scrub(c.cwd),
    lfsSkip: c.lfsSkip,
  }));
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
    // The success outcome pinned CONCRETELY (not just twin-equal — twin-equal alone is
    // satisfied by both twins failing the same way): a real Worktree at the right SHA.
    expect(normalize(syncOut)).toEqual({
      dir: '<dir>',
      headSha: HEAD_SHA,
      strippedInstructionFiles: [],
    });
    // The sequence itself, pinned once: common-dir → fetch → add → HEAD assert — and the
    // side-channel halves of the contract: fetch/add run in the repo root with the LFS
    // kill-switch env; the HEAD assert runs in the WORKTREE, not the repo.
    const flat = syncLog.map((c) => c.args.join(' '));
    expect(flat).toHaveLength(4);
    expect(flat[0]).toBe('rev-parse --git-common-dir');
    expect(flat[1]).toContain('fetch');
    expect(flat[2]).toContain('worktree add');
    expect(flat[3]).toBe('rev-parse HEAD');
    expect(syncLog[1]).toMatchObject({ cwd: '/repo', lfsSkip: true });
    expect(syncLog[2]).toMatchObject({ cwd: '/repo', lfsSkip: true });
    expect(syncLog[3].cwd).toContain('head');
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
      expect(log.some((c) => c.args.includes('worktree') && c.args.includes('add'))).toBe(false);
    }
    expect(normalizeArgv(asyncLog)).toEqual(normalizeArgv(syncLog));
  });

  it('add failure: same taxonomy mapping AND same argv sequence', async () => {
    const script: Scripted[] = [
      { match: is('rev-parse', '--git-common-dir'), text: '.git' },
      { error: 'fatal: invalid reference: aaaa', match: is('worktree', 'add') },
    ];
    const { asyncLog, asyncOut, syncLog, syncOut } = await runBoth(script, tmp());
    expect(syncOut).toEqual(asyncOut);
    expect(syncOut).toMatchObject({ kind: 'no-such-pr' });
    // Full sequence equality — the first cut asserted only non-emptiness here, leaving
    // the one branch with no cleanup unpinned (grok-f2/claude-f3 on this diff's review).
    expect(normalizeArgv(asyncLog)).toEqual(normalizeArgv(syncLog));
    // And the cleanup pinned CONCRETELY, like the sha-mismatch case (r3, grok-f3): the
    // finally-reap runs on add-failure too — remove + prune must both appear.
    for (const log of [syncLog, asyncLog]) {
      const flat = log.map((c) => c.args.join(' '));
      expect(flat.some((s) => s.includes('worktree remove --force'))).toBe(true);
      expect(flat.some((s) => s.includes('worktree prune'))).toBe(true);
    }
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
      const flat = log.map((c) => c.args.join(' '));
      expect(flat.some((s) => s.includes('worktree remove --force'))).toBe(true);
      expect(flat.some((s) => s.includes('worktree prune'))).toBe(true);
    }
    expect(normalizeArgv(asyncLog)).toEqual(normalizeArgv(syncLog));
  });
});

describe('resolveRepoLocation twins', () => {
  it('happy path pinned CONCRETELY, plus the same wrong-repo refusal', async () => {
    // Most-specific matcher FIRST: `is('remote')` also token-matches a `remote get-url`
    // call, and with script.find() taking the first hit, the original ordering fed
    // "origin" back as the URL — remoteSlug(null) → wrong-repo for BOTH twins, and the
    // twin-equality assertion passed on a shared failure (codex-f2/grok-f1 on this diff's
    // review: a parity test that only compares twins proves nothing about either).
    const script: Scripted[] = [
      { match: is('remote', 'get-url'), text: 'git@github.com:o/r.git' },
      { match: is('rev-parse', '--show-toplevel'), text: '/repo' },
      { match: is('remote'), text: 'origin' },
    ];
    const { async_, asyncLog, sync, syncLog } = scriptedGit(script);
    const argsOk = { prSlug: 'o/r', repoPath: '/repo' };
    const argsWrong = { prSlug: 'x/y', repoPath: '/repo' };
    const syncOk = resolveRepoLocation(argsOk, { allowedRoots: null, git: sync });
    // The concrete pin — a REAL RepoLocation, not merely "whatever sync returned":
    expect(syncOk).toEqual({
      fetchUrl: 'git@github.com:o/r.git',
      repoRoot: '/repo',
      slug: 'o/r',
    });
    expect(
      await resolveRepoLocationAsync(argsOk, { allowedRoots: null, git: async_ })
    ).toEqual(syncOk);
    const syncWrong = resolveRepoLocation(argsWrong, { allowedRoots: null, git: sync });
    expect(syncWrong).toMatchObject({ kind: 'wrong-repo' });
    expect(
      await resolveRepoLocationAsync(argsWrong, { allowedRoots: null, git: async_ })
    ).toEqual(syncWrong);
    expect(asyncLog).toEqual(syncLog);
  });
});

describe('stripAgentInstructions twins', () => {
  it('remove the same files from the same tree', async () => {
    const make = () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strip-parity-'));
      fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'x');
      fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'pkg', 'AGENTS.md'), 'x');
      fs.mkdirSync(path.join(dir, '.cursor', 'rules'), { recursive: true });
      fs.writeFileSync(path.join(dir, '.cursor', 'rules', 'a.mdc'), 'x');
      // The adversarial plant (r2, claude-f4): an instruction file INSIDE .cursor used to
      // survive because the walk never recursed past the rules check — the tree is
      // untrusted PR content, so the strip must reach it.
      fs.writeFileSync(path.join(dir, '.cursor', 'CLAUDE.md'), 'planted');
      // Case-variant plant (r3, claude-f1): on macOS/Windows this IS the file the agent
      // CLI would read; exact-case matching walked right past it.
      fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'lib', 'Agents.MD'), 'planted');
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'keep.ts'), 'x');
      return dir;
    };
    const a = make();
    const b = make();
    const syncRemoved = stripAgentInstructions(a);
    const asyncRemoved = await stripAgentInstructionsAsync(b);
    expect(asyncRemoved).toEqual(syncRemoved);
    expect(syncRemoved).toEqual([
      '.cursor/CLAUDE.md',
      '.cursor/rules',
      'CLAUDE.md',
      'lib/Agents.MD',
      'pkg/AGENTS.md',
    ]);
    for (const dir of [a, b]) {
      expect(fs.existsSync(path.join(dir, 'src', 'keep.ts'))).toBe(true);
      expect(fs.existsSync(path.join(dir, 'CLAUDE.md'))).toBe(false);
      expect(fs.existsSync(path.join(dir, '.cursor', 'CLAUDE.md'))).toBe(false);
    }
  });
});

describe('a post-create failure never strands the lock (r3: the unanimous finding)', () => {
  // The r2 fix guarded the write and left the trailing closeSync outside the recovery —
  // the same strand class one line later, caught independently by all three vendors in r3.
  // Both failure points are pinned: after EITHER throws, the lock file must be GONE (a
  // stranded file would wedge every later acquire for the full staleMs).
  it.each([['writeSync'], ['closeSync']] as const)(
    'fs.%s failure after O_EXCL create unlinks the just-created lock',
    async (fn) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strand-'));
      const lock = path.join(dir, 'ensemble-ai-worktree.lock');
      const spy = vi.spyOn(fs, fn).mockImplementationOnce(() => {
        throw Object.assign(new Error('ENOSPC: fake'), { code: 'ENOSPC' });
      });
      try {
        await expect(
          acquireRepoLockAsync(dir, { retries: 0, sleepMs: 1 })
        ).rejects.toThrow('ENOSPC');
        expect(fs.existsSync(lock)).toBe(false);
      } finally {
        spy.mockRestore();
      }
      // And the very next acquire succeeds instantly — nothing was stranded.
      (await acquireRepoLockAsync(dir, { retries: 0, sleepMs: 1 }))();
    }
  );
});

describe('real-lock wiring parity (no injected stub)', () => {
  it('both twins acquire + RELEASE the real lock around a materialization', async () => {
    // The other materialize cases inject a no-op lock, so a twin that dropped its lock
    // wiring entirely would still pass them (r3, claude-f3). Here the scripted git points
    // git-common-dir at a REAL temp dir and no lock is injected: success requires a real
    // acquire, and a clean release leaves no lock file behind.
    const common = fs.mkdtempSync(path.join(os.tmpdir(), 'lockwire-'));
    const lockFile = path.join(common, 'ensemble-ai-worktree.lock');
    const script: Scripted[] = [
      { match: is('rev-parse', '--git-common-dir'), text: common },
      { match: is('rev-parse', 'HEAD'), text: HEAD_SHA },
    ];
    const { async_, sync } = scriptedGit(script);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-'));
    const syncOut = materializeWorktree(
      { headSha: HEAD_SHA, location: LOCATION, pr: 7, worktreeRoot: root },
      { git: sync }
    );
    expect(normalize(syncOut)).toMatchObject({ headSha: HEAD_SHA });
    expect(fs.existsSync(lockFile)).toBe(false); // released, not stranded
    const asyncOut = await materializeWorktreeAsync(
      { headSha: HEAD_SHA, location: LOCATION, pr: 7, worktreeRoot: root },
      { git: async_ }
    );
    expect(normalize(asyncOut)).toMatchObject({ headSha: HEAD_SHA });
    expect(fs.existsSync(lockFile)).toBe(false);
  });
});

describe('the acquire refuses to mistake a caller bug for contention', () => {
  it('a nonexistent lock dir throws IMMEDIATELY (both styles), never a full-budget hang', async () => {
    // Hermetic: a fresh mkdtemp parent guarantees the child path cannot pre-exist on the
    // host (r2, codex-f2 — a fixed tmpdir path is host-state the test doesn't own).
    const missing = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'enoent-parity-')),
      'definitely-missing',
      'x'
    );
    // If these retried as contention they would take retries×sleep — the assertion is that
    // they throw the real errno at once (claude-f4: a bare catch made every errno look
    // like a held lock, a ~10-minute hang at server defaults).
    expect(() => acquireRepoLock(missing, { retries: 1000, sleepMs: 50 })).toThrow(/ENOENT/);
    await expect(
      acquireRepoLockAsync(missing, { retries: 1000, sleepMs: 50 })
    ).rejects.toThrow(/ENOENT/);
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
