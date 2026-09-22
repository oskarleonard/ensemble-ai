import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderVerifySandboxProfile, type VerifySandboxPaths } from './codex-sandbox';

// The rendered rules. The real sandbox-exec probes of the same profile live in verify-canaries.test.ts.
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
    // The one write grant is exactly the three scratch roots — nothing shared, nothing in home.
    const scratch = [paths.worktree, paths.tmpDir, paths.npmCache].map((root) => `(subpath ${JSON.stringify(root)})`);
    expect(profile.match(/^\(allow file-write\*.*$/gm)).toEqual([`(allow file-write* ${scratch.join(' ')})`]);
    expect(profile).toContain(`(subpath ${JSON.stringify(paths.nodePrefix)})`);
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:54321"))');
    expect(profile).not.toContain('(allow mach-lookup)');
    expect(profile).not.toContain('bsd.sb');
    expect(profile).toContain('(deny process-info*)');
    expect(profile).toContain('(allow process-info-pidinfo (target self))');
    expect(profile).not.toContain('(allow sysctl-read)');
    expect(profile).toContain('(sysctl-name "hw.pagesize_compat")');
    expect(profile).not.toContain('kern.proc');
  });

  it('reads the system roots and its own run dir, never another run in a shared temp tree', () => {
    // Order is the rule: SBPL's last match wins, so the deny must sit between the two allows.
    expect(renderVerifySandboxProfile(paths).match(/^\((allow|deny) file-read.*$/gm)).toEqual([
      '(allow file-read-metadata)',
      expect.stringMatching(/^\(allow file-read\* \(subpath "\/usr"\) .*\(subpath "\/private\/tmp"\)/),
      '(deny file-read-data file-read-xattr (subpath "/private/tmp") (subpath "/private/var/tmp") (subpath "/private/var/folders"))',
      `(allow file-read-data file-read-xattr (subpath ${JSON.stringify(paths.nodePrefix)}) (subpath "/private/tmp/verify-unique"))`,
    ]);
  });

  it('refuses root/home/relative grants, a shared run dir and scratch outside the run dir', () => {
    for (const field of ['worktree', 'tmpDir', 'npmCache', 'nodePrefix'] as const) {
      for (const root of ['/', os.homedir(), 'relative/checkout']) {
        expect(() => renderVerifySandboxProfile({ ...paths, [field]: root })).toThrow();
      }
    }
    // The run dir (the worktree's parent) is read-granted, so it must be dedicated: not in home —
    // including a child whose name merely starts with `..` — and neither a shared root nor an
    // ancestor of one, the operator's own $TMPDIR included.
    const inRunDir = (runDir: string) => ({ ...paths, worktree: path.join(runDir, 'checkout') });
    expect(() => renderVerifySandboxProfile(inRunDir(path.join(os.homedir(), '..cache')))).toThrow(/outside your home/);
    for (const runDir of ['/private/tmp', '/private', '/opt', '/private/var/folders', fs.realpathSync(os.tmpdir())]) {
      expect(() => renderVerifySandboxProfile(inRunDir(runDir))).toThrow(/dedicated directory/);
    }
    // Scratch outside the run dir — in home, a shared root, another run — or the run dir itself.
    for (const root of [path.join(os.homedir(), '.codex'), '/private/tmp', '/private/tmp/verify-other/tmp', '/private/tmp/verify-unique']) {
      expect(() => renderVerifySandboxProfile({ ...paths, tmpDir: root })).toThrow(/inside the run dir/);
    }
    expect(() => renderVerifySandboxProfile({ ...paths, proxyPort: 0 })).toThrow();
  });

  it('validates and renders normalized paths, and never lets nodePrefix reopen a temp tree', () => {
    // A trailing slash or `/.` IS the run dir — refused, not granted as a child of it.
    for (const root of ['/private/tmp/verify-unique/', '/private/tmp/verify-unique/.']) {
      expect(() => renderVerifySandboxProfile({ ...paths, tmpDir: root })).toThrow(/inside the run dir/);
    }
    const profile = renderVerifySandboxProfile({ ...paths, worktree: `${paths.worktree}/`, tmpDir: `${paths.tmpDir}/./` });
    expect(profile).toContain(`(subpath ${JSON.stringify(paths.worktree)})`);
    expect(profile).toContain(`(subpath ${JSON.stringify(paths.tmpDir)})`);
    expect(profile).not.toMatch(/\/\.?"\)/);
    // nodePrefix is re-granted after the temp-tree deny, so a prefix covering one would reopen it.
    for (const nodePrefix of ['/private/tmp', '/private/var', '/private/var/folders', fs.realpathSync(os.tmpdir())]) {
      expect(() => renderVerifySandboxProfile({ ...paths, nodePrefix })).toThrow(/nodePrefix/);
    }
    expect(() => renderVerifySandboxProfile({ ...paths, nodePrefix: '/opt/homebrew' })).not.toThrow();
  });
});
