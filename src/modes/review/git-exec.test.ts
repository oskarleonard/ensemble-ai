import { describe, expect, it } from 'vitest';

import { nonInteractiveSshCommand } from './git-exec';

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
