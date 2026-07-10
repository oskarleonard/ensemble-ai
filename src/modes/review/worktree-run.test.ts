import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isPreflightError, type GitRun } from './worktree';
import { openWorktree } from './worktree-run';

// THE RUN-LEVEL LIFECYCLE (spec §1, §9): pre-flight → materialize → (reap). Every failure is a
// NAMED cause, and a failed open leaves nothing behind. `git` is injected, so the whole taxonomy is
// exercised without a network, a fork, or a second repo on disk.

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

const ok = (text = '') => ({ ok: true as const, text });
const err = (error: string) => ({ ok: false as const, error });

let gitDir: string;
let repoRoot: string;
beforeEach(() => {
  // A REAL directory for `--git-common-dir`: materializeWorktree serializes on an O_EXCL lock
  // there, and we want the real lock exercised, not stubbed away.
  gitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-gitdir-'));
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-repo-'));
});
afterEach(() => {
  for (const d of [gitDir, repoRoot]) fs.rmSync(d, { force: true, recursive: true });
});

// A happy-path git: the checkout IS o/r, the fetch works, and the worktree lands on headSha.
function happyGit(overrides: (args: string[]) => ReturnType<GitRun> | null = () => null): {
  calls: string[][];
  git: GitRun;
} {
  const calls: string[][] = [];
  const git: GitRun = (args, opts) => {
    calls.push(args);
    const over = overrides(args);
    if (over) return over;
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return ok(repoRoot);
    if (args[0] === 'rev-parse' && args[1] === '--git-common-dir') return ok(gitDir);
    if (args[0] === 'remote' && args.length === 1) return ok('upstream\norigin');
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return ok(args[2] === 'origin' ? 'git@github.com:someone/fork.git' : 'https://github.com/o/r.git');
    }
    // `rev-parse HEAD` inside the worktree (opts.cwd is the new dir)
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ok(opts?.cwd ? HEAD : '');
    if (args[0] === 'ls-tree' || args.includes('ls-tree')) {
      return ok(`100644 blob ${'c'.repeat(40)}\tsrc/x.ts\0`);
    }
    return ok('');
  };
  return { calls, git };
}

const open = (git: GitRun, repoPath = repoRoot) =>
  openWorktree({ baseSha: BASE, headSha: HEAD, pr: 7, prSlug: 'o/r', repoPath }, { git });

describe('openWorktree — the happy path materializes ONE worktree at the receipt`s headSha', () => {
  it('proves the repo, fetches by explicit url, asserts HEAD, and exposes the readable surface', () => {
    const { calls, git } = happyGit();
    const session = open(git);
    expect(isPreflightError(session)).toBe(false);
    if (isPreflightError(session)) return;

    expect(session.headSha).toBe(HEAD);
    expect(session.baseSha).toBe(BASE);
    // ANY remote pointing at the PR's repo proves the checkout — here it is `upstream`, not `origin`.
    const fetch = calls.find((c) => c.includes('fetch'));
    expect(fetch).toContain('https://github.com/o/r.git');
    expect(fetch).toContain('pull/7/head');

    // The evidence manifest's readable surface: the tracked tree at headSha, keyed by blob SHA.
    expect(session.readableSurface()).toEqual([{ blobSha: 'c'.repeat(40), path: 'src/x.ts' }]);

    // Reap removes the worktree AND prunes the shared .git admin dir; it is idempotent.
    session.reap();
    session.reap();
    expect(calls.filter((c) => c.includes('remove'))).toHaveLength(1);
    expect(calls.some((c) => c.includes('prune'))).toBe(true);
    fs.rmSync(session.dir, { force: true, recursive: true });
  });
});

describe('openWorktree — the pre-flight fails CLOSED, with a named cause', () => {
  it('`not-a-repo`: the --repo path is not a git checkout', () => {
    const { git } = happyGit((args) =>
      args[1] === '--show-toplevel' ? err('not a git repository') : null
    );
    const res = open(git);
    expect(isPreflightError(res) && res.kind).toBe('not-a-repo');
  });

  it('`wrong-repo`: no remote points at the PR`s repo — never fetched into', () => {
    const { calls, git } = happyGit((args) =>
      args[0] === 'remote' && args[1] === 'get-url'
        ? ok('git@github.com:someone/else.git')
        : null
    );
    const res = open(git);
    expect(isPreflightError(res) && res.kind).toBe('wrong-repo');
    expect(calls.some((c) => c.includes('fetch'))).toBe(false);
  });

  it('`no-such-pr`: the PR ref does not exist on the remote', () => {
    const { calls, git } = happyGit((args) =>
      args.includes('fetch') ? err("fatal: couldn't find remote ref pull/7/head") : null
    );
    const res = open(git);
    expect(isPreflightError(res) && res.kind).toBe('no-such-pr');
    expect(calls.some((c) => c.includes('add'))).toBe(false);
  });

  it('`auth`: a credential failure is not reported as a retryable network blip', () => {
    const { git } = happyGit((args) =>
      args.includes('fetch') ? err('fatal: Authentication failed for https://github.com/o/r') : null
    );
    const res = open(git);
    expect(isPreflightError(res) && res.kind).toBe('auth');
  });

  it('`network`: an unrecognized git failure stays conservative (retryable, not a security claim)', () => {
    const { git } = happyGit((args) =>
      args.includes('fetch') ? err('fatal: unable to access: Could not resolve host: github.com') : null
    );
    const res = open(git);
    expect(isPreflightError(res) && res.kind).toBe('network');
  });

  it('`sha-mismatch`: the worktree resolved to a different commit — ABORT, never review it', () => {
    const { calls, git } = happyGit((args) =>
      args[0] === 'rev-parse' && args[1] === 'HEAD' ? ok('f'.repeat(40)) : null
    );
    const res = open(git);
    expect(isPreflightError(res) && res.kind).toBe('sha-mismatch');
    expect(isPreflightError(res) && res.message).toMatch(/ABORTING/);
    // A failed materialization leaves nothing behind.
    expect(calls.some((c) => c.includes('remove'))).toBe(true);
    expect(calls.some((c) => c.includes('prune'))).toBe(true);
  });

  // `acquireRepoLock` THROWS when a sibling review holds the repo lock past its staleness TTL, and
  // mkdtemp can throw on a full temp root. openWorktree promises the CLI a named cause on every
  // failure — the CLI opens the worktree before its try/finally, so a throw escapes as a stack
  // trace and a bare exit 1 rather than the documented exit 3.
  it('`lock-contended` / `materialize-failed`: a THROW becomes a named cause, never a stack trace', () => {
    const { git } = happyGit();
    const throwing = (message: string) => (): (() => void) => {
      throw new Error(message);
    };

    const contended = openWorktree(
      { baseSha: BASE, headSha: HEAD, pr: 7, prSlug: 'o/r', repoPath: repoRoot },
      { git, lock: throwing('ensemble-ai: could not acquire the worktree lock at /x after 1200 attempts') }
    );
    expect(isPreflightError(contended) && contended.kind).toBe('lock-contended');
    expect(isPreflightError(contended) && contended.message).toMatch(/another review|worktree lock/);

    const broken = openWorktree(
      { baseSha: BASE, headSha: HEAD, pr: 7, prSlug: 'o/r', repoPath: repoRoot },
      { git, lock: throwing('ENOSPC: no space left on device') }
    );
    expect(isPreflightError(broken) && broken.kind).toBe('materialize-failed');
    expect(isPreflightError(broken) && broken.message).toMatch(/ENOSPC/);
  });
});
