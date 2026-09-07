import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fileURLToPath } from 'node:url';

import {
  buildGrokReviewArgs,
  ensureSandboxProfile,
  extractGrokText,
  GROK_INACTIVITY_TIMEOUT_MS,
  GROK_PACKET_REVIEW_TIMEOUT_MS,
  GROK_WORKTREE_REVIEW_TIMEOUT_MS,
  parseGrokStream,
  resolveReviewSandbox,
  runGrokReview,
} from './grok';
import { REVIEW_TIMEOUT_MS } from './codex';
import type { ReviewerConfig } from '../core/types';

// The REAL captured stream (grok 1.0.5, `--output-format streaming-messages-json
// --include-partial-messages`), scrubbed of session/uuid values. The parser is pinned against what
// grok actually printed, not against a hand-written idea of it.
const STREAM_FIXTURE = fs.readFileSync(
  fileURLToPath(new URL('../../fixtures/grok/streaming-messages.ndjson', import.meta.url)),
  'utf8'
);
const STREAM_LINES = STREAM_FIXTURE.trimEnd().split('\n');
// The same stream with its terminal `result` line removed — a seat killed before it answered.
const CUT_STREAM = `${STREAM_LINES.slice(0, -1).join('\n')}\n`;

const CONFIG: ReviewerConfig = {
  cmd: 'grok',
  effort: 'high',
  id: 'grok',
  model: 'grok-4.5',
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
let lastOpts: { detached?: boolean; env?: unknown; stdio: unknown[] } = { stdio: [] };

beforeEach(() => {
  child = null;
  vi.mocked(spawn).mockImplementation(((
    _bin: string,
    _args: string[],
    opts: { detached?: boolean; env?: unknown; stdio: unknown[] }
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
  it('pins single-turn STREAMING output, the configured model+effort, the deny-by-default sandbox, and the neutral cwd', () => {
    const args = buildGrokReviewArgs(CONFIG, 'PROMPT', '/tmp/cwd');
    // single-turn: the prompt is the value of -p (reply prints to stdout).
    expect(args[args.indexOf('-p') + 1]).toBe('PROMPT');
    // THE LIVENESS PAIR. `streaming-messages-json` makes stdout an NDJSON progress stream (which is
    // what arms inactivityTimeoutMs) whose final `result` line still carries a terminal stop_reason;
    // `--include-partial-messages` is what makes the deltas flow DURING the work. A revert to the
    // one-envelope-at-the-end `json` format would silently disarm the watchdog — hence pinned.
    expect(args[args.indexOf('--output-format') + 1]).toBe('streaming-messages-json');
    expect(args).toContain('--include-partial-messages');
    expect(args.join(' ')).not.toContain('--output-format json');
    // the CONFIGURED strong model + effort, not the account default.
    expect(args[args.indexOf('-m') + 1]).toBe('grok-4.5');
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

// The three numbers the liveness work bought. The LIVENESS bar is the one that polices wedges; the
// two absolute caps are runaway backstops sized PAST honest work (grok-4.6 at xhigh legitimately
// runs 10-15 min per seat, and the old 15-min packet cap was killing that right tail).
describe('the grok seat watchdogs', () => {
  it('pins the packet + worktree backstops and the silence bar', () => {
    expect(GROK_PACKET_REVIEW_TIMEOUT_MS).toBe(30 * 60_000);
    expect(GROK_WORKTREE_REVIEW_TIMEOUT_MS).toBe(60 * 60_000);
    expect(GROK_INACTIVITY_TIMEOUT_MS).toBe(15 * 60_000);
  });

  it('keeps the silence bar STRICTLY under both backstops — otherwise it could never fire', () => {
    expect(GROK_INACTIVITY_TIMEOUT_MS).toBeLessThan(GROK_PACKET_REVIEW_TIMEOUT_MS);
    expect(GROK_INACTIVITY_TIMEOUT_MS).toBeLessThan(GROK_WORKTREE_REVIEW_TIMEOUT_MS);
  });
});

// Reading grok's NDJSON. Two rules carry the design: the reply is the `result` line (never
// reassembled from deltas — a partial review is not a review), and a broken line is skipped, never
// thrown (the watchdog kills mid-write, so a post-mortem parse must survive a half-object).
describe('parseGrokStream', () => {
  it('reads the whole reply off the result line of a REAL captured stream', () => {
    const s = parseGrokStream(STREAM_FIXTURE);
    expect(s.text).toBe('probe ok');
    expect(s.stopReason).toBe('end_turn');
    expect(s.subtype).toBe('success');
    expect(s.sawResult).toBe(true);
    expect(s.isError).toBe(false);
    expect(s.events).toBeGreaterThanOrEqual(20);
  });

  it('FAILS CLOSED on a stream cut before its result line — the deltas are never reassembled', () => {
    // The reply text IS in this stream, as `text_delta` events. Recovering it would hand
    // parseFindings a plausible HALF review that reads as a completed one with fewer findings.
    expect(CUT_STREAM).toContain('text_delta');
    const s = parseGrokStream(CUT_STREAM);
    expect(s.sawResult).toBe(false);
    expect(s.text).toBeNull();
    expect(s.stopReason).toBeNull();
    expect(s.events).toBeGreaterThan(0); // it WAS a stream — the answer just never arrived
  });

  it('ignores a trailing PARTIAL line (killed mid-write) instead of throwing', () => {
    const halfWritten = `${CUT_STREAM}${STREAM_LINES[STREAM_LINES.length - 1].slice(0, 40)}`;
    const s = parseGrokStream(halfWritten);
    expect(s.sawResult).toBe(false);
    expect(s.text).toBeNull();
  });

  it('skips a broken line mid-stream and still reads the result', () => {
    const noisy = [
      ...STREAM_LINES.slice(0, 3),
      '{"type":"stream_ev',
      ...STREAM_LINES.slice(3),
    ].join('\n');
    expect(parseGrokStream(noisy).text).toBe('probe ok');
  });

  it('skips blank lines', () => {
    expect(parseGrokStream(`\n\n${STREAM_FIXTURE}\n\n`).text).toBe('probe ok');
  });

  it('returns null when the result line reports an error', () => {
    const s = parseGrokStream(
      '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}\n'
    );
    expect(s.sawResult).toBe(true);
    expect(s.isError).toBe(true);
    expect(s.text).toBeNull();
  });

  it('returns null for a non-success subtype even when is_error is false', () => {
    const s = parseGrokStream(
      '{"type":"result","subtype":"error_max_turns","is_error":false,"result":"half an answer"}\n'
    );
    expect(s.subtype).toBe('error_max_turns');
    expect(s.text).toBeNull();
  });

  it('returns null for an empty reply — a refusal still emits a valid result line', () => {
    const s = parseGrokStream(
      '{"type":"result","subtype":"success","is_error":false,"result":"   ","stop_reason":"refusal"}\n'
    );
    expect(s.sawResult).toBe(true);
    expect(s.stopReason).toBe('refusal');
    expect(s.text).toBeNull();
  });

  it('counts NO events for the old json envelope — which is what licenses the legacy fallback', () => {
    const s = parseGrokStream('{"text":"REVIEW","stopReason":"EndTurn"}');
    expect(s.events).toBe(0);
    expect(s.sawResult).toBe(false);
    expect(s.text).toBeNull();
  });

  it('is empty-safe', () => {
    expect(parseGrokStream('')).toMatchObject({ events: 0, sawResult: false, text: null });
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

// THE LEGACY FALLBACK. Not the live path any more (parseGrokStream is), but kept and kept TESTED:
// a future grok that drops or ignores `streaming-messages-json` answers in this old shape, and the
// seat must degrade to a working review rather than crash. runGrokReview reaches it only when the
// stdout was never the NDJSON stream at all.
describe('extractGrokText (legacy envelope fallback)', () => {
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

// One NDJSON stream, as grok prints it: an init line, some work, then the terminal `result` line.
const grokStream = (reply: string): string =>
  [
    JSON.stringify({ session_id: 'S', subtype: 'init', type: 'system' }),
    JSON.stringify({ event: { type: 'message_start' }, type: 'stream_event' }),
    JSON.stringify({
      event: { delta: { text: reply, type: 'text_delta' }, type: 'content_block_delta' },
      type: 'stream_event',
    }),
    JSON.stringify({
      is_error: false,
      result: reply,
      stop_reason: 'end_turn',
      subtype: 'success',
      type: 'result',
    }),
  ].join('\n') + '\n';

describe('runGrokReview (stdout capture)', () => {
  it("captures the NDJSON stream from STDOUT (piped) and returns the result line's reply on a clean close", async () => {
    const p = runGrokReview('PROMPT', { ...CONFIG, sandbox: 'strict' });
    // stdout MUST be piped for grok (its reply is stdout, not an -o file) — and under
    // `capture: 'stdout'` that same pipe is what resets the liveness watchdog.
    expect(lastOpts.stdio[1]).toBe('pipe');
    expect(lastOpts.detached).toBe(true); // group-reapable
    child?.stdout.emit('data', Buffer.from(grokStream('REVIEW BODY')));
    child?.emit('close');
    const result = await p;
    expect(result.ok).toBe(true);
    expect(result.raw).toBe('REVIEW BODY');
    expect(result.timedOut).toBe(false);
    expect(result.timedOutReason).toBeUndefined();
  });

  it('accumulates chunked stdout before settling', async () => {
    const p = runGrokReview('PROMPT', { ...CONFIG, sandbox: 'strict' });
    const stream = grokStream('CHUNKED');
    child?.stdout.emit('data', Buffer.from(stream.slice(0, 60)));
    child?.stdout.emit('data', Buffer.from(stream.slice(60)));
    child?.emit('close');
    const result = await p;
    expect(result.raw).toBe('CHUNKED');
  });

  it('does NOT truncate when exit fires before the final stdout chunk (Codex f4)', async () => {
    const p = runGrokReview('PROMPT', { ...CONFIG, sandbox: 'strict' });
    // exit arrives BEFORE the pipe has delivered the rest of the RESULT LINE — settling on exit
    // would read a half-written terminal line, i.e. a seat that answered read as one that never
    // did. The grace defers to close.
    const stream = grokStream('FULL REVIEW');
    const split = stream.length - 30;
    child?.stdout.emit('data', Buffer.from(stream.slice(0, split)));
    child?.emit('exit');
    child?.stdout.emit('data', Buffer.from(stream.slice(split)));
    child?.emit('close');
    const result = await p;
    expect(result.raw).toBe('FULL REVIEW');
  });

  // FAIL CLOSED. This is the whole point of not reassembling deltas: a killed seat's stdout is a
  // heap of half-finished NDJSON, and the ONLY safe reading of it is "no review".
  it('fails closed on a stream cut before its result line — never the raw NDJSON as a "review"', async () => {
    const p = runGrokReview('PROMPT', { ...CONFIG, sandbox: 'strict' });
    child?.stdout.emit('data', Buffer.from(CUT_STREAM));
    child?.emit('close');
    const result = await p;
    expect(result.ok).toBe(false);
    expect(result.raw).toBeNull(); // NOT the NDJSON blob, which parseFindings would choke on
  });

  // FORMAT DRIFT DEGRADES, it does not crash: a grok that ignored the streaming flag answers in the
  // old envelope, which is not a stream at all — so the legacy extractor is allowed to take it.
  it('still reads the OLD json envelope when grok emits no stream at all', async () => {
    const p = runGrokReview('PROMPT', { ...CONFIG, sandbox: 'strict' });
    child?.stdout.emit(
      'data',
      Buffer.from(JSON.stringify({ stopReason: 'EndTurn', text: 'LEGACY REVIEW' }))
    );
    child?.emit('close');
    const result = await p;
    expect(result.ok).toBe(true);
    expect(result.raw).toBe('LEGACY REVIEW');
  });

  it('returns a bounded NDJSON tail so a seat leaves a record of what it was doing', async () => {
    const p = runGrokReview('PROMPT', { ...CONFIG, sandbox: 'strict' });
    child?.stdout.emit('data', Buffer.from(grokStream('REVIEW BODY')));
    child?.emit('close');
    const result = await p;
    expect(result.stream).toContain('"type":"stream_event"');
    expect(result.stream).toContain('"subtype":"success"');
  });

  it('kills the child (group-aware) when the absolute backstop fires, and names that watchdog', async () => {
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
    expect(result.timedOutReason).toBe('absolute');
    expect(result.failWhy).toBeUndefined(); // it was still working — not a wedge
    expect(result.ok).toBe(false);
    expect(result.raw).toBeNull();
  });

  // THE POINT OF THE WHOLE CHANGE. A seat that goes silent is reclaimed at the SILENCE bar, long
  // before the runaway backstop, and it names itself so the trail never confuses a wedge with an
  // honest seat the backstop cut.
  it('reclaims a SILENT seat at the liveness bar and says so', async () => {
    vi.useFakeTimers();
    const p = runGrokReview('PROMPT', { ...CONFIG, sandbox: 'strict' });
    // It spoke once, then went quiet — so the rolling bar is armed and reset, not never-started.
    child?.stdout.emit('data', Buffer.from('{"type":"system","subtype":"init"}\n'));
    vi.advanceTimersByTime(GROK_INACTIVITY_TIMEOUT_MS + 1_000);
    expect(child?.kills[0]).toBe('SIGTERM');
    child?.emit('close');
    const result = await p;
    expect(result.timedOut).toBe(true);
    expect(result.timedOutReason).toBe('inactivity');
    expect(result.failWhy).toBe('the liveness watchdog cut it after 15 min of silence');
    expect(result.ok).toBe(false);
    expect(result.raw).toBeNull();
  });

  // The other half of the bargain: the bar reclaims wedges, it does not police honest work. Two
  // 14-min stretches of silence — 28 min of work, which the OLD 15-min packet cap would have
  // killed outright — and the rolling reset carries it through untouched.
  it('a seat that keeps streaming is NEVER cut by the liveness bar', async () => {
    vi.useFakeTimers();
    const p = runGrokReview('PROMPT', { ...CONFIG, sandbox: 'strict' });
    const almost = GROK_INACTIVITY_TIMEOUT_MS - 60_000; // 14 min of quiet, then a heartbeat
    for (let i = 0; i < 2; i++) {
      child?.stdout.emit('data', Buffer.from(`{"type":"stream_event","n":${i}}\n`));
      vi.advanceTimersByTime(almost);
    }
    expect(2 * almost).toBeGreaterThan(REVIEW_TIMEOUT_MS); // the budget this change bought back
    expect(2 * almost).toBeLessThan(GROK_PACKET_REVIEW_TIMEOUT_MS); // still inside the backstop
    expect(child?.kills).toHaveLength(0);
    child?.stdout.emit('data', Buffer.from(grokStream('SLOW BUT HONEST')));
    child?.emit('close');
    const result = await p;
    expect(result.timedOut).toBe(false);
    expect(result.raw).toBe('SLOW BUT HONEST');
  });
});

// WORKTREE EVIDENCE QUALIFICATION (codex-f3). resolveReviewSandbox admits `strict` as well as
// `ensemble-review`, but only `ensemble-review` carries the secret deny-list, and that is the CLI
// profile (GROK_CLI_SANDBOX) the receipt's id attests a seat ran behind. Handing a `strict` seat the
// whole project would attest a profile it never ran under, so the seat must fail closed instead.
describe('runGrokReview — the worktree is only granted under the QUALIFYING sandbox', () => {
  it('refuses the worktree under `strict`, and says why, without spawning', async () => {
    const spawned = vi.mocked(spawn);
    spawned.mockClear();
    const result = await runGrokReview('p', { ...CONFIG, sandbox: 'strict' }, {
      worktree: '/private/tmp/wt',
    });
    expect(result.ok).toBe(false);
    expect(result.raw).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderrTail).toMatch(/refusing worktree evidence/);
    expect(result.stderrTail).toMatch(/ensemble-review/);
    expect(spawned).not.toHaveBeenCalled();
  });

  // A failed seat, never a thrown one: the orchestrator records it, it cannot qualify a receipt.
  it('resolves rather than rejects, so an adapter caller never sees an unhandled rejection', async () => {
    await expect(
      runGrokReview('p', { ...CONFIG, sandbox: 'strict' }, { worktree: '/private/tmp/wt' })
    ).resolves.toMatchObject({ ok: false });
  });
});

// THE EGRESS FENCE, grok half (codex-f3). grok honors the standard proxy env vars — PROBED
// 2026-07-10 the same way codex was: a logging CONNECT proxy saw its `cli-chat-proxy.grok.com:443`
// tunnel. So its worktree seat is spawned pointed at the engine's proxy, which allows that host plus
// `auth.x.ai` (the bearer-auth endpoint the chat proxy's token comes from) and refuses everything
// else (its `api.mixpanel.com` telemetry included).
describe('runGrokReview — the worktree seat is fenced by the egress proxy', () => {
  it('hands the worktree seat the proxy env, with NO_PROXY forced empty', async () => {
    const spawned = vi.mocked(spawn);
    spawned.mockClear();
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-wt-'));
    const run = runGrokReview('p', CONFIG, { timeoutMs: 10_000, worktree: wt });
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());

    const env = lastOpts.env as Record<string, string>;
    expect(env.HTTPS_PROXY).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(env.ALL_PROXY).toBe(env.HTTPS_PROXY);
    expect(env.NO_PROXY).toBe('');
    child?.emit('exit');
    await run;
    fs.rmSync(wt, { force: true, recursive: true });
  });

  // A PACKET seat has no untrusted tree to be injected from, and its receipt attests no fence — so
  // it is spawned exactly as before, with no proxy env at all.
  it('leaves the packet path unfenced and unchanged — no proxy env', async () => {
    const spawned = vi.mocked(spawn);
    spawned.mockClear();
    const run = runGrokReview('p', CONFIG, { timeoutMs: 10_000 });
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    expect(lastOpts.env).toBeUndefined();
    child?.emit('exit');
    await run;
  });

  // THE TEARDOWN IS UNCONDITIONAL. `ensureSandboxProfile`, `resolveGrokBin` and `runReviewerExec`
  // all sit between "the proxy is listening" and "the reply came back", and each can throw. On the
  // old `.then()`-only teardown the proxy's listening server survived the throw — and because the
  // CLI sets `process.exitCode` instead of calling `process.exit()`, that live handle kept the
  // event loop alive and the run never exited. Assert the socket is actually GONE, not just that a
  // close() was called.
  it('closes the proxy when the spawn path throws, so no listening fence outlives the seat', async () => {
    const spawned = vi.mocked(spawn);
    spawned.mockClear();
    let port = 0;
    spawned.mockImplementation(((
      _bin: string,
      _args: string[],
      opts: { env?: Record<string, string> }
    ) => {
      port = Number(new URL(opts.env?.HTTPS_PROXY ?? '').port);
      throw new Error('spawn exploded');
    }) as unknown as typeof spawn);

    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-wt-'));
    try {
      await expect(
        runGrokReview('p', CONFIG, { timeoutMs: 10_000, worktree: wt })
      ).rejects.toThrow('spawn exploded');
      expect(port).toBeGreaterThan(0);
      await expect(dial(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      fs.rmSync(wt, { force: true, recursive: true });
    }
  });
});

// Connect to a loopback port, or reject with the OS error — the proof that a proxy is really down.
function dial(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => {
      s.destroy();
      resolve();
    });
    s.on('error', reject);
  });
}
