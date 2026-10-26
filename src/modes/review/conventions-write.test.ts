import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CONVENTIONS_IN_TREE_DIR, CONVENTIONS_IN_TREE_FILE, gitRootEntriesAtHead, writeConventionsInTree, writeExclusive } from './conventions-write';

const SHA = 'a'.repeat(40);
const none = () => null;

describe('writeConventionsInTree — the handover is a sandbox-boundary write into the PR\'s own tree', () => {
  let wt: string;
  let elsewhere: string;
  beforeEach(() => {
    wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-convw-wt-'));
    elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-convw-elsewhere-'));
  });
  afterEach(() => {
    fs.rmSync(wt, { force: true, recursive: true });
    fs.rmSync(elsewhere, { force: true, recursive: true });
  });

  it('writes the file 0600 in a 0700 directory with an ignore-all beside it, when nothing is in the way', () => {
    const res = writeConventionsInTree(wt, SHA, 'RULES', { rootEntriesAtHead: none });
    expect(res.ok).toBe(true);
    const dir = path.join(wt, CONVENTIONS_IN_TREE_DIR);
    const file = path.join(dir, CONVENTIONS_IN_TREE_FILE);
    expect(res.ok && res.file).toBe(file);
    expect(fs.readFileSync(file, 'utf8')).toBe('RULES');
    expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe('*\n');
    if (process.platform !== 'win32') {
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses when the PR committed the directory as a SYMLINK — nothing lands at the link\'s target', () => {
    fs.symlinkSync(elsewhere, path.join(wt, CONVENTIONS_IN_TREE_DIR));
    const res = writeConventionsInTree(wt, SHA, 'RULES', { rootEntriesAtHead: none });
    expect(res).toEqual({ ok: false, why: `a symlink already sits at ${CONVENTIONS_IN_TREE_DIR} in the checkout` });
    expect(fs.readdirSync(elsewhere)).toEqual([]);
  });

  it('refuses when a directory or a file already sits at the path (the author\'s content is never written over)', () => {
    fs.mkdirSync(path.join(wt, CONVENTIONS_IN_TREE_DIR));
    expect(writeConventionsInTree(wt, SHA, 'RULES', { rootEntriesAtHead: none })).toEqual({ ok: false, why: `a directory already sits at ${CONVENTIONS_IN_TREE_DIR} in the checkout` });
    fs.rmSync(path.join(wt, CONVENTIONS_IN_TREE_DIR), { recursive: true });
    fs.writeFileSync(path.join(wt, CONVENTIONS_IN_TREE_DIR), 'x');
    expect(writeConventionsInTree(wt, SHA, 'RULES', { rootEntriesAtHead: none })).toEqual({ ok: false, why: `a file already sits at ${CONVENTIONS_IN_TREE_DIR} in the checkout` });
  });

  it('refuses when the head TRACKS the path, compared case-folded, before touching the disk', () => {
    const res = writeConventionsInTree(wt, SHA, 'RULES', { rootEntriesAtHead: () => ['README.md', '.Ensemble-Conventions'] });
    expect(res).toEqual({ ok: false, why: 'the PR head tracks `.Ensemble-Conventions` — the engine never writes over the author\'s path' });
    expect(fs.readdirSync(wt)).toEqual([]);
  });

  it('a failure after the directory exists removes the directory — no half-written handover stays for a seat to read', () => {
    let calls = 0;
    const failing: typeof writeExclusive = (file, body) => {
      calls++;
      if (calls === 2) throw new Error('disk full');
      writeExclusive(file, body);
    };
    const res = writeConventionsInTree(wt, SHA, 'RULES', { rootEntriesAtHead: none, writeExclusive: failing });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.why).toContain('disk full');
    expect(fs.existsSync(path.join(wt, CONVENTIONS_IN_TREE_DIR))).toBe(false);
  });
});

describe('writeExclusive — a NEW regular file, never through a link, never over an existing file', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-convw-x-'));
  });
  afterEach(() => fs.rmSync(dir, { force: true, recursive: true }));

  it('refuses a symlink at the path and leaves its target untouched', () => {
    const target = path.join(dir, 'target.txt');
    fs.writeFileSync(target, 'SECRET');
    fs.symlinkSync(target, path.join(dir, 'link'));
    expect(() => writeExclusive(path.join(dir, 'link'), 'RULES')).toThrow();
    expect(fs.readFileSync(target, 'utf8')).toBe('SECRET');
  });
  it('refuses an existing regular file', () => {
    fs.writeFileSync(path.join(dir, 'f'), 'OLD');
    expect(() => writeExclusive(path.join(dir, 'f'), 'NEW')).toThrow(/EEXIST/);
    expect(fs.readFileSync(path.join(dir, 'f'), 'utf8')).toBe('OLD');
  });
});

describe('gitRootEntriesAtHead — the tree\'s root entries at the head, or null when git cannot say', () => {
  let repo: string;
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-convw-git-'));
    git('init', '-q');
  });
  afterEach(() => fs.rmSync(repo, { force: true, recursive: true }));

  it('lists a committed symlink at the engine\'s path by name — so the writer refuses the route for that head', () => {
    fs.writeFileSync(path.join(repo, 'README.md'), 'r');
    fs.symlinkSync('/etc', path.join(repo, CONVENTIONS_IN_TREE_DIR));
    git('add', '-A');
    git('commit', '-q', '-m', 'planted');
    const sha = git('rev-parse', 'HEAD');
    expect(gitRootEntriesAtHead(repo, sha)).toEqual([CONVENTIONS_IN_TREE_DIR, 'README.md']);
    // The checked-out link is ALSO caught by the lstat fence — the two agree on the refusal.
    const res = writeConventionsInTree(repo, sha, 'RULES');
    expect(res).toEqual({ ok: false, why: `the PR head tracks \`${CONVENTIONS_IN_TREE_DIR}\` — the engine never writes over the author's path` });
  });
  it('is null outside a repository and for a malformed sha', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-convw-plain-'));
    try {
      expect(gitRootEntriesAtHead(plain, SHA)).toBeNull();
    } finally {
      fs.rmSync(plain, { force: true, recursive: true });
    }
    expect(gitRootEntriesAtHead(repo, 'HEAD')).toBeNull();
  });
});
