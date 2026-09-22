import { execFile, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Exercise the package consumers install, not just the TypeScript source.
import { renderVerifySandboxProfile, startEgressProxy, wrapWithSandbox } from '../../dist/index.js';
import {
  codexSandboxSupported,
  renderVerifySandboxProfile as renderSourceProfile,
  type VerifySandboxPaths,
} from './codex-sandbox';

const exec = promisify(execFile);

describe.skipIf(!codexSandboxSupported())('built verify fence: real sandbox-exec canaries', () => {
  let scratch: string;
  let roots: VerifySandboxPaths;
  let profile: string;
  let homeCanary: string;

  function render(proxyPort = roots.proxyPort) {
    fs.writeFileSync(profile, renderVerifySandboxProfile({ ...roots, proxyPort }));
  }

  function probe(script: string) {
    const file = path.join(roots.worktree, 'probe.cjs');
    fs.writeFileSync(file, script);
    const sandboxed = wrapWithSandbox(profile, process.execPath, [file]);
    return exec(sandboxed.bin, sandboxed.args, {
      cwd: roots.worktree,
      env: { PATH: '/usr/bin:/bin', TMPDIR: roots.tmpDir, HOME: roots.tmpDir },
      timeout: 10000,
    });
  }

  beforeEach(() => {
    scratch = fs.realpathSync(fs.mkdtempSync('/private/tmp/ensemble-verify-canary-'));
    roots = {
      worktree: path.join(scratch, 'checkout'),
      nodePrefix: path.dirname(path.dirname(fs.realpathSync(process.execPath))),
      tmpDir: path.join(scratch, 'tmp'),
      npmCache: path.join(scratch, 'cache'),
      proxyPort: 54321,
    };
    profile = path.join(scratch, 'verify.sb');
    homeCanary = path.join(os.homedir(), `.verify-canary-${path.basename(scratch)}`);
    for (const dir of [roots.worktree, roots.tmpDir, roots.npmCache]) fs.mkdirSync(dir);
    render();
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(homeCanary, { force: true });
  });

  it('the built package renders exactly the source profile (run `npm run build` if not)', () => {
    expect(renderVerifySandboxProfile(roots)).toBe(renderSourceProfile(roots));
  });

  it('denies HOME reads with EPERM, directly and through a scratch symlink', async () => {
    fs.writeFileSync(homeCanary, 'only-a-test-canary');
    const escape = path.join(roots.worktree, 'escape');
    fs.symlinkSync(homeCanary, escape);
    const result = await probe(`
      const fs = require('node:fs'), assert = require('node:assert/strict');
      for (const file of ${JSON.stringify([homeCanary, escape])}) assert.throws(() => fs.readFileSync(file), { code: 'EPERM' });
      console.log('HOME read EPERM');
    `);
    expect(result.stdout.trim()).toBe('HOME read EPERM');
  });

  it("denies reading or listing the operator's $TMPDIR and the shared /tmp outside its own run", async () => {
    const operatorCanary = path.join(fs.realpathSync(os.tmpdir()), `verify-canary-${path.basename(scratch)}`);
    const sharedCanary = `${scratch}-shared`;
    try {
      for (const file of [operatorCanary, sharedCanary]) fs.writeFileSync(file, 'another-run');
      const result = await probe(`
        const fs = require('node:fs'), assert = require('node:assert/strict');
        for (const file of ${JSON.stringify([operatorCanary, sharedCanary])}) assert.throws(() => fs.readFileSync(file), { code: 'EPERM' });
        for (const dir of ${JSON.stringify([path.dirname(operatorCanary), '/private/tmp'])}) assert.throws(() => fs.readdirSync(dir), { code: 'EPERM' });
        console.log('shared temp EPERM');
      `);
      expect(result.stdout.trim()).toBe('shared temp EPERM');
    } finally {
      for (const file of [operatorCanary, sharedCanary]) fs.rmSync(file, { force: true });
    }
  });

  it('reads the private repo beside the checkout, in its own run dir', async () => {
    const repo = path.join(scratch, 'repo');
    const git = (...args: string[]) =>
      spawnSync('/usr/bin/git', ['-c', 'user.name=canary', '-c', 'user.email=canary@example.invalid', ...args], { encoding: 'utf8' });
    expect(git('init', '-q', repo).status).toBe(0);
    expect(git('-C', repo, 'commit', '-q', '--allow-empty', '-m', 'canary').status).toBe(0);
    const head = git('-C', repo, 'rev-parse', 'HEAD').stdout.trim();
    const result = await probe(`
      process.stdout.write(require('node:child_process').execFileSync('/usr/bin/git', ['-C', ${JSON.stringify(repo)}, 'rev-parse', 'HEAD'], {
        encoding: 'utf8', env: {...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'}
      }));
    `);
    expect(result.stdout.trim()).toBe(head);
  });

  it('allows writes in every scratch root and executing a file planted in the checkout', async () => {
    const executable = path.join(roots.worktree, 'executable');
    fs.writeFileSync(executable, '#!/bin/sh\necho scratch-exec-ok\n', { mode: 0o700 });
    const result = await probe(`
      const fs = require('node:fs'), assert = require('node:assert/strict');
      for (const root of ${JSON.stringify([roots.worktree, roots.tmpDir, roots.npmCache])}) fs.writeFileSync(root + '/allowed', 'ok');
      assert.equal(require('node:child_process').execFileSync(${JSON.stringify(executable)}, { encoding: 'utf8' }).trim(), 'scratch-exec-ok');
      console.log('scratch write+exec ok');
    `);
    expect(result.stdout.trim()).toBe('scratch write+exec ok');
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

  it('allows the test step to initialize an offline Git fixture through the system toolchain', async () => {
    const result = await probe(`
      const out = require('node:child_process').execFileSync('/usr/bin/git', ['init', 'git-fixture'], {
        encoding: 'utf8', env: {...process.env, DEVELOPER_DIR: '/Library/Developer/CommandLineTools', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null'}
      });
      require('node:assert/strict').match(out, /Initialized empty Git repository/);
      console.log('git-fixture-ok');
    `);
    expect(result.stdout.trim()).toBe('git-fixture-ok');
  });

  it('allows test workers to terminate their own sandboxed children, not the trusted parent', async () => {
    const result = await probe(`
      const assert = require('node:assert/strict');
      assert.throws(() => process.kill(process.ppid, 0), { code: 'EPERM' });
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 2000)']);
      child.on('spawn', () => child.kill('SIGTERM'));
      child.on('exit', (code, signal) => { assert.equal(signal, 'SIGTERM'); console.log('sandbox-child-only'); });
    `);
    expect(result.stdout.trim()).toBe('sandbox-child-only');
  });

  it('denies a write outside every scratch write root with EPERM', async () => {
    const outside = path.join(scratch, 'outside');
    const result = await probe(`
      require('node:assert/strict').throws(() => require('node:fs').writeFileSync(${JSON.stringify(outside)}, 'canary'), { code: 'EPERM' });
      console.log('outside-scratch write EPERM');
    `);
    expect(result.stdout.trim()).toBe('outside-scratch write EPERM');
    expect(fs.existsSync(outside)).toBe(false);
  });

  it("denies the trusted parent's KERN_PROCARGS2 and process info, and never returns its canary", async () => {
    const source = path.join(roots.worktree, 'procargs.c');
    const binary = path.join(roots.worktree, 'procargs');
    // Prints what the fence let through and exits 0: the test asserts the line, so a regression
    // fails on a readable diff rather than on an opaque exit status.
    fs.writeFileSync(source, `
      #include <sys/sysctl.h>
      #include <errno.h>
      #include <libproc.h>
      #include <stdio.h>
      #include <stdlib.h>
      #include <string.h>
      int main(int argc, char **argv) {
        if (argc != 2) return 2;
        int pid = atoi(argv[1]);
        int mib[3] = {CTL_KERN, KERN_PROCARGS2, pid};
        static char buf[1000000];
        size_t len = sizeof(buf);
        int result = sysctl(mib, 3, buf, &len, NULL, 0), error = errno;
        const char *canary = "VERIFY_ONLY_CANARY=ok";
        int found = memmem(buf, sizeof(buf), canary, strlen(canary)) != NULL;
        char exe[PROC_PIDPATHINFO_MAXSIZE];
        int pidpath = proc_pidpath(pid, exe, sizeof(exe));
        printf("sysctl-result=%d errno=%d canary=%d pidpath=%d\\n", result, error, found, pidpath);
        return 0;
      }
    `);
    const compile = spawnSync('/usr/bin/cc', [source, '-o', binary], { encoding: 'utf8' });
    expect(compile.status, compile.stderr).toBe(0);
    // The fresh trusted parent has ONLY a harmless canary + PATH. Never query
    // the test worker's actual environment or any unrelated process.
    const parent = path.join(roots.worktree, 'parent.cjs');
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
      cwd: roots.worktree, env: { PATH: '/usr/bin:/bin', VERIFY_ONLY_CANARY: 'ok' }, timeout: 15000,
    });
    expect(result.stdout.trim()).toBe('sysctl-result=-1 errno=1 canary=0 pidpath=0');
  });

  it('denies a direct outbound socket with EPERM', async () => {
    const result = await probe(`
      const socket = require('node:net').connect(443, '1.1.1.1');
      socket.on('connect', () => { console.log('direct socket CONNECTED'); process.exit(0); });
      socket.on('error', (e) => console.log('direct socket ' + e.code));
    `);
    expect(result.stdout.trim()).toBe('direct socket EPERM');
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
