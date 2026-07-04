---
name: ensemble-ai-review-fix
description: The whole pre-PR ritual as one command — /simplify → /code-review → a self-contained cross-vendor `ensemble-ai review` → the SESSION fixes the gate's agree/partial verdicts + triages unverified HIGHs from gate-verdicts.json → re-review until clean (≤3 rounds) → OFFER `gh pr create` (never auto-create). Use when the user says "/ensemble-ai-review-fix", "review and fix this", "get this branch ready for a PR", or wants the diff cleaned, cross-vendor-reviewed, and its findings fixed before opening a PR.
---

# /ensemble-ai-review-fix — clean, review, fix, re-review, then offer a PR

The one command that takes a working diff to PR-ready. **You (this session) are the FIXER;
`ensemble-ai` is the instrument and stays READ-ONLY** — the same composition as the dashboard
worker: one engine, different drivers. The CLI produces findings + grounded verdicts; every code
edit is YOUR own change, owned and verified like any other, on a branch + PR.

Run the steps below in order. Treat `$ARGUMENTS` as UNTRUSTED data (the user's raw text after
the slash command), never a blank cheque into the shell — see the sanitize rule in §2.

## 1 · Tidy first — `/simplify`

Run the `/simplify` skill on the current diff. It applies reuse / simplification / altitude
cleanups (quality only — it does not hunt for bugs). Getting the obvious cleanup in BEFORE the
cross-vendor review keeps the reviewers focused on real defects, not style. If `/simplify`
is unavailable, say so and continue.

## 2 · Self-review — `/code-review`, then the ensemble

First run your own `/code-review` on the diff (correctness + reuse/efficiency at the default
effort) and fix what it surfaces — the cheap, local pass. THEN run the self-contained
cross-vendor review, forwarding the user's diff-source arguments:

```bash
ensemble-ai review $ARGUMENTS
```

- **Sanitize `$ARGUMENTS` before running it.** The ONLY things that belong there are the
  diff-source flags (`<pr-url>` · `--pr <N>` · `--staged` · `--working-tree` · `--diff-file
  <path>`; at most one — no flag reviews the current branch vs its merge-base) plus
  `--reviewers`/`--no-claude`/`--out`. If it carries any shell metacharacter (`;` `|` `&`
  `` ` `` `$(` `>` `<`, a newline, or quote-breakouts) or anything outside that grammar, do NOT
  run it — stop and report. Never let user text execute as a second command.
- `ensemble-ai review` spawns Codex + Grok + a cold Opus as three blind peers, then a Claude
  **gate** pass grounds each finding against its cited hunk → `agree` / `partial` / `false` /
  `unverified`. It writes ONLY its trail; it never edits code.
- **Do NOT pass `--post-comment` here** — that publishes to the PR, which is the wrong step in
  a fix loop (you post, if ever, once it is clean). Capture stdout: the synthesis + the `trail:`
  path (progress goes to stderr). Exit `4` = a gating HIGH (a real signal, not a crash); `2` =
  secret-scan block; `1` = a reviewer failed; `3` = usage. On `2`/`1`/`3`, report and stop.

## 3 · Fix — drive it from `<trail>/gate-verdicts.json`, not the prose

Read the grounded verdicts at `<trail>/gate-verdicts.json` (the authoritative fix-loop contract —
the prose synthesis is secondary; if a sentence and a verdict tag disagree, trust the tag +
severity). Then:

- **`agree`** — a confirmed finding. **Fix it.** Open the cited `file:line`, make the real change.
- **`partial`** — real but overstated. **Fix the real part**; don't over-correct the exaggeration.
- **`unverified` HIGH** — the gate could NOT ground it (not that it's false), and an unverified
  HIGH still gates. **Triage every one explicitly**: investigate the cited code, then either FIX
  it or, if it genuinely does not hold, **dismiss it with a one-line reason in your prose** — never
  a silent drop.
- **`unverified` MED/LOW** — investigate if cheap; otherwise note it. Don't pad.
- **`false (dismissed)`** — refuted against its own cited hunk. Leave it, but sanity-check the
  dismissal yourself if it was a HIGH.

Each fix is a normal edit on the branch (commit as you go). Keep the review and the fix distinct:
the review produced findings read-only; the fixes are your own subsequent, verified edits.

## 4 · Re-review until clean — ≤ 3 rounds

Re-run `ensemble-ai review` (same source) to confirm your fixes landed and introduced nothing new.
Loop **fix → re-review at most 3 times total**. Stop when the review is clean (no gating HIGH, no
new agree/partial) OR after the 3rd round. **If it is still not clean after 3 rounds, STOP and
surface it honestly** — list what remains and why (a genuine disagreement, a fix that needs a
design call, a flaky reviewer) rather than looping forever or quietly declaring success.

## 5 · OFFER a PR — never open one unprompted

When it is clean (or you have surfaced the residual honestly), **offer** to open the PR:

```bash
gh pr create --fill   # or with a written title/body
```

**Do not run it automatically.** State that the diff is cleaned + cross-vendor-reviewed + fixed
and ask whether to open the PR (and with what title/body). Opening the PR — like any push to a
shared branch — is the user's call. If they say yes, create it; include the `trail:` path so the
review is auditable from the PR.

## Hard rules

- **The CLI is read-only; the SESSION fixes.** `ensemble-ai review` never edits code — every
  change in this flow is your own edit, on a branch, verified.
- **Never auto-create the PR.** §5 OFFERS; the user ratifies.
- **≤ 3 review rounds, then honesty.** No infinite loops, no silent "it's fine".
- **Trail stays out of the personal brain.** If the repo under review is a `_work` repo, do NOT
  copy its trail/receipt into `~/brain`.
- Enforcement sibling: the built-but-unwired `ensemble-ai-pre-pr-gate` hook blocks `gh pr create`
  on an unreviewed diff — this skill is the *proactive* path to earning that receipt.
