import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import fs from 'node:fs';

import {
  buildCodexWorktreeArgs,
  codexSandboxSupported,
  defaultCodexSandboxPaths,
  isUnsafeReadRoot,
  renderCodexSandboxProfile,
  wrapWithSandbox,
  writeCodexSandboxProfile,
} from './codex-sandbox';

// These five helpers COMPOSE the containment boundary: the argv that turns codex's internal
// sandbox off, the wrapper that turns the external one on, and the paths the profile trusts.
// Untested, a refactor that drops the bypass flag, reorders `-f <profile>`, or widens a read root
// would run codex with no effective sandbox and nothing would fail — a costume, not a boundary.

const HOME = '/Users/example';

describe('isUnsafeReadRoot — a read root may never be, or contain, $HOME', () => {
  it('rejects the filesystem root', () => {
    expect(isUnsafeReadRoot('/', HOME)).toBe(true);
  });

  it('rejects $HOME itself and any ancestor of it', () => {
    expect(isUnsafeReadRoot(HOME, HOME)).toBe(true);
    expect(isUnsafeReadRoot('/Users', HOME)).toBe(true); // every user's home
    expect(isUnsafeReadRoot(`${HOME}/`, HOME)).toBe(true);
  });

  it('accepts a real prefix that merely SITS INSIDE $HOME', () => {
    // The nvm/volta/fnm layouts — a versioned dir under $HOME is fine, it is not an ancestor.
    expect(isUnsafeReadRoot(`${HOME}/.nvm/versions/node/v22.1.0`, HOME)).toBe(false);
    expect(isUnsafeReadRoot(`${HOME}/.codex`, HOME)).toBe(false);
  });

  it('accepts system prefixes outside $HOME', () => {
    expect(isUnsafeReadRoot('/usr/local', HOME)).toBe(false);
    expect(isUnsafeReadRoot('/opt/homebrew', HOME)).toBe(false);
    expect(isUnsafeReadRoot('/private/tmp/wt', HOME)).toBe(false);
  });
});

describe('renderCodexSandboxProfile FAILS CLOSED on an unsafe read root', () => {
  const ok = {
    codexHome: path.join(os.homedir(), '.codex'),
    nodePrefix: '/usr/local',
    worktree: '/private/tmp/wt',
  };

  it('renders when every root is safe', () => {
    expect(renderCodexSandboxProfile(ok)).toContain('(deny default)');
  });

  // `/bin/node` -> nodePrefix `/`; `~/bin/node` -> nodePrefix `$HOME`. A profile granting either
  // would let the seat read ~/.ssh — verified live. Refuse rather than emit it.
  it('throws when nodePrefix collapses to the filesystem root', () => {
    expect(() => renderCodexSandboxProfile({ ...ok, nodePrefix: '/' })).toThrow(/nodePrefix/);
  });

  it('throws when nodePrefix collapses to $HOME', () => {
    expect(() => renderCodexSandboxProfile({ ...ok, nodePrefix: os.homedir() })).toThrow(
      /contains your home directory/
    );
  });

  it('throws when the worktree is $HOME, and names the offending root', () => {
    expect(() => renderCodexSandboxProfile({ ...ok, worktree: os.homedir() })).toThrow(/worktree/);
  });

  it('throws when codexHome is $HOME rather than ~/.codex', () => {
    expect(() => renderCodexSandboxProfile({ ...ok, codexHome: os.homedir() })).toThrow(
      /codexHome/
    );
  });
});

describe('wrapWithSandbox — the external profile is the boundary', () => {
  it('execs sandbox-exec with -f <profile> BEFORE the wrapped bin', () => {
    const { args, bin } = wrapWithSandbox('/tmp/p.sb', 'codex', ['exec', '-m', 'gpt-5.5']);
    expect(bin).toBe('/usr/bin/sandbox-exec');
    expect(args.slice(0, 3)).toEqual(['-f', '/tmp/p.sb', 'codex']);
    expect(args.slice(3)).toEqual(['exec', '-m', 'gpt-5.5']);
  });
});

describe('buildCodexWorktreeArgs — codex INTERNAL sandbox off, external profile governs', () => {
  const args = buildCodexWorktreeArgs({ effort: 'high', model: 'gpt-5.5' }, '/tmp/o.md', 'review');

  it('disables the internal sandbox (nested Seatbelt does not compose)', () => {
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('carries the reply through the -o outfile, as in packet mode', () => {
    expect(args[args.indexOf('-o') + 1]).toBe('/tmp/o.md');
    expect(args.at(-1)).toBe('review');
  });

  it('passes the configured model and reasoning effort', () => {
    expect(args[args.indexOf('-m') + 1]).toBe('gpt-5.5');
    expect(args).toContain('model_reasoning_effort="high"');
  });
});

describe('writeCodexSandboxProfile — the temp dir is the caller\'s to reap, not a leak', () => {
  const ok = {
    codexHome: path.join(os.homedir(), '.codex'),
    nodePrefix: '/usr/local',
    worktree: '/private/tmp/wt',
  };

  it('writes an owner-only profile and hands back a cleanup that removes the dir', () => {
    const { cleanup, file } = writeCodexSandboxProfile(ok);
    expect(fs.readFileSync(file, 'utf8')).toContain('(deny default)');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const dir = path.dirname(file);
    cleanup();
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('cleanup is idempotent', () => {
    const { cleanup } = writeCodexSandboxProfile(ok);
    cleanup();
    expect(() => cleanup()).not.toThrow();
  });

  // Render before mkdtemp: an unsafe root must throw without leaving a dir behind.
  it('creates nothing when the profile is refused', () => {
    const before = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ensemble-sb-')).length;
    expect(() => writeCodexSandboxProfile({ ...ok, nodePrefix: '/' })).toThrow();
    const after = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('ensemble-sb-')).length;
    expect(after).toBe(before);
  });
});

describe('codexSandboxSupported — Seatbelt is macOS-only, so elsewhere fail closed', () => {
  it('is false off darwin', () => {
    expect(codexSandboxSupported('linux')).toBe(false);
    expect(codexSandboxSupported('win32')).toBe(false);
  });
});

describe('defaultCodexSandboxPaths', () => {
  it('realpaths the worktree — Seatbelt matches resolved paths, so /tmp would match nothing', () => {
    const p = defaultCodexSandboxPaths(os.tmpdir());
    expect(p.worktree).toBe(path.resolve(p.worktree));
    expect(p.worktree.startsWith('/private/') || process.platform !== 'darwin').toBe(true);
  });

  it('points codexHome at ~/.codex, never at $HOME', () => {
    expect(defaultCodexSandboxPaths(os.tmpdir()).codexHome).toBe(
      path.join(os.homedir(), '.codex')
    );
  });
});
