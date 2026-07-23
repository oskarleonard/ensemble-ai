import { describe, expect, it } from 'vitest';

import { buildClaudeReviewArgs } from './claude';
import {
  CLAUDE_REVIEWER_SEAT_DEFAULTS,
  type GateSeatFlags,
  resolveClaudeReviewerSeat,
  resolveGateSeat,
} from './gate-seat';

// Collect warnings so a test can assert both the resolved seat AND that the fall-back was LOUD.
function resolve(raw: unknown, flags: GateSeatFlags = {}) {
  const warnings: string[] = [];
  const seat = resolveGateSeat(raw, flags, (m) => warnings.push(m));
  return { seat, warnings };
}

// The gate argv the run actually spawns — the model/effort resolution is only meaningful through
// buildClaudeReviewArgs, so every case asserts the ARGV, not just the intermediate config.
const gateArgv = (raw: unknown, flags: GateSeatFlags = {}) =>
  buildClaudeReviewArgs('P', resolve(raw, flags).seat.config);

// today's default gate argv (no --model/--effort → the CLI's Opus default) — DC6 baseline.
const DEFAULT_ARGV = buildClaudeReviewArgs('P', {
  cmd: 'claude',
  effort: 'default',
  id: 'claude',
  model: 'default',
  vendor: 'anthropic',
});

describe('resolveGateSeat — per-seat gate model/effort (done-criterion 6)', () => {
  it('no config ⇒ gate argv identical to today\'s defaults (Opus, no --model/--effort)', () => {
    expect(gateArgv({})).toEqual(DEFAULT_ARGV);
    expect(gateArgv(undefined)).toEqual(DEFAULT_ARGV);
    const { seat } = resolve({});
    expect(seat.config.model).toBe('default');
    expect(seat.config.effort).toBe('default');
    expect(seat.modelSource).toBe('default');
    expect(seat.effortSource).toBe('default');
    expect(gateArgv({})).not.toContain('--model');
    expect(gateArgv({})).not.toContain('--effort');
  });

  it('a `gate` entry ⇒ gate argv carries --model fable --effort max', () => {
    const args = gateArgv({ gate: { effort: 'max', model: 'fable' } });
    expect(args[args.indexOf('--model') + 1]).toBe('fable');
    expect(args[args.indexOf('--effort') + 1]).toBe('max');
    const { seat } = resolve({ gate: { effort: 'max', model: 'fable' } });
    expect(seat.modelSource).toBe('file');
    expect(seat.effortSource).toBe('file');
  });

  it('the Opus-reviewer argv is UNCHANGED when only the gate seat is configured', () => {
    // The reviewer reads the `claude` voice (absent here → default), NOT the gate seat: the two
    // seats DIVERGE. The reviewer stays on the built-in default while the gate flips to fable.
    const reviewerArgv = buildClaudeReviewArgs('P', {
      cmd: 'claude',
      effort: 'default',
      id: 'claude',
      model: 'default',
      vendor: 'anthropic',
    });
    expect(reviewerArgv).toEqual(DEFAULT_ARGV);
    expect(reviewerArgv).not.toContain('--model');
    expect(gateArgv({ gate: { effort: 'max', model: 'fable' } })).toContain('fable');
  });

  it('missing `gate` + present `claude` ⇒ inherits the claude voice model/effort', () => {
    const raw = { claude: { effort: 'high', model: 'sonnet' } };
    const args = gateArgv(raw);
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    const { seat } = resolve(raw);
    expect(seat.modelSource).toBe('file');
    expect(seat.effortSource).toBe('file');
  });

  it('a `gate` entry OVERRIDES an inherited claude voice (gate wins over claude)', () => {
    const raw = { claude: { effort: 'high', model: 'sonnet' }, gate: { effort: 'max', model: 'fable' } };
    const args = gateArgv(raw);
    expect(args[args.indexOf('--model') + 1]).toBe('fable');
    expect(args[args.indexOf('--effort') + 1]).toBe('max');
  });

  it('junk `gate` (not an object) ⇒ falls back + warns + still runs', () => {
    const { seat, warnings } = resolve({ gate: 'opus' });
    expect(seat.config.model).toBe('default');
    expect(seat.config.effort).toBe('default');
    expect(warnings.some((w) => w.includes('expected an object'))).toBe(true);
    // still a usable seat → still spawns the default gate
    expect(gateArgv({ gate: 'opus' })).toEqual(DEFAULT_ARGV);
  });

  it('junk `gate` field (model not a string) ⇒ falls back to claude/default + warns', () => {
    const { seat, warnings } = resolve({ claude: { model: 'sonnet' }, gate: { model: 42 } });
    expect(seat.config.model).toBe('sonnet'); // inherited, not the junk 42
    expect(warnings.some((w) => w.includes('`model` must be a non-empty string'))).toBe(true);
  });

  it('a `cmd` key on `gate` ⇒ ignored + warned, spawn stays `claude -p`', () => {
    const raw = { gate: { cmd: 'grok', model: 'fable' } };
    const { seat, warnings } = resolve(raw);
    expect(seat.config.cmd).toBe('claude'); // never the config's cmd
    expect(warnings.some((w) => w.includes('`cmd` is ignored'))).toBe(true);
    // model still applies; the deny-list belt (proof the spawn stays claude -p) is present
    const args = gateArgv(raw);
    expect(args.slice(0, 2)).toEqual(['-p', 'P']);
    expect(args[args.indexOf('--model') + 1]).toBe('fable');
    expect(args).toContain('--disallowedTools');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
  });

  it('flags beat file — --gate-model / --gate-effort override the `gate` entry', () => {
    const raw = { gate: { effort: 'max', model: 'fable' } };
    const args = gateArgv(raw, { effort: 'high', model: 'opus' });
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
    const { seat } = resolve(raw, { effort: 'high', model: 'opus' });
    expect(seat.modelSource).toBe('flag');
    expect(seat.effortSource).toBe('flag');
  });

  it('flags beat an inherited claude voice too', () => {
    const raw = { claude: { effort: 'low', model: 'sonnet' } };
    const args = gateArgv(raw, { model: 'opus' });
    expect(args[args.indexOf('--model') + 1]).toBe('opus');
    // effort not flagged → still inherits the claude voice's
    expect(args[args.indexOf('--effort') + 1]).toBe('low');
    expect(resolve(raw, { model: 'opus' }).seat.effortSource).toBe('file');
  });

  it('a --gate-effort outside the CLAUDE_EFFORTS whitelist is ignored (+ warned), falls to file', () => {
    const raw = { gate: { effort: 'max', model: 'fable' } };
    const { seat, warnings } = resolve(raw, { effort: 'ludicrous' });
    expect(seat.config.effort).toBe('max'); // the bogus flag did NOT win; the file value stands
    expect(seat.effortSource).toBe('file');
    expect(warnings.some((w) => w.includes('not a known effort'))).toBe(true);
  });

  // codex-f1 / grok-f1: a FILE effort outside the whitelist must NOT resolve to source:'file' and
  // be advertised by `config` while buildClaudeReviewArgs silently drops it — the file path is now
  // validated with the same whitelist as the flag path.
  it('a FILE gate.effort outside the whitelist warns + falls back (never advertised as file)', () => {
    const raw = { gate: { effort: 'ludicrous', model: 'fable' } };
    const { seat, warnings } = resolve(raw);
    expect(seat.config.effort).toBe('default'); // dropped, not the bogus value
    expect(seat.effortSource).toBe('default');
    expect(warnings.some((w) => w.includes('not a known effort'))).toBe(true);
    // the model still resolves; the argv carries no --effort (matches the spawn), not a bad one
    const args = gateArgv(raw);
    expect(args[args.indexOf('--model') + 1]).toBe('fable');
    expect(args).not.toContain('--effort');
  });

  it('an invalid FILE gate.effort falls through to a valid claude.effort (per-link validation)', () => {
    const raw = { claude: { effort: 'high' }, gate: { effort: 'ludicrous', model: 'fable' } };
    const { seat, warnings } = resolve(raw);
    expect(seat.config.effort).toBe('high'); // inherited the valid claude link, not 'default'
    expect(seat.effortSource).toBe('file');
    expect(warnings.some((w) => w.includes('not a known effort'))).toBe(true);
  });
});

describe('loadGateSeat — file-failure loudness + the default sentinel (dogfood fixes)', () => {
  it('warns on a malformed voices.json (loud, never silent) and still resolves the default seat', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { loadGateSeat } = await import('./gate-seat');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-gate-seat-'));
    const file = path.join(dir, 'voices.json');
    fs.writeFileSync(file, '{ not json');
    const warnings: string[] = [];
    const seat = loadGateSeat(file, {}, (m) => warnings.push(m));
    expect(warnings.some((w) => w.includes('could not read'))).toBe(true);
    expect(seat.config.model).toBe('default');
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it('stays silent on a MISSING voices.json (the normal zero-config case)', async () => {
    const { loadGateSeat } = await import('./gate-seat');
    const warnings: string[] = [];
    const seat = loadGateSeat('/nonexistent/ea-gate-seat/voices.json', {}, (m) => warnings.push(m));
    expect(warnings).toEqual([]);
    expect(seat.config.model).toBe('default');
  });

  it("treats an explicit 'default' effort/model as the documented sentinel — no spurious warning, falls through", () => {
    const warnings: string[] = [];
    const seat = resolveGateSeat(
      { claude: { effort: 'high' }, gate: { effort: 'default', model: 'default' } },
      {} as GateSeatFlags,
      (m) => warnings.push(m),
    );
    expect(warnings).toEqual([]);
    expect(seat.config.effort).toBe('high');
    expect(seat.effortSource).toBe('file');
    expect(seat.config.model).toBe('default');
    expect(seat.modelSource).toBe('default');
  });
});

// The claude REVIEWER seat: unlike the gate, its chain NEVER ends at the 'default' sentinel —
// a headless seat must not inherit the operator's interactive CLI default (the 2026-07-23 fire
// inherited a fresh `/model` switch to Fable 5 and the leg died on its cap).
describe('resolveClaudeReviewerSeat — headless seat never rides the CLI default', () => {
  function resolveClaude(raw: unknown, flags: GateSeatFlags = {}) {
    const warnings: string[] = [];
    const seat = resolveClaudeReviewerSeat(raw, flags, (m) => warnings.push(m));
    return { seat, warnings };
  }

  it('no config ⇒ the BAKED opus @ max, and the argv PINS the model', () => {
    const { seat, warnings } = resolveClaude({});
    expect(warnings).toEqual([]);
    expect(seat.config.model).toBe(CLAUDE_REVIEWER_SEAT_DEFAULTS.model);
    expect(seat.config.effort).toBe(CLAUDE_REVIEWER_SEAT_DEFAULTS.effort);
    expect(seat.modelSource).toBe('default');
    const argv = buildClaudeReviewArgs('P', seat.config);
    expect(argv).toContain('--model');
    expect(argv).toContain('opus');
    expect(argv).toContain('--effort');
    expect(argv).toContain('max');
  });

  it("an explicit 'default' in the file falls through to the BAKED opus — never to no-flag", () => {
    const { seat, warnings } = resolveClaude({ claude: { effort: 'default', model: 'default' } });
    expect(warnings).toEqual([]);
    expect(seat.config.model).toBe('opus');
    expect(seat.modelSource).toBe('default');
    expect(buildClaudeReviewArgs('P', seat.config)).toContain('--model');
  });

  it('the voices.json `claude` entry overrides the baked default', () => {
    const { seat } = resolveClaude({ claude: { effort: 'high', model: 'sonnet' } });
    expect(seat.config.model).toBe('sonnet');
    expect(seat.modelSource).toBe('file');
    expect(seat.config.effort).toBe('high');
    expect(seat.effortSource).toBe('file');
  });

  it('--claude-model/--claude-effort beat the file', () => {
    const { seat } = resolveClaude(
      { claude: { effort: 'high', model: 'sonnet' } },
      { effort: 'xhigh', model: 'opus' },
    );
    expect(seat.config.model).toBe('opus');
    expect(seat.modelSource).toBe('flag');
    expect(seat.config.effort).toBe('xhigh');
    expect(seat.effortSource).toBe('flag');
  });

  it('an unknown --claude-effort is ignored + warned; the chain continues', () => {
    const { seat, warnings } = resolveClaude({}, { effort: 'ultra' });
    expect(warnings.some((w) => w.includes('--claude-effort "ultra"'))).toBe(true);
    expect(seat.config.effort).toBe('max');
    expect(seat.effortSource).toBe('default');
  });

  it('a junk file effort warns and falls back to the baked value — never resolves as file', () => {
    const { seat, warnings } = resolveClaude({ claude: { effort: 'turbo' } });
    expect(warnings.some((w) => w.includes('"turbo"'))).toBe(true);
    expect(seat.config.effort).toBe('max');
    expect(seat.effortSource).toBe('default');
  });
});
