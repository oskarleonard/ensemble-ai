import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildGrokReviewArgs,
  ensureSandboxProfile,
  extractGrokText,
  resolveReviewSandbox,
  runGrokReview,
} from './grok';
import type { ReviewerConfig } from '../core/types';

const CONFIG: ReviewerConfig = {
  cmd: 'grok',
  effort: 'high',
  id: 'grok',
  model: 'grok-build',
  sandbox: 'ensemble-review',
  vendor: 'xai',
};

// Mock just `spawn` (keep the rest real), and stub resolveBin so resolveGrokBin
// never shells out to find grok. The real watchdog/spawn primitive stays — we're
// asserting runGrokReview WIRES the stdout-capture path through it.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));
vi.mock('../core/bin', () => ({ resolveBin: () => 'grok' }));

type FakeChild = EventEmitter & {
  kill: (sig: string) => void;
  kills: string[];
  stderr: EventEmitter;
  stdout: EventEmitter;
};

let child: FakeChild | null = null;
let lastOpts: { detached?: boolean; stdio: unknown[] } = { stdio: [] };

beforeEach(() => {
  child = null;
  vi.mocked(spawn).mockImplementation(((
    _bin: string,
    _args: string[],
    opts: { detached?: boolean; stdio: unknown[] }
  ) => {
    const c = new EventEmitter() as FakeChild;
    c.kills = [];
    c.kill = (sig: string) => {
      c.kills.push(sig);
    };
    c.stderr = new EventEmitter();
    c.stdout = new EventEmitter();
    child = c;
    lastOpts = opts;
    return c;
  }) as unknown as typeof spawn);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('buildGrokReviewArgs', () => {
  it('pins single-turn JSON output, the configured model+effort, the deny-by-default sandbox, and the neutral cwd', () => {
    const args = buildGrokReviewArgs(CONFIG, 'PROMPT', '/tmp/cwd');
    // single-turn: the prompt is the value of -p (reply prints to stdout).
    expect(args[args.indexOf('-p') + 1]).toBe('PROMPT');
    // the JSON envelope (gives a stopReason terminal signal).
    expect(args[args.indexOf('--output-format') + 1]).toBe('json');
    // the CONFIGURED strong model + effort, not the account default.
    expect(args[args.indexOf('-m') + 1]).toBe('grok-build');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    // THE boundary: an OS-enforced deny-by-default sandbox profile (never tool-denial).
    expect(args[args.indexOf('--sandbox') + 1]).toBe('ensemble-review');
    // the diff is IN the prompt → grok runs from a neutral throwaway cwd.
    expect(args[args.indexOf('--cwd') + 1]).toBe('/tmp/cwd');
    // defense in depth (NOT the boundary).
    expect(args).toContain('--disable-web-search');
    expect(args[args.indexOf('--disallowed-tools') + 1]).toBe(
      'bash,search_replace'
    );
    expect(args).toContain('--no-memory');
    // the unreliable structured-output path is NEVER used (freeform + parseFindings).
    expect(args.join(' ')).not.toContain('--json-schema');
  });

  it('falls back to the hardened default profile when no sandbox is configured', () => {
    const args = buildGrokReviewArgs(
      { ...CONFIG, sandbox: undefined },
      'P',
      '/c'
    );
    expect(args[args.indexOf('--sandbox') + 1]).toBe('ensemble-review');
  });

  it('REFUSES a writable/permissive profile — the boundary is not config-disablable', () => {
    for (const weak of ['off', 'workspace', 'devbox', 'totally-made-up']) {
      const args = buildGrokReviewArgs({ ...CONFIG, sandbox: weak }, 'P', '/c');
      // A config that tries to weaken the boundary is forced back to the hardened
      // default — never passed through to grok's --sandbox (Codex f1).
      expect(args[args.indexOf('--sandbox') + 1]).toBe('ensemble-review');
    }
  });
});

describe('resolveReviewSandbox', () => {
  it('keeps a proven deny-by-default profile', () => {
    expect(resolveReviewSandbox('strict')).toBe('strict');
    expect(resolveReviewSandbox('ensemble-review')).toBe('ensemble-review');
  });

  it('rejects read-everywhere / writable / unknown profiles (→ hardened default)', () => {
    // read-only blocks WRITES but READS EVERYWHERE → rejected for reviewers (f2).
    expect(resolveReviewSandbox('read-only')).toBe('ensemble-review');
    expect(resolveReviewSandbox('off')).toBe('ensemble-review');
    expect(resolveReviewSandbox('workspace')).toBe('ensemble-review');
    expect(resolveReviewSandbox('devbox')).toBe('ensemble-review');
    expect(resolveReviewSandbox('my-writable-profile')).toBe('ensemble-review');
    expect(resolveReviewSandbox(undefined)).toBe('ensemble-review');
    expect(resolveReviewSandbox('')).toBe('ensemble-review');
  });
});

describe('extractGrokText', () => {
  it('pulls .text out of the --output-format json envelope', () => {
    const env = JSON.stringify({
      sessionId: 'x',
      stopReason: 'EndTurn',
      text: '```json\n{"summary":"ok","findings":[]}\n```',
    });
    expect(extractGrokText(env)).toContain('"summary":"ok"');
  });

  it('falls back to the raw stdout when it is not the expected envelope', () => {
    expect(extractGrokText('just some text')).toBe('just some text');
  });

  it('returns null for empty stdout', () => {
    expect(extractGrokText('   ')).toBeNull();
  });

  it('returns null (not the envelope JSON) when the envelope parses but .text is empty', () => {
    // A refusal / length-stop emits a VALID envelope with text: "". The reply must
    // be treated as "no usable review" → null (→ failed-reviewer), never returned
    // verbatim — else parseFindings reads the envelope as an empty "reviewed" run.
    expect(extractGrokText('{"text":"","stopReason":"refusal"}')).toBeNull();
    expect(extractGrokText('{"stopReason":"length"}')).toBeNull();
  });
});

describe('ensureSandboxProfile', () => {
  it('is a no-op for a built-in profile (grok already knows it)', () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'grok-sbx-')),
      'sandbox.toml'
    );
    ensureSandboxProfile('read-only', file);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('provisions the ensemble-review profile (strict base + secret deny) when absent', () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'grok-sbx-')),
      'sandbox.toml'
    );
    ensureSandboxProfile('ensemble-review', file);
    const toml = fs.readFileSync(file, 'utf8');
    expect(toml).toContain('[profiles.ensemble-review]');
    expect(toml).toContain('extends = "strict"'); // deny-by-default reads (f2)
    expect(toml).not.toContain('extends = "read-only"');
    expect(toml).toContain('deny =');
  });

  it('is idempotent and never clobbers an existing sandbox.toml', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-sbx-'));
    const file = path.join(dir, 'sandbox.toml');
    fs.writeFileSync(file, '[profiles.mine]\nextends = "workspace"\n');
    ensureSandboxProfile('ensemble-review', file);
    const toml = fs.readFileSync(file, 'utf8');
    expect(toml).toContain('[profiles.mine]'); // preserved
    expect(toml).toContain('[profiles.ensemble-review]'); // appended
    ensureSandboxProfile('ensemble-review', file); // second call
    const again = fs.readFileSync(file, 'utf8');
    expect(again.match(/\[profiles.ensemble-review\]/g)).toHaveLength(1); // not duplicated
  });

  it('REPLACES a stale ensemble-review block (read-only → strict) in place, keeping other profiles (f2)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-sbx-'));
    const file = path.join(dir, 'sandbox.toml');
    // the leaky profile a pre-f2 build provisioned, beside a user-owned profile
    fs.writeFileSync(
      file,
      '[profiles.mine]\nextends = "workspace"\n\n' +
        "# ensemble-review — the cross-vendor Grok reviewer's sandbox (ensemble-ai).\n" +
        '# read-only base (no repo/home writes) + kernel-deny secret reads.\n' +
        '[profiles.ensemble-review]\nextends = "read-only"\ndeny = ["**/.env"]\n'
    );
    ensureSandboxProfile('ensemble-review', file);
    const toml = fs.readFileSync(file, 'utf8');
    expect(toml).toContain('extends = "strict"'); // upgraded to deny-by-default
    expect(toml).not.toContain('extends = "read-only"'); // stale base gone
    expect(toml).toContain('[profiles.mine]'); // user profile preserved
    expect(toml.match(/\[profiles.ensemble-review\]/g)).toHaveLength(1); // not duplicated
    ensureSandboxProfile('ensemble-review', file); // now-current → idempotent
    expect(fs.readFileSync(file, 'utf8')).toBe(toml);
  });
});

describe('runGrokReview (stdout capture)', () => {
  it('captures the reply from STDOUT (piped) and returns the envelope .text on a clean close', async () => {
    const p = runGrokReview('PROMPT', { ...CONFIG, sandbox: 'strict' });
    // stdout MUST be piped for grok (its reply is stdout, not an -o file).
    expect(lastOpts.stdio[1]).toBe('pipe');
    expect(lastOpts.detached).toBe(true); // group-reapable
    child?.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({ stopReason: 'EndTurn', text: 'REVIEW BODY' })
      )
    );
    child?.emit('close');
    const result = await p;
    expect(result.ok).toBe(true);
    expect(result.raw).toBe('REVIEW BODY');
    expect(result.timedOut).toBe(false);
  });

  it('accumulates chunked stdout before settling', async () => {
    const p = runGrokReview('PROMPT', { ...CONFIG, sandbox: 'strict' });
    const env = JSON.stringify({ stopReason: 'EndTurn', text: 'CHUNKED' });
    child?.stdout.emit('data', Buffer.from(env.slice(0, 10)));
    child?.stdout.emit('data', Buffer.from(env.slice(10)));
    child?.emit('close');
    const result = await p;
    expect(result.raw).toBe('CHUNKED');
  });

  it('does NOT truncate when exit fires before the final stdout chunk (Codex f4)', async () => {
    const p = runGrokReview('PROMPT', { ...CONFIG, sandbox: 'strict' });
    // exit arrives BEFORE the pipe has delivered the rest of the envelope — the old
    // settle-on-exit read a truncated (invalid) JSON here. The grace defers to close.
    child?.stdout.emit('data', Buffer.from('{"text":"FULL'));
    child?.emit('exit');
    child?.stdout.emit('data', Buffer.from(' REVIEW"}'));
    child?.emit('close');
    const result = await p;
    expect(result.raw).toBe('FULL REVIEW'); // the whole envelope, not 'FULL'
  });

  it('kills the child (group-aware) when the watchdog fires, and reports null/timedOut', async () => {
    const p = runGrokReview(
      'PROMPT',
      {
        ...CONFIG,
        sandbox: 'strict',
      },
      { timeoutMs: 20 }
    );
    await new Promise((r) => setTimeout(r, 45)); // let the watchdog fire
    expect(child?.kills[0]).toBe('SIGTERM');
    child?.emit('close');
    const result = await p;
    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.raw).toBeNull();
  });
});
