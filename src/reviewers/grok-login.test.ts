import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ensureGrokLogin,
  GROK_LOGIN_EXPIRY_FAIL_PREFIX,
  GrokLoginExpiryError,
  type GrokModelsRun,
  isGrokLoginExpiryFailure,
  readGrokLoginExpiry,
} from './grok-login';

// The injected clock: every case runs at this instant.
const NOW = Date.parse('2026-10-01T01:00:00.000Z');
const MIN = 60_000;
const DEADLINE_MS = 30 * MIN; // a packet seat's backstop
const MARGIN_MS = 5 * MIN;

// grok's live shape (2026-10-01): one entry per issuer, `expires_at` with MICROsecond precision.
// Every credential-looking field is present so the reader is proven to hand back none of them.
function entry(expiresAt: unknown): Record<string, unknown> {
  return {
    auth_mode: 'Oidc',
    create_time: '2026-09-30T19:12:01.872380Z',
    email: 'someone@example.com',
    expires_at: expiresAt,
    key: 'SECRET-ACCESS-TOKEN',
    refresh_token: 'SECRET-REFRESH-TOKEN',
    user_id: 'user-1',
  };
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace('Z', '380Z'); // 6 fractional digits, like grok writes
}

let dir: string;
let file: string;

function writeAuth(entries: Record<string, unknown>): void {
  fs.writeFileSync(file, JSON.stringify(entries));
}

// A stubbed `grok models`: records each run, and optionally rewrites auth.json the way grok's own
// refresh would.
function runner(onRun?: () => void): { runs: GrokModelsRun[]; run: (r: GrokModelsRun) => Promise<void> } {
  const runs: GrokModelsRun[] = [];
  return {
    run: async (r) => {
      runs.push(r);
      onRun?.();
    },
    runs,
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-login-test-'));
  file = path.join(dir, 'auth.json');
});

afterEach(() => {
  fs.rmSync(dir, { force: true, recursive: true });
});

describe('readGrokLoginExpiry', () => {
  it('returns ONLY a date — no credential field crosses the reader', () => {
    writeAuth({ 'https://auth.x.ai::a': entry('2026-10-01T07:12:01.872380Z') });
    const expiry = readGrokLoginExpiry(file);
    expect(expiry).toBeInstanceOf(Date);
    expect(expiry?.toISOString()).toBe('2026-10-01T07:12:01.872Z');
    expect(JSON.stringify(expiry)).not.toMatch(/SECRET|someone@|Oidc|user-1/);
  });

  it('takes the EARLIEST expiry across issuer entries', () => {
    writeAuth({
      'https://auth.x.ai::a': entry('2026-10-01T07:12:01.872380Z'),
      'https://other.example::b': entry('2026-10-01T03:00:00.000000+00:00'),
    });
    expect(readGrokLoginExpiry(file)?.toISOString()).toBe('2026-10-01T03:00:00.000Z');
  });

  it('is null for a missing file, a non-JSON file, and entries with no usable expires_at', () => {
    expect(readGrokLoginExpiry(path.join(dir, 'absent.json'))).toBeNull();
    fs.writeFileSync(file, 'not json');
    expect(readGrokLoginExpiry(file)).toBeNull();
    writeAuth({ apikey: { auth_mode: 'ApiKey', key: 'SECRET' }, odd: entry(12345), bad: entry('soon') });
    expect(readGrokLoginExpiry(file)).toBeNull();
  });
});

describe('ensureGrokLogin', () => {
  const opts = (run: (r: GrokModelsRun) => Promise<void>) => ({
    authFile: file,
    bin: '/opt/grok-pinned',
    deadlineMs: DEADLINE_MS,
    marginMs: MARGIN_MS,
    now: () => NOW,
    runModels: run,
  });

  it('passes a fresh login WITHOUT running `grok models`', async () => {
    writeAuth({ 'https://auth.x.ai::a': entry(iso(NOW + 5 * 60 * MIN)) });
    const r = runner();
    await expect(ensureGrokLogin(opts(r.run))).resolves.toBeUndefined();
    expect(r.runs).toHaveLength(0);
  });

  it('refreshes a near-expiry login with ONE unsandboxed `grok models`, and passes once expires_at moved', async () => {
    writeAuth({ 'https://auth.x.ai::a': entry(iso(NOW + 20 * MIN)) });
    const r = runner(() => writeAuth({ 'https://auth.x.ai::a': entry(iso(NOW + 6 * 60 * MIN)) }));
    await expect(ensureGrokLogin(opts(r.run))).resolves.toBeUndefined();
    expect(r.runs).toHaveLength(1);
    const [run] = r.runs;
    // The same binary the seat spawns, the bare subcommand — no `--sandbox`, no prompt.
    expect(run.bin).toBe('/opt/grok-pinned');
    expect(run.args).toEqual(['models']);
    // grok's OWN refresh window, widened to the seat's deadline + margin (35 min = 2100 s).
    expect(run.env).toEqual({ GROK_AUTH_EARLY_INVALIDATION_SECS: '2100' });
    // A fresh temp cwd, removed afterwards — never the consumer's working directory.
    expect(run.cwd).not.toBe(process.cwd());
    expect(path.dirname(run.cwd)).toBe(path.resolve(os.tmpdir()));
    expect(fs.existsSync(run.cwd)).toBe(false);
    expect(run.timeoutMs).toBeGreaterThan(0);
  });

  it('throws the distinct error when the refresh does not extend the login — and never retries', async () => {
    writeAuth({ 'https://auth.x.ai::a': entry(iso(NOW + 20 * MIN)) });
    const r = runner();
    const err = await ensureGrokLogin(opts(r.run)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokLoginExpiryError);
    const message = (err as Error).message;
    expect(message.startsWith(GROK_LOGIN_EXPIRY_FAIL_PREFIX)).toBe(true);
    expect(isGrokLoginExpiryFailure(message)).toBe(true);
    expect(message).toMatch(/run `grok` once to sign in/);
    expect(message).not.toMatch(/SECRET/);
    expect(r.runs).toHaveLength(1);
  });

  it('says the seat outlasts any login when even a refreshed one is too short', async () => {
    writeAuth({ 'https://auth.x.ai::a': entry(iso(NOW + 20 * MIN)) });
    const r = runner(() => writeAuth({ 'https://auth.x.ai::a': entry(iso(NOW + 6 * 60 * MIN)) }));
    const err = await ensureGrokLogin({ ...opts(r.run), deadlineMs: 7 * 60 * MIN }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GrokLoginExpiryError);
    expect((err as Error).message).toMatch(/even the freshly refreshed login .* shorten it/);
  });

  it('lets the re-read decide when the refresh run itself throws', async () => {
    writeAuth({ 'https://auth.x.ai::a': entry(iso(NOW + 20 * MIN)) });
    const crashing = async () => {
      writeAuth({ 'https://auth.x.ai::a': entry(iso(NOW + 6 * 60 * MIN)) });
      throw new Error('killed by the watchdog');
    };
    await expect(ensureGrokLogin(opts(crashing))).resolves.toBeUndefined();
    writeAuth({ 'https://auth.x.ai::a': entry(iso(NOW + 20 * MIN)) });
    const failing = async () => {
      throw new Error('grok exploded');
    };
    await expect(ensureGrokLogin(opts(failing))).rejects.toBeInstanceOf(GrokLoginExpiryError);
  });

  it('fails closed when the expiring login vanished during the refresh', async () => {
    writeAuth({ 'https://auth.x.ai::a': entry(iso(NOW + 20 * MIN)) });
    const r = runner(() => fs.rmSync(file));
    await expect(ensureGrokLogin(opts(r.run))).rejects.toBeInstanceOf(GrokLoginExpiryError);
  });

  it('passes with no auth file, and with entries carrying no expires_at (API-key mode)', async () => {
    const r = runner();
    await expect(ensureGrokLogin(opts(r.run))).resolves.toBeUndefined();
    writeAuth({ apikey: { auth_mode: 'ApiKey', key: 'SECRET' } });
    await expect(ensureGrokLogin(opts(r.run))).resolves.toBeUndefined();
    expect(r.runs).toHaveLength(0);
  });
});

describe('isGrokLoginExpiryFailure', () => {
  it('recognizes only the pre-flight failure', () => {
    expect(isGrokLoginExpiryFailure(`${GROK_LOGIN_EXPIRY_FAIL_PREFIX}: x`)).toBe(true);
    expect(isGrokLoginExpiryFailure('the liveness watchdog cut it')).toBe(false);
    expect(isGrokLoginExpiryFailure(undefined)).toBe(false);
  });
});
