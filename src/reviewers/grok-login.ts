import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runReviewerExec } from '../core/spawn';

// THE GROK LOGIN PRE-FLIGHT — a sandboxed grok seat must never START with a login grok itself says
// is missing, and the login it starts with gets grok's own refresh first.
//
// THE CONTRACT — the declared threat model this module is built and reviewed against:
//   · It may REFUSE a seat only when two runs that exited 0 both report grok's not-authenticated line.
//   · Every other outcome PROCEEDS, and its warning is RECORDED in the seat's result (ensureGrokLogin
//     returns it; runGrokReview prepends it to the seat's stderrTail).
//   · It never adds more than the seat's own time budget allows: both runs spend from the seat's one
//     deadline, and the seat spawns with only what is left. (A run cut at its cap settles after the
//     shared spawn's kill grace — the same grace the seat's own backstop carries, not pre-flight time.)
//   · Anything outside that contract is out of scope.
//
// Lived 2026-10-01: grok's OAuth access token lives 6 h. Under `--sandbox ensemble-review` the CLI
// cannot refresh it — its credential files and their lock are kernel-unwritable there, so its unified
// log reads `auth lock: … Operation not permitted` → `auth 401` → `auth recovery: credential-less
// 401, parking on uncharged resubmit`, repeating. The seat never fails; it parks until a backstop
// cuts it, and every minute of that is a minute a consumer's alternate seat could have been running.
//
// So before EVERY sandboxed seat, grok runs once OUTSIDE the sandbox: `grok --sandbox off models`
// (a catalog listing, no inference turn). Two things make it the refresh the seat needs:
//   · it runs unsandboxed — the explicit `--sandbox off` overrides a default profile from grok's
//     own config as well as an inherited GROK_SANDBOX, which is also stripped from the child env;
//   · grok refreshes only inside its "early invalidation" window, GROK_AUTH_EARLY_INVALIDATION_SECS
//     (documented in the CLI, default 300 s). This one run widens it to what is left of the seat's
//     budget plus the margin, so a login that would expire during the seat is renewed now. Proved
//     live 2026-10-01: `auth.refresh.success`, `expires_at` +6 h, no inference turn.
//
// What decides the seat is grok's OWN first stdout line from a run that EXITED 0 — a run that exits
// nonzero, hangs or never starts does not decide, whatever it printed. grok 1.0.44's authenticated
// lines: "You are logged in with <provider>." · "You are authenticated via deployment key." ·
// "You are authenticated via XAI_API_KEY (environment variable)." · "You are using XAI_API_KEY.";
// the other is "You are not authenticated." Only that last line can refuse the seat, and only once
// CONFIRMED: a proactive refresh that fails — two pre-flights racing grok's refresh single-flight,
// an auth-server blip — also prints it while the cached session is still valid. So it is re-asked
// once with GROK_AUTH_EARLY_INVALIDATION_SECS=0, which grok's docs define as "Disable the proactive
// buffer: refresh at expiry or on a 401": the confirm run reads the cached session and does not
// retry the proactive refresh, so it cannot re-enter the race that failed (checked live 2026-10-01:
// window 0 → logged in, exit 0, no `auth.refresh.*` event). The one case it still refreshes is a
// token already past its expiry — there the cached session is unusable anyway. A confirm run that
// reads authenticated proceeds with a warning that the widened refresh failed. Anything else —
// either run failing, hanging, exiting nonzero or printing an unknown line — PROCEEDS with a warning
// quoting its exit code and stderr tail: the seat's backstop owns that case, as it always did.
//
// What this module never does: read grok's private credential files (ruling 92adf3b2 — grok, not
// us, owns its login state), widen the review sandbox, or implement an OAuth refresh itself.

// Slack between "grok refreshed the login" and "the seat's backstop could cut it": the spawn, the
// egress proxy, a clock that drifts. Five minutes is grok's own default early-invalidation window.
export const GROK_LOGIN_MARGIN_MS = 300_000;

// `grok models` is a catalog listing — seconds of work, a refresh included. A minute bounds a hung
// one — or less, when less of the seat's budget is left; it is killed and the seat proceeds.
const GROK_LOGIN_REFRESH_TIMEOUT_MS = 60_000;

// The stderr kept from a models run and quoted in a warning — its tail, so the last error shows.
const GROK_MODELS_STDERR_LIMIT = 500;

// grok's status lines — the first line `grok models` prints. The two prefixes are completed by grok
// ("…with grok.com.", "…via deployment key.", "…via XAI_API_KEY (environment variable)."); every
// line they start is an authenticated session.
export const GROK_STATUS_LOGGED_IN_PREFIX = 'You are logged in with ';
export const GROK_STATUS_AUTHENTICATED_VIA_PREFIX = 'You are authenticated via ';
export const GROK_STATUS_API_KEY = 'You are using XAI_API_KEY.';
export const GROK_STATUS_NOT_AUTHENTICATED = 'You are not authenticated.';

// The one seat failure a re-spawn of the same seat cannot fix. Consumers key on this prefix (see
// isGrokLoginExpiryFailure) to hand the chair to its alternate at once, the way
// USAGE_LIMIT_FAIL_PREFIX marks a closed subscription window.
export const GROK_LOGIN_EXPIRY_FAIL_PREFIX = 'grok login expires before this review can finish';

export function isGrokLoginExpiryFailure(failWhy: string | undefined): boolean {
  return failWhy?.startsWith(GROK_LOGIN_EXPIRY_FAIL_PREFIX) ?? false;
}

export class GrokLoginExpiryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrokLoginExpiryError';
  }
}

export interface GrokModelsRun {
  args: string[];
  bin: string;
  cwd: string;
  // Merged over the parent env; an `undefined` value removes an inherited variable.
  env: Record<string, string | undefined>;
  // The seat's cancel handle: a cancel during the pre-flight kills this run's child too.
  onSpawn?: (kill: () => void) => void;
  timeoutMs: number;
}

export interface GrokModelsResult {
  // null when a signal ended the run (the watchdog's kill) or it never reported one.
  exitCode: number | null;
  stderrTail: string;
  stdout: string | null;
  timedOut: boolean;
}

export type GrokModelsRunner = (run: GrokModelsRun) => Promise<GrokModelsResult>;

// The real `grok models`: the shared watchdog'd, group-killed spawn, its stdout returned.
async function runGrokModels(run: GrokModelsRun): Promise<GrokModelsResult> {
  const { error, exitCode, raw, stderrTail, timedOut } = await runReviewerExec({
    ...run,
    capture: 'stdout',
    stderrLimit: GROK_MODELS_STDERR_LIMIT,
  });
  // A binary that could not be spawned never ran — surface that, never read it as a run that
  // printed nothing.
  if (error) throw error;
  return { exitCode: exitCode ?? null, stderrTail, stdout: raw, timedOut };
}

export interface EnsureGrokLoginOpts {
  // The SAME resolved grok binary the seat will spawn — its refresh is the one that counts.
  bin: string;
  // When the seat's time budget ends (epoch ms) — the ONE deadline both models runs spend from, and
  // the seat after them. The refresh window covers what is left of it.
  deadlineAt: number;
  marginMs?: number;
  // The seat's cancel handle, handed each models run's kill.
  onSpawn?: (kill: () => void) => void;
  runModels?: GrokModelsRunner;
  warn?: (message: string) => void;
}

// A warning as one stderr line — the live notice and the line a seat's stderrTail records.
export function grokLoginWarningLine(message: string): string {
  return `⚠ ensemble-ai grok pre-flight: ${message}\n`;
}

function warnToStderr(message: string): void {
  process.stderr.write(grokLoginWarningLine(message));
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// One models run: its result and the cap it ran under, or the error it failed with (a spawn that
// never started, or no budget left to start it).
type ModelsRun = (GrokModelsResult & { timeoutMs: number }) | { failed: string };

// The first non-empty stdout line, trimmed — what the run printed, decisive or not.
function firstLine(run: GrokModelsResult): string | undefined {
  return run.stdout?.split('\n').find((line) => line.trim())?.trim();
}

// grok's status line — ONLY from a run that exited 0. A run that failed, hung or exited nonzero is
// not an answer, whatever it printed: it can neither pass, confirm nor refuse the seat.
function statusOf(run: ModelsRun): string | undefined {
  if ('failed' in run || run.timedOut || run.exitCode !== 0) return undefined;
  return firstLine(run);
}

// What a run did, for a warning: why its line does not decide, then its exit code and stderr tail.
function describeRun(run: ModelsRun): string {
  if ('failed' in run) return `failed (${run.failed}) — the run never started`;
  const line = firstLine(run);
  const what = run.timedOut
    ? `did not finish within ${run.timeoutMs / 1000} s`
    : line
      ? `printed "${line.slice(0, 200)}"`
      : 'printed no status line';
  const stderr = run.stderrTail.slice(-GROK_MODELS_STDERR_LIMIT).replace(/\s+/g, ' ').trim();
  return `${what} (exit code ${run.exitCode ?? 'none'}; stderr ${stderr ? `"${stderr}"` : 'empty'})`;
}

function isAuthenticated(status: string | undefined): boolean {
  return (
    status !== undefined &&
    (status === GROK_STATUS_API_KEY ||
      status.startsWith(GROK_STATUS_LOGGED_IN_PREFIX) ||
      status.startsWith(GROK_STATUS_AUTHENTICATED_VIA_PREFIX))
  );
}

// Run grok's own refresh outside the sandbox, sized to the seat, then read grok's status line.
// Resolves — with the warnings it raised, each also announced through `warn` — when the seat may
// spawn; throws GrokLoginExpiryError, whose message starts with GROK_LOGIN_EXPIRY_FAIL_PREFIX, only
// when two runs that exited 0 both say grok is not authenticated.
export async function ensureGrokLogin(opts: EnsureGrokLoginOpts): Promise<string[]> {
  const warn = opts.warn ?? warnToStderr;
  const proceed = 'the seat proceeds; its backstop owns a login that cannot last';
  const warned = (message: string): string[] => {
    warn(message);
    return [message];
  };

  // A fresh temp cwd: `grok models` must not pick up a project's `.grok/` config from wherever the
  // consumer happens to run. Failing to make one is not a reason to fail the seat.
  let cwd: string;
  try {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-login-'));
  } catch (e) {
    return warned(`could not create a temp cwd for \`grok models\` (${errorText(e)}) — ${proceed}`);
  }
  try {
    const warning = await decide(opts, cwd, proceed);
    return warning ? warned(warning) : [];
  } finally {
    try {
      fs.rmSync(cwd, { force: true, recursive: true });
    } catch {
      // throwaway dir — best-effort cleanup; it never decides the seat
    }
  }
}

// The decision: undefined when the seat proceeds silently, a warning when it proceeds with one.
async function decide(opts: EnsureGrokLoginOpts, cwd: string, proceed: string): Promise<string | undefined> {
  const runModels = opts.runModels ?? runGrokModels;
  const remainingMs = () => opts.deadlineAt - Date.now();
  const models = async (env: Record<string, string | undefined>): Promise<ModelsRun> => {
    // Each run is capped by what is left of the seat's budget, never only by its own minute.
    const timeoutMs = Math.min(GROK_LOGIN_REFRESH_TIMEOUT_MS, remainingMs());
    if (timeoutMs <= 0) return { failed: "the seat's time budget is spent" };
    try {
      const run = await runModels({
        args: ['--sandbox', 'off', 'models'],
        bin: opts.bin,
        cwd,
        env,
        ...(opts.onSpawn ? { onSpawn: opts.onSpawn } : {}),
        timeoutMs,
      });
      return { ...run, timeoutMs };
    } catch (e) {
      return { failed: errorText(e) };
    }
  };

  const windowSecs = Math.ceil((remainingMs() + (opts.marginMs ?? GROK_LOGIN_MARGIN_MS)) / 1000);
  const refresh = await models({ GROK_AUTH_EARLY_INVALIDATION_SECS: String(windowSecs), GROK_SANDBOX: undefined });
  const status = statusOf(refresh);
  if (isAuthenticated(status)) return undefined;
  if (status !== GROK_STATUS_NOT_AUTHENTICATED) return `\`grok models\` ${describeRun(refresh)} — ${proceed}`;

  // The confirm run: window 0 — grok refreshes only at expiry or on a 401, so it reads the cached
  // session instead of retrying the proactive refresh that just failed.
  const confirm = await models({ GROK_AUTH_EARLY_INVALIDATION_SECS: '0', GROK_SANDBOX: undefined });
  const confirmed = statusOf(confirm);
  if (confirmed === GROK_STATUS_NOT_AUTHENTICATED) {
    throw new GrokLoginExpiryError(
      `${GROK_LOGIN_EXPIRY_FAIL_PREFIX}: grok reports "${confirmed}" — run \`grok\` once to sign in, then re-run the review.`
    );
  }
  const refreshed = `the refresh run (window ${windowSecs} s) ${describeRun(refresh)}`;
  return isAuthenticated(confirmed)
    ? `the widened login refresh failed — ${refreshed}, but grok's cached login is still valid; the confirm run ${describeRun(confirm)}. The seat proceeds; the login may expire during it.`
    : `${refreshed}; the confirm run ${describeRun(confirm)} — ${proceed}`;
}
