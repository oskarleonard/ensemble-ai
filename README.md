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

### The verified gate — dismiss-only exit authority (exit 4)

The `review` / `security` **CLI** adds one gate on top of the facts above: **exit `4`** when a completed review surfaced a **HIGH** finding. Its cold-Opus **gate reviewer** grounds each finding against the exact diff hunk the reviewers saw and tags it `agree` / `partial` / `false` / `unverified`; a HIGH stops the gate **only** on a citation-validated **`false`** — *dismiss-only*: the gate can drop a hallucinated HIGH from a weak reviewer, but can **never** bless, promote, or soften anything else. Everything else (`agree` / `partial` / `unverified` / missing) still gates, uniformly across Codex, Grok, and the Opus reviewer.

**Grounding is not proof.** The citation only proves the gate *read* the disputed code (a whitespace-normalized, minimum-anchor quote of the finding's own hunk in the pinned packet). The `false` verdict itself is the gate model's **judgment**, not a proof of falsity.

**Provenance-scoped by default** — dismissal authority is trusted for your own local diffs, strict for anything foreign:

| Diff source | Authority | Effect |
| --- | --- | --- |
| `--working-tree` · `--staged` · branch-vs-merge-base (the default) | **ON** | a validated-`false` HIGH is dismissed |
| `--pr <N\|url>` · a PR URL · piped stdin · `--diff-file` | **STRICT** | every HIGH gates (verdicts advisory) |

- **`--strict-high`** forces STRICT **anywhere** — every HIGH gates even one the gate dismissed (use for untrusted diffs / CI, or any run where raw HIGH severity should gate).
- **`--gate-dismissals`** opts a **foreign** diff into the dismiss-only authority (local diffs already have it). Its reader-of-record for a non-git input (stdin / `--diff-file` / a PR) is the run's **pinned packet** (`packet.gate.json` — the reviewer-visible diff at the resolved head SHA), the SAME immutable artifact the local path reads; nothing is re-derived from the working tree.
- **`--no-fail-on-high`** suppresses exit 4 entirely (unchanged).

A **gate failure never opens the gate and never trips exit 1** — a spawn error, a timeout, an unparseable / unknown-schema envelope, a missing / corrupt / SHA-mismatched packet, or a trail-write failure all force every verdict to `unverified`, so a HIGH still gates. Dismissed HIGHs print **loudly** (`HIGH (dismissed by gate — <reason>)`), and the run writes a durable `gate-verdicts.json` trail (raw + effective verdict + a machine-readable downgrade reason per finding). Exit precedence: `2` (secret-scan) > `1` (reviewer failed) > `4` (HIGH) > `0`.

**Feeding a fix-loop:** the **structured verdicts** in `<trail>/gate-verdicts.json` (the `<trail>` path the run prints already includes the per-run id) — *not* the synthesis prose — are authoritative. Point a coding agent at the trail and fix the `agree` / `partial` findings; treat every `unverified` (especially an **unverified HIGH**, which still blocks the gate) as an explicit investigate-or-triage set, never a silent drop. Keep the gate seat at least as capable as your strongest reviewer — a weak gate mostly returns `unverified` (the safe-but-toothless mode), which stdout flags as "gate teeth did not engage".

### Configuring the seats — `reviewers.json` and `voices.json`

Every seat is **config, not a hardcode** — two JSON files under `~/.ensemble-ai/` (each env-overridable: `ENSEMBLE_REVIEWERS_FILE` / `ENSEMBLE_VOICES_FILE`). Run `ensemble-ai config` (alias of `ensemble-ai reviewers`) to print the **resolved** seats — id · vendor · model · effort · sandbox, plus which file each came from — so what you see is exactly what the modes run. Neither file needs to exist; a missing or junk entry falls back to the baked default (a bad config can never silently disable a seat).

**`~/.ensemble-ai/reviewers.json`** — the cross-vendor **reviewers** (Codex + Grok), the diff-facing lenses:

```json
{
  "codex": { "model": "gpt-5.5", "effort": "xhigh" },
  "grok":  { "model": "grok-build", "effort": "high" }
}
```

**`~/.ensemble-ai/voices.json`** — the Claude **voices** (`claude` = the brainstorm/consult voice **and** the cold-Opus review reviewer) plus the **`gate`** seat (the verified-gate synthesizer). The gate takes **`model` and `effort` only** — it is always a `claude -p` spawn under the read-only plan-mode + write-tool deny-list, so a `cmd` key on the `gate` seat is **ignored + warned** (the read-only posture can't be configured away). This makes "reviewer = Opus @ high, **gate = Fable @ max**" expressible:

```json
{
  "claude": { "model": "opus", "effort": "high" },
  "gate":   { "model": "fable", "effort": "max" }
}
```

- **Gate resolution chain:** the `gate` entry → the `claude` entry (model/effort only) → the built-in default (**Opus**). A `gate` seat with no `voices.json` at all is byte-for-byte today's default gate.
- **Per-run override:** `--gate-model <m>` / `--gate-effort <e>` beat the file for one run (an effort outside `low|medium|high|xhigh|max` is ignored — today's whitelist, kept). Codex/Grok stay per-reviewer-configurable via `reviewers.json`.
- **Capability floor:** keep the gate at least as capable as your strongest reviewer. A weak gate mostly returns `unverified` — *safe but toothless* (it can't dismiss what it can't ground), which the gate summary line flags with **`gate teeth did not engage — consider a stronger gate model`**. That notice is the runtime signal that the seat is under-powered for the diff.

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
