# ensemble-ai

Cross-vendor AI CLI — convene multiple models (Codex, Grok, …) on a task, **read-only**, and collect their output as typed, machine-readable **facts**.

Modes (architected mode-first): **`review`** (a code diff), **`security`** (a code diff, security lens), **`brainstorm`** (a topic), and **`consult`** / **`ask`** (a question) are implemented. Every mode is a variation of "fan out across vendors → synthesize" — their **disagreement is the signal**.

It's the portable engine behind a cross-vendor *code review* workflow: give it a `git diff`, it runs each configured reviewer **read-only in an OS-enforced sandbox**, parses their output into typed findings, and writes a self-describing trail plus a content-tied receipt. It emits **facts** (findings + per-reviewer execution status + coverage + a receipt) — **never a gate verdict**. The gate policy belongs to whatever consumes it (a terminal, a pre-PR hook, a dashboard).

## Install

No npm release yet — install from git:

```sh
npm i -g github:oskarleonard/ensemble-ai
# or as a dependency
npm i github:oskarleonard/ensemble-ai
```

The package has **zero runtime dependencies** (node built-ins only) and ships a prebuilt `dist/`, so a git install needs no build step. Reviewers are invoked via their own CLIs (`codex`, `grok`) — install + authenticate those separately.

## Usage

```sh
# review base...HEAD (base auto-resolved the way `gh pr create` resolves it)
ensemble-ai review

# review a specific range
ensemble-ai review --base origin/main

# review uncommitted tracked changes
ensemble-ai review --working-tree

# review a raw diff from a pipe or a file (PR-agnostic)
git diff main...HEAD | ensemble-ai review
ensemble-ai review --diff-file change.diff

# pick reviewers + where the trail goes
ensemble-ai review --reviewers codex,grok --out ./review-trail
```

Options: `--base <ref>` · `--reviewers <ids>` · `--out <dir>` · `--sandbox <profile>` · `--allow-sensitive` · `--ceiling <bytes>` · `--cwd <dir>` · `--run-id <id>`.

The **trail** defaults to a repo-local `.ensemble-ai/reviews/<run-id>/` when you're reviewing the current repo's own diff (it's gitignored, discoverable beside the code); a URL-PR / raw-diff / stdin review, or a non-repo cwd, falls back to an OS temp dir so a diff from a *different* repo never writes into your cwd. Override the base with `--out <dir>`. Trail + receipt files are written owner-only (`0600`). The `review input`, `receipt:`, and `trail:` paths are printed on **stdout**.

**Exit codes** (execution status, not a gate verdict): `0` = the review completed (even *with* findings) · `1` = a reviewer failed (crash / timeout / no parse) · `2` = blocked by the diff secret-scan · `3` = usage / no diff.

### Brainstorm

`brainstorm` runs ideation on a **topic** (not a diff) across multiple AI voices and synthesizes the result:

```sh
# three rounds: independent ideas → cross-critique → ranked synthesis
ensemble-ai brainstorm "naming options for a cross-vendor AI CLI"

# bring shared context, pick voices, name the synthesizer
ensemble-ai brainstorm "how should we shard this table?" --file schema.sql
ensemble-ai brainstorm "feature ideas" --voices codex,grok --synthesizer codex
```

The three rounds: **(1) generate** — each voice produces ideas *independently* (no anchoring on the others); **(2) critique** — each voice sees the *others'* ideas and critiques + extends them ("they talk to each other"); **(3) synthesize** — one voice de-duplicates, weighs the critiques, and produces a **ranked recommendation** crediting contributors. Default roster: **Codex + Grok + Claude** — Claude joins as a voice here (no independence concern, unlike review). Any voice can fail without taking down the others; if the synthesizer is unavailable it degrades to a deterministic dedupe.

Options: `--file <path>` · `--voices <ids>` · `--synthesizer <id>` · `--timeout <seconds>` · `--voices-file <path>` · `--json` · `--cwd <dir>`.

**Exit codes:** `0` = ideas produced (synthesis printed) · `1` = no usable output (every voice failed) · `3` = usage or an unexpected operational error.

### Consult

`consult` (alias `ask`) poses a **question** to the ensemble and separates signal from noise — where the voices **agree** (confident) vs where they **diverge** (look closer):

```sh
# each voice answers INDEPENDENTLY, then one synthesizes agree vs diverge
ensemble-ai consult "Should I use Postgres or SQLite for a single-user desktop app?"
ensemble-ai ask "Is this migration plan safe?" --file plan.md

# opt into an extra round where the voices review each other before synthesis
ensemble-ai consult "Which caching strategy for this workload?" --critique
```

The rounds: **(1) answer** — each voice answers the question *independently* (no anchoring), so concurrence across voices is a real signal; **(2) critique** *(optional, `--critique`, off by default)* — each voice reviews the *others'* answers; **(3) synthesize** — one voice separates **AGREEMENTS** (the confident core) from **DIVERGENCES** (flagged "look closer", recording who took which position) and gives a bottom-line recommendation. This is consult's difference from brainstorm: brainstorm *generates + ranks ideas*; consult *answers a question* and surfaces the ensemble's consensus vs split. Default roster: **Codex + Grok + Claude**. Fail-closed on bad flags; any voice can fail without taking down the others; an unavailable synthesizer degrades to a clearly-flagged deterministic list that makes **no** agreement claim.

Options: `--file <path>` · `--critique` · `--voices <ids>` · `--synthesizer <id>` · `--timeout <seconds>` · `--voices-file <path>` · `--json` · `--cwd <dir>`.

**Exit codes:** `0` = answers produced (synthesis printed) · `1` = no usable output (every voice failed) · `3` = usage or an unexpected operational error.

## Design

- **Vendor-neutral by construction** — a reviewer is config (`id · model · effort · sandbox`); adding one is a registry entry, not a rewrite.
- **Read-only, OS-enforced** — a reviewer can never mutate the work (kernel-fail-closed, not tool-denial). Grok additionally runs under a *deny-by-default-reads* profile (`ensemble-review`), so it can't read secrets *outside* the diff packet; Codex runs under its own `-s read-only` (writes + network blocked) and the equivalent read-confinement for Codex is tracked as follow-up. The diff-payload secret-scan (below) is the cross-cutting guard for secrets *inside* the payload.
- **Diff-payload secret-scan** — the diff itself is the payload sent to a provider, so a preflight scan default-rejects diffs that carry secrets / sensitive paths (override with `--allow-sensitive`); every match is named in the manifest.
- **Facts, not verdicts** — the engine reports findings + execution status + coverage; the consumer computes the gate.
- **A verifiable trail** — per-reviewer typed findings JSON + a manifest recording base/head, the canonical-diff content digest (distinct from any commit SHA), each reviewer's model/effort + execution status, and **coverage** (omitted paths named — binary / generated / over-limit — never silently dropped).
- **A content-tied receipt** — keyed by the full reviewed identity `(repo, baseSha, headSha, diffDigest, policyHash)`, validated **live** against the immutable per-reviewer artifacts (never a stored boolean), and coverage-qualified (an omitted *source* file does not qualify). A consumer's pre-PR gate can check it without re-running the review.

## Library

The same engine is importable in-process (one engine, no drift):

```ts
import { runReviewMode, isDiffReviewed } from 'ensemble-ai';
```

## License

MIT
