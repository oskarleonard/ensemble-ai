# ensemble-ai entrypoints

Two developer entrypoints that WRAP the `ensemble-ai` CLI — thin layers, one
engine. Nothing here re-implements review/brainstorm/consult logic; it all shells
out to `ensemble-ai <mode>`.

1. **Claude skills** — `/review`, `/security`, `/brainstorm`, `/consult`: run the
   matching CLI mode and summarize the result in-session.
2. **A pre-PR review GATE** — a Claude Code `PreToolUse` hook on `gh pr create`
   that runs `ensemble-ai receipt verify --strict` and BLOCKS the PR unless the
   current diff has a valid, artifact-proven cross-vendor review receipt.

Both are shipped as repo artifacts; install them yourself with `install.sh`
(no agent installs them for you — the work config in particular is never touched
unattended).

## Prerequisite

The `ensemble-ai` CLI must be on `PATH`. From this repo:

```bash
npm run build        # produces dist/ (committed, but rebuild after edits)
npm link             # or: npm i -g .   → puts `ensemble-ai` + the gate bin on PATH
```

## 1 · Claude skills

Each `skills/<name>/SKILL.md` is a minimal wrapper: it tells Claude to run
`ensemble-ai <mode> $ARGUMENTS` and relay the output.

| Skill        | Runs                        | For                                            |
|--------------|-----------------------------|------------------------------------------------|
| `/review`    | `ensemble-ai review …`      | cross-vendor code review of a diff/PR/branch   |
| `/security`  | `ensemble-ai security …`    | the same, under a security-auditor lens        |
| `/brainstorm`| `ensemble-ai brainstorm "…"`| divergent ideation → cross-critique → converge |
| `/consult`   | `ensemble-ai consult "…"`   | cross-vendor Q&A: AGREE vs DIVERGE + a rec      |

Install: `install.sh` copies them into `<config-dir>/skills/`, or copy a folder by
hand. Invoke in Claude Code with `/review`, `/security`, etc.

## 2 · The pre-PR review gate (hook)

A `PreToolUse` hook that fires on every Bash tool call but only ACTS on
`gh pr create`. On a PR-create it runs, in the command's cwd:

```
ensemble-ai receipt verify --strict [--trail <dir>]
```

- **exit 0** (a current, artifact-proven receipt exists) → the PR is **allowed**.
- **exit non-zero** (no receipt / stale / under-policy / under-coverage) → the PR
  is **blocked** (fail-closed) with instructions to review first.

### Why `--strict` needs a trail dir

`--strict` (the artifact-required mode) PROVES the receipt against the immutable
per-reviewer artifacts a review writes to its `--out` dir — a hand-written receipt
can't pass. So the gate must know where those artifacts are:

1. Review with a **stable** out dir:  `ensemble-ai review --out .ensemble-ai/trail`
2. Point the gate at it:  `export ENSEMBLE_AI_TRAIL_DIR="$PWD/.ensemble-ai/trail"`
   — or the gate auto-discovers a `.ensemble-ai/trail` dir under the repo cwd.
3. Add `.ensemble-ai/` to `.gitignore` (it's a local, push-free cache).

If no trail dir is resolvable, `--strict` fails closed → the gate blocks (the safe
default). Use the override below to proceed without a review.

### Never hard-bricks

The gate can always be bypassed, so it can never wedge PR creation:

- **Per-PR:** append `# ensemble-ai:skip-gate` to the `gh pr create` command, or
  run it with `ENSEMBLE_AI_GATE_OVERRIDE=1`.
- **Broken install:** if the `ensemble-ai` CLI isn't on `PATH`, the gate FAILS
  OPEN (allows) with a warning instead of blocking every PR.

### Install into BOTH config dirs

The gate is **review-only** and **purely local** — it runs the local verifier and
reads a local receipt store; it transmits nothing. That makes it safe to install in
the work config too, so it reaches `_work`/Lisk diffs (per the ratified
codex-grok-work-code-review-policy — personal Codex/Grok tooling may REVIEW work
code, review-only, nothing leaves the machine):

```bash
entrypoints/install.sh ~/.claude
entrypoints/install.sh ~/.claude-work
```

`install.sh` merges a `PreToolUse` Bash hook into each `<config-dir>/settings.json`
(backing it up first, idempotently) pointing at `node <repo>/dist/entrypoints/hook.js`.

### Manual settings.json (if you'd rather not run install.sh)

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node /ABS/PATH/TO/ensemble-ai/dist/entrypoints/hook.js" }
        ]
      }
    ]
  }
}
```

(Or, if you `npm link`ed the package, the command can be the bin name
`ensemble-ai-pre-pr-gate`.)

### Hook contract

The hook reads the Claude Code `PreToolUse` JSON on stdin (`tool_name`,
`tool_input.command`, `cwd`). On a block it prints a `permissionDecision: "deny"`
object on stdout AND exits **2** with the reason on stderr (the version-robust
block signal). On an allow it exits **0** (silently, or with a fail-open warning on
stderr). The decision logic is pure + unit-tested in `src/entrypoints/hook.ts`.
