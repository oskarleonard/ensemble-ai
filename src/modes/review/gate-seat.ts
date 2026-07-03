import fs from 'node:fs';

import type { VoiceConfig } from '../brainstorm/types';
import { VOICES_FILE } from '../brainstorm/voices';

import { CLAUDE_EFFORTS } from './claude';

// The GATE seat — the synthesis reviewer — is independently configurable from the `claude`
// review VOICE: "reviewer = Opus @ high, gate = Fable @ max" must be expressible. But the gate
// is ALWAYS a `claude -p` spawn under the read-only plan-mode + write-tool deny-list belt, so it
// takes `{model, effort}` ONLY — a `cmd` key can't reconfigure the spawn away from claude and is
// ignored + warned (the read-only posture can't be configured away). Resolution chain: the
// voices.json `gate` entry → the `claude` entry (model/effort only) → the built-in default (Opus,
// i.e. the 'default' sentinel → no --model/--effort). A junk entry falls to the next link + a
// warning — the junk-config-never-disables-a-seat posture reviewers.json already has.

export type SeatSource = 'flag' | 'file' | 'default';

export interface GateSeatFlags {
  // `--gate-effort <e>` — overrides the file. A value outside the CLAUDE_EFFORTS whitelist is
  // ignored (today's argv behavior, kept) + warned, then falls through to the file/default.
  effort?: string;
  // `--gate-model <m>` — overrides the file. Any non-empty string is a valid model name.
  model?: string;
}

export interface GateSeat {
  // A VoiceConfig for the spawn: id/cmd/vendor pinned to the claude binary (the gate is always
  // `claude -p` — `cmd` is not honored), model/effort resolved. buildClaudeReviewArgs reads only
  // model/effort, so id:'claude' is a spawn detail; the ROLE label ('gate') lives at the render.
  config: VoiceConfig;
  effortSource: SeatSource;
  modelSource: SeatSource;
}

function nonEmptyStr(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function plainObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

// PURE: resolve the gate seat from the raw voices.json object + flag overrides. Emits warnings
// through `warn` (never throws) — a junk / `cmd`-bearing entry warns and falls through, never
// disabling the seat. Deterministic, so it is unit-tested directly for done-criterion 6.
export function resolveGateSeat(
  raw: unknown,
  flags: GateSeatFlags,
  warn: (m: string) => void
): GateSeat {
  const root = plainObject(raw) ?? {};

  // A `gate` key that isn't a plain object is junk — warn + inherit from claude/default.
  let gate: Record<string, unknown> | null = null;
  if (root.gate !== undefined) {
    gate = plainObject(root.gate);
    if (!gate)
      warn(
        'gate seat: expected an object like {"model":"…","effort":"…"} — ignoring the `gate` entry and inheriting the claude voice / built-in default',
      );
  }
  const claude = plainObject(root.claude);

  // `cmd` on the gate seat can't reconfigure the spawn (always `claude -p`) — ignore + warn.
  if (gate && 'cmd' in gate)
    warn(
      'gate seat: `cmd` is ignored — the gate is always a `claude -p` spawn (read-only plan mode + write-tool deny-list); remove it',
    );

  // MODEL — flag → gate.model → claude.model (inherit) → 'default' (Opus). Any non-empty string
  // is a valid model name (buildClaudeReviewArgs passes it through; 'default' omits --model).
  let model = 'default';
  let modelSource: SeatSource = 'default';
  const flagModel = nonEmptyStr(flags.model);
  if (flagModel) {
    model = flagModel;
    modelSource = 'flag';
  } else {
    if (gate && 'model' in gate && nonEmptyStr(gate.model) === null)
      warn(
        'gate seat: `model` must be a non-empty string — falling back to the claude voice / built-in default',
      );
    const inherited = (gate && nonEmptyStr(gate.model)) || (claude && nonEmptyStr(claude.model));
    if (inherited) {
      model = inherited;
      modelSource = 'file';
    }
  }

  // EFFORT — flag → gate.effort → claude.effort (inherit) → 'default'. A flag effort outside the
  // CLAUDE_EFFORTS whitelist is IGNORED (today's behavior) + warned, then falls through. A FILE
  // effort is stored as-is (buildClaudeReviewArgs whitelist-filters it at argv time — parity with
  // the claude voice, so a bogus file value degrades exactly as it does today, not specially).
  let effort = 'default';
  let effortSource: SeatSource = 'default';
  const flagEffort = nonEmptyStr(flags.effort);
  if (flagEffort && CLAUDE_EFFORTS.has(flagEffort)) {
    effort = flagEffort;
    effortSource = 'flag';
  } else {
    if (flagEffort && !CLAUDE_EFFORTS.has(flagEffort))
      warn(
        `gate seat: --gate-effort "${flagEffort}" is not a known effort (${[...CLAUDE_EFFORTS].join('|')}) — ignored`,
      );
    if (gate && 'effort' in gate && nonEmptyStr(gate.effort) === null)
      warn(
        'gate seat: `effort` must be a non-empty string — falling back to the claude voice / built-in default',
      );
    const inherited = (gate && nonEmptyStr(gate.effort)) || (claude && nonEmptyStr(claude.effort));
    if (inherited) {
      effort = inherited;
      effortSource = 'file';
    }
  }

  return {
    config: { cmd: 'claude', effort, id: 'claude', model, vendor: 'anthropic' },
    effortSource,
    modelSource,
  };
}

// Read + resolve the gate seat from a voices.json file (default ~/.ensemble-ai/voices.json). A
// missing / unreadable / invalid file → an empty raw → the built-in default seat (never throws).
export function loadGateSeat(
  file: string = VOICES_FILE,
  flags: GateSeatFlags = {},
  warn: (m: string) => void = () => {},
): GateSeat {
  let raw: unknown = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = {};
  }
  return resolveGateSeat(raw, flags, warn);
}
