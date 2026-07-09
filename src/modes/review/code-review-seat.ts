// THE ONE CLAUDE PRODUCER (spec §3) — the worktree-mode Claude seat, running the built-in
// /code-review methodology over the whole project at headSha.
//
// BUILD-TIME MUST-VERIFY, SETTLED 2026-07-09 (this build, live): headless `claude -p` CAN invoke
// the built-in skill. Probed against a temp repo with a planted off-by-one: `claude -p
// "/code-review\n\n<schema instructions>" --permission-mode plan` ran the real skill (its
// multi-angle methodology is visible in the reply), found the bug AND the reuse cleanup, and
// emitted a parseable ```json block in the ensemble schema. So PLAN A holds and the vendored
// methodology prompt (plan B) is NOT needed — the seat invokes the skill by name.
//
// The seat is a PRODUCER, not the gate. /simplify and /review are NOT producers in the post
// tail (§3): /simplify's distinct value is APPLYING fixes, which is off the table on a foreign
// PR, and /review is subsumed by the worktree + materialized diff.
export const CODE_REVIEW_SKILL = '/code-review';

// Quality-lens calibration (Oskar): structural simplification only. Never style/naming/format.
export const QUALITY_LENS = `Report BUGS and STRUCTURAL quality only: correctness defects, scope-narrowing, simpler function shape, dead branches, and reinvented utilities. NEVER report style, naming, formatting, or import-ordering nits — they are noise on someone else's pull request.`;

// The ensemble finding schema, restated for the seat so its reply parses through the SAME
// parseFindings path codex and grok use (symmetry IS robustness — one parser, no per-seat drift).
const SCHEMA_BLOCK = `{"summary":"<one sentence>","findings":[{"title":"<short>","body":"<what is wrong, why, and the fix>","severity":"high|medium|low","confidence":"high|medium|low","evidence":{"file":"<repo-relative path>","line":<number>}}]}`;

export interface CodeReviewSeatPromptArgs {
  // The base SHA the PR diverged from. The seat is told the exact command that materializes the
  // change under review, so the skill reviews the PR — not the (empty) diff of a detached HEAD.
  baseSha: string;
  headSha: string;
  // The detached, read-only worktree of the PR head — the whole project, as Oskar sees it when
  // he opens a CLI in-project.
  worktree: string;
}

// PURE: the seat prompt. `/code-review` leads so the CLI expands the built-in skill; the trailing
// contract pins the evidence anchor (file:line@headSha, §5) and the reply schema. Encoded as data
// so a unit test pins the exact shape.
export function renderCodeReviewSeatPrompt(args: CodeReviewSeatPromptArgs): string {
  return `${CODE_REVIEW_SKILL}

You are reviewing someone else's pull request, read-only. You may not edit, stage, or push anything.

The full project at the PR head is checked out at ${args.worktree} (detached at ${args.headSha}).
The change under review is exactly: git diff ${args.baseSha}...${args.headSha}
Run that command to see the change, and read any file in the worktree for whole-project context —
a finding may cite an UNCHANGED file (a reinvented utility, a convention the diff drifts from).

${QUALITY_LENS}

Anchor every finding at file:line as it exists at ${args.headSha}.

After the review, your FINAL output must end with exactly one fenced \`\`\`json block, and no other
json block, in this schema:
${SCHEMA_BLOCK}`;
}

// The seat's argv is `buildClaudeReviewArgs` (./claude) verbatim — same read-only belt
// (`--permission-mode plan` + the write-tool deny-list), same model/effort gating. What makes
// this a WORKTREE seat is not a flag: it is the prompt above plus the spawn cwd (the worktree,
// so the skill's git + file tools reach the project). Depth policy (§3, Oskar-corrected): the
// seat's default effort stays TOP — scaling is a downward valve the CONSUMER turns.
