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

  it('reads the system roots and its own scratch roots, never another run in a shared temp tree', () => {
    // Order is the rule: SBPL's last match wins, so the deny must sit between the two allows.
    expect(renderVerifySandboxProfile(paths).match(/^\((allow|deny) file-read.*$/gm)).toEqual([
      '(allow file-read-metadata)',
      expect.stringMatching(/^\(allow file-read\* \(subpath "\/usr"\) .*\(subpath "\/private\/tmp"\)/),
      '(deny file-read-data file-read-xattr (subpath "/private/tmp") (subpath "/private/var/tmp") (subpath "/private/var/folders"))',
      `(allow file-read-data file-read-xattr ${[paths.nodePrefix, paths.worktree, paths.tmpDir, paths.npmCache].map((root) => `(subpath ${JSON.stringify(root)})`).join(' ')})`,
    ]);
  });

  it('executes only from toolchain roots, the node install and its scratch roots', () => {
    const [exec] = renderVerifySandboxProfile(paths).match(/^\(allow process-exec.*$/gm) ?? [];
    expect(exec).toContain('(subpath "/usr")');
    expect(exec).toContain(`(subpath ${JSON.stringify(paths.nodePrefix)})`);
    expect(exec).toContain(`(subpath ${JSON.stringify(paths.npmCache)})`);
    expect(exec).not.toContain('(subpath "/private/tmp/verify-unique")');
    expect(exec).not.toContain('(subpath "/private/tmp")');
    expect(exec).not.toContain('(subpath "/private/var")');
  });

  it('refuses root/home/relative grants, scratch in home, and shared roots as scratch', () => {
    for (const field of ['worktree', 'tmpDir', 'npmCache', 'nodePrefix'] as const) {
      for (const root of ['/', os.homedir(), 'relative/checkout']) {
        expect(() => renderVerifySandboxProfile({ ...paths, [field]: root })).toThrow();
      }
    }
    for (const field of ['worktree', 'tmpDir', 'npmCache'] as const) {
      // Inside home — including a child whose name merely starts with `..`.
      for (const root of [path.join(os.homedir(), '.codex'), path.join(os.homedir(), '..cache')]) {
        expect(() => renderVerifySandboxProfile({ ...paths, [field]: root })).toThrow(/outside your home/);
      }
      // A shared root or an ancestor of one, the operator's own $TMPDIR included.
      for (const root of ['/private/tmp', '/private', '/opt', '/private/var/folders', fs.realpathSync(os.tmpdir())]) {
        expect(() => renderVerifySandboxProfile({ ...paths, [field]: root })).toThrow(/dedicated directory/);
      }
    }
    expect(() => renderVerifySandboxProfile({ ...paths, proxyPort: 0 })).toThrow();
  });

  it('validates and renders normalized paths, and never lets nodePrefix reopen a temp tree', () => {
    // Normalized BEFORE validation: `/private/tmp/` and `/private/tmp/.` are still `/private/tmp`.
    for (const root of ['/private/tmp/', '/private/tmp/.']) {
      expect(() => renderVerifySandboxProfile({ ...paths, tmpDir: root })).toThrow(/dedicated directory/);
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
