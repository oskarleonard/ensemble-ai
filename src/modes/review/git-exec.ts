import { execFileSync } from 'node:child_process';
import path from 'node:path';

import type { GitRun } from './worktree';

// THE ONE real `git` exec seam for worktree evidence mode. Every state machine over git
// (worktree.ts's pre-flight + materialization, evidence-manifest.ts's tree read) takes a `GitRun`
// so it is unit-tested without a repo; this is the implementation the CLI injects.
//
// It NEVER throws: a failed git RETURNS `{ok:false, error}` carrying git's own stderr, which is
// exactly what `classifyGitError` maps into the pre-flight taxonomy. A throwing runner would turn
// a legible `wrong-repo` / `no-such-pr` into a stack trace.
//
// `GIT_TERMINAL_PROMPT=0` is not optional. A `git fetch` against a repo the user cannot read will
// otherwise BLOCK on a credential prompt — and this runs unattended, before any seat spawns, with
// a 12-minute review waiting behind it. With prompting off git fails immediately and its stderr
// ("could not read Username", "Authentication failed") classifies as `auth`. The same for
// `GIT_ASKPASS`/`SSH_ASKPASS`: an askpass helper would pop a GUI dialog on a desktop Mac.
//
// `GIT_TERMINAL_PROMPT` governs GIT's own prompts — it says nothing to `ssh`. A `git@github.com:`
// remote (what `resolveRepoLocation` hands back for most checkouts) shells out to ssh, which
// prompts for a key passphrase on `/dev/tty` all by itself; the run would then wedge until the
// GIT_TIMEOUT_MS backstop fires, minutes later, for what is really an auth failure. `BatchMode=yes`
// makes ssh fail immediately instead, and its stderr ("Permission denied (publickey)") classifies
// as `auth` like every other credential failure.
//
// We only ever extend a PLAIN `ssh` invocation. git runs GIT_SSH_COMMAND through `sh -c`, so a
// user whose value is a wrapper script or an alternate binary (a VPN helper, a custom agent) would
// receive `-o BatchMode=yes` as ITS argv — which it may reject outright, turning a hypothetical
// passphrase prompt into a guaranteed failed fetch. Their command is theirs; leave it exactly as
// they set it, and accept that they own the interactivity of their own tooling.
export function nonInteractiveSshCommand(configured = process.env.GIT_SSH_COMMAND): string | null {
  const cmd = configured?.trim();
  if (!cmd) return 'ssh -o BatchMode=yes';
  const bin = path.basename(cmd.split(/\s+/)[0]);
  return bin === 'ssh' ? `${cmd} -o BatchMode=yes` : null;
}

// `git config core.sshCommand` is the OTHER channel a user configures ssh through, and it is the
// one a multi-key checkout normally uses (`core.sshCommand = ssh -i ~/.ssh/id_work`). Setting
// GIT_SSH_COMMAND SILENTLY OVERRIDES it — verified against real git (2026-07-10): with both set,
// only the env value runs. So injecting our default would drop that `-i <key>`, and a fetch that
// works by hand would fail `Permission denied (publickey)` and classify as `auth`. Read the
// effective value for this cwd and hand it to `nonInteractiveSshCommand` exactly like the env form,
// so a plain `ssh` is extended and a wrapper is left alone.
//
// Memoized per cwd: `execGit()` is reused across the whole pre-flight and once per changed file by
// the history packet — one `git config` probe per directory, not one per git command.
function effectiveSshCommand(cwd: string | undefined, cache: Map<string, string | undefined>): string | undefined {
  const key = cwd ?? '';
  if (cache.has(key)) return cache.get(key);
  let value = process.env.GIT_SSH_COMMAND?.trim() || undefined;
  if (!value) {
    try {
      value =
        execFileSync('git', ['config', '--get', 'core.sshCommand'], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim() || undefined;
    } catch {
      value = undefined; // `git config --get` exits 1 when the key is unset — nothing configured.
    }
  }
  cache.set(key, value);
  return value;
}

function nonInteractiveEnv(configuredSsh: string | undefined): Record<string, string> {
  const ssh = nonInteractiveSshCommand(configuredSsh);
  return {
    GIT_ASKPASS: '',
    GIT_TERMINAL_PROMPT: '0',
    SSH_ASKPASS: '',
    // Absent ⇒ git resolves ssh itself, from the user's own GIT_SSH_COMMAND or core.sshCommand.
    ...(ssh ? { GIT_SSH_COMMAND: ssh } : {}),
  };
}

// A cold `fetch` of a large repo's PR head is genuinely slow, so the bound is generous — but it IS
// bounded: an unbounded git call would wedge the run exactly the way the reviewer watchdog exists
// to prevent. `ls-tree -r` of a big tree is the biggest reply, hence the 64 MB buffer.
const GIT_TIMEOUT_MS = 600_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export function execGit(): GitRun {
  const sshByCwd = new Map<string, string | undefined>();
  return (args, opts) => {
    try {
      const text = execFileSync('git', args, {
        cwd: opts?.cwd,
        encoding: 'utf8',
        env: {
          ...process.env,
          ...nonInteractiveEnv(effectiveSshCommand(opts?.cwd, sshByCwd)),
          ...(opts?.env ?? {}),
        },
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
      });
      return { ok: true, text };
    } catch (e) {
      const err = e as { message?: string; stderr?: Buffer | string };
      const stderr = err.stderr ? String(err.stderr).trim() : '';
      return { error: stderr || err.message || 'git failed', ok: false };
    }
  };
}
