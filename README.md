# ensemble-ai

Cross-vendor AI CLI — convene multiple models (Codex, Grok, …) on a task, **read-only**, and collect their output as typed, machine-readable **facts**.

Modes (architected mode-first): **`review`** — a code diff — is implemented; `brainstorm` and `security` are reserved.

It's the portable engine behind a cross-vendor *code review* workflow: give it a `git diff`, it runs each configured reviewer in an **OS-enforced, deny-by-default-reads sandbox**, parses their output into typed findings, and writes a self-describing trail plus a content-tied receipt. It emits **facts** (findings + per-reviewer execution status + coverage + a receipt) — **never a gate verdict**. The gate policy belongs to whatever consumes it (a terminal, a pre-PR hook, a dashboard).

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

**Exit codes** (execution status, not a gate verdict): `0` = the review completed (even *with* findings) · `1` = a reviewer failed (crash / timeout / no parse) · `2` = blocked by the diff secret-scan · `3` = usage / no diff.

## Design

- **Vendor-neutral by construction** — a reviewer is config (`id · model · effort · sandbox`); adding one is a registry entry, not a rewrite.
- **Read-only, deny-by-default reads** — a reviewer can never mutate the work, and can't read secrets *outside* the diff packet (an OS-enforced sandbox, kernel-fail-closed — not tool-denial).
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
