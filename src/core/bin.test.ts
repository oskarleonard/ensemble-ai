import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The PATH probe (`zsh -ic whence -p`) is the one thing a test must never really run —
// CI has no login zsh. Real temp files stand in for "exists"; only execFileSync is faked.
const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFileSync: execFileSyncMock,
}));

import { resolveBin } from './bin';

let dir: string;
let existing: string;
let candidate: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-bin-'));
  existing = path.join(dir, 'pinned-cli');
  candidate = path.join(dir, 'default-cli');
  fs.writeFileSync(existing, '');
  fs.writeFileSync(candidate, '');
});
afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  execFileSyncMock.mockReset();
});

// The cache is module-scoped and keyed by name, so every test resolves its own name.
describe('resolveBin — an explicitly set override is authoritative', () => {
  it('set + exists → that path, ahead of an existing candidate and without a PATH probe', () => {
    vi.stubEnv('T1_BIN', existing);
    expect(resolveBin('t1', { candidates: [candidate], envVar: 'T1_BIN' })).toBe(existing);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('set + missing → throws naming the variable and the path; no candidate, no PATH probe', () => {
    const missing = path.join(dir, 'pruned-cli');
    vi.stubEnv('T2_BIN', missing);
    expect(() => resolveBin('t2', { candidates: [candidate], envVar: 'T2_BIN' })).toThrow(
      `T2_BIN=${missing} does not exist — unset it to use the default resolution`
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('a relative override resolves against the caller cwd and returns an absolute path', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.stubEnv('T9_BIN', './pinned-cli');
    expect(resolveBin('t9', { envVar: 'T9_BIN' })).toBe(existing);
    vi.stubEnv('T9_BIN', 't9');
    expect(() => resolveBin('t9', { candidates: [candidate], envVar: 'T9_BIN' })).toThrow(
      `T9_BIN=t9 (resolved to ${path.join(dir, 't9')}) does not exist — unset it to use the default resolution`
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('names the resolved path only when it differs from the raw value', () => {
    // Concatenated, not path.join'd — join would normalize the `..` away.
    const missing = `${dir}/gone/../gone-cli`;
    vi.stubEnv('T10_BIN', missing);
    expect(() => resolveBin('t10', { envVar: 'T10_BIN' })).toThrow(
      `T10_BIN=${missing} (resolved to ${path.join(dir, 'gone-cli')}) does not exist`
    );
    const absolute = path.join(dir, 'absent-cli');
    vi.stubEnv('T10_BIN', absolute);
    expect(() => resolveBin('t10', { envVar: 'T10_BIN' })).toThrow(/^T10_BIN=\S+ does not exist/);
  });

  it('a throw is never memoized — the next call re-checks the override', () => {
    const late = path.join(dir, 'late-cli');
    vi.stubEnv('T3_BIN', late);
    expect(() => resolveBin('t3', { envVar: 'T3_BIN' })).toThrow('does not exist');
    fs.writeFileSync(late, '');
    expect(resolveBin('t3', { envVar: 'T3_BIN' })).toBe(late);
  });

  it('beats an earlier cached resolution of the same name', () => {
    expect(resolveBin('t4', { candidates: [candidate], envVar: 'T4_BIN' })).toBe(candidate);
    vi.stubEnv('T4_BIN', existing);
    expect(resolveBin('t4', { candidates: [candidate], envVar: 'T4_BIN' })).toBe(existing);
    vi.stubEnv('T4_BIN', path.join(dir, 'gone-cli'));
    expect(() => resolveBin('t4', { candidates: [candidate], envVar: 'T4_BIN' })).toThrow(
      'does not exist'
    );
  });
});

describe('resolveBin — unset or empty override: candidates, then PATH (unchanged)', () => {
  it('unset → the first existing candidate, without a PATH probe', () => {
    const absent = path.join(dir, 'absent-cli');
    expect(resolveBin('t5', { candidates: [absent, candidate], envVar: 'T5_BIN' })).toBe(
      candidate
    );
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('unset + no candidate exists → the login shell PATH, last line wins', () => {
    execFileSyncMock.mockReturnValue('banner noise\n/opt/bin/t6\n');
    expect(resolveBin('t6', { candidates: [path.join(dir, 'absent-cli')], envVar: 'T6_BIN' })).toBe(
      '/opt/bin/t6'
    );
    expect(execFileSyncMock).toHaveBeenCalledWith('/bin/zsh', ['-ic', 'whence -p t6'], {
      encoding: 'utf8',
    });
  });

  it('empty string → treated as unset', () => {
    vi.stubEnv('T7_BIN', '');
    expect(resolveBin('t7', { candidates: [candidate], envVar: 'T7_BIN' })).toBe(candidate);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });

  it('nothing resolves → throws', () => {
    execFileSyncMock.mockReturnValue('');
    expect(() => resolveBin('t8', { envVar: 'T8_BIN' })).toThrow('t8 binary not found');
  });
});
