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
  /**
   * The spawn cwd. Defaults to a throwaway `os.tmpdir()` — the packet path, where a read tool has
   * nothing of the repo to reach. A WORKTREE seat passes the detached read-only worktree here:
   * for a harness-controlled CLI (claude), the cwd IS what grants whole-project read access. It is
   * BORROWED, never owned — one worktree per run, shared by every seat, reaped by the run.
   */
  cwd?: string;
  /**
   * Extra env for the child, merged OVER `process.env`. A fenced seat passes the egress proxy's
   * `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` (+ an empty `NO_PROXY`) here — merging over the parent
   * env is what lets `NO_PROXY: ''` OVERRIDE an operator's inherited `NO_PROXY=*`, which would
   * otherwise let the seat bypass the proxy for exactly the hosts it most wants to reach.
   */
  env?: Record<string, string>;
  /** Receives the kill handle so a caller (e.g. a cancel) can abort the child. */
  onSpawn?: (kill: () => void) => void;
  /** The -o tempfile the reply is read from, then unlinked. Required for 'outfile'. */
  outFile?: string;
  /**
   * LIVENESS watchdog (only while stdout is piped — `capture: 'stdout'` or `streamStdout`):
   * kill the group after this long with NO data on stdout/stderr. A streaming CLI (claude
   * `--output-format stream-json`, codex `--json`) emits an event every few seconds while it
   * works, so silence this long means a wedged seat — while honest long work never trips it.
   * This is the watchdog doing its actual job (reclaim wedges, never police honest work);
   * `timeoutMs` then degrades to a pure runaway backstop. Ignored when stdout is not piped:
   * an outfile-only seat is silent by construction, and arming it there would reclaim
   * every honest run.
   */
  inactivityTimeoutMs?: number;
  /** Cap the retained stderr tail (a noise channel) at this many chars. */
  stderrLimit: number;
  /** Cap the retained stream tail (see `streamStdout`) at this many chars. */
  streamLimit?: number;
  /**
   * Pipe stdout for LIVENESS while the reply still comes from the `-o` file. For a CLI that
   * emits a machine-readable progress stream beside its final-message file (codex `--json` +
   * `-o`): every event resets the inactivity watchdog, and a bounded tail of the stream comes
   * back as `streamTail`, so a seat the watchdog reclaims leaves a record of what it was doing
   * instead of only "it timed out". Meaningless under `capture: 'stdout'`, where stdout is the
   * reply and already drives liveness.
   */
  streamStdout?: boolean;
  /** Watchdog timeout; on expiry the whole process GROUP is SIGTERM→SIGKILLed. */
  timeoutMs: number;
}

// The retained stream tail is a diagnostic, not the reply: big enough to show the last stretch
// of tool calls and reasoning before a kill, bounded so a chatty hour-long seat cannot grow the
// parent's heap without limit.
const STREAM_TAIL_LIMIT = 1_000_000;

export interface ReviewerExecResult {
  /** The reply (the -o file, or accumulated stdout) — or null if none produced. */
  raw: string | null;
  stderrTail: string;
  /** The bounded tail of the progress stream (`streamStdout` only). */
  streamTail?: string;
  timedOut: boolean;
  /** Which watchdog fired: the absolute backstop or the liveness (inactivity) one. */
  timedOutReason?: 'absolute' | 'inactivity';
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
// VENDOR-NEUTRAL: codex reads its reply from an `-o` tempfile (its stdout, when
// piped at all, is a progress stream for liveness); grok prints its reply to
// STDOUT and has no outfile. `capture` flips that one axis — everything else (the
// detached group, the escalating group-kill, the settle-on-exit + absolute
// backstop) is shared so the two paths can't drift.
export function runReviewerExec(
  opts: ReviewerExecOpts
): Promise<ReviewerExecResult> {
  const { bin, args, outFile, timeoutMs, stderrLimit, onSpawn } = opts;
  const capture = opts.capture ?? 'outfile';
  const streamStdout = capture !== 'stdout' && opts.streamStdout === true;
  const pipeStdout = capture === 'stdout' || streamStdout;
  const streamLimit = opts.streamLimit ?? STREAM_TAIL_LIMIT;
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: opts.cwd ?? os.tmpdir(),
      detached: true,
      ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}),
      // stdout is piped when we read the reply from it (grok) or stream it for
      // liveness (codex `--json`); an outfile-only seat keeps it 'ignore'.
      stdio: ['ignore', pipeStdout ? 'pipe' : 'ignore', 'pipe'],
    });
    const killer = makeEscalatingKill(
      { kill: (sig) => killTree(child, sig) },
      KILL_GRACE_MS
    );
    onSpawn?.(killer.kill);
    let timedOut = false;
    let timedOutReason: 'absolute' | 'inactivity' | undefined;
    const killTimer = setTimeout(() => {
      timedOut = true;
      timedOutReason = 'absolute';
      killer.kill();
    }, timeoutMs);
    // The liveness watchdog: a rolling timer reset by every stdout/stderr chunk.
    // Only armed when the caller opted in (a streaming CLI); expiry means the seat
    // went silent — wedged — and is reclaimed just like an absolute timeout.
    const inactivityMs = opts.inactivityTimeoutMs;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = () => {
      if (!inactivityMs || !pipeStdout) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        timedOutReason = 'inactivity';
        killer.kill();
      }, inactivityMs);
    };
    armIdle();
    let stderrTail = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      armIdle();
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-stderrLimit);
    });
    let stdoutBuf = '';
    let streamTail = '';
    if (capture === 'stdout') {
      child.stdout?.on('data', (chunk: Buffer) => {
        armIdle();
        stdoutBuf += chunk.toString('utf8');
      });
    } else if (streamStdout) {
      child.stdout?.on('data', (chunk: Buffer) => {
        armIdle();
        streamTail = (streamTail + chunk.toString('utf8')).slice(-streamLimit);
      });
    }
    let settled = false;
    let exitDrain: ReturnType<typeof setTimeout> | null = null;
    const settle = () => {
      if (settled) return; // exit AND close both fire on a clean run — settle once
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(backstop);
      if (idleTimer) clearTimeout(idleTimer);
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
      resolve({
        raw,
        stderrTail,
        ...(streamStdout ? { streamTail } : {}),
        timedOut,
        ...(timedOutReason ? { timedOutReason } : {}),
      });
    };
    const backstop = setTimeout(settle, timeoutMs + KILL_GRACE_MS + 5_000);
    // outfile capture (codex): the reply is the -o file, complete on disk by `exit`
    // — settle immediately. Whenever stdout is piped — the reply IS stdout (grok), or
    // it streams progress (codex `--json`) — Node can fire `exit` before the pipe
    // delivers its last chunk (`close` is the post-drain event), so defer `exit`
    // briefly for `close`/the final data, falling back via EXIT_DRAIN_GRACE_MS if a
    // held-open pipe never closes.
    child.on(
      'exit',
      pipeStdout
        ? () => {
            exitDrain = setTimeout(settle, EXIT_DRAIN_GRACE_MS);
          }
        : settle
    );
    child.on('close', settle);
    child.on('error', settle);
  });
}
