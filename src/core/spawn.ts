import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

import { resolveBin } from './bin';

// Env override, then the login shell's PATH (codex lives in the nvm bin).
export function resolveCodexBin(): string {
  return resolveBin('codex', { envVar: 'CODEX_BIN' });
}

// After a SIGTERM, a process that ignores it gets a SIGKILL this long later.
const KILL_GRACE_MS = 3_000;
// stdout-capture only: how long `exit` waits for `close`/the final stdout chunk
// before settling anyway. `close` (post-stdio-drain) cancels it instantly, so a
// clean run pays ZERO extra latency; this only bounds the rare held-pipe case so a
// large reply isn't truncated by an early `exit`, nor hangs to backstop.
const EXIT_DRAIN_GRACE_MS = 250;

// SIGTERM, then SIGKILL after a grace period if the child still hasn't exited.
// Without escalation a wedged reviewer would ignore the lone SIGTERM and never
// die. The signal it escalates must hit the whole process GROUP (the caller passes
// a group-aware kill — see killTree): a reviewer CLI boots an rmcp transport +
// node subprocesses, and signalling only the direct parent ORPHANS them. That
// matters because the orphan can keep the inherited stderr pipe open, so the
// child's `close` event never fires (lived: a 40-min 0%-CPU wedge) — which is why
// the callers also settle on `exit` and arm an absolute backstop, not trust
// `close`. Returns `clear()` to drop the pending SIGKILL once the child settles.
// `schedule`/`cancel` are injectable so the escalation is unit-testable.
export function makeEscalatingKill(
  child: { kill: (signal: NodeJS.Signals) => void },
  graceMs: number,
  schedule: (
    fn: () => void,
    ms: number
  ) => ReturnType<typeof setTimeout> = setTimeout,
  cancel: (t: ReturnType<typeof setTimeout>) => void = clearTimeout
): { clear: () => void; kill: () => void } {
  let hard: ReturnType<typeof setTimeout> | null = null;
  return {
    clear: () => {
      if (hard) cancel(hard);
      hard = null;
    },
    kill: () => {
      child.kill('SIGTERM');
      if (!hard) hard = schedule(() => child.kill('SIGKILL'), graceMs);
    },
  };
}

// Signal the child's whole process GROUP, not just the direct child. A reviewer
// CLI is a node process that boots an rmcp transport + node subprocesses; a child
// spawned `detached` becomes its own group leader, so a NEGATIVE-pid signal reaps
// the entire tree at once. Without this, signalling only the parent leaves the
// rmcp grandchild alive holding the inherited stderr pipe — and `close` never
// fires. `signalGroup` is injectable for tests; falls back to a direct
// `child.kill` when there's no pid (a mock child) or the group is already gone
// (ESRCH).
export function killTree(
  child: { kill: (signal: NodeJS.Signals) => void; pid?: number },
  signal: NodeJS.Signals,
  signalGroup: (pid: number, signal: NodeJS.Signals) => void = (pid, sig) =>
    process.kill(-pid, sig)
): void {
  const pid = child.pid;
  if (typeof pid === 'number' && pid > 0) {
    try {
      signalGroup(pid, signal);
      return;
    } catch {
      // group already exited (ESRCH) or platform can't — fall through to direct
    }
  }
  try {
    child.kill(signal);
  } catch {
    // child already dead — nothing left to signal
  }
}

export interface ReviewerExecOpts {
  /** The full CLI arg list — the caller encodes the call contract here. */
  args: string[];
  /** Resolved binary path. The CALLER resolves it (so tests can stub it). */
  bin: string;
  /**
   * Where the reply is read from. `'outfile'` (codex): the reply lands in the
   * `-o` tempfile and stdout is ignored. `'stdout'` (grok): the reply IS stdout
   * (grok `-p --output-format json` prints the envelope and exits — there is no
   * `-o` file). Defaults to `'outfile'` for the proven Codex path.
   */
  capture?: 'outfile' | 'stdout';
  /** Receives the kill handle so a caller (e.g. a cancel) can abort the child. */
  onSpawn?: (kill: () => void) => void;
  /** The -o tempfile the reply is read from, then unlinked. Required for 'outfile'. */
  outFile?: string;
  /** Cap the retained stderr tail (a noise channel) at this many chars. */
  stderrLimit: number;
  /** Watchdog timeout; on expiry the whole process GROUP is SIGTERM→SIGKILLed. */
  timeoutMs: number;
}

export interface ReviewerExecResult {
  /** The reply (the -o file, or accumulated stdout) — or null if none produced. */
  raw: string | null;
  stderrTail: string;
  timedOut: boolean;
}

// The shared reviewer spawn contract, owned in ONE place and CALLED (not copied)
// by every vendor adapter, so the two can't drift. Preflighted live and
// load-bearing in every detail:
// - `detached`: the reviewer becomes its own process-group leader, so the
//   group-aware watchdog (makeEscalatingKill + killTree) reaps its rmcp subprocess
//   tree instead of orphaning it — an orphan keeps the inherited stderr pipe open.
// - settles on `exit` (process death), NOT only `close` (stdio EOF), which that
//   orphan can hold open forever; plus an absolute backstop, so even if NEITHER
//   event fires the promise still resolves (lived: a 40-min 0%-CPU wedge).
// - stdin is 'ignore' (CLOSED): a piped-but-empty stdin makes codex append a
//   <stdin> block to the prompt.
// - the reply comes from the -o file (codex) OR accumulated stdout (grok); for
//   codex stdout is empty and the exit code LIES ("at capacity" exits 0 with no
//   file), so success = a non-empty reply, never the exit code.
//
// VENDOR-NEUTRAL: codex reads its reply from an `-o` tempfile (stdout ignored);
// grok prints its reply to STDOUT and has no outfile. `capture` flips that one
// axis — everything else (the detached group, the escalating group-kill, the
// settle-on-exit + absolute backstop) is shared so the two paths can't drift.
export function runReviewerExec(
  opts: ReviewerExecOpts
): Promise<ReviewerExecResult> {
  const { bin, args, outFile, timeoutMs, stderrLimit, onSpawn } = opts;
  const capture = opts.capture ?? 'outfile';
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: os.tmpdir(),
      detached: true,
      // stdout is piped ONLY when we read the reply from it (grok); codex keeps
      // it 'ignore' (its reply is the -o file) exactly as the proven path did.
      stdio: ['ignore', capture === 'stdout' ? 'pipe' : 'ignore', 'pipe'],
    });
    const killer = makeEscalatingKill(
      { kill: (sig) => killTree(child, sig) },
      KILL_GRACE_MS
    );
    onSpawn?.(killer.kill);
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      killer.kill();
    }, timeoutMs);
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-stderrLimit);
    });
    let stdoutBuf = '';
    if (capture === 'stdout') {
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
      });
    }
    let settled = false;
    let exitDrain: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (settled) return; // exit AND close both fire on a clean run — settle once
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(backstop);
      if (exitDrain) clearTimeout(exitDrain);
      killer.clear();
      let raw: string | null = null;
      if (capture === 'stdout') {
        const text = stdoutBuf.trim();
        if (text) raw = text;
      } else {
        try {
          const text = fs.readFileSync(outFile ?? '', 'utf8').trim();
          if (text) raw = text;
          fs.unlinkSync(outFile ?? '');
        } catch {
          // no -o file → the reviewer produced nothing (capacity / wedge / kill)
        }
      }
      resolve({ raw, stderrTail, timedOut });
    };
    const backstop = setTimeout(settle, timeoutMs + KILL_GRACE_MS + 5_000);
    // outfile capture (codex): the reply is the -o file, complete on disk by `exit`
    // — settle immediately. stdout capture (grok): the reply IS stdout, and Node can
    // fire `exit` before the pipe delivers its last chunk (`close` is the post-drain
    // event) — so defer `exit` briefly for `close`/the final data, falling back via
    // EXIT_DRAIN_GRACE_MS if a held-open pipe never closes.
    child.on(
      'exit',
      capture === 'stdout'
        ? () => {
            exitDrain = setTimeout(settle, EXIT_DRAIN_GRACE_MS);
          }
        : settle
    );
    child.on('close', settle);
    child.on('error', settle);
  });
}
