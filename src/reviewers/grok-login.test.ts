import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ensureGrokLogin,
  GROK_LOGIN_EXPIRY_FAIL_PREFIX,
  GROK_STATUS_API_KEY,
  GROK_STATUS_NOT_AUTHENTICATED,
  GROK_PREFLIGHT_CANCELLED_WHY,
  GrokLoginExpiryError,
  grokLoginWarningLine,
  GrokPreflightCancelledError,
  type GrokModelsResult,
  type GrokModelsRun,
  isGrokLoginExpiryFailure,
  trackSeatCancel,
} from './grok-login';

const MIN = 60_000;
const BUDGET_MS = 30 * MIN; // a packet seat's backstop
const MARGIN_MS = 5 * MIN;

// grok 1.0.44's authenticated status lines, verbatim — every one of them is a session the seat can use.
const LOGGED_IN = 'You are logged in with grok.com.';
const DEPLOYMENT_KEY = 'You are authenticated via deployment key.';
const ENV_API_KEY = 'You are authenticated via XAI_API_KEY (environment variable).';
const AUTHENTICATED = [LOGGED_IN, DEPLOYMENT_KEY, ENV_API_KEY, GROK_STATUS_API_KEY];

// THE CLOCK. Every budget figure is computed from Date.now(), so the tests hold it still and move it
// only where a run "takes" time — the arithmetic is then exact, never a race with the wall clock.
const NOW = 1_800_000_000_000;
let clock = NOW;
beforeEach(() => {
  clock = NOW;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

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

type Answer = GrokModelsResult | (() => GrokModelsResult);

// A run that answers after `ms` of the seat's budget has gone by.
const took = (ms: number, answer: GrokModelsResult): Answer => () => {
  clock += ms;
  return answer;
};

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
  return preflightWith({}, ...answers);
}

async function preflightWith(opts: { cancel?: ReturnType<typeof trackSeatCancel> }, ...answers: Answer[]) {
  const r = runner(...answers);
  const warn = vi.fn();
  const outcome = ensureGrokLogin({
    ...opts,
    bin: '/opt/grok/bin/grok-pinned',
    deadlineAt: NOW + BUDGET_MS,
    marginMs: MARGIN_MS,
    runModels: r.run,
    warn,
  });
  return { outcome, r, warn };
}

// The one warning a pre-flight raised — announced through `warn` AND returned for the seat's result.
async function oneWarning(outcome: Promise<string[]>, warn: ReturnType<typeof vi.fn>): Promise<string> {
  const warnings = await outcome;
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warnings).toEqual([warn.mock.calls[0]?.[0]]);
  return warnings[0] ?? '';
}

// A stand-in grok binary in its own temp dir; the caller removes `dir`.
function standInGrok(script: string, mode = 0o755) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-login-real-'));
  const bin = path.join(dir, 'grok');
  fs.writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode });
  return { bin, dir };
}

describe('ensureGrokLogin — the models run', () => {
  it('runs `grok --sandbox off models` through the seat bin, in a removed temp cwd, sized to the seat', async () => {
    const { outcome, r } = await preflight(answered(LOGGED_IN));
    await expect(outcome).resolves.toEqual([]);
    expect(r.runs).toHaveLength(1);
    const [run] = r.runs;
    expect(run?.args).toEqual(['--sandbox', 'off', 'models']);
    expect(run?.bin).toBe('/opt/grok/bin/grok-pinned');
    // grok's refresh window widened to what is left of the seat's budget plus the margin: 30 + 5 min.
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
    const r = runner(answered(LOGGED_IN));
    await ensureGrokLogin({ bin: 'grok', deadlineAt: NOW + 1_001, marginMs: 0, runModels: r.run, warn: vi.fn() });
    expect(r.runs[0]?.env.GROK_AUTH_EARLY_INVALIDATION_SECS).toBe('2');
  });

  it('runs on EVERY seat — there is no "fresh enough, skip" shortcut', async () => {
    const r = runner(answered(LOGGED_IN));
    for (let i = 0; i < 3; i++) {
      await ensureGrokLogin({ bin: 'grok', deadlineAt: NOW + BUDGET_MS, runModels: r.run, warn: vi.fn() });
    }
    expect(r.runs).toHaveLength(3);
  });

  it('a temp cwd that cannot be created proceeds with a warning — no run, nothing to remove', async () => {
    vi.spyOn(fs, 'mkdtempSync').mockImplementationOnce(() => {
      throw new Error('ENOSPC: no space left on device, mkdtemp');
    });
    const rm = vi.spyOn(fs, 'rmSync');
    const { outcome, r, warn } = await preflight(answered(GROK_STATUS_NOT_AUTHENTICATED));
    const warning = await oneWarning(outcome, warn);
    expect(r.runs).toHaveLength(0);
    expect(rm).not.toHaveBeenCalled();
    expect(warning).toMatch(
      /could not create a temp cwd for `grok models` \(ENOSPC: no space left on device, mkdtemp\) — the seat proceeds/
    );
  });
});

// THE SEAT'S ONE BUDGET. The pre-flight spends from the seat's deadline, never on top of it: each run
// is capped at min(60 s, what is left), and a confirm with nothing left never starts.
describe("ensureGrokLogin — the seat's time budget", () => {
  it('caps the refresh run at the budget when less than a minute is left, and sizes the window to it', async () => {
    const r = runner(answered(LOGGED_IN));
    await ensureGrokLogin({ bin: 'grok', deadlineAt: NOW + 10_000, runModels: r.run, warn: vi.fn() });
    expect(r.runs[0]?.timeoutMs).toBe(10_000);
    // 10 s left + the 5-min default margin.
    expect(r.runs[0]?.env.GROK_AUTH_EARLY_INVALIDATION_SECS).toBe('310');
  });

  it.each<[string, number, number, number]>([
    ['what the refresh run left', 90_000, 45_000, 45_000],
    ['its minute, when more is left', 200_000, 30_000, 60_000],
  ])('the confirm run is capped at %s', async (_, budgetMs, refreshTookMs, confirmCapMs) => {
    const r = runner(took(refreshTookMs, answered(GROK_STATUS_NOT_AUTHENTICATED)), answered(LOGGED_IN));
    await ensureGrokLogin({ bin: 'grok', deadlineAt: NOW + budgetMs, runModels: r.run, warn: vi.fn() });
    expect(r.runs.map((run) => run.timeoutMs)).toEqual([Math.min(60_000, budgetMs), confirmCapMs]);
  });

  it('with no budget left the confirm run never starts — the seat proceeds with a warning, never refused', async () => {
    const r = runner(took(60_000, answered(GROK_STATUS_NOT_AUTHENTICATED)));
    const warn = vi.fn();
    const outcome = ensureGrokLogin({ bin: 'grok', deadlineAt: NOW + 60_000, runModels: r.run, warn });
    const warning = await oneWarning(outcome, warn);
    expect(r.runs).toHaveLength(1);
    expect(warning).toMatch(
      /; the confirm run failed \(the seat's time budget is spent\) — the run never started — the seat proceeds/
    );
  });

  it('a timed-out run is quoted with the cap it actually had', async () => {
    const r = runner(answered('', { exitCode: null, stdout: null, timedOut: true }));
    const warn = vi.fn();
    const outcome = ensureGrokLogin({ bin: 'grok', deadlineAt: NOW + 5_000, runModels: r.run, warn });
    expect(await oneWarning(outcome, warn)).toMatch(/did not finish within 5 s \(exit code none; stderr empty\)/);
  });

  it("hands the seat's cancel handle to every models run", async () => {
    const cancel = trackSeatCancel(vi.fn());
    const r = runner(answered(GROK_STATUS_NOT_AUTHENTICATED), answered(LOGGED_IN));
    await ensureGrokLogin({ bin: 'grok', cancel, deadlineAt: NOW + BUDGET_MS, runModels: r.run, warn: vi.fn() });
    expect(r.runs).toHaveLength(2);
    expect(r.runs.every((run) => run.onSpawn === cancel.onSpawn)).toBe(true);
  });
});

// The REAL runner (the shared group-killed spawn) against a stand-in grok: proves the env the child
// actually receives — GROK_SANDBOX gone even though the parent has it, the window set — and its cwd.
describe('ensureGrokLogin — the real runner', () => {
  it('the child sees no GROK_SANDBOX, the widened window, the args and a temp cwd', async () => {
    const report = path.join(os.tmpdir(), `grok-login-report-${process.pid}-${clock}`);
    const { bin, dir } = standInGrok(
      `printf '%s|%s|%s|%s\\n' "\${GROK_SANDBOX-unset}" "$GROK_AUTH_EARLY_INVALIDATION_SECS" "$*" "$(pwd -P)" > "${report}"\necho '${LOGGED_IN}'`
    );
    try {
      vi.stubEnv('GROK_SANDBOX', 'ensemble-review');
      const warn = vi.fn();
      await expect(ensureGrokLogin({ bin, deadlineAt: NOW + BUDGET_MS, marginMs: MARGIN_MS, warn })).resolves.toEqual([]);
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
  // unless the window is 0. The confirm child must see the window at 0 — even though the parent env
  // carries another value — and no GROK_SANDBOX.
  it('the confirm child runs with the window at 0 and no GROK_SANDBOX, and its logged-in line lets the seat proceed', async () => {
    const { bin, dir } = standInGrok(
      `if [ "$GROK_AUTH_EARLY_INVALIDATION_SECS" != "0" ]; then echo '${GROK_STATUS_NOT_AUTHENTICATED}'; echo 'auth refresh failed: lock held' >&2; exit 0; fi\n[ -n "\${GROK_SANDBOX+set}" ] && { echo 'sandboxed'; exit 0; }\necho '${LOGGED_IN}'`
    );
    try {
      vi.stubEnv('GROK_AUTH_EARLY_INVALIDATION_SECS', '999');
      vi.stubEnv('GROK_SANDBOX', 'ensemble-review');
      const warn = vi.fn();
      const message = await oneWarning(
        ensureGrokLogin({ bin, deadlineAt: NOW + BUDGET_MS, marginMs: MARGIN_MS, warn }),
        warn
      );
      expect(message).toMatch(/^the widened login refresh failed/);
      expect(message).toContain('stderr "auth refresh failed: lock held"');
      expect(message).toContain(`the confirm run printed "${LOGGED_IN}"`);
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it('a bin that cannot be spawned reads as a FAILED run, not one that printed nothing', async () => {
    const { bin, dir } = standInGrok(`echo '${LOGGED_IN}'`, 0o644);
    try {
      const warn = vi.fn();
      const warning = await oneWarning(ensureGrokLogin({ bin, deadlineAt: NOW + BUDGET_MS, warn }), warn);
      expect(warning).toMatch(/^`grok models` failed \(.*EACCES.*\) — the run never started — the seat proceeds/);
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("passes the run's exit code and stderr tail through to the warning", async () => {
    const { bin, dir } = standInGrok(`echo 'Session expired, please log in.'\necho 'error: token refresh 503' >&2\nexit 2`);
    try {
      const warn = vi.fn();
      expect(await oneWarning(ensureGrokLogin({ bin, deadlineAt: NOW + BUDGET_MS, warn }), warn)).toBe(
        '`grok models` printed "Session expired, please log in." (exit code 2; stderr "error: token refresh 503") — the seat proceeds; its backstop owns a login that cannot last'
      );
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  // A cancel arriving mid-pre-flight: the kill handle the seat's caller holds is the models child's,
  // so the cancel ends it at once — not after its minute — and the pre-flight ABORTS the seat: the
  // seat's later spawn would register a kill nobody calls, so it must never start.
  it("a cancel through the seat's handle kills the pre-flight's child and aborts the seat", async () => {
    const { bin, dir } = standInGrok(`sleep 30\necho '${GROK_STATUS_NOT_AUTHENTICATED}'`);
    try {
      const warn = vi.fn();
      const kills: Array<() => void> = [];
      const started = performance.now();
      const cancel = trackSeatCancel((kill) => kills.push(kill));
      const run = ensureGrokLogin({ bin, cancel, deadlineAt: NOW + BUDGET_MS, warn });
      await vi.waitFor(() => expect(kills).toHaveLength(1));
      kills[0]?.();
      const err: unknown = await run.catch((e: unknown) => e);
      expect(performance.now() - started).toBeLessThan(10_000);
      expect(err).toBeInstanceOf(GrokPreflightCancelledError);
      expect(isGrokLoginExpiryFailure((err as Error).message)).toBe(false);
      expect(kills).toHaveLength(1); // no confirm run after the cancel
      expect(warn).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  // A crash is not a cancel: a grok that dies on a signal nobody sent through the seat's handle —
  // here its own SIGABRT, the shape of a panic — proceeds with a warning, never aborts the seat.
  it('a run a signal ended that the seat did not send (SIGABRT) proceeds with a warning', async () => {
    const { bin, dir } = standInGrok(`echo 'thread main panicked' >&2\nkill -ABRT $$`);
    try {
      const warn = vi.fn();
      const cancel = trackSeatCancel(vi.fn());
      const warning = await oneWarning(ensureGrokLogin({ bin, cancel, deadlineAt: NOW + BUDGET_MS, warn }), warn);
      expect(warning).toBe(
        '`grok models` was ended by a signal the pre-flight did not send (exit code none; stderr "thread main panicked") — the seat proceeds; its backstop owns a login that cannot last'
      );
      expect(cancel.cancelled()).toBe(false);
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  let kills: Array<() => void> = [];
  beforeEach(() => {
    kills = [];
  });

  // The rule, on a stubbed runner: only the seat's handed kill being CALLED aborts — on the refresh
  // run and on the confirm run alike — and the temp cwd is still removed. A run that died on a signal
  // with no call proceeds.
  const cancelledRun = (cancel: ReturnType<typeof trackSeatCancel>): Answer => () => {
    cancel.onSpawn?.(() => {});
    // The caller cancels — the kill it holds is the one the models run just handed out.
    kills.at(-1)?.();
    return answered('', { exitCode: null, stdout: null });
  };
  it.each([
    ['the refresh run', (c: ReturnType<typeof trackSeatCancel>) => [cancelledRun(c)]],
    ['the confirm run', (c: ReturnType<typeof trackSeatCancel>) => [answered(GROK_STATUS_NOT_AUTHENTICATED), cancelledRun(c)]],
  ])("a cancel through the seat's handle during %s aborts the seat with a non-login reason", async (_which, answersFor) => {
    const cancel = trackSeatCancel((kill) => kills.push(kill));
    const answers = answersFor(cancel);
    const { outcome, r, warn } = await preflightWith({ cancel }, ...answers);
    const err: unknown = await outcome.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokPreflightCancelledError);
    expect((err as Error).message).toBe(GROK_PREFLIGHT_CANCELLED_WHY);
    expect(isGrokLoginExpiryFailure((err as Error).message)).toBe(false);
    expect(r.runs).toHaveLength(answers.length);
    expect(warn).not.toHaveBeenCalled();
    expect(fs.existsSync(r.runs[0]?.cwd ?? '')).toBe(false);
  });

  it.each([
    ['the refresh run', [answered('', { exitCode: null, stdout: null })]],
    ['the confirm run', [answered(GROK_STATUS_NOT_AUTHENTICATED), answered('', { exitCode: null, stdout: null })]],
  ])('a signal-killed %s with no cancel called proceeds with a warning', async (_which, answers) => {
    const cancel = trackSeatCancel((kill) => kills.push(kill));
    const { outcome, r, warn } = await preflightWith({ cancel }, ...answers);
    const warning = await oneWarning(outcome, warn);
    expect(warning).toContain('was ended by a signal the pre-flight did not send (exit code none; stderr empty)');
    expect(warning).toMatch(/the seat proceeds; its backstop owns a login that cannot last$/);
    expect(r.runs).toHaveLength(answers.length);
  });
});

describe("ensureGrokLogin — grok's own status line decides", () => {
  it.each(AUTHENTICATED)('passes, silently, after one run, when grok says "%s"', async (status) => {
    const { outcome, r, warn } = await preflight(answered(status));
    await expect(outcome).resolves.toEqual([]);
    expect(r.runs).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a line that only LOOKS like a login is not one — it proceeds with a warning', async () => {
    const { outcome, r, warn } = await preflight(answered('You are using a deprecated authentication method (WebLogin).'));
    expect(await oneWarning(outcome, warn)).toMatch(/printed "You are using a deprecated authentication method \(WebLogin\)\."/);
    expect(r.runs).toHaveLength(1);
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
    // Two runs: the widened refresh, then the confirm — a cached-only read (window 0) with the sandbox
    // REMOVED from its env, the same bin, args and (still existing) temp cwd.
    expect(r.runs).toHaveLength(2);
    const [refresh, confirm] = r.runs;
    expect(refresh?.env.GROK_AUTH_EARLY_INVALIDATION_SECS).toBe('2100');
    expect(Object.keys(confirm?.env ?? {}).sort()).toEqual(['GROK_AUTH_EARLY_INVALIDATION_SECS', 'GROK_SANDBOX']);
    expect(confirm?.env.GROK_AUTH_EARLY_INVALIDATION_SECS).toBe('0');
    expect(confirm?.env.GROK_SANDBOX).toBeUndefined();
    expect(confirm?.args).toEqual(refresh?.args);
    expect(confirm?.bin).toBe(refresh?.bin);
    expect(confirm?.cwd).toBe(refresh?.cwd);
    expect(r.cwdExisted).toEqual([true, true]);
    expect(fs.existsSync(refresh?.cwd ?? '')).toBe(false);
  });

  it.each(AUTHENTICATED)(
    'a failed widened refresh whose confirm run reads "%s" proceeds, warning the login may expire during the seat',
    async (status) => {
      const { outcome, r, warn } = await preflight(
        answered(GROK_STATUS_NOT_AUTHENTICATED, { stderrTail: 'auth.refresh.error: single-flight lost\n' }),
        answered(status)
      );
      expect(await oneWarning(outcome, warn)).toBe(
        `the widened login refresh failed — the refresh run (window 2100 s) printed "${GROK_STATUS_NOT_AUTHENTICATED}" (exit code 0; stderr "auth.refresh.error: single-flight lost"), but grok's cached login is still valid; the confirm run printed "${status}" (exit code 0; stderr empty). The seat proceeds; the login may expire during it.`
      );
      expect(r.runs).toHaveLength(2);
    }
  );

  it.each<[string, Answer, RegExp]>([
    ['hangs', answered(GROK_STATUS_NOT_AUTHENTICATED, { exitCode: null, timedOut: true }), /did not finish within 60 s \(exit code none; stderr empty\)/],
    ['fails', () => { throw new Error('spawn EAGAIN'); }, /failed \(spawn EAGAIN\) — the run never started/],
    ['prints an unrecognised line', answered('Session expired, please log in.'), /printed "Session expired, please log in\." \(exit code 0; stderr empty\)/],
    ['prints nothing', { exitCode: 1, stderrTail: 'boom', stdout: null, timedOut: false }, /printed no status line \(exit code 1; stderr "boom"\)/],
  ])('a confirm run that %s does NOT refuse — the seat proceeds with a warning', async (_, confirm, detail) => {
    const { outcome, r, warn } = await preflight(answered(GROK_STATUS_NOT_AUTHENTICATED), confirm);
    const message = await oneWarning(outcome, warn);
    expect(r.runs).toHaveLength(2);
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

// ONLY A RUN THAT EXITED 0 ANSWERS. A nonzero exit — whatever line it printed — can neither pass,
// confirm nor refuse the seat: it warns, quoting the exit code, and the seat proceeds.
describe('ensureGrokLogin — the exit code', () => {
  it('a not-authenticated line from a run that exited nonzero warns and proceeds — no confirm run, no refusal', async () => {
    const { outcome, r, warn } = await preflight(answered(GROK_STATUS_NOT_AUTHENTICATED, { exitCode: 1 }));
    expect(await oneWarning(outcome, warn)).toBe(
      '`grok models` printed "You are not authenticated." (exit code 1; stderr empty) — the seat proceeds; its backstop owns a login that cannot last'
    );
    expect(r.runs).toHaveLength(1);
  });

  it('a confirm run that exited nonzero cannot confirm the refusal', async () => {
    const { outcome, r, warn } = await preflight(
      answered(GROK_STATUS_NOT_AUTHENTICATED),
      answered(GROK_STATUS_NOT_AUTHENTICATED, { exitCode: 2 })
    );
    const message = await oneWarning(outcome, warn);
    expect(r.runs).toHaveLength(2);
    expect(message).toMatch(/; the confirm run printed "You are not authenticated\." \(exit code 2; stderr empty\) — the seat proceeds/);
  });

  it('a logged-in line from a run that exited nonzero is not a silent pass', async () => {
    const { outcome, r, warn } = await preflight(answered(LOGGED_IN, { exitCode: 1 }));
    expect(await oneWarning(outcome, warn)).toMatch(/^`grok models` printed "You are logged in with grok\.com\." \(exit code 1; stderr empty\) — the seat proceeds/);
    expect(r.runs).toHaveLength(1);
  });

  it("a logged-in confirm run that exited nonzero does not vouch for the cached login", async () => {
    const { outcome, warn } = await preflight(answered(GROK_STATUS_NOT_AUTHENTICATED), answered(LOGGED_IN, { exitCode: 1 }));
    const message = await oneWarning(outcome, warn);
    expect(message).not.toMatch(/cached login is still valid/);
    expect(message).toMatch(/; the confirm run printed "You are logged in with grok\.com\." \(exit code 1; stderr empty\) — the seat proceeds/);
  });
});

// Never fail a seat on a line we cannot read: the seat's backstop owns these, as before the pre-flight.
// Each warning quotes what the run did — its exit code and stderr tail — and none triggers a confirm run.
describe('ensureGrokLogin — anything unreadable proceeds with a warning', () => {
  it('a run that HANGS (timed out) proceeds — even if it printed a status first', async () => {
    const { outcome, r, warn } = await preflight(
      answered(GROK_STATUS_NOT_AUTHENTICATED, { exitCode: null, stderrTail: 'still refreshing', timedOut: true })
    );
    expect(await oneWarning(outcome, warn)).toMatch(
      /did not finish within 60 s \(exit code none; stderr "still refreshing"\) — the seat proceeds/
    );
    expect(r.runs).toHaveLength(1);
  });

  it('a run that FAILS (the runner throws) proceeds', async () => {
    const { outcome, r, warn } = await preflight(() => {
      throw new Error('spawn ENOENT');
    });
    expect(await oneWarning(outcome, warn)).toMatch(/failed \(spawn ENOENT\) — the run never started — the seat proceeds/);
    expect(fs.existsSync(r.runs[0]?.cwd ?? '')).toBe(false);
  });

  it('an unrecognised status line proceeds, quoting what was read', async () => {
    const { outcome, warn } = await preflight(answered('Session expired, please log in.', { exitCode: 3, stderrTail: 'x'.repeat(2_000) }));
    const message = await oneWarning(outcome, warn);
    expect(message).toMatch(/printed "Session expired, please log in\." \(exit code 3; stderr "x+"\)/);
    // The stderr quoted is a bounded tail, whatever a runner hands back.
    expect(message.match(/stderr "(x+)"/)?.[1]).toHaveLength(500);
  });

  it('no stdout at all proceeds', async () => {
    const { outcome, warn } = await preflight({ exitCode: 0, stderrTail: '', stdout: null, timedOut: false });
    expect(await oneWarning(outcome, warn)).toMatch(/printed no status line \(exit code 0; stderr empty\)/);
  });
});

describe('grokLoginWarningLine', () => {
  it('is the one live stderr line a warning becomes', () => {
    expect(grokLoginWarningLine('x')).toBe('⚠ ensemble-ai grok pre-flight: x\n');
  });
});

describe('isGrokLoginExpiryFailure', () => {
  it('keys on the prefix only', () => {
    expect(isGrokLoginExpiryFailure(`${GROK_LOGIN_EXPIRY_FAIL_PREFIX}: grok reports "x"`)).toBe(true);
    expect(isGrokLoginExpiryFailure('grok usage limit reached')).toBe(false);
    expect(isGrokLoginExpiryFailure(undefined)).toBe(false);
  });
});
