import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runReviewerExec } from '../core/spawn';

// THE GROK LOGIN PRE-FLIGHT — a sandboxed grok seat must never START with a login that expires
// before it can finish.
//
// Lived 2026-10-01: grok's OAuth access token lives 6 h (an `auth.json` entry's `expires_at` is its
// `create_time` + 6 h). Under `--sandbox ensemble-review` the CLI cannot refresh it — `auth.json`
// and its lock are kernel-unwritable there, so its unified log reads `auth lock: failed to open
// ~/.grok/auth.json.lock: Operation not permitted` → `auth 401` → `auth recovery: credential-less
// 401, parking on uncharged resubmit`, repeating. The seat never fails; it parks until a backstop
// cuts it, and every minute of that is a minute a consumer's alternate seat could have been running.
//
// So the refresh happens OUTSIDE the sandbox, before the seat spawns, and only grok does it: a
// `grok models` run (no `--sandbox`, no inference turn) performs the CLI's own silent refresh. One
// knob makes that refresh reach far enough: grok refreshes only inside its "early invalidation"
// window, `GROK_AUTH_EARLY_INVALIDATION_SECS` (documented in the CLI, default 300 s — observed: a
// refresh fired 4 min before expiry, never earlier). With the default, a token holding 40 min
// could never be renewed for a 60-min seat. The pre-flight widens that window for this ONE
// `models` run to the seat's deadline plus the margin, so grok's own refresh fires exactly when
// the seat needs it.
//
// What this module never does: widen the review sandbox to make grok's credential files writable,
// or implement an OAuth refresh itself. And it reads ONE field of `auth.json` — the file holds
// credentials, so no other field is logged, returned, copied or hashed.

export const GROK_AUTH_FILE = path.join(os.homedir(), '.grok', 'auth.json');

// Slack between "the login is checked" and "the seat's backstop could cut it": the spawn, the
// egress proxy, a clock that drifts. Five minutes is grok's own default early-invalidation window.
export const GROK_LOGIN_MARGIN_MS = 300_000;

// `grok models` is a catalog listing — seconds of work. A minute bounds a hung one; it is killed
// and the re-read decides.
const GROK_LOGIN_REFRESH_TIMEOUT_MS = 60_000;

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

// When the stored logins expire — the earliest and the latest `expires_at` across the file's
// entries (they are keyed by issuer, e.g. `https://auth.x.ai::<id>`) — and nothing else from the file.
//
// Both, because the file is not one login. grok keeps an entry per issuer and can leave a legacy one
// behind, and only the entry it actually uses is the one `grok models` refreshes. So the EARLIEST
// decides whether to run the refresh (any short entry might be the one in use), and the LATEST
// decides whether the seat may pass (a stale entry the refresh never touches must not refuse every
// seat while the live login holds for hours). The trade: an active login that stays short while a
// stale entry outlives the seat passes and degrades to the old backstop hang — never a permanent
// outage.
//
// null means "no expiring login to check", and the pre-flight then PASSES: no file, a file that is
// not JSON, or entries without a parseable string `expires_at` (API-key mode, an expiry-less
// credential, a future grok that renamed the field). The pre-flight exists to stop a login it KNOWS
// is too short; failing every seat on a file it cannot read would trade one outage for another.
export function readGrokLoginExpiry(
  file: string = GROK_AUTH_FILE
): { earliest: Date; latest: Date } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const expiries: number[] = [];
  for (const entry of Object.values(parsed)) {
    if (typeof entry !== 'object' || entry === null) continue;
    const expiresAt: unknown = (entry as { expires_at?: unknown }).expires_at;
    if (typeof expiresAt !== 'string') continue;
    const ms = Date.parse(expiresAt);
    if (Number.isFinite(ms)) expiries.push(ms);
  }
  if (expiries.length === 0) return null;
  return { earliest: new Date(Math.min(...expiries)), latest: new Date(Math.max(...expiries)) };
}

export interface GrokModelsRun {
  args: string[];
  bin: string;
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
}

export type GrokModelsRunner = (run: GrokModelsRun) => Promise<void>;

// The real `grok models`: the shared watchdog'd, group-killed spawn, its output discarded.
async function runGrokModels(run: GrokModelsRun): Promise<void> {
  await runReviewerExec({ ...run, capture: 'stdout', stderrLimit: 1_000 });
}

export interface EnsureGrokLoginOpts {
  authFile?: string;
  // The SAME resolved grok binary the seat will spawn — its refresh is the one that counts.
  bin: string;
  // How long the seat may run from now: its effective absolute timeout.
  deadlineMs: number;
  marginMs?: number;
  now?: () => number;
  runModels?: GrokModelsRunner;
}

// Establish that the login outlives the seat's deadline plus the margin, refreshing it through grok
// (outside any sandbox) when it does not. Resolves when the seat may spawn; throws
// GrokLoginExpiryError — whose message starts with GROK_LOGIN_EXPIRY_FAIL_PREFIX — when it may not.
export async function ensureGrokLogin(opts: EnsureGrokLoginOpts): Promise<void> {
  const file = opts.authFile ?? GROK_AUTH_FILE;
  const now = opts.now ?? Date.now;
  const marginMs = opts.marginMs ?? GROK_LOGIN_MARGIN_MS;
  const needMs = opts.deadlineMs + marginMs;
  const before = readGrokLoginExpiry(file);
  if (!before || before.earliest.getTime() - now() >= needMs) return;

  // A fresh temp cwd: `grok models` must not pick up a project's `.grok/` config from wherever the
  // consumer happens to run.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-login-'));
  try {
    await (opts.runModels ?? runGrokModels)({
      args: ['models'],
      bin: opts.bin,
      cwd,
      env: { GROK_AUTH_EARLY_INVALIDATION_SECS: String(Math.ceil(needMs / 1000)) },
      timeoutMs: GROK_LOGIN_REFRESH_TIMEOUT_MS,
    });
  } catch {
    // A refresh run that failed or hung proves nothing either way — the re-read below decides.
  } finally {
    fs.rmSync(cwd, { force: true, recursive: true });
  }

  // Re-read once. A login that vanished during the refresh is not one this seat can count on.
  const after = readGrokLoginExpiry(file)?.latest;
  if (after && after.getTime() - now() >= needMs) return;
  const deadline = new Date(now() + opts.deadlineMs).toISOString();
  const margin = `${Math.round(marginMs / 60_000)}-min margin`;
  throw new GrokLoginExpiryError(
    after && after.getTime() > before.latest.getTime()
      ? `${GROK_LOGIN_EXPIRY_FAIL_PREFIX}: even the freshly refreshed login (expires ${after.toISOString()}) ends before the seat's deadline (${deadline}) plus a ${margin} — the seat's timeout is longer than a grok login lives; shorten it.`
      : `${GROK_LOGIN_EXPIRY_FAIL_PREFIX}: the login expires ${(after ?? before.latest).toISOString()}, before the seat's deadline (${deadline}) plus a ${margin}, and a refresh outside the sandbox did not extend it — run \`grok\` once to sign in, then re-run the review.`
  );
}
