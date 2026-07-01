// The Claude-skill entrypoint layer: thin wrappers that map a slash-command
// (`/review`, `/security`, `/brainstorm`, `/consult`) onto the corresponding
// `ensemble-ai <mode>` CLI invocation and tell Claude to summarize the result
// in-session. The skill markdown files (entrypoints/skills/<name>/SKILL.md) are
// the shipped artifacts; THIS module is the single source of truth for which CLI
// command each skill runs, so the wrappers can't drift from the CLI + a unit test
// can assert the shipped markdown invokes the right command. Pure — no I/O.

import type { ModeName } from '../modes';

// The `$ARGUMENTS` placeholder Claude Code substitutes with the user's raw text
// when a skill is invoked (e.g. `/review --pr 12` → ARGUMENTS = `--pr 12`). The
// wrappers forward it verbatim to the CLI so every CLI flag works from the skill.
export const SKILL_ARGS_PLACEHOLDER = '$ARGUMENTS';

export interface SkillSpec {
  // What the user types the arg as — a diff source, a topic, or a question.
  argHint: string;
  // A one-line description of what convening the ensemble does for this skill.
  blurb: string;
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
  {
    argHint: '[diff source — default: current branch · --pr N · --staged · --diff-file <path>]',
    blurb:
      'Convene every configured cross-vendor reviewer (Codex + Grok) on a code diff, read-only, and collect typed findings grouped by severity.',
    mode: 'review',
    name: 'review',
  },
  {
    argHint: '[diff source — default: current branch · --pr N · --staged · --diff-file <path>]',
    blurb:
      'Run the cross-vendor reviewers over a diff under a security-auditor lens (injection · XSS · authz · secret-leak · supply-chain · SSRF · path-traversal · crypto) plus a local dependency-surface flag.',
    mode: 'security',
    name: 'security',
  },
  {
    argHint: '"<topic>" [--file <path> for shared context]',
    blurb:
      'Convene multiple AI voices (Codex + Grok + Claude) on a topic: each generates ideas independently, critiques the others, then one synthesizes a ranked, de-duplicated recommendation.',
    mode: 'brainstorm',
    name: 'brainstorm',
  },
  {
    argHint: '"<question>" [--file <path> for context · --critique]',
    blurb:
      'Pose a question to the ensemble: each voice answers independently, then one synthesizes what they AGREE on (confident) vs where they DIVERGE (look closer) + a bottom-line recommendation.',
    mode: 'consult',
    name: 'consult',
  },
];

export function findSkill(name: string): SkillSpec | undefined {
  return SKILL_SPECS.find((s) => s.name === name);
}

// The exact CLI argv a skill runs: the mode followed by the user's raw args split
// on whitespace. Returns the argv array (what a spawn would receive) so a caller
// (and the test) sees precisely what the wrapper invokes — never a re-interpreted
// command. Unknown skill name → error (fail closed, never a silent no-op).
export function buildSkillCommand(
  name: string,
  userArgs: string[] = []
): { argv: string[] } | { error: string } {
  const spec = findSkill(name);
  if (!spec) {
    return {
      error: `unknown skill "${name}" (known: ${SKILL_SPECS.map((s) => s.name).join(', ')})`,
    };
  }
  // The skill name IS the CLI verb (review/security/brainstorm/consult), so the
  // wrapper stays a pure pass-through; resolveMode confirms it maps to a real mode.
  return { argv: [spec.name, ...userArgs] };
}

// The one-line shell invocation a SKILL.md tells Claude to run, forwarding the
// user's `$ARGUMENTS` verbatim. The single source of truth for the shipped
// markdown (a test asserts each SKILL.md contains exactly this line), so the
// skill wrapper and the CLI can never drift.
export function skillInvocationLine(spec: SkillSpec): string {
  return `ensemble-ai ${spec.name} ${SKILL_ARGS_PLACEHOLDER}`;
}

// Render the full SKILL.md body from a spec — the frontmatter (name + description
// Claude Code matches on) plus the minimal wrapper instructions. Generated from
// the registry so the docs, the invocation, and the mode mapping are one thing.
export function renderSkillDoc(spec: SkillSpec): string {
  const description = `${spec.blurb} Use when Oskar says "/${spec.name}", asks to ${spec.name} something with the ensemble / cross-vendor / multiple models, or wants a second (and third) vendor's take.`;
  return `---
name: ${spec.name}
description: ${description}
---

# /${spec.name} — cross-vendor ${spec.name} via ensemble-ai

Thin wrapper over the \`ensemble-ai\` CLI. It convenes the cross-vendor AI ensemble
and summarizes the result in this session — it does NOT re-implement the logic.

**What to run** (forward the user's arguments verbatim):

\`\`\`bash
${skillInvocationLine(spec)}
\`\`\`

- Arguments: \`${spec.argHint}\`
- The CLI is READ-ONLY (reviewers/voices run sandboxed) and LOCAL — nothing is
  transmitted beyond the vendor model calls the CLI itself makes.
- Prereq: the \`ensemble-ai\` CLI must be on \`PATH\` (see entrypoints/README.md).

**Then, in-session:**
1. Run the command above with the user's \`${SKILL_ARGS_PLACEHOLDER}\`.
2. If it exits non-zero, report the exit code + the CLI's stderr (e.g. \`review\`/\`security\`
   exit 4 = a HIGH finding is present — that is a real signal, not a crash).
3. Summarize the CLI output for the user: lead with the headline (the findings /
   the ranked recommendation / the AGREE-vs-DIVERGE), then the actionable detail.
   Do not re-run or second-guess the ensemble — relay + synthesize what it returned.
`;
}
