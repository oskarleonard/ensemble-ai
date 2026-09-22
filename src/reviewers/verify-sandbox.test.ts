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

  it('refuses root/home/relative grants, home scratch writes and shared system scratch', () => {
    for (const field of ['worktree', 'tmpDir', 'npmCache', 'nodePrefix'] as const) {
      for (const root of ['/', os.homedir(), 'relative/checkout']) {
        expect(() => renderVerifySandboxProfile({ ...paths, [field]: root })).toThrow();
      }
    }
    // Inside home, including a child whose name merely starts with `..`.
    for (const root of [path.join(os.homedir(), '.codex'), path.join(os.homedir(), '..cache')]) {
      expect(() => renderVerifySandboxProfile({ ...paths, tmpDir: root })).toThrow(/outside your home/);
    }
    // A shared system root, or an ancestor whose write grant would cover one.
    for (const root of ['/private/tmp', '/private', '/opt']) {
      expect(() => renderVerifySandboxProfile({ ...paths, tmpDir: root })).toThrow(/shared system root/);
    }
    expect(() => renderVerifySandboxProfile({ ...paths, proxyPort: 0 })).toThrow();
  });
});
