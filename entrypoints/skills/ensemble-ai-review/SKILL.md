---
name: ensemble-ai-review
description: Convene every configured cross-vendor reviewer (Codex + Grok) on a code diff, read-only, THEN add your own independent review and synthesize all voices into one trustworthy verdict. Use when the user says "/ensemble-ai-review", asks to review a diff/PR/branch with the ensemble / cross-vendor / multiple models, or wants a second (and third) vendor's take on code.
---

# /ensemble-ai-review — the whole ensemble on a diff, synthesized by YOU

This skill runs the `ensemble-ai` CLI to convene the cross-vendor reviewers (Codex +
Grok), and then **you — the Claude session running this skill — are the third voice
AND the synthesizer.** You independently review the same diff and make sense of every
voice. You do NOT re-implement the CLI's logic, and you do NOT edit the code.

**Why the session-Claude, not a spawned one:** whichever Claude you already are
(work-claude or personal) IS the ensemble's Claude, so the review bills the RIGHT
account — fire this from work-claude and the work code review draws on the WORK Claude
quota, never personal usage. (For a bare terminal with no Claude session, the CLI's
`--with-claude` flag spawns a headless `claude -p` reviewer + synthesizer instead —
see below. From here, inside a session, you are the cheaper, better path.)

## 1 · Run the cross-vendor reviewers (Codex + Grok)

Forward the user's arguments verbatim:

```bash
ensemble-ai review $ARGUMENTS
```

- Arguments: `[diff source — default: current branch · <pr-url> · --pr N · --staged · --diff-file <path>]`
- The CLI is READ-ONLY (reviewers run OS-sandboxed) and LOCAL — nothing leaves the
  machine beyond the vendor model calls the CLI itself makes.
- It also gathers the repo's conventions (root + touched-package `CLAUDE.md`/`AGENTS.md`
  + the linked/swept docs) and feeds them to the reviewers — so they don't fly blind.
- Prereq: the `ensemble-ai` CLI must be on `PATH` (see entrypoints/README.md).
- Exit codes: `4` = a HIGH finding is present (a real signal, not a crash) · `2` =
  blocked by the secret-scan · `1` = a reviewer failed · `3` = usage / no diff.
- Capture the CLI's stdout (the per-reviewer findings + the receipt/trail paths). If it
  exits non-zero for a reason OTHER than `4`, report the exit code + stderr and stop.

## 2 · Review the SAME diff yourself, independently

Before reading the CLI's findings closely, get the same diff the reviewers saw and form
your OWN opinion — a fresh, cold review finds real issues even on a re-read:

```bash
# whatever the user pointed the CLI at — mirror it. Examples:
git diff $(git merge-base origin/HEAD HEAD)...HEAD   # default: current branch
# or:  gh pr diff <N>            (for --pr N / a PR URL)
# or:  git diff --cached         (for --staged)
```

Read the diff and list your own findings (`file:line` · severity · why it matters · the
fix). This is a genuine review, not a rubber-stamp of the CLI output — disagree with
Codex/Grok where you have reason to.

## 3 · Synthesize every voice — "make sense of it"

Now combine all three voices (Codex · Grok · you) into one verdict:

- **Dedupe** — collapse the same issue reported by multiple voices into one finding.
- **AGREE (confident)** — findings ≥2 voices independently flagged. High-signal; lead
  with these.
- **DISAGREE / look closer** — a finding only one voice raised, or where voices
  conflict. Flag it, say who raised it, and give your read of whether it's real.
- **Per-finding sanity-check** — for each distinct finding, a one-line judgment:
  likely-real · look-closer · likely-false-positive, with the reason. Reviewers
  hallucinate; this is where you catch it.
- **Bottom line** — the headline: is this diff safe to merge, and what (if anything)
  must change first. Note how much rests on agreement vs a judgment call.

Lead the reply with the bottom line + the HIGH/agreed findings and their `file:line`,
then the look-closer items, then the receipt/trail paths from the CLI.

## Hard rules

- **REVIEW-ONLY. Never edit the code.** No `/simplify`, no `/code-review`, no fix-apply,
  no commits. Output is the synthesis + findings only. (The dashboard's review button
  keeps its curate-and-fix pass; this skill is the read-only portable sibling.)
- **Trail stays out of the personal brain.** If the repo under review is a `_work` repo,
  its trail/receipt must live only in a local/temp dir, never `~/brain` — the CLI
  enforces this, and you must not copy a `_work` review's artifacts into the brain.
- Do not second-guess the ensemble into silence: relay what the reviewers found, add
  your own findings, and synthesize — three voices, one verdict.
