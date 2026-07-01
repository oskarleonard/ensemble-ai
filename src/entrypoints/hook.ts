#!/usr/bin/env node
// The pre-PR REVIEW GATE — a Claude Code PreToolUse hook. It intercepts a Bash
// tool call, and when that call creates a GitHub PR (`gh pr create`) it runs
// `ensemble-ai receipt verify --strict` on the current diff and BLOCKS the PR
// unless a current, artifact-proven cross-vendor review receipt exists.
//
// Design contract (per the ratified codex-grok-work-code-review-policy):
//   • REVIEW-ONLY + purely LOCAL — it runs the local verify CLI and reads a local
//     receipt store; it never transmits anything anywhere. Safe to install in BOTH
//     ~/.claude AND ~/.claude-work so it reaches _work diffs.
//   • DEFAULT FAIL-CLOSED on an unreviewed diff: verify exits non-zero → block.
//   • NEVER HARD-BRICK: an explicit override (env ENSEMBLE_AI_GATE_OVERRIDE, or a
//     documented per-command marker) fails OPEN; and a gate that cannot even RUN
//     the verifier (CLI missing / spawn error) fails OPEN with a loud warning
//     rather than blocking all PR creation on a broken install.
//
// This module is PURE + injectable (decideGate takes its verify + env as deps) so
// the verify→gate decision is unit-tested with mocked receipt present/absent/stale.
// The thin runHook() at the bottom wires stdin JSON → the CLI → the hook output.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// The env var that forces the gate OPEN (fail-open) so it can never hard-brick PR
// creation. Any non-empty, non-"0"/"false" value enables the override.
export const OVERRIDE_ENV = 'ENSEMBLE_AI_GATE_OVERRIDE';
// An optional escape hatch a user can drop INTO the `gh pr create` command itself,
// e.g. `gh pr create ... # ensemble-ai:skip-gate`, to bypass a single PR without a
// persistent env change. Documented in entrypoints/README.md.
export const INLINE_OVERRIDE_MARKER = 'ensemble-ai:skip-gate';
// The env var pointing at the run-trail dir (a review's `--out`) whose immutable
// per-reviewer artifacts prove the receipt under --strict. Unset → strict verify
// fails closed (the safe default; document running reviews with a stable --out).
export const TRAIL_ENV = 'ENSEMBLE_AI_TRAIL_DIR';

export interface GateInput {
  // The Bash command text (undefined for non-Bash tools).
  command?: string;
  // The PreToolUse tool name, e.g. "Bash".
  toolName?: string;
}

// Does this tool call attempt to create a GitHub PR? Only a Bash `gh pr create`
// invocation is guarded — every other tool call passes straight through. Matches
// `gh` (optionally path-qualified) then `pr` then `create` as whitespace-separated
// tokens anywhere in the command (so `cd x && gh pr create …` is caught), tolerant
// of extra spaces; deliberately narrow to avoid guarding unrelated commands.
export function matchesGuardedCommand(input: GateInput): boolean {
  if (input.toolName && input.toolName !== 'Bash') return false;
  const cmd = input.command;
  if (!cmd) return false;
  return /(^|[\s;&|(])(?:[^\s;&|]*\/)?gh\s+pr\s+create(\s|$)/.test(cmd);
}

// Is the override active for this call? True if the override env is set to a truthy
// value OR the guarded command carries the inline skip marker.
export function isOverridden(input: GateInput, env: NodeJS.ProcessEnv): boolean {
  const raw = env[OVERRIDE_ENV];
  const envOn = !!raw && raw !== '0' && raw.toLowerCase() !== 'false';
  const inlineOn = !!input.command && input.command.includes(INLINE_OVERRIDE_MARKER);
  return envOn || inlineOn;
}

// The result of attempting to run `ensemble-ai receipt verify --strict`. `ran:false`
// means the verifier could not even execute (CLI missing / spawn error) — distinct
// from `ran:true, code!=0` (verify ran and reported the diff unreviewed).
export type VerifyOutcome =
  | { code: number; output: string; ran: true }
  | { error: string; ran: false };

export type GateDecision =
  | { action: 'allow'; reason: string }
  | { action: 'block'; reason: string };

export interface GateDeps {
  // True when the user has explicitly opted to bypass the gate for this call.
  overridden: boolean;
  // Runs the verifier. Injected so the decision is unit-tested without a CLI.
  verify: () => VerifyOutcome;
}

// The gate DECISION — pure. Order matters:
//   1. not a `gh pr create` → allow (pass through, untouched);
//   2. override active → allow (fail-open, so the gate can never hard-brick);
//   3. verifier could not run → allow with a warning (broken install ≠ unreviewed
//      diff; blocking every PR on a missing CLI is the hard-brick to avoid);
//   4. verify exit 0 → allow (a current, artifact-proven review receipt exists);
//   5. verify exit non-zero → BLOCK (fail-closed: unreviewed / stale / under-policy).
export function decideGate(input: GateInput, deps: GateDeps): GateDecision {
  if (!matchesGuardedCommand(input)) {
    return { action: 'allow', reason: 'not a `gh pr create` command' };
  }
  if (deps.overridden) {
    return {
      action: 'allow',
      reason: `gate overridden (${OVERRIDE_ENV} set or "${INLINE_OVERRIDE_MARKER}" in the command) — PR allowed WITHOUT a verified review`,
    };
  }
  const res = deps.verify();
  if (!res.ran) {
    return {
      action: 'allow',
      reason: `ensemble-ai review gate could not run the verifier (${res.error}) — failing OPEN so PR creation is not bricked; install the ensemble-ai CLI to enforce the gate`,
    };
  }
  if (res.code === 0) {
    return {
      action: 'allow',
      reason: 'the current diff has a valid, current cross-vendor review receipt',
    };
  }
  return {
    action: 'block',
    reason:
      'This PR has NO current cross-vendor review receipt for its diff. Review it first:\n' +
      '    ensemble-ai review --out .ensemble-ai/trail    # runs Codex + Grok, writes the receipt\n' +
      'then re-run `gh pr create`. ' +
      `To bypass this once: append \`# ${INLINE_OVERRIDE_MARKER}\` to the command, or set ${OVERRIDE_ENV}=1.\n` +
      'verify said:\n' +
      indentBlock((res.output || '').trim()),
  };
}

function indentBlock(s: string): string {
  if (!s) return '    (no output)';
  return s
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n');
}

// ── stdin → CLI → hook output wiring (the impure shell around decideGate) ────────

// Parse the Claude Code PreToolUse hook payload. Tolerant of shape drift: missing
// fields simply mean "not a guarded call" (→ allow), never a crash.
export function parseHookInput(raw: string): GateInput {
  try {
    const j = JSON.parse(raw) as {
      cwd?: string;
      tool_input?: { command?: string };
      tool_name?: string;
    };
    return {
      command: j.tool_input?.command,
      toolName: j.tool_name,
    };
  } catch {
    return {};
  }
}

// Extract the cwd the guarded command runs in, so verify checks the RIGHT repo.
export function parseCwd(raw: string): string | undefined {
  try {
    const j = JSON.parse(raw) as { cwd?: string };
    return typeof j.cwd === 'string' ? j.cwd : undefined;
  } catch {
    return undefined;
  }
}

// Resolve the trail dir for `verify --strict`: the env override, else a
// conventional `.ensemble-ai/trail` under the repo cwd if it exists. Unset +
// no convention dir → undefined → strict fails closed (the safe default).
export function resolveTrailDir(
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean = fs.existsSync
): string | undefined {
  const fromEnv = env[TRAIL_ENV];
  if (fromEnv) return fromEnv;
  if (cwd) {
    const conventional = path.join(cwd, '.ensemble-ai', 'trail');
    if (exists(conventional)) return conventional;
  }
  return undefined;
}

// Build the argv for `ensemble-ai receipt verify --strict [--trail <dir>]`. The
// pre-PR gate is the artifact-proven mode (per verify.ts): --strict requires the
// real reviewer artifacts, so an attestation-only or absent receipt fails closed.
export function buildVerifyArgs(trailDir: string | undefined): string[] {
  const args = ['receipt', 'verify', '--strict'];
  if (trailDir) args.push('--trail', trailDir);
  return args;
}

// Run the verifier via the `ensemble-ai` CLI on PATH. Exit codes ARE the contract
// (0 = reviewed; non-zero = not), so a non-zero exit is a normal outcome, not a
// throw to catch — execFileSync throws on non-zero, so we recover the code. A
// spawn failure (ENOENT — CLI not installed) is the `ran:false` fail-open path.
export function runVerifyCli(
  cwd: string | undefined,
  env: NodeJS.ProcessEnv
): VerifyOutcome {
  const trailDir = resolveTrailDir(cwd, env);
  const args = buildVerifyArgs(trailDir);
  try {
    const output = execFileSync('ensemble-ai', args, {
      cwd: cwd || process.cwd(),
      encoding: 'utf8',
      env,
      // Bound it so a wedged verify can't hang PR creation forever.
      timeout: 120_000,
    });
    return { code: 0, output, ran: true };
  } catch (e) {
    const err = e as {
      code?: number | string;
      status?: number | null;
      stderr?: Buffer | string;
      stdout?: Buffer | string;
      message?: string;
    };
    // A resolved exit status (number) means the CLI RAN and returned non-zero.
    if (typeof err.status === 'number') {
      const out = `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`;
      return { code: err.status, output: out, ran: true };
    }
    // No numeric status → the process could not be spawned (ENOENT, etc.).
    return {
      error: err.message || 'could not spawn `ensemble-ai`',
      ran: false,
    };
  }
}

export interface HookIO {
  env: NodeJS.ProcessEnv;
  log: (msg: string) => void; // stdout
  warn: (msg: string) => void; // stderr
}

// The full hook run: stdin JSON → decision → { exitCode }. A block is signalled to
// Claude Code by exit code 2 with the reason on stderr (the version-robust
// PreToolUse block contract) AND a permissionDecision JSON on stdout for newer
// versions; an allow is a silent exit 0 (with any fail-open warning on stderr).
export function runHook(raw: string, io: HookIO): number {
  const input = parseHookInput(raw);
  const cwd = parseCwd(raw);
  const decision = decideGate(input, {
    overridden: isOverridden(input, io.env),
    verify: () => runVerifyCli(cwd, io.env),
  });
  if (decision.action === 'block') {
    io.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: decision.reason,
        },
      })
    );
    io.warn(`[ensemble-ai pre-PR gate] BLOCKED — ${decision.reason}`);
    return 2;
  }
  // Allow. Surface a fail-open reason on stderr so a bypass is never silent.
  if (
    decision.reason.includes('overridden') ||
    decision.reason.includes('could not run')
  ) {
    io.warn(`[ensemble-ai pre-PR gate] ALLOW — ${decision.reason}`);
  }
  return 0;
}

// Auto-run ONLY as the actual hook entry (not when imported by a test). Reads the
// whole stdin payload synchronously, runs the hook, sets the process exit code.
function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return (
      path.resolve(entry) ===
      path.resolve(new URL(import.meta.url).pathname)
    );
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    raw = '';
  }
  process.exitCode = runHook(raw, {
    env: process.env,
    log: (m) => console.log(m),
    warn: (m) => console.error(m),
  });
}
