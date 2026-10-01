import { describe, expect, it } from 'vitest';

import { buildClaudeReviewArgs } from './claude';
import {
  CLAUDE_REVIEWER_SEAT_DEFAULTS,
  type GateSeatFlags,
  resolveClaudeReviewerSeat,
  resolveGateSeat,
  shadowChampionConfig,
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

// ── The VENDOR axis (the sol-gate promotion, 2026-09-06) ────────────────────────────────
describe('resolveGateSeat — vendor axis (anthropic default · codex = the shadow-proven judge)', () => {
  const warnAll = (): { warn: (m: string) => void; warnings: string[] } => {
    const warnings: string[] = [];
    return { warn: (m) => warnings.push(m), warnings };
  };

  it('defaults to anthropic — pre-vendor configs resolve byte-identically', () => {
    const seat = resolveGateSeat({}, {}, () => {});
    expect(seat.vendor).toBe('anthropic');
    expect(seat.vendorSource).toBe('default');
    expect(seat.config.cmd).toBe('claude');
    expect(seat.config.vendor).toBe('anthropic');
  });

  it('--gate-vendor codex resolves the shadow-proven baked seat (gpt-5.6-sol @ xhigh, codex identity)', () => {
    const seat = resolveGateSeat({}, { vendor: 'codex' }, () => {});
    expect(seat.vendor).toBe('codex');
    expect(seat.vendorSource).toBe('flag');
    expect(seat.config).toMatchObject({ cmd: 'codex', id: 'codex', vendor: 'openai', model: 'gpt-5.6-sol', effort: 'xhigh' });
    expect(seat.modelSource).toBe('default');
    expect(seat.effortSource).toBe('default');
  });

  it('a voices.json `gate.vendor: codex` entry carries its own model/effort — `ultra` is a KNOWN codex effort', () => {
    const seat = resolveGateSeat({ gate: { effort: 'ultra', model: 'gpt-5.6-terra', vendor: 'codex' } }, {}, () => {});
    expect(seat).toMatchObject({ vendor: 'codex', vendorSource: 'file', effortSource: 'file', modelSource: 'file' });
    expect(seat.config).toMatchObject({ model: 'gpt-5.6-terra', effort: 'ultra' });
  });

  it('the codex chain NEVER inherits from the claude voice — cross-vendor inheritance is meaningless', () => {
    const seat = resolveGateSeat({ claude: { effort: 'high', model: 'opus' }, gate: { vendor: 'codex' } }, {}, () => {});
    expect(seat.config.model).toBe('gpt-5.6-sol');
    expect(seat.config.effort).toBe('xhigh');
  });

  it('a junk codex effort warns and falls to the baked xhigh (junk never disables or re-tiers the seat)', () => {
    const { warn, warnings } = warnAll();
    const seat = resolveGateSeat({ gate: { effort: 'turbo', vendor: 'codex' } }, {}, warn);
    expect(seat.config.effort).toBe('xhigh');
    expect(warnings.some((w) => w.includes('not a known codex effort'))).toBe(true);
  });

  it('a junk vendor warns and stays anthropic — flag and file alike', () => {
    const { warn, warnings } = warnAll();
    expect(resolveGateSeat({}, { vendor: 'xai' }, warn).vendor).toBe('anthropic');
    expect(resolveGateSeat({ gate: { vendor: 'google' } }, {}, warn).vendor).toBe('anthropic');
    expect(warnings).toHaveLength(2);
  });

  it('the vendor FLAG beats the file, and the entry\'s model/effort do NOT follow across vendors', () => {
    const { warn, warnings } = warnAll();
    const seat = resolveGateSeat({ gate: { model: 'gpt-5.6-sol', vendor: 'codex' } }, { vendor: 'anthropic' }, warn);
    expect(seat.vendor).toBe('anthropic');
    expect(seat.vendorSource).toBe('flag');
    // "gpt-5.6-sol" into a claude spawn is an unknown-model death — the codex-scoped entry is
    // skipped LOUDLY and the anthropic chain falls to its own defaults.
    expect(seat.config.cmd).toBe('claude');
    expect(seat.config.model).not.toBe('gpt-5.6-sol');
    expect(warnings.some((w) => w.includes('codex-scoped'))).toBe(true);
  });

  it('the inverse: an anthropic-scoped entry never leaks its model into a codex gate', () => {
    const { warn, warnings } = warnAll();
    const seat = resolveGateSeat({ gate: { effort: 'max', model: 'fable' } }, { vendor: 'codex' }, warn);
    expect(seat.config).toMatchObject({ cmd: 'codex', model: 'gpt-5.6-sol', effort: 'xhigh' });
    expect(warnings.some((w) => w.includes('anthropic-scoped'))).toBe(true);
  });

  it('`cmd` on a codex-vendor entry is still ignored + warned — the runner binding is code', () => {
    const { warn, warnings } = warnAll();
    const seat = resolveGateSeat({ gate: { cmd: 'bash', vendor: 'codex' } }, {}, warn);
    expect(seat.config.cmd).toBe('codex');
    expect(warnings.some((w) => w.includes('`cmd` is ignored'))).toBe(true);
  });
});

describe('the advisor on the gate + claude reviewer seats — own entry only, never inherited (one re-vendoring exception)', () => {
  const settingsOf = (args: string[]): unknown =>
    args.includes('--settings') ? JSON.parse(args[args.indexOf('--settings') + 1]) : undefined;

  it('the gate reads its OWN `gate.advisor` and the argv carries it', () => {
    const { seat } = resolve({ gate: { advisor: 'claude-fable-5-1', model: 'opus' } });
    expect(seat.config.advisor).toBe('claude-fable-5-1');
    expect(settingsOf(buildClaudeReviewArgs('P', seat.config))).toEqual({ advisorModel: 'claude-fable-5-1' });
    expect(resolve({ gate: { advisor: 'off' } }).seat.config.advisor).toBe('off');
  });

  it('NO gate → claude inheritance: a claude-entry advisor leaves the gate inheriting the operator setting', () => {
    const { seat } = resolve({ claude: { advisor: 'off', model: 'opus' }, gate: { model: 'fable' } });
    expect(seat.config).not.toHaveProperty('advisor');
    expect(gateArgv({ claude: { advisor: 'off' } })).toEqual(DEFAULT_ARGV);
  });

  it('a codex gate ignores the advisor LOUDLY, and a re-vendoring flag never carries it across', () => {
    const codex = resolve({ gate: { advisor: 'off', vendor: 'codex' } });
    expect(codex.seat.vendor).toBe('codex');
    expect(codex.seat.config).not.toHaveProperty('advisor');
    expect(codex.warnings.some((w) => w.includes('`advisor` is ignored'))).toBe(true);
    // A codex-scoped entry with an advisor, flagged back to anthropic: its own advisor is still not
    // applied — and with no `claude` entry advisor, the gate inherits.
    const flagged = resolve({ gate: { advisor: 'off', vendor: 'codex' } }, { vendor: 'anthropic' });
    expect(flagged.seat.vendor).toBe('anthropic');
    expect(flagged.seat.config).not.toHaveProperty('advisor');
    expect(flagged.warnings.some((w) => w.includes('codex-scoped `gate` entry is ignored'))).toBe(true);
    // An anthropic entry with an advisor, flagged to codex: ignored, loudly.
    const toCodex = resolve({ gate: { advisor: 'fable' } }, { vendor: 'codex' });
    expect(toCodex.seat.config).not.toHaveProperty('advisor');
    expect(toCodex.warnings.some((w) => w.includes('`advisor` is ignored'))).toBe(true);
  });

  it('an invalid advisor on an ANTHROPIC gate throws naming the seat; on a codex gate it reaches no spawn, so it only warns', () => {
    expect(() => resolve({ gate: { advisor: null } })).toThrow(/voices\.json gate seat: `advisor`/);
    // Validated only where it applies: a codex gate never spawns claude, so its typo breaks nothing.
    const codex = resolve({ gate: { advisor: 'Fable', vendor: 'codex' } });
    expect(codex.seat.config).not.toHaveProperty('advisor');
    expect(codex.warnings.some((w) => w.includes('`advisor` is ignored') && w.includes('"Fable"'))).toBe(true);
    const flagged = resolve({ gate: { advisor: null } }, { vendor: 'codex' });
    expect(flagged.seat.vendor).toBe('codex');
  });

  // THE ONE EXCEPTION: a codex-scoped `gate` entry re-vendored to an anthropic gate (a flag, or
  // regate/reseat/probe pinning anthropic) takes its advisor from the `claude` entry — the one
  // advisor home for claude spawns — so "off" is spellable there and a typo refuses up front.
  it("a codex-scoped entry re-vendored to anthropic takes the `claude` entry's advisor, validated", () => {
    const off = resolve({ claude: { advisor: 'off' }, gate: { vendor: 'codex' } }, { vendor: 'anthropic' });
    expect(off.seat.vendor).toBe('anthropic');
    expect(off.seat.config.advisor).toBe('off');
    expect(settingsOf(buildClaudeReviewArgs('P', off.seat.config))).toEqual({ advisorModel: '' });
    // The entry's own advisor is ignored loudly; the claude entry's wins.
    const both = resolve(
      { claude: { advisor: 'claude-fable-5-1' }, gate: { advisor: 'off', vendor: 'codex' } },
      { vendor: 'anthropic' }
    );
    expect(both.seat.config.advisor).toBe('claude-fable-5-1');
    expect(both.warnings.some((w) => w.includes('its advisor comes from the `claude` entry'))).toBe(true);
    // No claude advisor → the gate inherits, as before.
    const none = resolve({ claude: { model: 'opus' }, gate: { vendor: 'codex' } }, { vendor: 'anthropic' });
    expect(none.seat.config).not.toHaveProperty('advisor');
    // Invalid → throws naming the `claude` entry, where the bad value lives.
    expect(() => resolve({ claude: { advisor: null }, gate: { vendor: 'codex' } }, { vendor: 'anthropic' })).toThrow(
      /voices\.json claude seat: `advisor`/
    );
  });

  it('the exception is one-way and scoped: the claude entry never reaches an anthropic-scoped or a codex gate', () => {
    // A codex gate (no flag): the claude entry's advisor is neither applied nor validated.
    const codex = resolve({ claude: { advisor: null }, gate: { vendor: 'codex' } });
    expect(codex.seat.vendor).toBe('codex');
    expect(codex.seat.config).not.toHaveProperty('advisor');
    // No gate entry at all: still inherit (no gate → claude inheritance).
    expect(resolve({ claude: { advisor: 'off' } }, { vendor: 'anthropic' }).seat.config).not.toHaveProperty('advisor');
  });

  it('the claude REVIEWER seat carries the `claude` entry\'s advisor; absent stays absent', () => {
    const seat = resolveClaudeReviewerSeat({ claude: { advisor: 'claude-opus-5-5' } }, {}, () => {});
    expect(seat.config.advisor).toBe('claude-opus-5-5');
    expect(resolveClaudeReviewerSeat({}, {}, () => {}).config).not.toHaveProperty('advisor');
    expect(() => resolveClaudeReviewerSeat({ claude: { advisor: '' } }, {}, () => {})).toThrow(
      /voices\.json claude seat: `advisor`/
    );
  });
});

describe('shadowChampionConfig — a codex gate is shadowed by the claude seat resolved UP FRONT', () => {
  it('builds the champion from the up-front config; a mid-run voices.json edit neither throws nor changes it', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { loadClaudeReviewerSeat } = await import('./gate-seat');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-shadow-champion-'));
    const file = path.join(dir, 'voices.json');
    fs.writeFileSync(file, JSON.stringify({ claude: { advisor: 'off', effort: 'high', model: 'sonnet' } }));
    const seat = loadClaudeReviewerSeat(file, { model: 'fable' });
    const upFront = structuredClone(seat.config);

    // Mid-run: the entry changes model AND gains an advisor that no longer validates. Re-reading
    // the file here (the old path) would throw inside the layer.
    fs.writeFileSync(file, JSON.stringify({ claude: { advisor: null, effort: 'low', model: 'haiku' } }));
    expect(() => loadClaudeReviewerSeat(file)).toThrow(/voices\.json claude seat: `advisor`/);

    const warnings: string[] = [];
    const champion = shadowChampionConfig(seat, 'xhigh', (m) => warnings.push(m));
    expect(champion).toEqual({ ...upFront, effort: 'xhigh' });
    expect(champion.model).toBe('fable');
    expect(champion.advisor).toBe('off');
    expect(seat.config).toEqual(upFront);
    expect(warnings).toEqual([]);
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it('no shadow effort keeps the seat config as resolved; an unknown one warns and keeps the seat effort', () => {
    const seat = resolveClaudeReviewerSeat({ claude: { effort: 'high' } }, {}, () => {});
    expect(shadowChampionConfig(seat, undefined, () => {})).toEqual(seat.config);
    expect(shadowChampionConfig(seat, '  ', () => {})).toEqual(seat.config);
    const warnings: string[] = [];
    expect(shadowChampionConfig(seat, 'ultra', (m) => warnings.push(m))).toEqual(seat.config);
    expect(warnings.some((w) => w.includes('--shadow-gate-effort "ultra" is not a known effort'))).toBe(true);
  });
});
