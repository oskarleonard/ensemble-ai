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

// A completed run that printed `status` — exit 0, quiet stderr, the way grok 1.0.44 answers.
const answered = (status: string, more: Partial<GrokModelsResult> = {}): GrokModelsResult => ({
  exitCode: 0,
  stderrTail: '',
  stdout: modelsStdout(status),
  timedOut: false,
  ...more,
});

type Answer = GrokModelsResult | (() => never);

// A stubbed `grok models`: records each run (and whether its cwd existed then) and answers with the
// next of `answers` — the last one repeats, so a single answer serves every run.
function runner(...answers: Answer[]) {
  const runs: GrokModelsRun[] = [];
  const cwdExisted: boolean[] = [];
  return {
    cwdExisted,
    run: async (r: GrokModelsRun): Promise<GrokModelsResult> => {
      runs.push(r);
      cwdExisted.push(fs.existsSync(r.cwd));
      const answer = answers[Math.min(runs.length, answers.length) - 1];
      if (!answer) throw new Error('no answer');
      return typeof answer === 'function' ? answer() : answer;
    },
    runs,
  };
}

async function preflight(...answers: Answer[]) {
  const r = runner(...answers);
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

// A stand-in grok binary in its own temp dir; the caller removes `dir`.
function standInGrok(script: string, mode = 0o755) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-login-real-'));
  const bin = path.join(dir, 'grok');
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode });
  return { bin, dir };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ensureGrokLogin — the models run', () => {
  it('runs `grok --sandbox off models` through the seat bin, in a removed temp cwd, sized to the seat', async () => {
    const { outcome, r } = await preflight(answered(GROK_STATUS_LOGGED_IN));
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
    const r = runner(answered(GROK_STATUS_LOGGED_IN));
    await ensureGrokLogin({ bin: 'grok', deadlineMs: 1_001, marginMs: 0, runModels: r.run, warn: vi.fn() });
    expect(r.runs[0]?.env.GROK_AUTH_EARLY_INVALIDATION_SECS).toBe('2');
  });

  it('runs on EVERY seat — there is no "fresh enough, skip" shortcut', async () => {
    const r = runner(answered(GROK_STATUS_LOGGED_IN));
    for (let i = 0; i < 3; i++) {
      await ensureGrokLogin({ bin: 'grok', deadlineMs: DEADLINE_MS, runModels: r.run, warn: vi.fn() });
    }
    expect(r.runs).toHaveLength(3);
  });

  it('a temp cwd that cannot be created proceeds with a warning — no run, nothing to remove', async () => {
    vi.spyOn(fs, 'mkdtempSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device, mkdtemp');
    });
    const rm = vi.spyOn(fs, 'rmSync');
    const { outcome, r, warn } = await preflight(answered(GROK_STATUS_NOT_AUTHENTICATED));
    await expect(outcome).resolves.toBeUndefined();
    expect(r.runs).toHaveLength(0);
    expect(rm).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /could not create a temp cwd for `grok models` \(ENOSPC: no space left on device, mkdtemp\) — the seat proceeds/
    );
  });
});

// The REAL runner (the shared group-killed spawn) against a stand-in grok: proves the env the child
// actually receives — GROK_SANDBOX gone even though the parent has it, the window set — and its cwd.
describe('ensureGrokLogin — the real runner', () => {
  it('the child sees no GROK_SANDBOX, the widened window, the args and a temp cwd', async () => {
    const report = path.join(os.tmpdir(), `grok-login-report-${process.pid}-${Date.now()}`);
    const { bin, dir } = standInGrok(
      `printf '%s|%s|%s|%s\\n' "\${GROK_SANDBOX-unset}" "$GROK_AUTH_EARLY_INVALIDATION_SECS" "$*" "$(pwd -P)" > "${report}"\necho '${GROK_STATUS_LOGGED_IN}'`
    );
    try {
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
      fs.rmSync(report, { force: true });
    }
  });

  // A grok whose widened refresh fails but whose cached session is valid: it says not authenticated
  // only while the window is set. The confirm child must see the window REMOVED — even though the
  // parent env carries one — and no GROK_SANDBOX.
  it('the confirm child runs without the widened window or GROK_SANDBOX, and its logged-in line lets the seat proceed', async () => {
    const { bin, dir } = standInGrok(
      `if [ -n "\${GROK_AUTH_EARLY_INVALIDATION_SECS+set}" ]; then echo '${GROK_STATUS_NOT_AUTHENTICATED}'; echo 'auth refresh failed: lock held' >&2; exit 0; fi\n[ -n "\${GROK_SANDBOX+set}" ] && { echo 'sandboxed'; exit 0; }\necho '${GROK_STATUS_LOGGED_IN}'`
    );
    try {
      vi.stubEnv('GROK_AUTH_EARLY_INVALIDATION_SECS', '999');
      vi.stubEnv('GROK_SANDBOX', 'ensemble-review');
      const warn = vi.fn();
      await expect(ensureGrokLogin({ bin, deadlineMs: DEADLINE_MS, marginMs: MARGIN_MS, warn })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      const message = String(warn.mock.calls[0]?.[0]);
      expect(message).toMatch(/^the widened login refresh failed/);
      expect(message).toContain('stderr "auth refresh failed: lock held"');
      expect(message).toContain(`the confirm run printed "${GROK_STATUS_LOGGED_IN}"`);
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it('a bin that cannot be spawned reads as a FAILED run, not one that printed nothing', async () => {
    const { bin, dir } = standInGrok(`echo '${GROK_STATUS_LOGGED_IN}'`, 0o644);
    try {
      const warn = vi.fn();
      await expect(ensureGrokLogin({ bin, deadlineMs: DEADLINE_MS, warn })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/^`grok models` failed \(.*EACCES.*\) — the run never started — the seat proceeds/);
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("passes the run's exit code and stderr tail through to the warning", async () => {
    const { bin, dir } = standInGrok(`echo 'Session expired, please log in.'\necho 'error: token refresh 503' >&2\nexit 2`);
    try {
      const warn = vi.fn();
      await expect(ensureGrokLogin({ bin, deadlineMs: DEADLINE_MS, warn })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe(
        '`grok models` printed "Session expired, please log in." (exit code 2; stderr "error: token refresh 503") — the seat proceeds; its backstop owns a login that cannot last'
      );
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe("ensureGrokLogin — grok's own status line decides", () => {
  it('passes, silently, after one run, when grok is logged in with grok.com', async () => {
    const { outcome, r, warn } = await preflight(answered(GROK_STATUS_LOGGED_IN));
    await expect(outcome).resolves.toBeUndefined();
    expect(r.runs).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('passes, silently, after one run, when grok is using XAI_API_KEY', async () => {
    const { outcome, r, warn } = await preflight(answered(GROK_STATUS_API_KEY));
    await expect(outcome).resolves.toBeUndefined();
    expect(r.runs).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses the seat when the CONFIRM run also says not authenticated — naming the line read and the remedy', async () => {
    const { outcome, r } = await preflight(answered(GROK_STATUS_NOT_AUTHENTICATED), answered(GROK_STATUS_NOT_AUTHENTICATED));
    const err: unknown = await outcome.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokLoginExpiryError);
    const message = (err as Error).message;
    expect(message.startsWith(`${GROK_LOGIN_EXPIRY_FAIL_PREFIX}: `)).toBe(true);
    expect(message).toContain(`grok reports "${GROK_STATUS_NOT_AUTHENTICATED}"`);
    expect(message).toContain('run `grok` once to sign in');
    expect(isGrokLoginExpiryFailure(message)).toBe(true);
    // Two runs: the widened refresh, then the confirm — the window and the sandbox both REMOVED from
    // the confirm child's env, the same bin, args and (still existing) temp cwd.
    expect(r.runs).toHaveLength(2);
    const [refresh, confirm] = r.runs;
    expect(refresh?.env.GROK_AUTH_EARLY_INVALIDATION_SECS).toBe('2100');
    expect(Object.keys(confirm?.env ?? {}).sort()).toEqual(['GROK_AUTH_EARLY_INVALIDATION_SECS', 'GROK_SANDBOX']);
    expect(confirm?.env.GROK_AUTH_EARLY_INVALIDATION_SECS).toBeUndefined();
    expect(confirm?.env.GROK_SANDBOX).toBeUndefined();
    expect(confirm?.args).toEqual(refresh?.args);
    expect(confirm?.bin).toBe(refresh?.bin);
    expect(confirm?.cwd).toBe(refresh?.cwd);
    expect(r.cwdExisted).toEqual([true, true]);
    expect(fs.existsSync(refresh?.cwd ?? '')).toBe(false);
  });

  it.each([GROK_STATUS_LOGGED_IN, GROK_STATUS_API_KEY])(
    'a failed widened refresh whose confirm run reads "%s" proceeds, warning the login may expire during the seat',
    async (status) => {
      const { outcome, r, warn } = await preflight(
        answered(GROK_STATUS_NOT_AUTHENTICATED, { stderrTail: 'auth.refresh.error: single-flight lost\n' }),
        answered(status)
      );
      await expect(outcome).resolves.toBeUndefined();
      expect(r.runs).toHaveLength(2);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toBe(
        `the widened login refresh failed — the refresh run (window 2100 s) printed "${GROK_STATUS_NOT_AUTHENTICATED}" (exit code 0; stderr "auth.refresh.error: single-flight lost"), but grok's cached login is still valid; the confirm run printed "${status}" (exit code 0; stderr empty). The seat proceeds; the login may expire during it.`
      );
    }
  );

  it.each<[string, Answer, RegExp]>([
    ['hangs', answered(GROK_STATUS_NOT_AUTHENTICATED, { exitCode: null, timedOut: true }), /did not finish within 60 s \(exit code none; stderr empty\)/],
    ['fails', () => { throw new Error('spawn EAGAIN'); }, /failed \(spawn EAGAIN\) — the run never started/],
    ['prints an unrecognised line', answered('Session expired, please log in.'), /printed "Session expired, please log in\." \(exit code 0; stderr empty\)/],
    ['prints nothing', { exitCode: 1, stderrTail: 'boom', stdout: null, timedOut: false }, /printed no status line \(exit code 1; stderr "boom"\)/],
  ])('a confirm run that %s does NOT refuse — the seat proceeds with a warning', async (_, confirm, detail) => {
    const { outcome, r, warn } = await preflight(answered(GROK_STATUS_NOT_AUTHENTICATED), confirm);
    await expect(outcome).resolves.toBeUndefined();
    expect(r.runs).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toMatch(/^the refresh run \(window 2100 s\) printed "You are not authenticated\." \(exit code 0; stderr empty\); the confirm run /);
    expect(message).toMatch(detail);
    expect(message).toMatch(/ — the seat proceeds; its backstop owns a login that cannot last$/);
  });

  it('reads the first NON-EMPTY line, trimmed', async () => {
    const blank = (status: string) => answered('', { stdout: `\n  ${status}  \n` });
    const { outcome } = await preflight(blank(GROK_STATUS_NOT_AUTHENTICATED), blank(GROK_STATUS_NOT_AUTHENTICATED));
    await expect(outcome).rejects.toBeInstanceOf(GrokLoginExpiryError);
  });
});

// Never fail a seat on a line we cannot read: the seat's backstop owns these, as before the pre-flight.
// Each warning quotes what the run did — its exit code and stderr tail — and none triggers a confirm run.
describe('ensureGrokLogin — anything unreadable proceeds with a warning', () => {
  it('a run that HANGS (timed out) proceeds — even if it printed a status first', async () => {
    const { outcome, r, warn } = await preflight(
      answered(GROK_STATUS_NOT_AUTHENTICATED, { exitCode: null, stderrTail: 'still refreshing', timedOut: true })
    );
    await expect(outcome).resolves.toBeUndefined();
    expect(r.runs).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(
      /did not finish within 60 s \(exit code none; stderr "still refreshing"\) — the seat proceeds/
    );
  });

  it('a run that FAILS (the runner throws) proceeds', async () => {
    const { outcome, r, warn } = await preflight(() => {
      throw new Error('spawn ENOENT');
    });
    await expect(outcome).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/failed \(spawn ENOENT\) — the run never started — the seat proceeds/);
    expect(fs.existsSync(r.runs[0]?.cwd ?? '')).toBe(false);
  });

  it('an unrecognised status line proceeds, quoting what was read', async () => {
    const { outcome, warn } = await preflight(answered('Session expired, please log in.', { exitCode: 3, stderrTail: 'x'.repeat(2_000) }));
    await expect(outcome).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toMatch(/printed "Session expired, please log in\." \(exit code 3; stderr "x+"\)/);
    // The stderr quoted is a bounded tail, whatever a runner hands back.
    expect(message.match(/stderr "(x+)"/)?.[1]).toHaveLength(500);
  });

  it('no stdout at all proceeds', async () => {
    const { outcome, warn } = await preflight({ exitCode: 0, stderrTail: '', stdout: null, timedOut: false });
    await expect(outcome).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatch(/printed no status line \(exit code 0; stderr empty\)/);
  });
});

describe('isGrokLoginExpiryFailure', () => {
  it('keys on the prefix only', () => {
    expect(isGrokLoginExpiryFailure(`${GROK_LOGIN_EXPIRY_FAIL_PREFIX}: grok reports "x"`)).toBe(true);
    expect(isGrokLoginExpiryFailure('grok usage limit reached')).toBe(false);
    expect(isGrokLoginExpiryFailure(undefined)).toBe(false);
  });
});
