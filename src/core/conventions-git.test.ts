import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitConventionReader, gitHasCommit } from './conventions';

// The git-backed reader reads the repo's conventions AT A REF out of a local clone — the base
// ref, so a PR's own edits to AGENTS.md never become the rules it is judged against.
describe('gitConventionReader — conventions at a ref, from the local clone', () => {
  let repo: string;
  let baseSha: string;
  let headSha: string;
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();
  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-gitconv-'));
    git('init', '-q');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# rules at base\n');
    fs.mkdirSync(path.join(repo, 'docs'));
    fs.writeFileSync(path.join(repo, 'docs', 'a.md'), 'A');
    fs.writeFileSync(path.join(repo, 'docs', 'b.txt'), 'not md');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.md\n');
    fs.writeFileSync(path.join(repo, 'secret.md'), 'TOKEN\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    baseSha = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# rules REWRITTEN by the PR\n');
    git('commit', '-q', '-am', 'head');
    headSha = git('rev-parse', 'HEAD');
  });
  afterEach(() => fs.rmSync(repo, { force: true, recursive: true }));

  it('reads a file as it was at the ref, not at the checkout', async () => {
    const reader = gitConventionReader(repo, baseSha);
    expect(await reader.read('AGENTS.md')).toBe('# rules at base\n');
    expect(await gitConventionReader(repo, headSha).read('AGENTS.md')).toBe('# rules REWRITTEN by the PR\n');
  });

  it('bounds the read to maxBytes, misses silently, never sees an ignored file or a directory', async () => {
    const reader = gitConventionReader(repo, baseSha);
    expect(await reader.read('AGENTS.md', 7)).toBe('# rules');
    expect(await reader.read('nope.md')).toBeNull();
    expect(await reader.read('secret.md')).toBeNull(); // ignored → never tracked → not at the ref
    expect(await reader.read('docs')).toBeNull();
    expect(await reader.read('../etc/passwd')).toBeNull();
    expect(await reader.read('/etc/passwd')).toBeNull();
  });

  it('lists the *.md files directly under a dir, repo-relative', async () => {
    const reader = gitConventionReader(repo, baseSha);
    expect(await reader.list('docs')).toEqual(['docs/a.md']);
    expect(await reader.list('missing')).toEqual([]);
  });

  it('gitHasCommit tells a present ref from an absent one', () => {
    expect(gitHasCommit(repo, baseSha)).toBe(true);
    expect(gitHasCommit(repo, 'f'.repeat(40))).toBe(false);
  });
});
