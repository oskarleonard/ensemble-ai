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
  // The canonical CLI mode (post-alias) this skill runs.
  mode: ModeName;
  // The slash-command name (no leading slash), == the CLI mode/alias the user knows.
  name: string;
}

// The four entrypoint skills. `name` is what the user types (and the CLI verb the
// wrapper runs); `mode` is the canonical mode it resolves to (only ever an
// IMPLEMENTED mode — asserted by the tests, so a skill can never point at a
// planned-but-unbuilt mode).
export const SKILL_SPECS: SkillSpec[] = [
  { mode: 'review', name: 'review' },
  { mode: 'security', name: 'security' },
  { mode: 'brainstorm', name: 'brainstorm' },
  { mode: 'consult', name: 'consult' },
];

export function findSkill(name: string): SkillSpec | undefined {
  return SKILL_SPECS.find((s) => s.name === name);
}

// The one-line shell invocation a SKILL.md tells Claude to run, forwarding the
// user's `$ARGUMENTS` verbatim. The single source of truth for the shipped markdown's
// invocation line (a test asserts each SKILL.md contains exactly this line), so the
// skill wrapper and the CLI can never drift.
export function skillInvocationLine(spec: SkillSpec): string {
  return `ensemble-ai ${spec.name} ${SKILL_ARGS_PLACEHOLDER}`;
}
