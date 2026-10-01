import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runReviewerExec } from '../core/spawn';

// THE GROK LOGIN PRE-FLIGHT — a sandboxed grok seat must never START with a login grok itself says
// is missing, and the login it starts with gets grok's own refresh first.
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
//     (documented in the CLI, default 300 s). This one run widens it to the seat's deadline plus the
//     margin, so a login that would expire during the seat is renewed now. Proved live 2026-10-01:
//     `auth.refresh.success`, `expires_at` +6 h, no inference turn.
//
// What decides the seat is grok's OWN first stdout line from that run (1.0.44, all exit 0):
//   "You are logged in with grok.com." · "You are using XAI_API_KEY." · "You are not authenticated."
// Only the last can refuse the seat, and only once CONFIRMED: a proactive refresh that fails — two
// pre-flights racing grok's refresh single-flight, an auth-server blip — also prints it while the
// cached session is still valid. So a not-authenticated line is re-asked once with grok's default
// window (GROK_AUTH_EARLY_INVALIDATION_SECS removed, so the widened refresh is not retried), and the
// seat is refused only if that run says it too. A confirm run that reads logged in proceeds with a
// warning that the widened refresh failed. A run that fails, hangs, or prints anything else PROCEEDS with a warning
// quoting its exit code and stderr tail: the seat's backstop owns that case, as it always did —
// failing every seat on a line we cannot read would trade one outage for another.
//
// What this module never does: read grok's private credential files (ruling 92adf3b2 — grok, not
// us, owns its login state), widen the review sandbox, or implement an OAuth refresh itself.

// Slack between "grok refreshed the login" and "the seat's backstop could cut it": the spawn, the
// egress proxy, a clock that drifts. Five minutes is grok's own default early-invalidation window.
export const GROK_LOGIN_MARGIN_MS = 300_000;

// `grok models` is a catalog listing — seconds of work, a refresh included. A minute bounds a hung
// one; it is killed and the seat proceeds on the backstop.
const GROK_LOGIN_REFRESH_TIMEOUT_MS = 60_000;

// The stderr kept from a models run and quoted in a warning — its tail, so the last error shows.
const GROK_MODELS_STDERR_LIMIT = 500;

// grok's status lines, verbatim — the first line `grok models` prints.
export const GROK_STATUS_LOGGED_IN = 'You are logged in with grok.com.';
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
  // How long the seat may run from now: its effective absolute timeout.
  deadlineMs: number;
  marginMs?: number;
  runModels?: GrokModelsRunner;
  warn?: (message: string) => void;
}

function warnToStderr(message: string): void {
  process.stderr.write(`⚠ ensemble-ai grok pre-flight: ${message}\n`);
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// One models run: its result, or the error it failed with (a spawn that never started).
type ModelsRun = GrokModelsResult | { failed: string };

// grok's status line — undefined for a run that failed or hung, whose output is not an answer.
function statusOf(run: ModelsRun): string | undefined {
  if ('failed' in run || run.timedOut) return undefined;
  return run.stdout?.split('\n').find((line) => line.trim())?.trim();
}

// What a run did, for a warning: why its line does not decide, then its exit code and stderr tail.
function describeRun(run: ModelsRun): string {
  if ('failed' in run) return `failed (${run.failed}) — the run never started`;
  const status = statusOf(run);
  const what = run.timedOut
    ? `did not finish within ${GROK_LOGIN_REFRESH_TIMEOUT_MS / 1000} s`
    : status
      ? `printed "${status.slice(0, 200)}"`
      : 'printed no status line';
  const stderr = run.stderrTail.slice(-GROK_MODELS_STDERR_LIMIT).replace(/\s+/g, ' ').trim();
  return `${what} (exit code ${run.exitCode ?? 'none'}; stderr ${stderr ? `"${stderr}"` : 'empty'})`;
}

function isLoggedIn(status: string | undefined): boolean {
  return status === GROK_STATUS_LOGGED_IN || status === GROK_STATUS_API_KEY;
}

// Run grok's own refresh outside the sandbox, sized to the seat, then read grok's status line.
// Resolves when the seat may spawn; throws GrokLoginExpiryError — whose message starts with
// GROK_LOGIN_EXPIRY_FAIL_PREFIX — only when grok says it is not authenticated, twice.
export async function ensureGrokLogin(opts: EnsureGrokLoginOpts): Promise<void> {
  const warn = opts.warn ?? warnToStderr;
  const proceed = 'the seat proceeds; its backstop owns a login that cannot last';

  // A fresh temp cwd: `grok models` must not pick up a project's `.grok/` config from wherever the
  // consumer happens to run. Failing to make one is not a reason to fail the seat.
  let cwd: string;
  try {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-login-'));
  } catch (e) {
    warn(`could not create a temp cwd for \`grok models\` (${errorText(e)}) — ${proceed}`);
    return;
  }
  try {
    await decide(opts, cwd, warn, proceed);
  } finally {
    try {
      fs.rmSync(cwd, { force: true, recursive: true });
    } catch {
      // throwaway dir — best-effort cleanup; it never decides the seat
    }
  }
}

async function decide(
  opts: EnsureGrokLoginOpts,
  cwd: string,
  warn: (message: string) => void,
  proceed: string
): Promise<void> {
  const runModels = opts.runModels ?? runGrokModels;
  const models = async (env: Record<string, string | undefined>): Promise<ModelsRun> => {
    try {
      return await runModels({
        args: ['--sandbox', 'off', 'models'],
        bin: opts.bin,
        cwd,
        env,
        timeoutMs: GROK_LOGIN_REFRESH_TIMEOUT_MS,
      });
    } catch (e) {
      return { failed: errorText(e) };
    }
  };

  const windowSecs = Math.ceil((opts.deadlineMs + (opts.marginMs ?? GROK_LOGIN_MARGIN_MS)) / 1000);
  const refresh = await models({ GROK_AUTH_EARLY_INVALIDATION_SECS: String(windowSecs), GROK_SANDBOX: undefined });
  const status = statusOf(refresh);
  if (isLoggedIn(status)) return;
  if (status !== GROK_STATUS_NOT_AUTHENTICATED) {
    warn(`\`grok models\` ${describeRun(refresh)} — ${proceed}`);
    return;
  }

  // The confirm run: grok's default window, so it reads the cached session instead of retrying the
  // widened refresh that just failed.
  const confirm = await models({ GROK_AUTH_EARLY_INVALIDATION_SECS: undefined, GROK_SANDBOX: undefined });
  const confirmed = statusOf(confirm);
  if (confirmed === GROK_STATUS_NOT_AUTHENTICATED) {
    throw new GrokLoginExpiryError(
      `${GROK_LOGIN_EXPIRY_FAIL_PREFIX}: grok reports "${confirmed}" — run \`grok\` once to sign in, then re-run the review.`
    );
  }
  const refreshed = `the refresh run (window ${windowSecs} s) ${describeRun(refresh)}`;
  warn(
    isLoggedIn(confirmed)
      ? `the widened login refresh failed — ${refreshed}, but grok's cached login is still valid; the confirm run ${describeRun(confirm)}. The seat proceeds; the login may expire during it.`
      : `${refreshed}; the confirm run ${describeRun(confirm)} — ${proceed}`
  );
}
