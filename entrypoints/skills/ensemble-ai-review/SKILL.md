---
name: ensemble-ai-review
description: Convene a SELF-CONTAINED cross-vendor review (Codex + Grok + a cold Opus) on a code diff, read-only, then a Claude synthesis pass that emits AGREE/DISAGREE + a per-finding sanity-check + a bottom line. Use when the user says "/ensemble-ai-review", asks to review a diff/PR/branch with the ensemble / cross-vendor / multiple models, or wants a second (and third) vendor's take on code.
---

# /ensemble-ai-review — the whole ensemble on a diff, self-contained

This skill runs the `ensemble-ai` CLI, which is now **self-contained**: it spawns THREE
blind peer reviewers on the SAME pinned packet — **Codex + Grok + a cold headless
`claude -p` (Opus, default-on)** — each writing its own review into the trail, then a
separate `claude -p` **synthesis** pass reads all three and emits AGREE(confident) /
DISAGREE(look-closer) · a per-finding sanity-check · a bottom line. You do NOT need to be
the third voice or the synthesizer — the CLI does all of that itself. Your job is to run
it, surface the synthesis, and (only if asked) fix the findings afterwards.

**Review-only.** This command makes ZERO writes to tracked files — its only writes are to
the (owner-only) trail dir. It never edits code. If the user then wants the findings
FIXED, that is a **separate action you take after** the review (see §4) — the review
itself never touches the code.

**Honest framing on the Opus reviewer's read-only-ness.** Codex and Grok run OS-sandboxed
read-only. The spawned Opus reviewer is **best-effort** read-only (`--permission-mode
plan` + a write-tool deny-list), NOT kernel-enforced. That is accepted by design — the
user runs this on their own diffs, and it matches the dashboard's own worker posture.
Don't overstate it as a hard sandbox.

## 1 · Run the self-contained review

Run the CLI, forwarding the user's arguments — but treat them as UNTRUSTED input, not a
blank cheque into the shell:

```bash
ensemble-ai review $ARGUMENTS
```

- **Sanitize `$ARGUMENTS` before you run it.** It is whatever the user typed after the
  slash command — data, not code. The ONLY things that belong there are the diff-source
  flags below and their values. Before running, confirm `$ARGUMENTS` contains ONLY those
  documented flags/values. If it carries any shell metacharacter (`;` `|` `&` `` ` ``
  `$(` `>` `<`, a newline, or quotes trying to break out) or anything outside that
  grammar, do NOT run the command — stop and report it. Never let user text execute as a
  second shell command.
- Arguments: `[<pr-url> · --pr <N> · --staged · --working-tree · --diff-file <path>]`
  — at most one; no flag → the current branch vs its merge-base with the default branch.
  `--no-claude` drops the Opus reviewer + synthesis (Codex + Grok only) — useful from a
  terminal with no `claude` CLI; `--reviewers codex,grok,claude` subsets the roster.
- The CLI is LOCAL and read-only — nothing leaves the machine beyond the vendor model
  calls it makes. It also gathers the repo's conventions (root + touched-package
  `CLAUDE.md`/`AGENTS.md` + linked/swept docs) so the reviewers don't fly blind.
- Prereq: the `ensemble-ai` CLI on `PATH` (see entrypoints/README.md), plus the `codex`,
  `grok`, and `claude` CLIs for their respective reviewers.
- Exit codes: `4` = a HIGH finding from ANY of the three reviewers (a real signal, not a
  crash) · `2` = blocked by the secret-scan · `1` = a reviewer failed · `3` = usage / no
  diff. If it exits non-zero for a reason OTHER than `4`, report the exit code + stderr
  and stop.
- Capture stdout: the per-reviewer findings, the **Claude synthesis** block, and the
  `review input` / `receipt:` / `trail:` paths (progress logs go to stderr).

## 2 · Surface the synthesis

The CLI already printed the synthesized verdict — the **Claude synthesis** block:
`summary` · ✓ AGREE (confident) · ⚠ DISAGREE (look closer) · per-finding sanity-checks ·
→ bottom line. Lead your reply with the **bottom line + the HIGH/agreed findings and
their `file:line`**, then the look-closer items, then the receipt/trail paths.

If the synthesis printed `DEGRADED (deterministic fallback…)`, the synthesizer voice was
unavailable — say so plainly; the per-reviewer findings are still shown but were NOT
cross-confirmed. The per-reviewer reviews live in the trail as `<trail>/review.<id>.md`
(codex/grok/claude) if you want to read one directly.

## 3 · (Optional) add your own read

The ensemble is already complete (three reviewers + a synthesis). You do NOT need to add
a fourth voice. But if you have a genuinely distinct concern the reviewers missed, you
MAY add it as your own clearly-labeled finding on top of the synthesis — don't pad, and
don't rubber-stamp.

## 4 · Fixing is a SEPARATE step — only if the user asks

Review never edits code. If the user then says "fix them" / "apply the fixes", THAT is a
separate action you take as this session — open the cited files, make the changes, and
follow the normal branch + PR discipline. Keep it distinct from the review: the review
produced the findings read-only; the fix is your own subsequent edit, owned and verified
like any other change. Do not fix pre-emptively.

## Hard rules

- **REVIEW-ONLY by default.** The `ensemble-ai review` run itself never edits code, never
  commits. A fix happens only on an explicit follow-up request (§4), as a separate step.
- **Trail stays out of the personal brain.** The CLI's trail defaults to a local dir. If
  the repo under review is a `_work` repo, do NOT copy its trail/receipt into `~/brain`.
- Do not second-guess the ensemble into silence: relay the synthesis + findings faithfully.
