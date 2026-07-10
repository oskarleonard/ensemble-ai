import { execFileSync } from 'node:child_process';

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
const NON_INTERACTIVE = {
  GIT_ASKPASS: '',
  GIT_TERMINAL_PROMPT: '0',
  SSH_ASKPASS: '',
};

// A cold `fetch` of a large repo's PR head is genuinely slow, so the bound is generous — but it IS
// bounded: an unbounded git call would wedge the run exactly the way the reviewer watchdog exists
// to prevent. `ls-tree -r` of a big tree is the biggest reply, hence the 64 MB buffer.
const GIT_TIMEOUT_MS = 600_000;
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

export function execGit(): GitRun {
  return (args, opts) => {
    try {
      const text = execFileSync('git', args, {
        cwd: opts?.cwd,
        encoding: 'utf8',
        env: { ...process.env, ...NON_INTERACTIVE, ...(opts?.env ?? {}) },
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
