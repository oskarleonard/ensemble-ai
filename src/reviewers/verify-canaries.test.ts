import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Exercise the package consumers install, not just the TypeScript source.
import { renderVerifySandboxProfile, startEgressProxy } from '../../dist/index.js';
import { renderVerifySandboxProfile as renderSourceProfile } from './codex-sandbox';

const exec = promisify(execFile);

describe.skipIf(process.platform !== 'darwin')('built verify fence: real sandbox-exec canaries', () => {
  let scratch: string;
  let checkout: string;
  let profile: string;
  let homeCanary: string;
  let outside: string;

  function render(proxyPort = 54321) {
    const roots = {
      worktree: checkout,
      nodePrefix: path.dirname(path.dirname(fs.realpathSync(process.execPath))),
      tmpDir: path.join(scratch, 'tmp'),
      npmCache: path.join(scratch, 'cache'),
      proxyPort,
    };
    const built = renderVerifySandboxProfile(roots);
    expect(built, 'rebuild dist before running the canaries').toBe(renderSourceProfile(roots));
    fs.writeFileSync(profile, built);
  }

  function probe(script: string) {
    const file = path.join(checkout, 'probe.cjs');
    fs.writeFileSync(file, script);
    return exec('/usr/bin/sandbox-exec', ['-f', profile, process.execPath, file], {
      cwd: checkout,
      env: { PATH: '/usr/bin:/bin' },
      timeout: 10000,
    });
  }

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync('/private/tmp/ensemble-verify-canary-'));
    checkout = path.join(scratch, 'checkout');
    profile = path.join(scratch, 'verify.sb');
    homeCanary = path.join(os.homedir(), `.verify-canary-${path.basename(scratch)}`);
    outside = path.join(scratch, 'outside');
    for (const dir of [checkout, path.join(scratch, 'tmp'), path.join(scratch, 'cache')]) fs.mkdirSync(dir);
    render();
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(homeCanary, { force: true });
  });

  it('denies a HOME read with EPERM', async () => {
    fs.writeFileSync(homeCanary, 'only-a-test-canary');
    const result = await probe(`
      require('node:assert/strict').throws(() => require('node:fs').readFileSync(${JSON.stringify(homeCanary)}), { code: 'EPERM' });
      console.log('HOME read EPERM');
    `);
    expect(result.stdout.trim()).toBe('HOME read EPERM');
  });

  it('allows Node to load the OS information npm requires', async () => {
    const result = await probe(`
      const os = require('node:os'), assert = require('node:assert/strict');
      assert.equal(os.type(), 'Darwin');
      assert.ok(os.release());
      console.log('node:os usable');
    `);
    expect(result.stdout.trim()).toBe('node:os usable');
  });

  it('allows npm to set its own process title', async () => {
    const result = await probe(`
      process.title = 'verify-canary';
      require('node:assert/strict').equal(process.title, 'verify-canary');
      console.log('self-title-ok');
    `);
    expect(result.stdout.trim()).toBe('self-title-ok');
  });

  it('denies a write outside every scratch write root with EPERM', async () => {
    const result = await probe(`
      require('node:assert/strict').throws(() => require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'canary'), { code: 'EPERM' });
      console.log('outside-scratch write EPERM');
    `);
    expect(result.stdout.trim()).toBe('outside-scratch write EPERM');
    expect(fs.existsSync(outside)).toBe(false);
  });

  it('denies KERN_PROCARGS2 for the trusted parent and never returns its canary', async () => {
    const source = path.join(checkout, 'procargs.c');
    const binary = path.join(checkout, 'procargs');
    fs.writeFileSync(source, `
      #include <sys/sysctl.h>
      #include <errno.h>
      #include <stdio.h>
      #include <stdlib.h>
      #include <string.h>
      int main(int argc, char **argv) {
        if (argc != 2) return 2;
        int mib[3] = {CTL_KERN, KERN_PROCARGS2, atoi(argv[1])};
        char buf[1000000] = {0}; size_t len = sizeof(buf);
        int result = sysctl(mib, 3, buf, &len, NULL, 0), error = errno;
        const char *canary = "VERIFY_ONLY_CANARY=ok";
        int found = 0;
        for (size_t i = 0; i + strlen(canary) <= sizeof(buf); i++)
          if (!memcmp(buf + i, canary, strlen(canary))) found = 1;
        printf("sysctl-result=%d errno=%d canary=%d\\n", result, error, found);
        return result == -1 && error == EPERM && found == 0 ? 0 : 1;
      }
    `);
    const compile = spawnSync('/usr/bin/cc', [source, '-o', binary], { encoding: 'utf8' });
    expect(compile.status, compile.stderr).toBe(0);
    // The fresh trusted parent has ONLY a harmless canary + PATH. Never query
    // the test worker's actual environment or any unrelated process.
    const parent = path.join(checkout, 'parent.cjs');
    fs.writeFileSync(parent, `
      const { spawnSync } = require('node:child_process');
      const result = spawnSync('/usr/bin/sandbox-exec', ['-f', ${JSON.stringify(profile)}, ${JSON.stringify(binary)}, String(process.pid)], {
        env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8', timeout: 10000
      });
      process.stdout.write(result.stdout || '');
      process.stderr.write(result.stderr || '');
      process.exit(result.status ?? 2);
    `);
    const result = await exec(process.execPath, [parent], {
      cwd: checkout, env: { PATH: '/usr/bin:/bin', VERIFY_ONLY_CANARY: 'ok' }, timeout: 15000,
    });
    expect(result.stdout.trim()).toBe('sysctl-result=-1 errno=1 canary=0');
  });

  it('refuses and logs an off-allowlist CONNECT from the fenced child', async () => {
    const proxy = await startEgressProxy({ allowHosts: ['registry.npmjs.org', 'github.com', 'codeload.github.com'] });
    try {
      render(proxy.port);
      const result = await probe(`
        const socket = require('node:net').connect(${proxy.port}, '127.0.0.1', () => {
          socket.write('CONNECT canary.invalid:443 HTTP/1.1\\r\\nHost: canary.invalid:443\\r\\n\\r\\n');
        });
        socket.on('data', data => { console.log(data.toString().split('\\r\\n')[0]); socket.destroy(); });
        socket.on('error', error => { console.error(error); process.exitCode = 1; });
      `);
      expect(result.stdout.trim()).toBe('HTTP/1.1 403 Forbidden');
      expect(proxy.denials).toEqual([expect.objectContaining({ host: 'canary.invalid', port: 443, method: 'CONNECT' })]);
    } finally {
      proxy.close();
    }
  });
});
