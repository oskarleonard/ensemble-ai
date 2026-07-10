import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { execGit, nonInteractiveSshCommand } from './git-exec';

// `GIT_TERMINAL_PROMPT=0` silences GIT's prompts, not ssh's. An ssh remote with a passphrased key
// prompts on /dev/tty by itself, wedging an unattended pre-flight until the 600s git backstop.
// `BatchMode=yes` makes ssh fail fast instead — but only a PLAIN `ssh` can be handed ssh's flags.
describe('nonInteractiveSshCommand — fail fast on ssh auth, without breaking the user`s tooling', () => {
  it('supplies a non-interactive ssh when the user configured none', () => {
    expect(nonInteractiveSshCommand(undefined)).toBe('ssh -o BatchMode=yes');
    expect(nonInteractiveSshCommand('   ')).toBe('ssh -o BatchMode=yes');
  });

  it('extends a plain `ssh` — including one carrying the user`s own flags and an absolute path', () => {
    expect(nonInteractiveSshCommand('ssh')).toBe('ssh -o BatchMode=yes');
    expect(nonInteractiveSshCommand('ssh -F /my/config -i ~/.ssh/work')).toBe(
      'ssh -F /my/config -i ~/.ssh/work -o BatchMode=yes'
    );
    expect(nonInteractiveSshCommand('/usr/bin/ssh -4')).toBe('/usr/bin/ssh -4 -o BatchMode=yes');
  });

  // git runs GIT_SSH_COMMAND through `sh -c`, so the flag would land in the WRAPPER's argv. A
  // wrapper that rejects it turns a hypothetical prompt into a guaranteed failed fetch — strictly
  // worse. Null ⇒ we set nothing and git inherits the user's own value untouched.
  it('never rewrites a wrapper script or an alternate binary', () => {
    expect(nonInteractiveSshCommand('/opt/vpn/ssh-wrapper.sh')).toBeNull();
    expect(nonInteractiveSshCommand('my-ssh-helper --vpn')).toBeNull();
    expect(nonInteractiveSshCommand('sshpass -p x ssh')).toBeNull();
  });
});

// `git config core.sshCommand` is the OTHER channel a user configures ssh through, and setting
// GIT_SSH_COMMAND SILENTLY OVERRIDES it (verified against real git: with both set, only the env
// value runs). Injecting our default unconditionally would therefore drop the `-i <key>` of every
// multi-key checkout — a fetch that works by hand would fail `Permission denied (publickey)` and
// classify as `auth`. These tests drive the REAL `git`, with a `core.sshCommand` that leaves a
// marker file, so the assertion is "which ssh command did git actually run".
describe('execGit — honors the user`s core.sshCommand instead of overriding it', () => {
  const dirs: string[] = [];
  const savedSshEnv = process.env.GIT_SSH_COMMAND;

  afterEach(() => {
    vi.unstubAllEnvs();
    if (savedSshEnv === undefined) delete process.env.GIT_SSH_COMMAND;
    else process.env.GIT_SSH_COMMAND = savedSshEnv;
    for (const d of dirs.splice(0)) fs.rmSync(d, { force: true, recursive: true });
  });

  // The developer's own env must not shadow the repo's config during the test. DELETED, not blanked:
  // an empty GIT_SSH_COMMAND is still SET, and the child would inherit it through `...process.env`.
  function withNoSshEnv(): void {
    delete process.env.GIT_SSH_COMMAND;
  }

  it('lets a WRAPPER core.sshCommand run — we set no GIT_SSH_COMMAND to override it', () => {
    withNoSshEnv();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-gitexec-'));
    dirs.push(dir);
    const marker = path.join(dir, 'CONFIG_RAN');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'core.sshCommand', `touch ${marker}`], { cwd: dir });

    // Fails (the "ssh" is a `touch`), but only AFTER git invoked it — which is the whole point.
    execGit()(['ls-remote', 'ssh://example.invalid/r.git'], { cwd: dir });

    expect(fs.existsSync(marker), 'git ran the user`s core.sshCommand').toBe(true);
  });

  // A plain `ssh` IS extendable, so we inline the user's command and append BatchMode — their
  // `-i <key>` survives, and ssh still fails fast instead of prompting on /dev/tty.
  it('extends a PLAIN ssh core.sshCommand rather than replacing it (keeps the user`s key)', () => {
    withNoSshEnv();
    expect(nonInteractiveSshCommand('ssh -i ~/.ssh/id_work')).toBe(
      'ssh -i ~/.ssh/id_work -o BatchMode=yes'
    );
  });

  it('an explicit GIT_SSH_COMMAND env still wins over core.sshCommand, as git itself decides', () => {
    vi.stubEnv('GIT_SSH_COMMAND', 'ssh -F /env/config');
    expect(nonInteractiveSshCommand(process.env.GIT_SSH_COMMAND)).toBe(
      'ssh -F /env/config -o BatchMode=yes'
    );
  });
});
