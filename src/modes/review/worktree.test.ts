import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  acquireRepoLock,
  classifyGitError,
  type GitRun,
  isPreflightError,
  materializeWorktree,
  reapWorktree,
  remoteSlug,
  resolveRepoLocation,
  rootAllowed,
} from './worktree';

const ok = (text = '') => ({ ok: true as const, text });
const err = (error: string) => ({ error, ok: false as const });

describe('remoteSlug — every GitHub remote form normalizes to owner/repo', () => {
  it.each([
    ['git@github.com:oskarleonard/ensemble-ai.git', 'oskarleonard/ensemble-ai'],
    ['https://github.com/oskarleonard/ensemble-ai.git', 'oskarleonard/ensemble-ai'],
    ['https://github.com/OskarLeonard/Ensemble-AI', 'oskarleonard/ensemble-ai'],
    ['ssh://git@github.com/o/r', 'o/r'],
    ['https://x-access-token:tok@github.com/o/r.git', 'o/r'],
  ])('%s → %s', (url, slug) => expect(remoteSlug(url)).toBe(slug));

  it('returns null for a non-GitHub remote (nothing to compare)', () => {
    expect(remoteSlug('git@gitlab.com:o/r.git')).toBeNull();
  });
});

describe('error taxonomy — a named cause, never a generic git failure', () => {
  it.each([
    ["couldn't find remote ref pull/9/head", 'no-such-pr'],
    ['fatal: Authentication failed for https://…', 'auth'],
    ['remote: Repository not found.', 'wrong-repo'],
    ["fatal: repository 'https://github.com/o/r.git/' not found", 'wrong-repo'],
    ['fatal: unable to access … Could not resolve host', 'network'],
  ])('%s → %s', (stderr, kind) => expect(classifyGitError(stderr)).toBe(kind));

  // `404` is git's not-found PHRASE, never a bare substring: `wrong-repo` is a definitive claim
  // ("your checkout is not this PR's repo"), so a transient failure must not be laundered into it.
  it('does not read an incidental "404" in a repo/host name as wrong-repo', () => {
    expect(classifyGitError('fatal: unable to access https://github.com/o/proj404: timed out')).toBe(
      'network'
    );
    expect(classifyGitError('fatal: unable to access via proxy-404.corp: connection reset')).toBe(
      'network'
    );
  });

  it('still catches the real 404 forms', () => {
    expect(classifyGitError('error: 404 while accessing …')).toBe('wrong-repo');
  });
});

describe('acquireRepoLock — a holder may only ever remove ITS OWN lock', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-lock-'));
  afterAll(() => fs.rmSync(tmp, { force: true, recursive: true }));

  const lockPath = (dir: string) => path.join(dir, 'ensemble-ai-worktree.lock');

  const freshDir = () => fs.mkdtempSync(path.join(tmp, 'gitdir-'));

  it('serializes: a second acquire fails once the retry budget is spent', () => {
    const dir = freshDir();
    const release = acquireRepoLock(dir);
    expect(fs.existsSync(lockPath(dir))).toBe(true);
    expect(() => acquireRepoLock(dir, { retries: 1, sleepMs: 1 })).toThrow(
      /could not acquire the worktree lock/
    );
    release();
    expect(fs.existsSync(lockPath(dir))).toBe(false);
  });

  // THE RECLAIM RACE. A stalls past the TTL; B reclaims and takes the lock; A finally releases.
  // A blind unlink here would delete B's LIVE lock and let a third process in while B is still
  // writing to the shared .git — exactly the corruption the lock exists to prevent.
  it("a stalled holder's release() does NOT delete the lock a reclaimer now holds", () => {
    const dir = freshDir();
    const releaseA = acquireRepoLock(dir, { staleMs: 0 }); // A holds
    const tokenA = fs.readFileSync(lockPath(dir), 'utf8');

    // B sees the lock as stale (staleMs 0), reclaims it, and takes it.
    const releaseB = acquireRepoLock(dir, { retries: 5, sleepMs: 1, staleMs: 0 });
    const tokenB = fs.readFileSync(lockPath(dir), 'utf8');
    expect(tokenB).not.toBe(tokenA);

    releaseA(); // the stalled holder wakes up and releases
    expect(fs.existsSync(lockPath(dir))).toBe(true); // B's lock SURVIVES
    expect(fs.readFileSync(lockPath(dir), 'utf8')).toBe(tokenB);

    releaseB();
    expect(fs.existsSync(lockPath(dir))).toBe(false);
  });

  it('reclaims a genuinely stale lock left by a crashed run', () => {
    const dir = freshDir();
    fs.writeFileSync(lockPath(dir), 'crashed-run:deadbeef');
    const old = Date.now() - 60 * 60_000;
    fs.utimesSync(lockPath(dir), old / 1000, old / 1000);
    const release = acquireRepoLock(dir, { retries: 2, sleepMs: 1 });
    expect(fs.readFileSync(lockPath(dir), 'utf8')).not.toContain('crashed-run');
    release();
  });

  it('release is idempotent and never throws', () => {
    const dir = freshDir();
    const release = acquireRepoLock(dir);
    release();
    expect(() => release()).not.toThrow();
  });

  // A budget shorter than the TTL could never reach the reclaim branch, so a sibling doing a slow
  // (but healthy) fetch would be reported as wedged.
  it('waits at least the staleness TTL by default, so the reclaim branch is reachable', () => {
    const dir = freshDir();
    const release = acquireRepoLock(dir);
    expect(() => acquireRepoLock(dir, { retries: 0, sleepMs: 1 })).toThrow(/0s/);
    release();
  });
});

describe('allowed-repo-roots (pin 5) — consumer config, never engine-baked', () => {
  it('no configured roots ⇒ the engine declares NO policy ⇒ allow', () => {
    expect(rootAllowed('/anywhere/at/all', null)).toBe(true);
  });
  it('a configured root allows itself and its children', () => {
    expect(rootAllowed('/a/repo', ['/a/repo'])).toBe(true);
    expect(rootAllowed('/a/repo/sub', ['/a/repo'])).toBe(true);
  });
  it('a sibling with a shared PREFIX is not "under" the root', () => {
    expect(rootAllowed('/a/repo-evil', ['/a/repo'])).toBe(false);
  });
});

describe('repo-location pre-flight — fails closed with a legible cause', () => {
  const git = (impl: Record<string, ReturnType<GitRun>>): GitRun =>
    ((args: string[]) => impl[args.join(' ')] ?? err('unexpected')) as GitRun;

  it('a non-repo path is `not-a-repo`', () => {
    const res = resolveRepoLocation(
      { prSlug: 'o/r', repoPath: '/tmp/x' },
      { allowedRoots: null, git: git({ 'rev-parse --show-toplevel': err('not a git repository') }) }
    );
    expect(isPreflightError(res) && res.kind).toBe('not-a-repo');
  });

  it('a checkout whose remotes point elsewhere is `wrong-repo` — never fetched into', () => {
    const res = resolveRepoLocation(
      { prSlug: 'o/r', repoPath: '/repo' },
      {
        allowedRoots: null,
        git: git({
          'rev-parse --show-toplevel': ok('/repo'),
          remote: ok('origin'),
          'remote get-url origin': ok('git@github.com:someone/else.git'),
        }),
      }
    );
    expect(isPreflightError(res) && res.kind).toBe('wrong-repo');
    expect(isPreflightError(res) && res.message).toContain('someone/else');
  });

  it('a disallowed root is refused BEFORE any fetch or trail write', () => {
    const res = resolveRepoLocation(
      { prSlug: 'o/r', repoPath: '/work/lisk-web' },
      { allowedRoots: ['/personal'], git: git({ 'rev-parse --show-toplevel': ok('/work/lisk-web') }) }
    );
    expect(isPreflightError(res) && res.kind).toBe('disallowed-root');
  });

  it('ANY remote pointing at the PR repo proves the checkout, and its URL is the fetch URL', () => {
    const res = resolveRepoLocation(
      { prSlug: 'o/r', repoPath: '/repo' },
      {
        allowedRoots: null,
        git: git({
          'rev-parse --show-toplevel': ok('/repo'),
          remote: ok('origin\nupstream'),
          'remote get-url origin': ok('git@github.com:fork/r.git'),
          'remote get-url upstream': ok('https://github.com/o/r.git'),
        }),
      }
    );
    expect(isPreflightError(res)).toBe(false);
    expect(res).toMatchObject({ fetchUrl: 'https://github.com/o/r.git', slug: 'o/r' });
  });
});

describe('materialization hardening — untrusted content is checked out INERT', () => {
  const location = { fetchUrl: 'https://github.com/o/r.git', repoRoot: '/repo', slug: 'o/r' };
  const headSha = 'a'.repeat(40);

  const noLock = () => () => {};

  function harness(headOut: string) {
    const calls: string[][] = [];
    const git: GitRun = ((args: string[], opts?: { env?: Record<string, string> }) => {
      calls.push(args);
      if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return ok('/repo/.git');
      if (args.includes('rev-parse') && args.includes('HEAD')) return ok(headOut);
      // record the env the fetch/add ran under
      if (opts?.env) calls.push([`ENV:${JSON.stringify(opts.env)}`]);
      return ok('');
    }) as GitRun;
    return { calls, git };
  }

  it('fetches by EXPLICIT url + ref — never assumes `origin` exposes pull/N/head', () => {
    const { calls, git } = harness(headSha);
    materializeWorktree({ headSha, location, pr: 7, worktreeRoot: '/tmp' }, { git, lock: noLock });
    const fetch = calls.find((c) => c.includes('fetch'));
    expect(fetch).toContain('https://github.com/o/r.git');
    expect(fetch).toContain('pull/7/head');
    expect(fetch).not.toContain('origin');
  });

  it('every git call disables hooks and neuters the LFS filters (so .lfsconfig is never honored)', () => {
    const { calls, git } = harness(headSha);
    materializeWorktree({ headSha, location, pr: 7, worktreeRoot: '/tmp' }, { git, lock: noLock });
    for (const name of ['fetch', 'worktree']) {
      const call = calls.find((c) => c.includes(name));
      expect(call, name).toContain('core.hooksPath=/dev/null');
      expect(call, name).toContain('filter.lfs.smudge=');
      expect(call, name).toContain('filter.lfs.process=');
    }
    const env = calls.find((c) => c[0]?.startsWith('ENV:'));
    expect(env?.[0]).toContain('GIT_LFS_SKIP_SMUDGE');
  });

  it('never recurses submodules, on fetch OR worktree add', () => {
    const { calls, git } = harness(headSha);
    materializeWorktree({ headSha, location, pr: 7, worktreeRoot: '/tmp' }, { git, lock: noLock });
    expect(calls.find((c) => c.includes('fetch'))).toContain('--no-recurse-submodules');
    expect(calls.find((c) => c.includes('worktree') && c.includes('add'))).toContain(
      '--no-recurse-submodules'
    );
  });

  it('checks out the receipt`s headSha by SHA and asserts HEAD — a mismatch ABORTS and reaps', () => {
    const { calls, git } = harness('b'.repeat(40)); // HEAD is NOT headSha
    const res = materializeWorktree({ headSha, location, pr: 7, worktreeRoot: '/tmp' }, { git, lock: noLock });
    expect(isPreflightError(res) && res.kind).toBe('sha-mismatch');
    expect(isPreflightError(res) && res.message).toMatch(/ABORTING/);
    // reaped: worktree remove + prune both ran
    expect(calls.some((c) => c.includes('remove'))).toBe(true);
    expect(calls.some((c) => c.includes('prune'))).toBe(true);
  });

  // `git worktree add` creates its directory with the process umask — 0755 under the common 022.
  // Directly inside a shared temp root (Linux `/tmp`, mode 1777) that publishes the PRIVATE source
  // of the PR under review to every other local user. The tree must sit inside an owner-only parent.
  it('nests the worktree inside an owner-only (0700) parent, and never pre-creates the tree path', () => {
    const { calls, git } = harness(headSha);
    const res = materializeWorktree({ headSha, location, pr: 7, worktreeRoot: '/tmp' }, { git, lock: noLock });
    expect(isPreflightError(res)).toBe(false);
    const dir = (res as { dir: string }).dir;
    const parent = path.dirname(dir);
    expect(path.basename(parent).startsWith('ensemble-worktree-')).toBe(true);
    expect(fs.statSync(parent).mode & 0o777).toBe(0o700);
    // git is handed a path that does NOT exist — it creates it. No delete-then-recreate race.
    expect(fs.existsSync(dir)).toBe(false);
    expect(calls.find((c) => c.includes('worktree') && c.includes('add'))).toContain(dir);
    reapWorktree('/repo', dir, { git });
    expect(fs.existsSync(parent)).toBe(false); // the parent is reaped too, not leaked
  });

  // The name check is the whole safety of reaping a parent: hand reap an unrelated directory and
  // it must not walk up and delete that directory's parent.
  it('reapWorktree removes a parent ONLY when the parent is one of ours', () => {
    const { git } = harness(headSha);
    const outsider = fs.mkdtempSync(path.join(os.tmpdir(), 'not-ours-'));
    const child = path.join(outsider, 'child');
    fs.mkdirSync(child);
    reapWorktree('/repo', child, { git });
    expect(fs.existsSync(outsider)).toBe(true); // parent survived
    fs.rmSync(outsider, { force: true, recursive: true });
  });

  it('a fetch failure maps to the taxonomy and never proceeds to worktree add', () => {
    const git = vi.fn((args: string[]) => {
      if (args[1] === '--git-common-dir' || args[0] === 'rev-parse') return ok('/repo/.git');
      if (args.includes('fetch')) return err("couldn't find remote ref pull/7/head");
      return ok('');
    }) as unknown as GitRun;
    const res = materializeWorktree({ headSha, location, pr: 7, worktreeRoot: '/tmp' }, { git, lock: noLock });
    expect(isPreflightError(res) && res.kind).toBe('no-such-pr');
    const calls = (git as unknown as { mock: { calls: [string[]][] } }).mock.calls;
    expect(calls.some(([a]) => a.includes('worktree') && a.includes('add'))).toBe(false);
  });
});
