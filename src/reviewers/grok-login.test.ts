import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ensureGrokLogin,
  GROK_LOGIN_EXPIRY_FAIL_PREFIX,
  GROK_STATUS_API_KEY,
  GROK_STATUS_LOGGED_IN,
  GROK_STATUS_NOT_AUTHENTICATED,
  GrokLoginExpiryError,
  type GrokModelsResult,
  type GrokModelsRun,
  isGrokLoginExpiryFailure,
} from './grok-login';

const MIN = 60_000;
const DEADLINE_MS = 30 * MIN; // a packet seat's backstop
const MARGIN_MS = 5 * MIN;

// grok 1.0.44's `models` stdout: its status line, then the catalog.
const modelsStdout = (status: string): string =>
  `${status}\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n`;

// A stubbed `grok models`: records each run (and whether its cwd existed then), answers with `result`.
function runner(result: GrokModelsResult | (() => never)) {
  const runs: GrokModelsRun[] = [];
  const cwdExisted: boolean[] = [];
  return {
    cwdExisted,
    run: async (r: GrokModelsRun): Promise<GrokModelsResult> => {
      runs.push(r);
      cwdExisted.push(fs.existsSync(r.cwd));
      return typeof result === 'function' ? result() : result;
    },
    runs,
  };
}

async function preflight(result: GrokModelsResult | (() => never)) {
  const r = runner(result);
  const warn = vi.fn();
  const outcome = ensureGrokLogin({
    bin: '/opt/grok/bin/grok-pinned',
    deadlineMs: DEADLINE_MS,
    marginMs: MARGIN_MS,
    runModels: r.run,
    warn,
  });
  return { outcome, r, warn };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ensureGrokLogin — the models run', () => {
  it('runs `grok --sandbox off models` through the seat bin, in a removed temp cwd, sized to the seat', async () => {
    const { outcome, r } = await preflight({ stdout: modelsStdout(GROK_STATUS_LOGGED_IN), timedOut: false });
    await expect(outcome).resolves.toBeUndefined();
    expect(r.runs).toHaveLength(1);
    const [run] = r.runs;
    expect(run?.args).toEqual(['--sandbox', 'off', 'models']);
    expect(run?.bin).toBe('/opt/grok/bin/grok-pinned');
    // grok's refresh window widened to the seat's deadline plus the margin: 30 + 5 min.
    expect(run?.env.GROK_AUTH_EARLY_INVALIDATION_SECS).toBe('2100');
    // The seat's sandbox is REMOVED from the child env, not set to some other value.
    expect(Object.keys(run?.env ?? {})).toContain('GROK_SANDBOX');
    expect(run?.env.GROK_SANDBOX).toBeUndefined();
    expect(run?.timeoutMs).toBe(60_000);
    expect(r.cwdExisted).toEqual([true]);
    expect(fs.existsSync(run?.cwd ?? '')).toBe(false);
    expect(path.dirname(run?.cwd ?? '')).toBe(os.tmpdir());
  });

  it('rounds the window UP to whole seconds', async () => {
    const r = runner({ stdout: modelsStdout(GROK_STATUS_LOGGED_IN), timedOut: false });
    await ensureGrokLogin({ bin: 'grok', deadlineMs: 1_001, marginMs: 0, runModels: r.run, warn: vi.fn() });
    expect(r.runs[0]?.env.GROK_AUTH_EARLY_INVALIDATION_SECS).toBe('2');
  });

  it('runs on EVERY seat — there is no "fresh enough, skip" shortcut', async () => {
    const r = runner({ stdout: modelsStdout(GROK_STATUS_LOGGED_IN), timedOut: false });
    for (let i = 0; i < 3; i++) {
      await ensureGrokLogin({ bin: 'grok', deadlineMs: DEADLINE_MS, runModels: r.run, warn: vi.fn() });
    }
    expect(r.runs).toHaveLength(3);
  });
});

// The REAL runner (the shared group-killed spawn) against a stand-in grok: proves the env the child
// actually receives — GROK_SANDBOX gone even though the parent has it, the window set — and its cwd.
describe('ensureGrokLogin — the real runner', () => {
  it('the child sees no GROK_SANDBOX, the widened window, the args and a temp cwd', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-login-real-'));
    try {
      const bin = path.join(dir, 'grok');
      const report = path.join(dir, 'report');
      fs.writeFileSync(
        bin,
        `#!/bin/sh\nprintf '%s|%s|%s|%s\\n' "\${GROK_SANDBOX-unset}" "$GROK_AUTH_EARLY_INVALIDATION_SECS" "$*" "$(pwd -P)" > "${report}"\necho '${GROK_STATUS_LOGGED_IN}'\n`,
        { mode: 0o755 }
      );
      vi.stubEnv('GROK_SANDBOX', 'ensemble-review');
      const warn = vi.fn();
      await ensureGrokLogin({ bin, deadlineMs: DEADLINE_MS, marginMs: MARGIN_MS, warn });
      const [sandbox, secs, args, cwd] = fs.readFileSync(report, 'utf8').trim().split('|');
      expect(sandbox).toBe('unset');
      expect(secs).toBe('2100');
      expect(args).toBe('--sandbox off models');
      expect(path.basename(cwd ?? '')).toMatch(/^grok-login-/);
      expect(fs.existsSync(cwd ?? '')).toBe(false);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("ensureGrokLogin — grok's own status line decides", () => {
  it('passes, silently, when grok is logged in with grok.com', async () => {
    const { outcome, warn } = await preflight({ stdout: modelsStdout(GROK_STATUS_LOGGED_IN), timedOut: false });
    await expect(outcome).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes, silently, when grok is using XAI_API_KEY', async () => {
    const { outcome, warn } = await preflight({ stdout: modelsStdout(GROK_STATUS_API_KEY), timedOut: false });
    await expect(outcome).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses the seat when grok is not authenticated — naming the line read and the remedy', async () => {
    const { outcome } = await preflight({ stdout: modelsStdout(GROK_STATUS_NOT_AUTHENTICATED), timedOut: false });
    const err: unknown = await outcome.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokLoginExpiryError);
    const message = (err as Error).message;
    expect(message.startsWith(`${GROK_LOGIN_EXPIRY_FAIL_PREFIX}: `)).toBe(true);
    expect(message).toContain(`grok reports "${GROK_STATUS_NOT_AUTHENTICATED}"`);
    expect(message).toContain('run `grok` once to sign in');
    expect(isGrokLoginExpiryFailure(message)).toBe(true);
  });

  it('reads the first NON-EMPTY line, trimmed', async () => {
    const { outcome } = await preflight({ stdout: `\n  ${GROK_STATUS_NOT_AUTHENTICATED}  \n`, timedOut: false });
    await expect(outcome).rejects.toBeInstanceOf(GrokLoginExpiryError);
  });
});

// Never fail a seat on a line we cannot read: the seat's backstop owns these, as before the pre-flight.
describe('ensureGrokLogin — anything unreadable proceeds with a warning', () => {
  it('a run that HANGS (timed out) proceeds — even if it printed a status first', async () => {
    const { outcome, warn } = await preflight({
      stdout: modelsStdout(GROK_STATUS_NOT_AUTHENTICATED),
      timedOut: true,
    });
    await expect(outcome).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/did not finish within 60 s — the seat proceeds/);
  });

  it('a run that FAILS (the runner throws) proceeds', async () => {
    const { outcome, r, warn } = await preflight(() => {
      throw new Error('spawn ENOENT');
    });
    await expect(outcome).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/failed \(spawn ENOENT\) — the seat proceeds/);
    expect(fs.existsSync(r.runs[0]?.cwd ?? '')).toBe(false);
  });

  it('an unrecognised status line proceeds, quoting what was read', async () => {
    const { outcome, warn } = await preflight({ stdout: modelsStdout('Session expired, please log in.'), timedOut: false });
    await expect(outcome).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/unrecognised status line \("Session expired, please log in\."\)/);
  });

  it('no stdout at all proceeds', async () => {
    const { outcome, warn } = await preflight({ stdout: null, timedOut: false });
    await expect(outcome).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/printed no status line/);
  });
});

describe('isGrokLoginExpiryFailure', () => {
  it('keys on the prefix only', () => {
    expect(isGrokLoginExpiryFailure(`${GROK_LOGIN_EXPIRY_FAIL_PREFIX}: grok reports "x"`)).toBe(true);
    expect(isGrokLoginExpiryFailure('grok usage limit reached')).toBe(false);
    expect(isGrokLoginExpiryFailure(undefined)).toBe(false);
  });
});
