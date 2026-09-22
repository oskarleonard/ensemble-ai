import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderVerifySandboxProfile, type VerifySandboxPaths } from './codex-sandbox';

const paths: VerifySandboxPaths = {
  worktree: '/private/tmp/verify-unique/checkout',
  tmpDir: '/private/tmp/verify-unique/tmp',
  npmCache: '/private/tmp/verify-unique/npm-cache',
  nodePrefix: path.join(os.homedir(), '.nvm/versions/node/v24.13.1'),
  proxyPort: 54321,
};

describe('the verify profile is separate from the read-only reviewer', () => {
  it('grants scratch writes, toolchain execution and only the proxy connection', () => {
    const profile = renderVerifySandboxProfile(paths);
    expect(profile).toContain('(deny default)');
    for (const root of [paths.worktree, paths.tmpDir, paths.npmCache]) {
      expect(profile).toContain(`(subpath ${JSON.stringify(root)})`);
    }
    expect(profile).toContain(`(subpath ${JSON.stringify(paths.nodePrefix)})`);
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:54321"))');
    expect(profile).not.toContain('(allow mach-lookup)');
    expect(profile).not.toContain('(allow file-write* (subpath "/private/tmp"))');
    expect(profile).not.toContain('bsd.sb');
  });

  it('refuses root/home grants, home scratch writes and shared system scratch', () => {
    for (const field of ['worktree', 'tmpDir', 'npmCache', 'nodePrefix'] as const) {
      for (const root of ['/', os.homedir()]) {
        expect(() => renderVerifySandboxProfile({ ...paths, [field]: root })).toThrow();
      }
    }
    expect(() => renderVerifySandboxProfile({ ...paths, tmpDir: path.join(os.homedir(), '.codex') })).toThrow();
    expect(() => renderVerifySandboxProfile({ ...paths, tmpDir: '/private/tmp' })).toThrow();
    expect(() => renderVerifySandboxProfile({ ...paths, proxyPort: 0 })).toThrow();
  });

  it.skipIf(process.platform !== 'darwin')('sandbox-exec permits scratch writes/exec and denies outside writes, home reads and direct sockets', () => {
    const dir = fs.realpathSync(fs.mkdtempSync('/private/tmp/ensemble-verify-probe-'));
    const homeCanary = path.join(os.homedir(), `.ensemble-verify-canary-${path.basename(dir)}`);
    const outside = `${dir}-outside`;
    try {
      const p = { ...paths, worktree: path.join(dir, 'checkout'), tmpDir: path.join(dir, 'tmp'), npmCache: path.join(dir, 'cache'), nodePrefix: path.dirname(path.dirname(fs.realpathSync(process.execPath))) };
      for (const root of [p.worktree, p.tmpDir, p.npmCache]) fs.mkdirSync(root);
      fs.writeFileSync(homeCanary, 'probe-only');
      const executable = path.join(p.worktree, 'executable');
      fs.writeFileSync(executable, '#!/bin/sh\necho scratch-exec-ok\n', { mode: 0o700 });
      fs.symlinkSync(homeCanary, path.join(p.worktree, 'escape'));
      const script = path.join(p.worktree, 'probe.cjs');
      fs.writeFileSync(script, `
        const fs = require('node:fs'), net = require('node:net'), assert = require('node:assert/strict');
        assert.equal(require('node:child_process').execFileSync(${JSON.stringify(executable)}, { encoding: 'utf8' }).trim(), 'scratch-exec-ok');
        for (const root of ${JSON.stringify([p.worktree, p.tmpDir, p.npmCache])}) fs.writeFileSync(root + '/allowed', 'ok');
        for (const file of ${JSON.stringify([homeCanary, path.join(p.worktree, 'escape')])}) assert.throws(() => fs.readFileSync(file), { code: 'EPERM' });
        assert.throws(() => fs.writeFileSync(${JSON.stringify(outside)}, 'bad'), { code: 'EPERM' });
        const socket = net.connect(443, '1.1.1.1');
        socket.on('error', e => { assert.equal(e.code, 'EPERM'); console.log('scratch allowed; outside/home/symlink/direct-network EPERM'); });
      `);
      const profile = path.join(dir, 'verify.sb');
      fs.writeFileSync(profile, renderVerifySandboxProfile(p));
      const result = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, script], { encoding: 'utf8', cwd: p.worktree, timeout: 10000 });
      expect(result.stderr).toBe('');
      expect(result.status, JSON.stringify(result)).toBe(0);
      expect(result.stdout).toContain('scratch allowed; outside/home/symlink/direct-network EPERM');
      expect(fs.existsSync(outside)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(homeCanary, { force: true });
      fs.rmSync(outside, { force: true });
    }
  });
});
