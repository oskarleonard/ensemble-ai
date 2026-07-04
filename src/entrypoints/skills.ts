// The Claude-skill entrypoint registry: which `ensemble-ai <mode>` CLI invocation
// each slash-command (`/review`, `/security`, `/brainstorm`, `/consult`) maps to.
// The shipped skill markdown (entrypoints/skills/<name>/SKILL.md) is the hand-authored
// artifact; THIS module pins the skill→CLI mapping in code so a unit test can assert
// every shipped SKILL.md invokes the CLI command it claims to — keeping the wrappers
// from drifting from the CLI. Pure — no I/O.

import type { ModeName } from '../modes';

// The `$ARGUMENTS` placeholder Claude Code substitutes with the user's raw text
// when a skill is invoked (e.g. `/review --pr 12` → ARGUMENTS = `--pr 12`). The
// wrappers forward it verbatim to the CLI so every CLI flag works from the skill.
export const SKILL_ARGS_PLACEHOLDER = '$ARGUMENTS';

export interface SkillSpec {
  // The canonical CLI mode (post-alias) this skill runs — the `ensemble-ai <mode>`
  // verb the wrapper invokes.
  mode: ModeName;
  // The Claude slash-command name (no leading slash). PREFIXED with `ensemble-ai-`
  // so the skills never collide with a user's other `/review`-style skills; it is
  // DECOUPLED from the CLI verb (`mode`) — the wrapper runs `ensemble-ai <mode>`,
  // not `ensemble-ai <name>`.
  name: string;
}

// The four entrypoint skills. `name` is the slash command the user types
// (`ensemble-ai-`-prefixed to avoid collisions); `mode` is the canonical CLI verb
// the wrapper runs (only ever an IMPLEMENTED mode — asserted by the tests, so a
// skill can never point at a planned-but-unbuilt mode).
export const SKILL_SPECS: SkillSpec[] = [
  { mode: 'review', name: 'ensemble-ai-review' },
  { mode: 'security', name: 'ensemble-ai-security' },
  { mode: 'brainstorm', name: 'ensemble-ai-brainstorm' },
  { mode: 'consult', name: 'ensemble-ai-consult' },
];

export function findSkill(name: string): SkillSpec | undefined {
  return SKILL_SPECS.find((s) => s.name === name);
}

// An ORCHESTRATION skill is NOT a thin one-mode wrapper: it drives a MULTI-STEP session ritual
// (`/ensemble-ai-review-fix`: /simplify → /code-review → `ensemble-ai review` → fix the gate's
// agree/partial verdicts + triage unverified HIGHs → re-review → offer `gh pr create`) with the
// SESSION as the fixer and the CLI staying READ-ONLY ("one engine, different drivers"). It still
// invokes the engine, so we pin the engine MODE it drives here — a unit test asserts the shipped
// markdown actually runs `ensemble-ai <mode>` + reads the `gate-verdicts.json` fix-loop contract,
// the same no-drift guarantee the thin wrappers get. Kept OUT of SKILL_SPECS (which is asserted to
// be EXACTLY the four `ensemble-ai <mode> $ARGUMENTS` wrappers).
export interface OrchestrationSkillSpec {
  // The engine mode the orchestration drives read-only (the session does the fixing).
  drives: ModeName;
  // The `ensemble-ai-`-prefixed slash-command name (as the thin wrappers), for the same reason.
  name: string;
}

export const ORCHESTRATION_SKILL_SPECS: OrchestrationSkillSpec[] = [
  { drives: 'review', name: 'ensemble-ai-review-fix' },
];

export function findOrchestrationSkill(
  name: string
): OrchestrationSkillSpec | undefined {
  return ORCHESTRATION_SKILL_SPECS.find((s) => s.name === name);
}

// The engine command an orchestration skill drives — `ensemble-ai <mode>`, WITHOUT a fixed
// $ARGUMENTS tail (the orchestration calls it in a loop with computed args — e.g. a re-review
// after applying a fix — not one verbatim pass-through like the thin wrappers). A test asserts
// the shipped markdown contains this command.
export function orchestrationEngineCommand(spec: OrchestrationSkillSpec): string {
  return `ensemble-ai ${spec.drives}`;
}

// The one-line shell invocation a SKILL.md tells Claude to run, forwarding the
// user's `$ARGUMENTS` verbatim. The single source of truth for the shipped markdown's
// invocation line (a test asserts each SKILL.md contains exactly this line), so the
// skill wrapper and the CLI can never drift.
export function skillInvocationLine(spec: SkillSpec): string {
  return `ensemble-ai ${spec.mode} ${SKILL_ARGS_PLACEHOLDER}`;
}
