import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { execGit } from '../modes/review/git-exec';
import { checkPinDrift, describePinDrift } from './pin-check';

// A git-drift primitive earns its keep only against REAL git — the worktree work paid for
// this exact lesson (a git-mocked suite stays green while the real command fails 100%). The
// setup mirrors the actual consumption model: a `remote` whose `main` advances, and a
// `local` clone (the consumer) that can be pinned at an older commit.
describe('checkPinDrift — real git', () => {
  const dirs: string[] = [];
  const git = execGit();

  // Isolated identity + config so the test never depends on (or touches) the dev's git setup.
  const env = {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@t',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@t',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
  };
  const g = (cwd: string, args: string[]): string =>
    execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...env } }).trim();

  function newTmp(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  }
  function remoteWithCommits(n: number): { remote: string; shas: string[] } {
    const remote = newTmp('pincheck-remote-');
    g(remote, ['init', '-q', '-b', 'main']);
    const shas: string[] = [];
    for (let i = 1; i <= n; i++) {
      fs.writeFileSync(path.join(remote, 'f.txt'), `c${i}`);
      g(remote, ['add', '-A']);
      g(remote, ['commit', '-q', '-m', `c${i}`]);
      shas.push(g(remote, ['rev-parse', 'HEAD']));
    }
    return { remote, shas };
  }
  function clone(remote: string): string {
    const local = newTmp('pincheck-local-');
    g(local, ['clone', '-q', remote, '.']);
    return local;
  }

  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { force: true, recursive: true });
  });

  it('reports CURRENT when the pin equals main', () => {
    const local = clone(remoteWithCommits(3).remote);
    const d = checkPinDrift({ repoDir: local, git, fetch: false });
    if ('error' in d) throw new Error(d.error);
    expect(d.status).toBe('current');
    expect(d.behind).toBe(0);
    expect(d.ahead).toBe(0);
    expect(describePinDrift(d)).toMatch(/current/);
  });

  it('reports STALE with the exact N behind when main advanced past the pin', () => {
    const { remote, shas } = remoteWithCommits(3);
    const local = clone(remote);
    g(local, ['checkout', '-q', shas[0]]); // pin the checkout at the FIRST commit
    const d = checkPinDrift({ repoDir: local, git, fetch: false });
    if ('error' in d) throw new Error(d.error);
    expect(d.status).toBe('stale');
    expect(d.behind).toBe(2);
    expect(d.ahead).toBe(0);
    expect(d.pinned).toBe(shas[0]);
    expect(describePinDrift(d)).toMatch(/STALE.*2 commits behind/);
  });

  it('FETCHES so a pin current at clone time goes stale once the remote main advances', () => {
    const { remote } = remoteWithCommits(2);
    const local = clone(remote);
    const before = checkPinDrift({ repoDir: local, git, fetch: true });
    if ('error' in before) throw new Error(before.error);
    expect(before.status).toBe('current');
    expect(before.fetched).toBe(true);

    fs.writeFileSync(path.join(remote, 'f.txt'), 'c3'); // remote main advances by 1
    g(remote, ['add', '-A']);
    g(remote, ['commit', '-q', '-m', 'c3']);

    const stale = checkPinDrift({ repoDir: local, git, fetch: true });
    if ('error' in stale) throw new Error(stale.error);
    expect(stale.status).toBe('stale');
    expect(stale.behind).toBe(1);
    expect(stale.fetched).toBe(true);
  });

  it('reports AHEAD (not stale) for a local commit past main', () => {
    const local = clone(remoteWithCommits(2).remote);
    fs.writeFileSync(path.join(local, 'g.txt'), 'local-only');
    g(local, ['add', '-A']);
    g(local, ['commit', '-q', '-m', 'local-only']);
    const d = checkPinDrift({ repoDir: local, git, fetch: false });
    if ('error' in d) throw new Error(d.error);
    expect(d.status).toBe('ahead');
    expect(d.ahead).toBe(1);
    expect(d.behind).toBe(0);
  });

  it('errors clearly when repoDir is not a git checkout', () => {
    const d = checkPinDrift({ repoDir: newTmp('pincheck-norepo-'), git, fetch: false });
    expect('error' in d).toBe(true);
  });
});

// Classification + fetch-fallback, driven by an injected GitRun — exact and offline, the way
// the rest of the engine unit-tests its git state machines.
describe('checkPinDrift — injected GitRun', () => {
  type Resp = { ok: true; text: string } | { ok: false; error: string };
  const fake = (table: (args: string[]) => Resp) => (args: string[]): Resp => table(args);

  it('falls back to the local ref (best-effort) when fetch fails, and flags it', () => {
    const PIN = 'a'.repeat(40);
    const MAIN = 'b'.repeat(40);
    const git = fake((args) => {
      if (args[0] === 'fetch') return { ok: false, error: 'fatal: unable to access — offline' };
      if (args.includes('HEAD^{commit}')) return { ok: true, text: PIN };
      if (args.includes('origin/main^{commit}')) return { ok: true, text: MAIN };
      if (args[2] === `${PIN}..${MAIN}`) return { ok: true, text: '4' };
      if (args[2] === `${MAIN}..${PIN}`) return { ok: true, text: '0' };
      return { ok: false, error: `unexpected: ${args.join(' ')}` };
    });
    const d = checkPinDrift({ repoDir: '/x', git, fetch: true });
    if ('error' in d) throw new Error(d.error);
    expect(d.status).toBe('stale');
    expect(d.behind).toBe(4);
    expect(d.fetched).toBe(false);
    expect(d.note).toMatch(/fetch failed/);
  });

  it('honors an explicit pin over HEAD', () => {
    const PIN = 'c'.repeat(40);
    const MAIN = 'd'.repeat(40);
    const seen: string[][] = [];
    const git = fake((args) => {
      seen.push(args);
      if (args[0] === 'fetch') return { ok: true, text: '' };
      if (args.includes('deadbeef^{commit}')) return { ok: true, text: PIN };
      if (args.includes('origin/main^{commit}')) return { ok: true, text: MAIN };
      if (args[0] === 'rev-list') return { ok: true, text: '0' };
      return { ok: false, error: `unexpected: ${args.join(' ')}` };
    });
    const d = checkPinDrift({ repoDir: '/x', git, pin: 'deadbeef' });
    if ('error' in d) throw new Error(d.error);
    expect(d.pinned).toBe(PIN);
    expect(seen.some((a) => a.includes('HEAD^{commit}'))).toBe(false);
    expect(seen.some((a) => a.includes('deadbeef^{commit}'))).toBe(true);
  });
});
