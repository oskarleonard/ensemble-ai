---
name: ensemble-ai-review
description: Convene every configured cross-vendor reviewer (Codex + Grok) on a code diff, read-only, and collect typed findings grouped by severity. Use when the user says "/ensemble-ai-review", asks to review a diff/PR/branch with the ensemble / cross-vendor / multiple models, or wants a second (and third) vendor's take on code.
---

# /ensemble-ai-review — cross-vendor review via ensemble-ai

Thin wrapper over the `ensemble-ai` CLI. It convenes the cross-vendor AI ensemble
and summarizes the result in this session — it does NOT re-implement the logic.

**What to run** (forward the user's arguments verbatim):

```bash
ensemble-ai review $ARGUMENTS
```

- Arguments: `[diff source — default: current branch · --pr N · --staged · --diff-file <path>]`
- The CLI is READ-ONLY (reviewers run sandboxed) and LOCAL — nothing is
  transmitted beyond the vendor model calls the CLI itself makes.
- Prereq: the `ensemble-ai` CLI must be on `PATH` (see entrypoints/README.md).

**Then, in-session:**
1. Run the command above with the user's `$ARGUMENTS`.
2. If it exits non-zero, report the exit code + the CLI's stderr. Note: exit 4 =
   a HIGH finding is present (a real signal, not a crash); exit 2 = blocked by the
   secret-scan; exit 1 = a reviewer failed; exit 3 = usage / no diff.
3. Summarize the CLI output for the user: lead with the headline (the HIGH/MED/LOW
   findings + their `file:line`), then the actionable detail and the receipt path.
   Do not re-run or second-guess the ensemble — relay + synthesize what it returned.
