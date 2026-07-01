---
name: security
description: Run the cross-vendor reviewers over a diff under a security-auditor lens (injection · XSS · authz · secret-leak · supply-chain · SSRF · path-traversal · crypto) plus a local dependency-surface flag. Use when the user says "/security", asks for a security audit/review of a diff/PR with the ensemble / cross-vendor / multiple models.
---

# /security — cross-vendor security audit via ensemble-ai

Thin wrapper over the `ensemble-ai` CLI. It convenes the cross-vendor AI ensemble
under a security-auditor lens and summarizes the result — it does NOT re-implement
the logic. Same engine + diff sources + receipt + HIGH gate as `/review`, but with
adversarial security prompts, findings tagged by security class, and a local
dependency-surface flag (manifest changes + risky imports — NO network).

**What to run** (forward the user's arguments verbatim):

```bash
ensemble-ai security $ARGUMENTS
```

- Arguments: `[diff source — default: current branch · --pr N · --staged · --diff-file <path>]`
- The CLI is READ-ONLY (reviewers run sandboxed) and LOCAL — nothing is
  transmitted beyond the vendor model calls the CLI itself makes.
- Prereq: the `ensemble-ai` CLI must be on `PATH` (see entrypoints/README.md).

**Then, in-session:**
1. Run the command above with the user's `$ARGUMENTS`.
2. If it exits non-zero, report the exit code + the CLI's stderr (exit 4 = a HIGH
   security finding; exit 2 = secret-scan block; exit 1 = a reviewer failed; exit 3
   = usage / no diff).
3. Summarize the CLI output: lead with the HIGH findings and their security class +
   `file:line`, then the dependency-surface flags and the receipt path.
   Do not re-run or second-guess the ensemble — relay + synthesize what it returned.
