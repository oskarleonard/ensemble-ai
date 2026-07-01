import { describe, expect, it } from 'vitest';

import {
  buildVerifyArgs,
  decideGate,
  type GateInput,
  isOverridden,
  matchesGuardedCommand,
  OVERRIDE_ENV,
  parseCwd,
  parseHookInput,
  resolveTrailDir,
  runHook,
  TRAIL_ENV,
  type VerifyOutcome,
} from './hook';

// A verify() that reports the diff reviewed (exit 0), unreviewed (exit non-zero),
// or un-runnable (spawn failure) — the three states the gate must distinguish.
const reviewed = (): VerifyOutcome => ({ code: 0, output: 'PASS', ran: true });
const unreviewed = (reason = 'NO RECEIPT'): (() => VerifyOutcome) => () => ({
  code: 3,
  output: reason,
  ran: true,
});
const cannotRun = (): VerifyOutcome => ({ error: 'spawn ensemble-ai ENOENT', ran: false });

const prCreate: GateInput = { command: 'gh pr create --fill', toolName: 'Bash' };

describe('matchesGuardedCommand', () => {
  it('matches a bare and a chained `gh pr create`', () => {
    expect(matchesGuardedCommand({ command: 'gh pr create', toolName: 'Bash' })).toBe(true);
    expect(
      matchesGuardedCommand({ command: 'cd repo && gh pr create --fill', toolName: 'Bash' })
    ).toBe(true);
    expect(
      matchesGuardedCommand({ command: '/opt/homebrew/bin/gh pr create -t x', toolName: 'Bash' })
    ).toBe(true);
  });

  it('does NOT match unrelated gh / non-Bash commands', () => {
    expect(matchesGuardedCommand({ command: 'gh pr list', toolName: 'Bash' })).toBe(false);
    expect(matchesGuardedCommand({ command: 'gh pr view 3', toolName: 'Bash' })).toBe(false);
    expect(matchesGuardedCommand({ command: 'echo gh pr create-ish', toolName: 'Bash' })).toBe(false);
    // a substring like `create` inside another word must not trip it
    expect(matchesGuardedCommand({ command: 'gh pr createx', toolName: 'Bash' })).toBe(false);
    // non-Bash tool → never guarded
    expect(matchesGuardedCommand({ command: 'gh pr create', toolName: 'Edit' })).toBe(false);
    expect(matchesGuardedCommand({})).toBe(false);
  });
});

describe('decideGate', () => {
  it('ALLOWS a non-PR command untouched (pass-through)', () => {
    const d = decideGate(
      { command: 'gh pr list', toolName: 'Bash' },
      { overridden: false, verify: () => reviewed() }
    );
    expect(d.action).toBe('allow');
  });

  it('ALLOWS `gh pr create` when the diff is reviewed (receipt present → exit 0)', () => {
    const d = decideGate(prCreate, { overridden: false, verify: () => reviewed() });
    expect(d.action).toBe('allow');
    expect(d.reason).toContain('valid');
  });

  it('BLOCKS `gh pr create` when there is NO receipt (verify exit non-zero)', () => {
    const d = decideGate(prCreate, { overridden: false, verify: unreviewed('NO RECEIPT') });
    expect(d.action).toBe('block');
    expect(d.reason).toContain('NO current cross-vendor review receipt');
    expect(d.reason).toContain('NO RECEIPT'); // the verify output is echoed
  });

  it('BLOCKS when the receipt is STALE (commits since review → verify exit non-zero)', () => {
    const d = decideGate(prCreate, {
      overridden: false,
      verify: unreviewed('STALE — a receipt exists but its digest no longer matches'),
    });
    expect(d.action).toBe('block');
    expect(d.reason).toContain('STALE');
  });

  it('fails OPEN when overridden (never hard-brick PR creation)', () => {
    const d = decideGate(prCreate, { overridden: true, verify: unreviewed() });
    expect(d.action).toBe('allow');
    expect(d.reason).toContain('overridden');
  });

  it('fails OPEN with a warning when the verifier cannot run (broken install ≠ unreviewed)', () => {
    const d = decideGate(prCreate, { overridden: false, verify: () => cannotRun() });
    expect(d.action).toBe('allow');
    expect(d.reason).toContain('could not run');
  });
});

describe('isOverridden', () => {
  it('honors the override env (truthy only)', () => {
    expect(isOverridden(prCreate, { [OVERRIDE_ENV]: '1' })).toBe(true);
    expect(isOverridden(prCreate, { [OVERRIDE_ENV]: 'yes' })).toBe(true);
    expect(isOverridden(prCreate, { [OVERRIDE_ENV]: '0' })).toBe(false);
    expect(isOverridden(prCreate, { [OVERRIDE_ENV]: 'false' })).toBe(false);
    expect(isOverridden(prCreate, {})).toBe(false);
  });

  it('honors the inline skip marker in the command', () => {
    expect(
      isOverridden({ command: 'gh pr create # ensemble-ai:skip-gate', toolName: 'Bash' }, {})
    ).toBe(true);
  });
});

describe('resolveTrailDir + buildVerifyArgs', () => {
  it('prefers the env trail dir', () => {
    expect(resolveTrailDir('/repo', { [TRAIL_ENV]: '/t' }, () => false)).toBe('/t');
  });

  it('falls back to the conventional .ensemble-ai/trail when it exists', () => {
    const dir = resolveTrailDir('/repo', {}, (p) => p === '/repo/.ensemble-ai/trail');
    expect(dir).toBe('/repo/.ensemble-ai/trail');
  });

  it('returns undefined when neither is present (strict then fails closed)', () => {
    expect(resolveTrailDir('/repo', {}, () => false)).toBeUndefined();
  });

  it('builds `receipt verify --strict` and appends --trail only when set', () => {
    expect(buildVerifyArgs(undefined)).toEqual(['receipt', 'verify', '--strict']);
    expect(buildVerifyArgs('/t')).toEqual(['receipt', 'verify', '--strict', '--trail', '/t']);
  });
});

describe('parseHookInput / parseCwd', () => {
  it('extracts the Bash command, tool name, and cwd', () => {
    const raw = JSON.stringify({
      cwd: '/repo',
      tool_input: { command: 'gh pr create' },
      tool_name: 'Bash',
    });
    expect(parseHookInput(raw)).toEqual({ command: 'gh pr create', toolName: 'Bash' });
    expect(parseCwd(raw)).toBe('/repo');
  });

  it('degrades to an empty input on malformed JSON (→ allow, never crash)', () => {
    expect(parseHookInput('not json')).toEqual({});
    expect(parseCwd('not json')).toBeUndefined();
  });
});

describe('runHook (stdin → decision → exit code + output)', () => {
  // runHook calls the real runVerifyCli internally, so we assert its OUTPUT
  // contract only on the paths that never reach the CLI: a non-guarded command
  // (silent allow) and an overridden gh pr create (fail-open allow with a
  // warning). The verify→block DECISION itself is covered by decideGate above.
  function capture(raw: string, env: NodeJS.ProcessEnv) {
    const logs: string[] = [];
    const warns: string[] = [];
    const code = runHook(raw, {
      env,
      log: (m) => logs.push(m),
      warn: (m) => warns.push(m),
    });
    return { code, logs, warns };
  }

  it('silently allows (exit 0, no output) a non-PR command', () => {
    const raw = JSON.stringify({ tool_input: { command: 'gh pr list' }, tool_name: 'Bash' });
    const { code, logs, warns } = capture(raw, {});
    expect(code).toBe(0);
    expect(logs).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  it('allows (exit 0) with a warning when overridden on a real gh pr create', () => {
    const raw = JSON.stringify({
      cwd: '/nonexistent',
      tool_input: { command: 'gh pr create --fill' },
      tool_name: 'Bash',
    });
    const { code, warns } = capture(raw, { [OVERRIDE_ENV]: '1' });
    expect(code).toBe(0);
    expect(warns.join('\n')).toContain('overridden');
  });
});
