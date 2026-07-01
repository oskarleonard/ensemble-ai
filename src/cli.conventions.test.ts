import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A REAL integration test of the `diff` command's convention gathering: a throwaway
// git repo on disk, driven through `main` with NO engine mock (unlike cli.test.ts) —
// proving the CLI's local path populates the packet conventions via the SAME
// gatherConventions the dashboard calls. (The `--pr <url>` path shares that gatherer
// through a gh reader; its live proof is the dogfood smoke.)
import { main } from './cli';

let tmp: string;
let logs: string[];

function git(args: string[]): void {
  execFileSync('git', args, {
    cwd: tmp,
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@e.co',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@e.co',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-conv-'));
  git(['init', '-q']);
  // A monorepo: root conventions (with an @-import, a prose ref, and an absolute
  // @~/ import that MUST be ignored) + a package with its own CLAUDE.md.
  fs.writeFileSync(
    path.join(tmp, 'CLAUDE.md'),
    '# root rules\n@AGENTS.md\n@~/brain/me/identity.md\nsee CONTRIBUTING.md\n'
  );
  fs.writeFileSync(path.join(tmp, 'AGENTS.md'), 'root agents doc');
  fs.writeFileSync(path.join(tmp, 'CONTRIBUTING.md'), 'contributing');
  fs.mkdirSync(path.join(tmp, 'pkg/api'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'pkg/api/CLAUDE.md'), 'api package rules');
  fs.writeFileSync(path.join(tmp, 'pkg/api/handler.ts'), 'export const a = 1;\n');
  git(['add', '-A']);
  git(['commit', '-qm', 'init']);
  // Uncommitted change in the package → working-tree diff touches pkg/api.
  fs.writeFileSync(path.join(tmp, 'pkg/api/handler.ts'), 'export const a = 2;\n');

  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { force: true, recursive: true });
});

describe('A5 · `diff` populates packet conventions (local mode)', () => {
  it('gathers root + touched package + common-docs, in-repo only', async () => {
    const code = await main(['diff', '--cwd', tmp, '--working-tree']);
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('conventions:');
    expect(out).toContain('CLAUDE.md');
    expect(out).toContain('AGENTS.md'); // @-import followed
    expect(out).toContain('CONTRIBUTING.md'); // prose ref / common-docs
    expect(out).toContain('pkg/api/CLAUDE.md'); // walk-up to the touched package
    // boundary: no ~/brain file ever appears as a gathered entry
    expect(out).not.toContain('brain/me/identity.md');
  });

  it('--json carries a conventions manifest with the gathered files', async () => {
    const code = await main(['diff', '--cwd', tmp, '--working-tree', '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as {
      conventions?: { files: { path: string; included: boolean }[] };
    };
    const paths = (parsed.conventions?.files ?? [])
      .filter((f) => f.included)
      .map((f) => f.path);
    expect(paths).toContain('CLAUDE.md');
    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('pkg/api/CLAUDE.md');
    expect(paths.every((p) => !p.includes('brain'))).toBe(true);
  });

  it('--no-conventions emits no conventions block', async () => {
    const code = await main([
      'diff',
      '--cwd',
      tmp,
      '--working-tree',
      '--no-conventions',
    ]);
    expect(code).toBe(0);
    expect(logs.join('\n')).not.toContain('conventions:');
  });

  // The load-bearing boundary: an in-tree symlink pointing OUTSIDE the repo passes the
  // lexical under-root check but MUST NOT be followed (realpath exposes the escape).
  it('does NOT follow an in-repo symlink that escapes the repo root', async () => {
    // A secret file OUTSIDE the repo, and an in-repo symlink + @-import pointing at it.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.md'), 'TOP-SECRET-LEAK-CONTENT');
    fs.symlinkSync(path.join(outside, 'secret.md'), path.join(tmp, 'leak.md'));
    fs.writeFileSync(
      path.join(tmp, 'CLAUDE.md'),
      '# root rules\n@AGENTS.md\n@leak.md\nsee CONTRIBUTING.md\n'
    );
    try {
      const code = await main([
        'diff',
        '--cwd',
        tmp,
        '--working-tree',
        '--json',
      ]);
      expect(code).toBe(0);
      const out = logs.join('\n');
      // The escaping symlink's target content never enters the packet…
      expect(out).not.toContain('TOP-SECRET-LEAK-CONTENT');
      // …and leak.md is not gathered as a convention file (its read resolves outside root).
      const parsed = JSON.parse(out) as {
        conventions?: { files: { path: string; included: boolean }[] };
      };
      const paths = (parsed.conventions?.files ?? []).map((f) => f.path);
      expect(paths).not.toContain('leak.md');
      // in-repo conventions still gather normally (the guard rejects ONLY the escape).
      expect(paths).toContain('AGENTS.md');
    } finally {
      fs.rmSync(outside, { force: true, recursive: true });
    }
  });
});
