---
name: brainstorm
description: Convene multiple AI voices (Codex + Grok + Claude) on a topic — each generates ideas independently, critiques the others, then one synthesizes a ranked, de-duplicated recommendation. Use when the user says "/brainstorm", wants cross-vendor ideation on a feature/name/architecture, or asks "what am I missing" with the ensemble.
---

# /brainstorm — cross-vendor ideation via ensemble-ai

Thin wrapper over the `ensemble-ai` CLI. It convenes the cross-vendor AI ensemble
on a topic and summarizes the result — it does NOT re-implement the logic. Three
rounds: independent ideas → cross-critique → one voice synthesizes a ranked,
contributor-credited recommendation.

**What to run** (forward the user's arguments verbatim):

```bash
ensemble-ai brainstorm $ARGUMENTS
```

- Arguments: `"<topic>" [--file <path> for shared context]`
- The CLI is READ-ONLY and LOCAL — nothing is transmitted beyond the vendor model
  calls the CLI itself makes.
- Prereq: the `ensemble-ai` CLI must be on `PATH` (see entrypoints/README.md).

**Then, in-session:**
1. Run the command above with the user's `$ARGUMENTS` (quote the topic).
2. If it exits non-zero, report the exit code + the CLI's stderr (exit 1 = every
   voice failed; exit 3 = usage / operational error).
3. Summarize the CLI output: lead with the Round-3 ranked recommendation (with
   contributors), then the notable independent ideas and cross-critiques worth
   Oskar's attention. Do not re-run or second-guess the ensemble — relay + synthesize.
