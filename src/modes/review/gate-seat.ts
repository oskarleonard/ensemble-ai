import fs from 'node:fs';

import type { VoiceConfig } from '../brainstorm/types';
import { VOICE_DEFAULTS, VOICES_FILE } from '../brainstorm/voices';

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

// Resolve one field (model or effort) — identical bar the key: a valid FLAG wins outright; else the
// value inherits gate → claude → 'default', each with its source. Two field-specific rules are
// applied by the caller: the flag is pre-validated (it passes `null` for a rejected flag), and
// `accept` filters the FILE links (model takes anything; effort must be a known level). A file
// value that is present but junk, or present but rejected by `accept`, warns and falls through to
// the next link — so a bogus effort can never resolve to `source:'file'` and be advertised by
// `ensemble-ai config` while buildClaudeReviewArgs silently drops it at spawn (the flag/file
// symmetry codex+grok flagged). This owns every source so the two fields can't drift.
function resolveField(
  key: 'effort' | 'model',
  flag: string | null,
  gate: Record<string, unknown> | null,
  claude: Record<string, unknown> | null,
  warn: (m: string) => void,
  accept: (v: string) => boolean = () => true
): { source: SeatSource; value: string } {
  if (flag) return { source: 'flag', value: flag };
  const fromGate = gate ? nonEmptyStr(gate[key]) : null;
  if (gate && key in gate && fromGate === null)
    warn(
      `gate seat: \`${key}\` must be a non-empty string — falling back to the claude voice / built-in default`,
    );
  // gate value first, then the inherited claude value; a non-empty value the field rejects (an
  // effort outside CLAUDE_EFFORTS — the `accept` branch is only reachable for effort) warns and
  // falls through rather than resolving to a value the spawn would drop.
  for (const v of [fromGate, claude ? nonEmptyStr(claude[key]) : null]) {
    if (v === null) continue;
    // The documented 'default' sentinel means "no explicit value at this link" — fall through
    // silently; it is the documented spelling, not junk.
    if (v === 'default') continue;
    if (accept(v)) return { source: 'file', value: v };
    warn(
      `gate seat: \`${key}\` "${v}" is not a known effort (${[...CLAUDE_EFFORTS].join('|')}) — falling back to the claude voice / built-in default`,
    );
  }
  return { source: 'default', value: 'default' };
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
  const { source: modelSource, value: model } = resolveField(
    'model',
    nonEmptyStr(flags.model),
    gate,
    claude,
    warn
  );

  // EFFORT — flag → gate.effort → claude.effort (inherit) → 'default', validated against the
  // CLAUDE_EFFORTS whitelist at EVERY link. A flag outside it is IGNORED + warned; a FILE value
  // outside it likewise warns + falls through (so `config` never advertises an effort the gate
  // would silently drop at spawn — the flag/file symmetry codex+grok flagged). buildClaudeReviewArgs
  // still argv-filters at spawn, so the resolved seat and the spawn now agree.
  const isKnownEffort = (v: string): boolean => CLAUDE_EFFORTS.has(v);
  const flagEffort = nonEmptyStr(flags.effort);
  const effortFlagOk = flagEffort !== null && isKnownEffort(flagEffort);
  if (flagEffort && !effortFlagOk)
    warn(
      `gate seat: --gate-effort "${flagEffort}" is not a known effort (${[...CLAUDE_EFFORTS].join('|')}) — ignored`,
    );
  const { source: effortSource, value: effort } = resolveField(
    'effort',
    effortFlagOk ? flagEffort : null,
    gate,
    claude,
    warn,
    isKnownEffort
  );

  return {
    // The gate IS the claude binary with a swapped model/effort — source its identity (cmd/id/
    // vendor) from the one canonical claude voice so it can't drift from it, overriding only the
    // two fields the gate seat configures.
    config: { ...VOICE_DEFAULTS.claude, effort, model },
    effortSource,
    modelSource,
  };
}

// Read a voices.json for one seat resolver. A missing file is the normal zero-config case —
// silent. Any OTHER failure (unreadable, malformed JSON) silently resetting the seat would
// violate the junk-config-is-loud posture, so it warns before falling back.
function readVoicesRaw(
  file: string,
  warn: (m: string) => void,
  seatLabel: string,
  fallbackNote: string
): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
      warn(
        `${seatLabel}: could not read \`${file}\` (${(e as Error).message.split('\n')[0]}) — ${fallbackNote}`,
      );
    return {};
  }
}

// Read + resolve the gate seat from a voices.json file (default ~/.ensemble-ai/voices.json). A
// missing / unreadable / invalid file → an empty raw → the built-in default seat (never throws).
export function loadGateSeat(
  file: string = VOICES_FILE,
  flags: GateSeatFlags = {},
  warn: (m: string) => void = () => {},
): GateSeat {
  return resolveGateSeat(
    readVoicesRaw(file, warn, 'gate seat', 'using the claude voice / built-in default'),
    flags,
    warn
  );
}

// ── The claude REVIEWER (producer) seat ───────────────────────────────────────────────────────
// Chain: `--claude-model`/`--claude-effort` → the voices.json `claude` entry → opus @ max BAKED.
// Unlike the gate, this chain deliberately NEVER ends at the 'default' sentinel (= no --model →
// whatever the operator's saved interactive CLI default happens to be): the seat runs headless
// and unattended, so riding the interactive default is not a model choice, it is an accident.
// Run 2026-07-23-15-36-50 fired minutes after a `/model` switch to Fable 5 — the seat inherited
// it, burned the Fable quota, and failed the leg ("You've reached your Fable 5 limit" was the
// whole review). The registry seat (core/reviewers.ts) always SAID opus @ max; this resolver
// makes the review layer honor it. An operator who wants a different model states it: flag or
// file. Reuses GateSeat's shape — both are a resolved claude-binary seat (model/effort + sources).
export const CLAUDE_REVIEWER_SEAT_DEFAULTS = { effort: 'max', model: 'opus' } as const;

export function resolveClaudeReviewerSeat(
  raw: unknown,
  flags: GateSeatFlags,
  warn: (m: string) => void
): GateSeat {
  const root = plainObject(raw) ?? {};
  const claude = plainObject(root.claude);
  const isKnownEffort = (v: string): boolean => CLAUDE_EFFORTS.has(v);

  // Same flag pre-validation the gate applies: an unknown --claude-effort is ignored + warned,
  // then the chain continues (flag/file symmetry — never resolve a value the spawn would drop).
  const flagEffort = nonEmptyStr(flags.effort);
  const effortFlagOk = flagEffort !== null && isKnownEffort(flagEffort);
  if (flagEffort && !effortFlagOk)
    warn(
      `claude seat: --claude-effort "${flagEffort}" is not a known effort (${[...CLAUDE_EFFORTS].join('|')}) — ignored`,
    );

  const pick = (
    key: 'effort' | 'model',
    flag: string | null,
    accept: (v: string) => boolean,
    baked: string
  ): { source: SeatSource; value: string } => {
    if (flag) return { source: 'flag', value: flag };
    const fromFile = claude ? nonEmptyStr(claude[key]) : null;
    if (claude && key in claude && fromFile === null)
      warn(
        `claude seat: \`${key}\` must be a non-empty string — using the built-in ${baked}`,
      );
    // 'default' is the documented "no explicit value at this link" sentinel — for THIS seat it
    // falls through to the baked value, never to the interactive CLI default (header comment).
    if (fromFile !== null && fromFile !== 'default') {
      if (accept(fromFile)) return { source: 'file', value: fromFile };
      warn(
        `claude seat: \`${key}\` "${fromFile}" is not a known effort (${[...CLAUDE_EFFORTS].join('|')}) — using the built-in ${baked}`,
      );
    }
    return { source: 'default', value: baked };
  };

  const model = pick('model', nonEmptyStr(flags.model), () => true, CLAUDE_REVIEWER_SEAT_DEFAULTS.model);
  const effort = pick('effort', effortFlagOk ? flagEffort : null, isKnownEffort, CLAUDE_REVIEWER_SEAT_DEFAULTS.effort);

  return {
    // Identity (cmd/id/vendor) from the one canonical claude voice, like the gate — only
    // model/effort are configurable; the capability fence is not.
    config: { ...VOICE_DEFAULTS.claude, effort: effort.value, model: model.value },
    effortSource: effort.source,
    modelSource: model.source,
  };
}

// Read + resolve the claude REVIEWER seat from a voices.json file. Same never-throws contract
// as loadGateSeat.
export function loadClaudeReviewerSeat(
  file: string = VOICES_FILE,
  flags: GateSeatFlags = {},
  warn: (m: string) => void = () => {},
): GateSeat {
  return resolveClaudeReviewerSeat(
    readVoicesRaw(file, warn, 'claude seat', `using the built-in ${CLAUDE_REVIEWER_SEAT_DEFAULTS.model} @ ${CLAUDE_REVIEWER_SEAT_DEFAULTS.effort}`),
    flags,
    warn
  );
}
