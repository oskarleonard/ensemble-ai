import { describe, expect, it } from 'vitest';

import { buildClaudeReviewArgs } from './claude';
import { resolveGateSeat, type GateSeatFlags } from './gate-seat';

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
