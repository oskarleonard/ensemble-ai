import { describe, expect, it, vi } from 'vitest';

import {
  classifyGitError,
  type GitRun,
  isPreflightError,
  materializeWorktree,
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
    ['fatal: unable to access … Could not resolve host', 'network'],
  ])('%s → %s', (stderr, kind) => expect(classifyGitError(stderr)).toBe(kind));
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
