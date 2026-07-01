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
quota, never personal usage. You are the cheaper, better path: no extra process and the
synthesis is done by the model already in the loop. (A bare-terminal spawned-`claude -p`
reviewer for use OUTSIDE a session is a deferred follow-up — this skill is the session
path.)

**Honest framing — you are review-INTENT, not a sandbox.** Codex and Grok run
OS-sandboxed read-only; **you do not.** Your read-only-ness here is this skill's
instruction, followed — the user's own session doing a review-only task — not a
kernel-enforced guarantee. That's fine (it's your own session, and the Hard rules below
bind you to review-only), but state it plainly: don't claim you're "technically
read-only." Just don't edit anything.

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

Before reading the CLI's findings closely, form your OWN opinion on the same diff the
reviewers saw. Reconstruct that context yourself — the diff, plus the repo conventions
the CLI gathered (it writes the gathered manifest to `<trail>/conventions.json`, where
`<trail>` is the `trail:` path the CLI printed):

```bash
# whatever the user pointed the CLI at — mirror it. Examples:
git diff $(git merge-base origin/HEAD HEAD)...HEAD   # default: current branch
# or:  gh pr diff <N>            (for --pr N / a PR URL)
# or:  git diff --cached         (for --staged)
# then also read the repo's root + touched-package CLAUDE.md / AGENTS.md
cat <trail>/conventions.json     # the convention files the CLI fed Codex/Grok
```

Read it and list your own findings (`file:line` · severity · why it matters · the fix).
This is a genuine review, not a rubber-stamp of the CLI output — disagree with Codex/Grok
where you have reason to. **Your review is a full voice in the synthesized verdict below —
weigh a HIGH you raise as seriously as a Codex/Grok one; never wave your own HIGH
through.** (Note: only Codex/Grok drive the CLI's exit-code `4` gate — your findings live
in the verdict you report to the human, not in the CLI exit status.)

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
- **Trail stays out of the personal brain.** The CLI's trail defaults to a local temp
  dir. If the repo under review is a `_work` repo, do NOT copy its trail/receipt into
  `~/brain` (this is your behavior to hold — a `_work`-aware trail fence in the CLI is a
  deferred follow-up).
- Do not second-guess the ensemble into silence: relay what the reviewers found, add
  your own findings, and synthesize — three voices, one verdict.
