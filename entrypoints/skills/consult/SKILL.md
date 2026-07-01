---
name: consult
description: Pose a question to the ensemble (Codex + Grok + Claude) — each voice answers independently, then one synthesizes what they AGREE on (confident) vs where they DIVERGE (look closer) + a bottom-line recommendation. Use when the user says "/consult" or "/ask", wants a cross-vendor answer to a decision/research question, or a second and third vendor's take.
---

# /consult — cross-vendor Q&A via ensemble-ai

Thin wrapper over the `ensemble-ai` CLI (the `consult` mode, alias `ask`). It poses
a question to the cross-vendor AI ensemble and summarizes the result — it does NOT
re-implement the logic. Each voice answers independently, then one synthesizes
AGREE (the confident core) vs DIVERGE (flagged "look closer") + a recommendation.

**What to run** (forward the user's arguments verbatim):

```bash
ensemble-ai consult $ARGUMENTS
```

- Arguments: `"<question>" [--file <path> for context · --critique]`
- The CLI is READ-ONLY and LOCAL — nothing is transmitted beyond the vendor model
  calls the CLI itself makes.
- Prereq: the `ensemble-ai` CLI must be on `PATH` (see entrypoints/README.md).

**Then, in-session:**
1. Run the command above with the user's `$ARGUMENTS` (quote the question).
2. If it exits non-zero, report the exit code + the CLI's stderr (exit 1 = every
   voice failed; exit 3 = usage / operational error).
3. Summarize the CLI output: lead with the AGREE points (confident) and the
   recommendation, then flag the DIVERGE points where the vendors disagreed — those
   are where to look closer. Do not re-run or second-guess the ensemble — relay + synthesize.
