import { HISTORY_PACKET_CLAUSE } from './history-packet';
import {
  materializedDiffClause,
  readOnlyWorktreeClause,
  UNTRUSTED_INSTRUCTIONS_CLAUSE,
} from './worktree';

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
// RE-VERIFIED 2026-07-10 UNDER THE CAPABILITY FENCE (./claude): the skill's own first move is
// `git diff`, and the fence removes Bash. Probed with the diff MATERIALIZED into the prompt and a
// neutral cwd + `--add-dir <tree>`: the skill still ran, read the tree by absolute path, found both
// planted bugs, and emitted the schema-shaped ```json block. So plan A survives the fence — but the
// prompt must hand it the diff, because the seat can no longer produce it. That is the ONLY change
// the fence forces on this prompt.
//
// The seat is a PRODUCER, not the gate. /simplify and /review are NOT producers in the post
// tail (§3): /simplify's distinct value is APPLYING fixes, which is off the table on a foreign
// PR, and /review is subsumed by the worktree + materialized diff.
// HISTORY: this seat used to open its prompt with the literal `/code-review` slash command —
// which, under `claude -p`, INVOKES the skill: a multi-agent pipeline that fans out finder and
// verifier subagents, each a fresh full-context conversation at the seat's own model/effort.
// On lisk-backend#683 (run 2026-08-07-17-16-13) one such producer consumed ~77% of a Max 5x
// subscription window, where the operator's interactive single-conversation review of the same
// PR costs ~5%. The ensemble already IS the multi-voice verification (codex + grok + the gate),
// so the skill's internal fan-out bought redundant depth at ~15x the price. The seat is now what
// its docs always claimed: a COLD SINGLE-PASS peer — one conversation, direct Read/Grep/Glob,
// the fence's Agent/Task deny (claude.ts) making the no-fan-out shape structural.
export const COLD_PEER_ROLE =
  'You are a cold peer reviewer: ONE single-conversation review pass, done directly by you with Read, Grep, and Glob. Do NOT delegate to subagents or any orchestration tool.';

// The operator's manual review method, encoded (2026-08-07). This is what he does when he
// reviews a PR by hand — the flow the native /code-review skill replaced at ~15x the cost,
// which is why that skill is BANNED from ensemble seats (operator decision: it eats the
// subscription window; if he ever wants it he prompts it manually, outside the ensemble).
// Ordering is deliberate: functional bugs are the reason reviews exist; the simplify lens
// is second; the self-check is what separates a finding from a guess.
//
// Extended 2026-08-10 after lisk-backend#683: a human reviewer landed seven findings AFTER a
// full ensemble round, CodeRabbit, and the author's own passes — four of them in classes no
// seat had hunted (a guard covering two of four routes, a guard added to dead code, tests
// whose fixtures never set the new field, a declared five-method set with two tested). Those
// four hunts are now explicit steps, and the self-check carries the execution-decidable rule:
// the worst miss (an enum-cast index predicate no PostgreSQL accepts) had been RAISED earlier
// and argued away instead of run.
//
// Extended 2026-09-02 after lisk-web#903: the fifth hunt (WRAPPER-BOUNDARY TRACE). The costliest
// human-caught bug lived ACROSS a package boundary — the NumericInput wrapper dropped its lib's
// sourceInfo, so a display round-trip silently rewrote submitted amounts. Three seats filed the
// 2-decimal SYMPTOM; none read the wrapped source to find the mechanism, because no step said to
// cross the boundary.
//
// Extended 2026-08-26 after lisk-backend#736: a finding rested on "the documented escape hatch" —
// a paragraph two sibling migrations carried about pre-creating an index out of band — which no
// script, runbook, or deploy step performs. The maintainer rejected it; the finding worth posting
// was the gap between the comment and the practice. The self-check now grounds a claimed practice
// in the repo's operational files, never in sibling comments.
export const OPERATOR_REVIEW_METHOD = `## How to review (in this order)

1. Walk the diff hunk by hunk. For every touched function, read enough surrounding code —
   its callers, its callees, the rest of the file — to judge the change in context, not in
   isolation.
2. Hunt FUNCTIONAL BUGS first: correctness defects, broken edge cases, regressions of
   behavior the diff did not intend to change, authorization gaps, contract drift (API
   shapes, DB writes, event payloads), and state/concurrency hazards.
   Five hunts reviews are known to skip — run each explicitly:
   - NEW GUARD, EVERY ROUTE: when the diff adds a guard or invariant check, enumerate EVERY
     code path that reaches the protected operation (grep the entry points, count the call
     sites) and verify each path passes through it. A guard on two of four routes is a
     finding, and the call-site enumeration is its proof.
   - CALLER CENSUS: for every function the diff touches, count its non-test callers. Zero
     production callers is dead code — a guard or fix added there protects nothing.
   - TEST EFFECTIVENESS: for each new behavior, name the test that FAILS if the behavior is
     reverted. A fixture that never sets the new field makes every assertion on it vacuous
     (zero-value == zero-value still passes with the feature deleted).
   - DECLARED-SET COMPLETENESS: when the diff declares an enumerable set (a comment listing
     the N methods a rule covers, a routing matrix, a doc table), verify every element is
     handled and tested — defects hide in the unsampled remainder.
   - WRAPPER-BOUNDARY TRACE: when the diff changes, configures, or consumes a component that
     WRAPS a shared-package or third-party primitive, READ the wrapped source and verify the
     wrapper preserves the contract end to end — callback arguments it drops, prop-driven
     events it re-emits as if user-typed, options it swallows. The bug lives ACROSS the
     boundary: each side looks correct alone (a wrapper dropping its lib's sourceInfo let a
     display round-trip silently rewrite submitted amounts — three seats saw the symptom,
     none crossed the boundary to the mechanism).
3. Then the simplify lens: a utility that already exists and was reinvented, a simpler
   function shape, dead or unreachable branches, scope that silently narrowed or widened.
4. SELF-CHECK every candidate finding before reporting it: re-read the code at the PR head
   and ask "does this actually make sense — what concrete input or state makes it fail?"
   Drop anything you cannot ground at file:line. Downgrade confidence on anything that
   depends on an assumption you could not verify in the tree. EXCEPTION — execution-decidable
   claims: when a finding turns on runtime behavior you cannot run here (would this DDL
   apply, does this compile, would that test fail), do NOT talk yourself out of it by arguing
   how the runtime probably behaves. Report it, ground what the reading supports, and name
   the exact command that would settle it.
   - CLAIM VS PRACTICE: a finding that leans on something the tree only DESCRIBES — a comment
     saying an index is "pre-created out of band", a docstring naming a step ops runs first, a
     paragraph repeated across sibling files — is grounded only if that practice exists in the
     repo's operational files: scripts, runbooks, CI/deploy config, Makefile targets. Sibling
     files repeating a paragraph prove a convention was copied, not that anyone performs it.
     When the practice is absent, do not build on the claim: the finding is the inconsistency
     itself — say which is true, the comment or the deploy path.`;

// Quality-lens calibration (Oskar): structural simplification only. Never style/naming/format.
export const QUALITY_LENS = `Report BUGS and STRUCTURAL quality only: correctness defects, scope-narrowing, simpler function shape, dead branches, and reinvented utilities. NEVER report style, naming, formatting, or import-ordering nits — they are noise on someone else's pull request.`;

// The ensemble finding schema, restated for the seat so its reply parses through the SAME
// parseFindings path codex and grok use (symmetry IS robustness — one parser, no per-seat drift).
const SCHEMA_BLOCK = `{"summary":"<one sentence>","findings":[{"title":"<short>","body":"<what is wrong, why, and the fix>","severity":"high|medium|low","confidence":"high|medium|low","evidence":{"file":"<repo-relative path>","line":<number>}}]}`;

export interface CodeReviewSeatPromptArgs {
  // The base SHA the PR diverged from. Named so the seat knows which range it is looking at, even
  // though it can no longer compute that range itself.
  baseSha: string;
  // The reviewer-visible diff, already materialized by the engine. The seat has no shell, so this
  // IS the change under review — there is no `git diff` for it to run.
  diff: string;
  headSha: string;
  // True when the engine wrote a history packet (./history-packet) into this seat's cwd: the
  // `git log`/`git blame` the fence took away. Omitted ⇒ no clause, because a prompt must never
  // name evidence that is not there (a shallow clone builds no packet).
  history?: boolean;
  // The detached, read-only worktree of the PR head — the whole project, as Oskar sees it when
  // he opens a CLI in-project. Reached by ABSOLUTE path: it is a read root, not the seat's cwd.
  worktree: string;
}

// PURE: the seat prompt. `/code-review` leads so the CLI expands the built-in skill; the trailing
// contract pins the evidence anchor (file:line@headSha, §5) and the reply schema. Encoded as data
// so a unit test pins the exact shape.
export function renderCodeReviewSeatPrompt(args: CodeReviewSeatPromptArgs): string {
  const history = args.history ? `\n\n${HISTORY_PACKET_CLAUSE}` : '';
  return `${COLD_PEER_ROLE}

You are reviewing someone else's pull request, read-only. You may not edit, stage, or push anything.
You have NO shell and NO network: there is no Bash tool, so do not try to run \`git\` or any command.

${readOnlyWorktreeClause({ headSha: args.headSha, reach: 'reach every file', worktree: args.worktree })} Read any file there for whole-project context: a finding may
cite an UNCHANGED file (a reinvented utility, a convention the diff drifts from).

${materializedDiffClause(args)}

${UNTRUSTED_INSTRUCTIONS_CLAUSE}${history}

${OPERATOR_REVIEW_METHOD}

${QUALITY_LENS}

Anchor every finding at file:line as it exists at ${args.headSha}.

After the review, your FINAL output must end with exactly one fenced \`\`\`json block, and no other
json block, in this schema:
${SCHEMA_BLOCK}`;
}

// The seat's argv is `buildClaudeReviewArgs` (./claude) verbatim — same capability fence (no Bash,
// no network, no MCP, a neutral cwd, the worktree as an `--add-dir` read root, `$HOME` read-denied),
// same model/effort gating. What makes this a WORKTREE seat is not a flag: it is the prompt above
// plus that read root. Depth policy (§3, Oskar-corrected): the seat's default effort stays TOP —
// scaling is a downward valve the CONSUMER turns.
