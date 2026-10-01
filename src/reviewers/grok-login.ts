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
// Only the last refuses the seat. A run that fails, hangs, or prints anything else PROCEEDS with a
// warning: the seat's backstop owns that case, as it always did — failing every seat on a line we
// cannot read would trade one outage for another.
//
// What this module never does: read grok's private credential files (ruling 92adf3b2 — grok, not
// us, owns its login state), widen the review sandbox, or implement an OAuth refresh itself.

// Slack between "grok refreshed the login" and "the seat's backstop could cut it": the spawn, the
// egress proxy, a clock that drifts. Five minutes is grok's own default early-invalidation window.
export const GROK_LOGIN_MARGIN_MS = 300_000;

// `grok models` is a catalog listing — seconds of work, a refresh included. A minute bounds a hung
// one; it is killed and the seat proceeds on the backstop.
const GROK_LOGIN_REFRESH_TIMEOUT_MS = 60_000;

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
  stdout: string | null;
  timedOut: boolean;
}

export type GrokModelsRunner = (run: GrokModelsRun) => Promise<GrokModelsResult>;

// The real `grok models`: the shared watchdog'd, group-killed spawn, its stdout returned.
async function runGrokModels(run: GrokModelsRun): Promise<GrokModelsResult> {
  const { raw, timedOut } = await runReviewerExec({ ...run, capture: 'stdout', stderrLimit: 1_000 });
  return { stdout: raw, timedOut };
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

// Run grok's own refresh outside the sandbox, sized to the seat, then read grok's status line.
// Resolves when the seat may spawn; throws GrokLoginExpiryError — whose message starts with
// GROK_LOGIN_EXPIRY_FAIL_PREFIX — only when grok says it is not authenticated.
export async function ensureGrokLogin(opts: EnsureGrokLoginOpts): Promise<void> {
  const marginMs = opts.marginMs ?? GROK_LOGIN_MARGIN_MS;
  const warn = opts.warn ?? warnToStderr;
  const proceed = 'the seat proceeds; its backstop owns a login that cannot last';

  // A fresh temp cwd: `grok models` must not pick up a project's `.grok/` config from wherever the
  // consumer happens to run.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-login-'));
  let result: GrokModelsResult;
  try {
    result = await (opts.runModels ?? runGrokModels)({
      args: ['--sandbox', 'off', 'models'],
      bin: opts.bin,
      cwd,
      env: {
        GROK_AUTH_EARLY_INVALIDATION_SECS: String(Math.ceil((opts.deadlineMs + marginMs) / 1000)),
        GROK_SANDBOX: undefined,
      },
      timeoutMs: GROK_LOGIN_REFRESH_TIMEOUT_MS,
    });
  } catch (e) {
    warn(`\`grok models\` failed (${e instanceof Error ? e.message : String(e)}) — ${proceed}`);
    return;
  } finally {
    try {
      fs.rmSync(cwd, { force: true, recursive: true });
    } catch {
      // throwaway dir — best-effort cleanup; it never decides the seat
    }
  }

  if (result.timedOut) {
    warn(`\`grok models\` did not finish within ${GROK_LOGIN_REFRESH_TIMEOUT_MS / 1000} s — ${proceed}`);
    return;
  }
  const status = result.stdout?.split('\n').find((line) => line.trim())?.trim();
  if (status === GROK_STATUS_NOT_AUTHENTICATED) {
    throw new GrokLoginExpiryError(
      `${GROK_LOGIN_EXPIRY_FAIL_PREFIX}: grok reports "${status}" — run \`grok\` once to sign in, then re-run the review.`
    );
  }
  if (status === GROK_STATUS_LOGGED_IN || status === GROK_STATUS_API_KEY) return;
  warn(
    status
      ? `\`grok models\` printed an unrecognised status line ("${status.slice(0, 200)}") — ${proceed}`
      : `\`grok models\` printed no status line — ${proceed}`
  );
}
