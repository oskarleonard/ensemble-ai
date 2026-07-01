You are an adversarial code reviewer from a DIFFERENT vendor than the author.
You have NO prior memory: your own memory, the repository, and every earlier
conversation are unknown to you EXCEPT what is embedded below. Review only
what is here; do not assume facts not present.

Repository: https://github.com/oskarleonard/ensemble-ai · reviewing the diff below

## Objective
_(why this review was fired)_

Adversarial cross-vendor review of a code diff — find correctness, security, and convention issues a same-vendor author might miss.

## The diff under review
_(the change itself — review THIS, not the whole repo)_

diff --git a/entrypoints/README.md b/entrypoints/README.md
new file mode 100644
index 0000000..8edb999
--- /dev/null
+++ b/entrypoints/README.md
@@ -0,0 +1,119 @@
+# ensemble-ai entrypoints
+
+Two developer entrypoints that WRAP the `ensemble-ai` CLI — thin layers, one
+engine. Nothing here re-implements review/brainstorm/consult logic; it all shells
+out to `ensemble-ai <mode>`.
+
+1. **Claude skills** — `/review`, `/security`, `/brainstorm`, `/consult`: run the
+   matching CLI mode and summarize the result in-session.
+2. **A pre-PR review GATE** — a Claude Code `PreToolUse` hook on `gh pr create`
+   that runs `ensemble-ai receipt verify --strict` and BLOCKS the PR unless the
+   current diff has a valid, artifact-proven cross-vendor review receipt.
+
+Both are shipped as repo artifacts; install them yourself with `install.sh`
+(no agent installs them for you — the work config in particular is never touched
+unattended).
+
+## Prerequisite
+
+The `ensemble-ai` CLI must be on `PATH`. From this repo:
+
+```bash
+npm run build        # produces dist/ (committed, but rebuild after edits)
+npm link             # or: npm i -g .   → puts `ensemble-ai` + the gate bin on PATH
+```
+
+## 1 · Claude skills
+
+Each `skills/<name>/SKILL.md` is a minimal wrapper: it tells Claude to run
+`ensemble-ai <mode> $ARGUMENTS` and relay the output.
+
+| Skill        | Runs                        | For                                            |
+|--------------|-----------------------------|------------------------------------------------|
+| `/review`    | `ensemble-ai review …`      | cross-vendor code review of a diff/PR/branch   |
+| `/security`  | `ensemble-ai security …`    | the same, under a security-auditor lens        |
+| `/brainstorm`| `ensemble-ai brainstorm "…"`| divergent ideation → cross-critique → converge |
+| `/consult`   | `ensemble-ai consult "…"`   | cross-vendor Q&A: AGREE vs DIVERGE + a rec      |
+
+Install: `install.sh` copies them into `<config-dir>/skills/`, or copy a folder by
+hand. Invoke in Claude Code with `/review`, `/security`, etc.
+
+## 2 · The pre-PR review gate (hook)
+
+A `PreToolUse` hook that fires on every Bash tool call but only ACTS on
+`gh pr create`. On a PR-create it runs, in the command's cwd:
+
+```
+ensemble-ai receipt verify --strict [--trail <dir>]
+```
+
+- **exit 0** (a current, artifact-proven receipt exists) → the PR is **allowed**.
+- **exit non-zero** (no receipt / stale / under-policy / under-coverage) → the PR
+  is **blocked** (fail-closed) with instructions to review first.
+
+### Why `--strict` needs a trail dir
+
+`--strict` (the artifact-required mode) PROVES the receipt against the immutable
+per-reviewer artifacts a review writes to its `--out` dir — a hand-written receipt
+can't pass. So the gate must know where those artifacts are:
+
+1. Review with a **stable** out dir:  `ensemble-ai review --out .ensemble-ai/trail`
+2. Point the gate at it:  `export ENSEMBLE_AI_TRAIL_DIR="$PWD/.ensemble-ai/trail"`
+   — or the gate auto-discovers a `.ensemble-ai/trail` dir under the repo cwd.
+3. Add `.ensemble-ai/` to `.gitignore` (it's a local, push-free cache).
+
+If no trail dir is resolvable, `--strict` fails closed → the gate blocks (the safe
+default). Use the override below to proceed without a review.
+
+### Never hard-bricks
+
+The gate can always be bypassed, so it can never wedge PR creation:
+
+- **Per-PR:** append `# ensemble-ai:skip-gate` to the `gh pr create` command, or
+  run it with `ENSEMBLE_AI_GATE_OVERRIDE=1`.
+- **Broken install:** if the `ensemble-ai` CLI isn't on `PATH`, the gate FAILS
+  OPEN (allows) with a warning instead of blocking every PR.
+
+### Install into BOTH config dirs
+
+The gate is **review-only** and **purely local** — it runs the local verifier and
+reads a local receipt store; it transmits nothing. That makes it safe to install in
+the work config too, so it reaches `_work`/Lisk diffs (per the ratified
+codex-grok-work-code-review-policy — personal Codex/Grok tooling may REVIEW work
+code, review-only, nothing leaves the machine):
+
+```bash
+entrypoints/install.sh ~/.claude
+entrypoints/install.sh ~/.claude-work
+```
+
+`install.sh` merges a `PreToolUse` Bash hook into each `<config-dir>/settings.json`
+(backing it up first, idempotently) pointing at `node <repo>/dist/entrypoints/hook.js`.
+
+### Manual settings.json (if you'd rather not run install.sh)
+
+```jsonc
+{
+  "hooks": {
+    "PreToolUse": [
+      {
+        "matcher": "Bash",
+        "hooks": [
+          { "type": "command", "command": "node /ABS/PATH/TO/ensemble-ai/dist/entrypoints/hook.js" }
+        ]
+      }
+    ]
+  }
+}
+```
+
+(Or, if you `npm link`ed the package, the command can be the bin name
+`ensemble-ai-pre-pr-gate`.)
+
+### Hook contract
+
+The hook reads the Claude Code `PreToolUse` JSON on stdin (`tool_name`,
+`tool_input.command`, `cwd`). On a block it prints a `permissionDecision: "deny"`
+object on stdout AND exits **2** with the reason on stderr (the version-robust
+block signal). On an allow it exits **0** (silently, or with a fail-open warning on
+stderr). The decision logic is pure + unit-tested in `src/entrypoints/hook.ts`.
diff --git a/entrypoints/install.sh b/entrypoints/install.sh
new file mode 100755
index 0000000..f30e6a5
--- /dev/null
+++ b/entrypoints/install.sh
@@ -0,0 +1,83 @@
+#!/usr/bin/env bash
+# ensemble-ai entrypoints installer — copies the Claude skills + wires the pre-PR
+# review-gate hook into a Claude Code config dir.
+#
+# RUN IT YOURSELF. It is deliberately NOT run by any agent unattended, and it never
+# modifies a config dir you did not pass. Install into BOTH config dirs so the gate
+# reaches your work diffs too (the gate is REVIEW-ONLY + purely LOCAL — it runs the
+# local verifier and reads a local receipt store; it transmits nothing):
+#
+#   entrypoints/install.sh ~/.claude
+#   entrypoints/install.sh ~/.claude-work
+#
+# With no argument it targets ${CLAUDE_CONFIG_DIR:-$HOME/.claude}.
+#
+# What it does, idempotently (safe to re-run):
+#   1. copies entrypoints/skills/* into  <target>/skills/
+#   2. merges a PreToolUse "Bash" hook into <target>/settings.json that runs the
+#      built gate bin — node <repo>/dist/entrypoints/hook.js — on every Bash call
+#      (the hook itself only acts on `gh pr create`; everything else passes through).
+# settings.json is backed up to settings.json.bak before it is touched.
+set -euo pipefail
+
+REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
+HOOK_JS="$REPO/dist/entrypoints/hook.js"
+SKILLS_SRC="$REPO/entrypoints/skills"
+TARGET="${1:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"
+
+command -v node >/dev/null 2>&1 || { echo "error: node is required (the hook + this installer use it)" >&2; exit 1; }
+[ -f "$HOOK_JS" ] || { echo "error: $HOOK_JS not found — run 'npm run build' in $REPO first" >&2; exit 1; }
+[ -d "$SKILLS_SRC" ] || { echo "error: $SKILLS_SRC not found" >&2; exit 1; }
+
+echo "ensemble-ai entrypoints → $TARGET"
+mkdir -p "$TARGET/skills"
+
+# 1) skills
+for dir in "$SKILLS_SRC"/*/; do
+  name="$(basename "$dir")"
+  mkdir -p "$TARGET/skills/$name"
+  cp "$dir/SKILL.md" "$TARGET/skills/$name/SKILL.md"
+  echo "  skill: /$name  →  $TARGET/skills/$name/SKILL.md"
+done
+
+# 2) the pre-PR gate hook — merge into settings.json without clobbering other hooks.
+SETTINGS="$TARGET/settings.json"
+[ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.bak" && echo "  backup: $SETTINGS.bak"
+
+HOOK_CMD="node $HOOK_JS"
+SETTINGS="$SETTINGS" HOOK_CMD="$HOOK_CMD" node <<'NODE'
+const fs = require('fs');
+const file = process.env.SETTINGS;
+const cmd = process.env.HOOK_CMD;
+let cfg = {};
+try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { cfg = {}; }
+cfg.hooks = cfg.hooks || {};
+const pre = Array.isArray(cfg.hooks.PreToolUse) ? cfg.hooks.PreToolUse : [];
+// Idempotent: drop any prior ensemble-ai gate group, then add a fresh one.
+const isOurs = (g) => Array.isArray(g.hooks) && g.hooks.some(
+  (h) => typeof h.command === 'string' && h.command.includes('entrypoints/hook.js')
+);
+const kept = pre.filter((g) => !isOurs(g));
+kept.push({ matcher: 'Bash', hooks: [{ type: 'command', command: cmd }] });
+cfg.hooks.PreToolUse = kept;
+fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
+console.log('  hook:  PreToolUse Bash → ' + cmd);
+NODE
+
+cat <<EOF
+
+Done. The pre-PR review gate is active for $TARGET.
+
+  • It BLOCKS \`gh pr create\` unless the current diff has a valid, artifact-proven
+    cross-vendor review receipt (\`ensemble-ai receipt verify --strict\`).
+  • To earn a receipt, review with a STABLE trail dir and point the gate at it:
+        ensemble-ai review --out .ensemble-ai/trail
+        export ENSEMBLE_AI_TRAIL_DIR="\$PWD/.ensemble-ai/trail"   # or set once, globally
+    (add .ensemble-ai/ to your .gitignore.)
+  • Bypass a single PR:  append \`# ensemble-ai:skip-gate\` to the command,
+    or set ENSEMBLE_AI_GATE_OVERRIDE=1  (the gate can never hard-brick PR creation).
+  • Requires the \`ensemble-ai\` CLI on PATH; if it's missing the gate FAILS OPEN
+    (allows) with a warning rather than blocking.
+
+Install into your OTHER config dir too, e.g.:  entrypoints/install.sh ~/.claude-work
+EOF
diff --git a/entrypoints/skills/brainstorm/SKILL.md b/entrypoints/skills/brainstorm/SKILL.md
new file mode 100644
index 0000000..16f91a5
--- /dev/null
+++ b/entrypoints/skills/brainstorm/SKILL.md
@@ -0,0 +1,30 @@
+---
+name: brainstorm
+description: Convene multiple AI voices (Codex + Grok + Claude) on a topic — each generates ideas independently, critiques the others, then one synthesizes a ranked, de-duplicated recommendation. Use when the user says "/brainstorm", wants cross-vendor ideation on a feature/name/architecture, or asks "what am I missing" with the ensemble.
+---
+
+# /brainstorm — cross-vendor ideation via ensemble-ai
+
+Thin wrapper over the `ensemble-ai` CLI. It convenes the cross-vendor AI ensemble
+on a topic and summarizes the result — it does NOT re-implement the logic. Three
+rounds: independent ideas → cross-critique → one voice synthesizes a ranked,
+contributor-credited recommendation.
+
+**What to run** (forward the user's arguments verbatim):
+
+```bash
+ensemble-ai brainstorm $ARGUMENTS
+```
+
+- Arguments: `"<topic>" [--file <path> for shared context]`
+- The CLI is READ-ONLY and LOCAL — nothing is transmitted beyond the vendor model
+  calls the CLI itself makes.
+- Prereq: the `ensemble-ai` CLI must be on `PATH` (see entrypoints/README.md).
+
+**Then, in-session:**
+1. Run the command above with the user's `$ARGUMENTS` (quote the topic).
+2. If it exits non-zero, report the exit code + the CLI's stderr (exit 1 = every
+   voice failed; exit 3 = usage / operational error).
+3. Summarize the CLI output: lead with the Round-3 ranked recommendation (with
+   contributors), then the notable independent ideas and cross-critiques worth
+   Oskar's attention. Do not re-run or second-guess the ensemble — relay + synthesize.
diff --git a/entrypoints/skills/consult/SKILL.md b/entrypoints/skills/consult/SKILL.md
new file mode 100644
index 0000000..f67f9f4
--- /dev/null
+++ b/entrypoints/skills/consult/SKILL.md
@@ -0,0 +1,30 @@
+---
+name: consult
+description: Pose a question to the ensemble (Codex + Grok + Claude) — each voice answers independently, then one synthesizes what they AGREE on (confident) vs where they DIVERGE (look closer) + a bottom-line recommendation. Use when the user says "/consult" or "/ask", wants a cross-vendor answer to a decision/research question, or a second and third vendor's take.
+---
+
+# /consult — cross-vendor Q&A via ensemble-ai
+
+Thin wrapper over the `ensemble-ai` CLI (the `consult` mode, alias `ask`). It poses
+a question to the cross-vendor AI ensemble and summarizes the result — it does NOT
+re-implement the logic. Each voice answers independently, then one synthesizes
+AGREE (the confident core) vs DIVERGE (flagged "look closer") + a recommendation.
+
+**What to run** (forward the user's arguments verbatim):
+
+```bash
+ensemble-ai consult $ARGUMENTS
+```
+
+- Arguments: `"<question>" [--file <path> for context · --critique]`
+- The CLI is READ-ONLY and LOCAL — nothing is transmitted beyond the vendor model
+  calls the CLI itself makes.
+- Prereq: the `ensemble-ai` CLI must be on `PATH` (see entrypoints/README.md).
+
+**Then, in-session:**
+1. Run the command above with the user's `$ARGUMENTS` (quote the question).
+2. If it exits non-zero, report the exit code + the CLI's stderr (exit 1 = every
+   voice failed; exit 3 = usage / operational error).
+3. Summarize the CLI output: lead with the AGREE points (confident) and the
+   recommendation, then flag the DIVERGE points where the vendors disagreed — those
+   are where to look closer. Do not re-run or second-guess the ensemble — relay + synthesize.
diff --git a/entrypoints/skills/review/SKILL.md b/entrypoints/skills/review/SKILL.md
new file mode 100644
index 0000000..59ac8fd
--- /dev/null
+++ b/entrypoints/skills/review/SKILL.md
@@ -0,0 +1,29 @@
+---
+name: review
+description: Convene every configured cross-vendor reviewer (Codex + Grok) on a code diff, read-only, and collect typed findings grouped by severity. Use when the user says "/review", asks to review a diff/PR/branch with the ensemble / cross-vendor / multiple models, or wants a second (and third) vendor's take on code.
+---
+
+# /review — cross-vendor review via ensemble-ai
+
+Thin wrapper over the `ensemble-ai` CLI. It convenes the cross-vendor AI ensemble
+and summarizes the result in this session — it does NOT re-implement the logic.
+
+**What to run** (forward the user's arguments verbatim):
+
+```bash
+ensemble-ai review $ARGUMENTS
+```
+
+- Arguments: `[diff source — default: current branch · --pr N · --staged · --diff-file <path>]`
+- The CLI is READ-ONLY (reviewers run sandboxed) and LOCAL — nothing is
+  transmitted beyond the vendor model calls the CLI itself makes.
+- Prereq: the `ensemble-ai` CLI must be on `PATH` (see entrypoints/README.md).
+
+**Then, in-session:**
+1. Run the command above with the user's `$ARGUMENTS`.
+2. If it exits non-zero, report the exit code + the CLI's stderr. Note: exit 4 =
+   a HIGH finding is present (a real signal, not a crash); exit 2 = blocked by the
+   secret-scan; exit 1 = a reviewer failed; exit 3 = usage / no diff.
+3. Summarize the CLI output for the user: lead with the headline (the HIGH/MED/LOW
+   findings + their `file:line`), then the actionable detail and the receipt path.
+   Do not re-run or second-guess the ensemble — relay + synthesize what it returned.
diff --git a/entrypoints/skills/security/SKILL.md b/entrypoints/skills/security/SKILL.md
new file mode 100644
index 0000000..e4765a8
--- /dev/null
+++ b/entrypoints/skills/security/SKILL.md
@@ -0,0 +1,32 @@
+---
+name: security
+description: Run the cross-vendor reviewers over a diff under a security-auditor lens (injection · XSS · authz · secret-leak · supply-chain · SSRF · path-traversal · crypto) plus a local dependency-surface flag. Use when the user says "/security", asks for a security audit/review of a diff/PR with the ensemble / cross-vendor / multiple models.
+---
+
+# /security — cross-vendor security audit via ensemble-ai
+
+Thin wrapper over the `ensemble-ai` CLI. It convenes the cross-vendor AI ensemble
+under a security-auditor lens and summarizes the result — it does NOT re-implement
+the logic. Same engine + diff sources + receipt + HIGH gate as `/review`, but with
+adversarial security prompts, findings tagged by security class, and a local
+dependency-surface flag (manifest changes + risky imports — NO network).
+
+**What to run** (forward the user's arguments verbatim):
+
+```bash
+ensemble-ai security $ARGUMENTS
+```
+
+- Arguments: `[diff source — default: current branch · --pr N · --staged · --diff-file <path>]`
+- The CLI is READ-ONLY (reviewers run sandboxed) and LOCAL — nothing is
+  transmitted beyond the vendor model calls the CLI itself makes.
+- Prereq: the `ensemble-ai` CLI must be on `PATH` (see entrypoints/README.md).
+
+**Then, in-session:**
+1. Run the command above with the user's `$ARGUMENTS`.
+2. If it exits non-zero, report the exit code + the CLI's stderr (exit 4 = a HIGH
+   security finding; exit 2 = secret-scan block; exit 1 = a reviewer failed; exit 3
+   = usage / no diff).
+3. Summarize the CLI output: lead with the HIGH findings and their security class +
+   `file:line`, then the dependency-surface flags and the receipt path.
+   Do not re-run or second-guess the ensemble — relay + synthesize what it returned.
diff --git a/package.json b/package.json
index fe38eaf..2998bc3 100644
--- a/package.json
+++ b/package.json
@@ -10,7 +10,8 @@
   },
   "type": "module",
   "bin": {
-    "ensemble-ai": "dist/cli.js"
+    "ensemble-ai": "dist/cli.js",
+    "ensemble-ai-pre-pr-gate": "dist/entrypoints/hook.js"
   },
   "main": "./dist/index.js",
   "types": "./dist/index.d.ts",
diff --git a/src/entrypoints/hook.test.ts b/src/entrypoints/hook.test.ts
new file mode 100644
index 0000000..022028c
--- /dev/null
+++ b/src/entrypoints/hook.test.ts
@@ -0,0 +1,184 @@
+import { describe, expect, it } from 'vitest';
+
+import {
+  buildVerifyArgs,
+  decideGate,
+  type GateInput,
+  isOverridden,
+  matchesGuardedCommand,
+  OVERRIDE_ENV,
+  parseCwd,
+  parseHookInput,
+  resolveTrailDir,
+  runHook,
+  TRAIL_ENV,
+  type VerifyOutcome,
+} from './hook';
+
+// A verify() that reports the diff reviewed (exit 0), unreviewed (exit non-zero),
+// or un-runnable (spawn failure) — the three states the gate must distinguish.
+const reviewed = (): VerifyOutcome => ({ code: 0, output: 'PASS', ran: true });
+const unreviewed = (reason = 'NO RECEIPT'): (() => VerifyOutcome) => () => ({
+  code: 3,
+  output: reason,
+  ran: true,
+});
+const cannotRun = (): VerifyOutcome => ({ error: 'spawn ensemble-ai ENOENT', ran: false });
+
+const prCreate: GateInput = { command: 'gh pr create --fill', toolName: 'Bash' };
+
+describe('matchesGuardedCommand', () => {
+  it('matches a bare and a chained `gh pr create`', () => {
+    expect(matchesGuardedCommand({ command: 'gh pr create', toolName: 'Bash' })).toBe(true);
+    expect(
+      matchesGuardedCommand({ command: 'cd repo && gh pr create --fill', toolName: 'Bash' })
+    ).toBe(true);
+    expect(
+      matchesGuardedCommand({ command: '/opt/homebrew/bin/gh pr create -t x', toolName: 'Bash' })
+    ).toBe(true);
+  });
+
+  it('does NOT match unrelated gh / non-Bash commands', () => {
+    expect(matchesGuardedCommand({ command: 'gh pr list', toolName: 'Bash' })).toBe(false);
+    expect(matchesGuardedCommand({ command: 'gh pr view 3', toolName: 'Bash' })).toBe(false);
+    expect(matchesGuardedCommand({ command: 'echo gh pr create-ish', toolName: 'Bash' })).toBe(false);
+    // a substring like `create` inside another word must not trip it
+    expect(matchesGuardedCommand({ command: 'gh pr createx', toolName: 'Bash' })).toBe(false);
+    // non-Bash tool → never guarded
+    expect(matchesGuardedCommand({ command: 'gh pr create', toolName: 'Edit' })).toBe(false);
+    expect(matchesGuardedCommand({})).toBe(false);
+  });
+});
+
+describe('decideGate', () => {
+  it('ALLOWS a non-PR command untouched (pass-through)', () => {
+    const d = decideGate(
+      { command: 'gh pr list', toolName: 'Bash' },
+      { overridden: false, verify: () => reviewed() }
+    );
+    expect(d.action).toBe('allow');
+  });
+
+  it('ALLOWS `gh pr create` when the diff is reviewed (receipt present → exit 0)', () => {
+    const d = decideGate(prCreate, { overridden: false, verify: () => reviewed() });
+    expect(d.action).toBe('allow');
+    expect(d.reason).toContain('valid');
+  });
+
+  it('BLOCKS `gh pr create` when there is NO receipt (verify exit non-zero)', () => {
+    const d = decideGate(prCreate, { overridden: false, verify: unreviewed('NO RECEIPT') });
+    expect(d.action).toBe('block');
+    expect(d.reason).toContain('NO current cross-vendor review receipt');
+    expect(d.reason).toContain('NO RECEIPT'); // the verify output is echoed
+  });
+
+  it('BLOCKS when the receipt is STALE (commits since review → verify exit non-zero)', () => {
+    const d = decideGate(prCreate, {
+      overridden: false,
+      verify: unreviewed('STALE — a receipt exists but its digest no longer matches'),
+    });
+    expect(d.action).toBe('block');
+    expect(d.reason).toContain('STALE');
+  });
+
+  it('fails OPEN when overridden (never hard-brick PR creation)', () => {
+    const d = decideGate(prCreate, { overridden: true, verify: unreviewed() });
+    expect(d.action).toBe('allow');
+    expect(d.reason).toContain('overridden');
+  });
+
+  it('fails OPEN with a warning when the verifier cannot run (broken install ≠ unreviewed)', () => {
+    const d = decideGate(prCreate, { overridden: false, verify: () => cannotRun() });
+    expect(d.action).toBe('allow');
+    expect(d.reason).toContain('could not run');
+  });
+});
+
+describe('isOverridden', () => {
+  it('honors the override env (truthy only)', () => {
+    expect(isOverridden(prCreate, { [OVERRIDE_ENV]: '1' })).toBe(true);
+    expect(isOverridden(prCreate, { [OVERRIDE_ENV]: 'yes' })).toBe(true);
+    expect(isOverridden(prCreate, { [OVERRIDE_ENV]: '0' })).toBe(false);
+    expect(isOverridden(prCreate, { [OVERRIDE_ENV]: 'false' })).toBe(false);
+    expect(isOverridden(prCreate, {})).toBe(false);
+  });
+
+  it('honors the inline skip marker in the command', () => {
+    expect(
+      isOverridden({ command: 'gh pr create # ensemble-ai:skip-gate', toolName: 'Bash' }, {})
+    ).toBe(true);
+  });
+});
+
+describe('resolveTrailDir + buildVerifyArgs', () => {
+  it('prefers the env trail dir', () => {
+    expect(resolveTrailDir('/repo', { [TRAIL_ENV]: '/t' }, () => false)).toBe('/t');
+  });
+
+  it('falls back to the conventional .ensemble-ai/trail when it exists', () => {
+    const dir = resolveTrailDir('/repo', {}, (p) => p === '/repo/.ensemble-ai/trail');
+    expect(dir).toBe('/repo/.ensemble-ai/trail');
+  });
+
+  it('returns undefined when neither is present (strict then fails closed)', () => {
+    expect(resolveTrailDir('/repo', {}, () => false)).toBeUndefined();
+  });
+
+  it('builds `receipt verify --strict` and appends --trail only when set', () => {
+    expect(buildVerifyArgs(undefined)).toEqual(['receipt', 'verify', '--strict']);
+    expect(buildVerifyArgs('/t')).toEqual(['receipt', 'verify', '--strict', '--trail', '/t']);
+  });
+});
+
+describe('parseHookInput / parseCwd', () => {
+  it('extracts the Bash command, tool name, and cwd', () => {
+    const raw = JSON.stringify({
+      cwd: '/repo',
+      tool_input: { command: 'gh pr create' },
+      tool_name: 'Bash',
+    });
+    expect(parseHookInput(raw)).toEqual({ command: 'gh pr create', toolName: 'Bash' });
+    expect(parseCwd(raw)).toBe('/repo');
+  });
+
+  it('degrades to an empty input on malformed JSON (→ allow, never crash)', () => {
+    expect(parseHookInput('not json')).toEqual({});
+    expect(parseCwd('not json')).toBeUndefined();
+  });
+});
+
+describe('runHook (stdin → decision → exit code + output)', () => {
+  // runHook calls the real runVerifyCli internally, so we assert its OUTPUT
+  // contract only on the paths that never reach the CLI: a non-guarded command
+  // (silent allow) and an overridden gh pr create (fail-open allow with a
+  // warning). The verify→block DECISION itself is covered by decideGate above.
+  function capture(raw: string, env: NodeJS.ProcessEnv) {
+    const logs: string[] = [];
+    const warns: string[] = [];
+    const code = runHook(raw, {
+      env,
+      log: (m) => logs.push(m),
+      warn: (m) => warns.push(m),
+    });
+    return { code, logs, warns };
+  }
+
+  it('silently allows (exit 0, no output) a non-PR command', () => {
+    const raw = JSON.stringify({ tool_input: { command: 'gh pr list' }, tool_name: 'Bash' });
+    const { code, logs, warns } = capture(raw, {});
+    expect(code).toBe(0);
+    expect(logs).toHaveLength(0);
+    expect(warns).toHaveLength(0);
+  });
+
+  it('allows (exit 0) with a warning when overridden on a real gh pr create', () => {
+    const raw = JSON.stringify({
+      cwd: '/nonexistent',
+      tool_input: { command: 'gh pr create --fill' },
+      tool_name: 'Bash',
+    });
+    const { code, warns } = capture(raw, { [OVERRIDE_ENV]: '1' });
+    expect(code).toBe(0);
+    expect(warns.join('\n')).toContain('overridden');
+  });
+});
diff --git a/src/entrypoints/hook.ts b/src/entrypoints/hook.ts
new file mode 100644
index 0000000..87ee3f0
--- /dev/null
+++ b/src/entrypoints/hook.ts
@@ -0,0 +1,296 @@
+#!/usr/bin/env node
+// The pre-PR REVIEW GATE — a Claude Code PreToolUse hook. It intercepts a Bash
+// tool call, and when that call creates a GitHub PR (`gh pr create`) it runs
+// `ensemble-ai receipt verify --strict` on the current diff and BLOCKS the PR
+// unless a current, artifact-proven cross-vendor review receipt exists.
+//
+// Design contract (per the ratified codex-grok-work-code-review-policy):
+//   • REVIEW-ONLY + purely LOCAL — it runs the local verify CLI and reads a local
+//     receipt store; it never transmits anything anywhere. Safe to install in BOTH
+//     ~/.claude AND ~/.claude-work so it reaches _work diffs.
+//   • DEFAULT FAIL-CLOSED on an unreviewed diff: verify exits non-zero → block.
+//   • NEVER HARD-BRICK: an explicit override (env ENSEMBLE_AI_GATE_OVERRIDE, or a
+//     documented per-command marker) fails OPEN; and a gate that cannot even RUN
+//     the verifier (CLI missing / spawn error) fails OPEN with a loud warning
+//     rather than blocking all PR creation on a broken install.
+//
+// This module is PURE + injectable (decideGate takes its verify + env as deps) so
+// the verify→gate decision is unit-tested with mocked receipt present/absent/stale.
+// The thin runHook() at the bottom wires stdin JSON → the CLI → the hook output.
+
+import { execFileSync } from 'node:child_process';
+import fs from 'node:fs';
+import path from 'node:path';
+
+// The env var that forces the gate OPEN (fail-open) so it can never hard-brick PR
+// creation. Any non-empty, non-"0"/"false" value enables the override.
+export const OVERRIDE_ENV = 'ENSEMBLE_AI_GATE_OVERRIDE';
+// An optional escape hatch a user can drop INTO the `gh pr create` command itself,
+// e.g. `gh pr create ... # ensemble-ai:skip-gate`, to bypass a single PR without a
+// persistent env change. Documented in entrypoints/README.md.
+export const INLINE_OVERRIDE_MARKER = 'ensemble-ai:skip-gate';
+// The env var pointing at the run-trail dir (a review's `--out`) whose immutable
+// per-reviewer artifacts prove the receipt under --strict. Unset → strict verify
+// fails closed (the safe default; document running reviews with a stable --out).
+export const TRAIL_ENV = 'ENSEMBLE_AI_TRAIL_DIR';
+
+export interface GateInput {
+  // The Bash command text (undefined for non-Bash tools).
+  command?: string;
+  // The PreToolUse tool name, e.g. "Bash".
+  toolName?: string;
+}
+
+// Does this tool call attempt to create a GitHub PR? Only a Bash `gh pr create`
+// invocation is guarded — every other tool call passes straight through. Matches
+// `gh` (optionally path-qualified) then `pr` then `create` as whitespace-separated
+// tokens anywhere in the command (so `cd x && gh pr create …` is caught), tolerant
+// of extra spaces; deliberately narrow to avoid guarding unrelated commands.
+export function matchesGuardedCommand(input: GateInput): boolean {
+  if (input.toolName && input.toolName !== 'Bash') return false;
+  const cmd = input.command;
+  if (!cmd) return false;
+  return /(^|[\s;&|(])(?:[^\s;&|]*\/)?gh\s+pr\s+create(\s|$)/.test(cmd);
+}
+
+// Is the override active for this call? True if the override env is set to a truthy
+// value OR the guarded command carries the inline skip marker.
+export function isOverridden(input: GateInput, env: NodeJS.ProcessEnv): boolean {
+  const raw = env[OVERRIDE_ENV];
+  const envOn = !!raw && raw !== '0' && raw.toLowerCase() !== 'false';
+  const inlineOn = !!input.command && input.command.includes(INLINE_OVERRIDE_MARKER);
+  return envOn || inlineOn;
+}
+
+// The result of attempting to run `ensemble-ai receipt verify --strict`. `ran:false`
+// means the verifier could not even execute (CLI missing / spawn error) — distinct
+// from `ran:true, code!=0` (verify ran and reported the diff unreviewed).
+export type VerifyOutcome =
+  | { code: number; output: string; ran: true }
+  | { error: string; ran: false };
+
+export type GateDecision =
+  | { action: 'allow'; reason: string }
+  | { action: 'block'; reason: string };
+
+export interface GateDeps {
+  // True when the user has explicitly opted to bypass the gate for this call.
+  overridden: boolean;
+  // Runs the verifier. Injected so the decision is unit-tested without a CLI.
+  verify: () => VerifyOutcome;
+}
+
+// The gate DECISION — pure. Order matters:
+//   1. not a `gh pr create` → allow (pass through, untouched);
+//   2. override active → allow (fail-open, so the gate can never hard-brick);
+//   3. verifier could not run → allow with a warning (broken install ≠ unreviewed
+//      diff; blocking every PR on a missing CLI is the hard-brick to avoid);
+//   4. verify exit 0 → allow (a current, artifact-proven review receipt exists);
+//   5. verify exit non-zero → BLOCK (fail-closed: unreviewed / stale / under-policy).
+export function decideGate(input: GateInput, deps: GateDeps): GateDecision {
+  if (!matchesGuardedCommand(input)) {
+    return { action: 'allow', reason: 'not a `gh pr create` command' };
+  }
+  if (deps.overridden) {
+    return {
+      action: 'allow',
+      reason: `gate overridden (${OVERRIDE_ENV} set or "${INLINE_OVERRIDE_MARKER}" in the command) — PR allowed WITHOUT a verified review`,
+    };
+  }
+  const res = deps.verify();
+  if (!res.ran) {
+    return {
+      action: 'allow',
+      reason: `ensemble-ai review gate could not run the verifier (${res.error}) — failing OPEN so PR creation is not bricked; install the ensemble-ai CLI to enforce the gate`,
+    };
+  }
+  if (res.code === 0) {
+    return {
+      action: 'allow',
+      reason: 'the current diff has a valid, current cross-vendor review receipt',
+    };
+  }
+  return {
+    action: 'block',
+    reason:
+      'This PR has NO current cross-vendor review receipt for its diff. Review it first:\n' +
+      '    ensemble-ai review --out .ensemble-ai/trail    # runs Codex + Grok, writes the receipt\n' +
+      'then re-run `gh pr create`. ' +
+      `To bypass this once: append \`# ${INLINE_OVERRIDE_MARKER}\` to the command, or set ${OVERRIDE_ENV}=1.\n` +
+      'verify said:\n' +
+      indentBlock((res.output || '').trim()),
+  };
+}
+
+function indentBlock(s: string): string {
+  if (!s) return '    (no output)';
+  return s
+    .split('\n')
+    .map((l) => `    ${l}`)
+    .join('\n');
+}
+
+// ── stdin → CLI → hook output wiring (the impure shell around decideGate) ────────
+
+// Parse the Claude Code PreToolUse hook payload. Tolerant of shape drift: missing
+// fields simply mean "not a guarded call" (→ allow), never a crash.
+export function parseHookInput(raw: string): GateInput {
+  try {
+    const j = JSON.parse(raw) as {
+      cwd?: string;
+      tool_input?: { command?: string };
+      tool_name?: string;
+    };
+    return {
+      command: j.tool_input?.command,
+      toolName: j.tool_name,
+    };
+  } catch {
+    return {};
+  }
+}
+
+// Extract the cwd the guarded command runs in, so verify checks the RIGHT repo.
+export function parseCwd(raw: string): string | undefined {
+  try {
+    const j = JSON.parse(raw) as { cwd?: string };
+    return typeof j.cwd === 'string' ? j.cwd : undefined;
+  } catch {
+    return undefined;
+  }
+}
+
+// Resolve the trail dir for `verify --strict`: the env override, else a
+// conventional `.ensemble-ai/trail` under the repo cwd if it exists. Unset +
+// no convention dir → undefined → strict fails closed (the safe default).
+export function resolveTrailDir(
+  cwd: string | undefined,
+  env: NodeJS.ProcessEnv,
+  exists: (p: string) => boolean = fs.existsSync
+): string | undefined {
+  const fromEnv = env[TRAIL_ENV];
+  if (fromEnv) return fromEnv;
+  if (cwd) {
+    const conventional = path.join(cwd, '.ensemble-ai', 'trail');
+    if (exists(conventional)) return conventional;
+  }
+  return undefined;
+}
+
+// Build the argv for `ensemble-ai receipt verify --strict [--trail <dir>]`. The
+// pre-PR gate is the artifact-proven mode (per verify.ts): --strict requires the
+// real reviewer artifacts, so an attestation-only or absent receipt fails closed.
+export function buildVerifyArgs(trailDir: string | undefined): string[] {
+  const args = ['receipt', 'verify', '--strict'];
+  if (trailDir) args.push('--trail', trailDir);
+  return args;
+}
+
+// Run the verifier via the `ensemble-ai` CLI on PATH. Exit codes ARE the contract
+// (0 = reviewed; non-zero = not), so a non-zero exit is a normal outcome, not a
+// throw to catch — execFileSync throws on non-zero, so we recover the code. A
+// spawn failure (ENOENT — CLI not installed) is the `ran:false` fail-open path.
+export function runVerifyCli(
+  cwd: string | undefined,
+  env: NodeJS.ProcessEnv
+): VerifyOutcome {
+  const trailDir = resolveTrailDir(cwd, env);
+  const args = buildVerifyArgs(trailDir);
+  try {
+    const output = execFileSync('ensemble-ai', args, {
+      cwd: cwd || process.cwd(),
+      encoding: 'utf8',
+      env,
+      // Bound it so a wedged verify can't hang PR creation forever.
+      timeout: 120_000,
+    });
+    return { code: 0, output, ran: true };
+  } catch (e) {
+    const err = e as {
+      code?: number | string;
+      status?: number | null;
+      stderr?: Buffer | string;
+      stdout?: Buffer | string;
+      message?: string;
+    };
+    // A resolved exit status (number) means the CLI RAN and returned non-zero.
+    if (typeof err.status === 'number') {
+      const out = `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`;
+      return { code: err.status, output: out, ran: true };
+    }
+    // No numeric status → the process could not be spawned (ENOENT, etc.).
+    return {
+      error: err.message || 'could not spawn `ensemble-ai`',
+      ran: false,
+    };
+  }
+}
+
+export interface HookIO {
+  env: NodeJS.ProcessEnv;
+  log: (msg: string) => void; // stdout
+  warn: (msg: string) => void; // stderr
+}
+
+// The full hook run: stdin JSON → decision → { exitCode }. A block is signalled to
+// Claude Code by exit code 2 with the reason on stderr (the version-robust
+// PreToolUse block contract) AND a permissionDecision JSON on stdout for newer
+// versions; an allow is a silent exit 0 (with any fail-open warning on stderr).
+export function runHook(raw: string, io: HookIO): number {
+  const input = parseHookInput(raw);
+  const cwd = parseCwd(raw);
+  const decision = decideGate(input, {
+    overridden: isOverridden(input, io.env),
+    verify: () => runVerifyCli(cwd, io.env),
+  });
+  if (decision.action === 'block') {
+    io.log(
+      JSON.stringify({
+        hookSpecificOutput: {
+          hookEventName: 'PreToolUse',
+          permissionDecision: 'deny',
+          permissionDecisionReason: decision.reason,
+        },
+      })
+    );
+    io.warn(`[ensemble-ai pre-PR gate] BLOCKED — ${decision.reason}`);
+    return 2;
+  }
+  // Allow. Surface a fail-open reason on stderr so a bypass is never silent.
+  if (
+    decision.reason.includes('overridden') ||
+    decision.reason.includes('could not run')
+  ) {
+    io.warn(`[ensemble-ai pre-PR gate] ALLOW — ${decision.reason}`);
+  }
+  return 0;
+}
+
+// Auto-run ONLY as the actual hook entry (not when imported by a test). Reads the
+// whole stdin payload synchronously, runs the hook, sets the process exit code.
+function isEntrypoint(): boolean {
+  const entry = process.argv[1];
+  if (!entry) return false;
+  try {
+    return (
+      path.resolve(entry) ===
+      path.resolve(new URL(import.meta.url).pathname)
+    );
+  } catch {
+    return false;
+  }
+}
+
+if (isEntrypoint()) {
+  let raw = '';
+  try {
+    raw = fs.readFileSync(0, 'utf8');
+  } catch {
+    raw = '';
+  }
+  process.exitCode = runHook(raw, {
+    env: process.env,
+    log: (m) => console.log(m),
+    warn: (m) => console.error(m),
+  });
+}
diff --git a/src/entrypoints/skills.test.ts b/src/entrypoints/skills.test.ts
new file mode 100644
index 0000000..2f7ebd3
--- /dev/null
+++ b/src/entrypoints/skills.test.ts
@@ -0,0 +1,92 @@
+import fs from 'node:fs';
+import path from 'node:path';
+import { fileURLToPath } from 'node:url';
+
+import { describe, expect, it } from 'vitest';
+
+import { IMPLEMENTED_MODES, resolveMode } from '../modes';
+
+import {
+  buildSkillCommand,
+  findSkill,
+  renderSkillDoc,
+  SKILL_ARGS_PLACEHOLDER,
+  SKILL_SPECS,
+  skillInvocationLine,
+} from './skills';
+
+// The shipped skill markdown lives at <repo>/entrypoints/skills/<name>/SKILL.md.
+const SKILLS_DIR = path.resolve(
+  path.dirname(fileURLToPath(import.meta.url)),
+  '../../entrypoints/skills'
+);
+
+describe('SKILL_SPECS registry', () => {
+  it('has the four entrypoint skills', () => {
+    expect(SKILL_SPECS.map((s) => s.name).sort()).toEqual([
+      'brainstorm',
+      'consult',
+      'review',
+      'security',
+    ]);
+  });
+
+  it('every skill maps ONLY to an IMPLEMENTED mode (no pointing at a planned mode)', () => {
+    for (const spec of SKILL_SPECS) {
+      // the skill name is the CLI verb; it must resolve to the spec's mode …
+      expect(resolveMode(spec.name)).toBe(spec.mode);
+      // … and that mode must actually be built
+      expect(IMPLEMENTED_MODES).toContain(spec.mode);
+    }
+  });
+});
+
+describe('buildSkillCommand (the wrapper invocation)', () => {
+  it('maps each skill to its CLI verb + forwards args verbatim', () => {
+    expect(buildSkillCommand('review', ['--pr', '12'])).toEqual({
+      argv: ['review', '--pr', '12'],
+    });
+    expect(buildSkillCommand('brainstorm', ['naming options for X'])).toEqual({
+      argv: ['brainstorm', 'naming options for X'],
+    });
+    // no args → just the verb
+    expect(buildSkillCommand('security')).toEqual({ argv: ['security'] });
+  });
+
+  it('fails closed on an unknown skill (never a silent no-op)', () => {
+    const r = buildSkillCommand('deploy');
+    expect('error' in r).toBe(true);
+  });
+});
+
+describe('skillInvocationLine', () => {
+  it('is `ensemble-ai <mode> $ARGUMENTS`', () => {
+    const spec = findSkill('consult')!;
+    expect(skillInvocationLine(spec)).toBe(`ensemble-ai consult ${SKILL_ARGS_PLACEHOLDER}`);
+  });
+});
+
+describe('shipped SKILL.md files (no drift from the registry)', () => {
+  for (const spec of SKILL_SPECS) {
+    it(`skills/${spec.name}/SKILL.md invokes the right CLI command`, () => {
+      const file = path.join(SKILLS_DIR, spec.name, 'SKILL.md');
+      const body = fs.readFileSync(file, 'utf8');
+      // frontmatter name matches the registry (what Claude Code keys the skill on)
+      expect(body).toContain(`name: ${spec.name}`);
+      // the wrapper invokes EXACTLY the CLI command the registry says it does
+      expect(body).toContain(skillInvocationLine(spec));
+      // and forwards the user's arguments placeholder
+      expect(body).toContain(SKILL_ARGS_PLACEHOLDER);
+    });
+  }
+});
+
+describe('renderSkillDoc', () => {
+  it('produces frontmatter + the invocation for a spec', () => {
+    const spec = findSkill('review')!;
+    const doc = renderSkillDoc(spec);
+    expect(doc.startsWith(`---\nname: review\n`)).toBe(true);
+    expect(doc).toContain(skillInvocationLine(spec));
+    expect(doc).toContain(spec.argHint);
+  });
+});
diff --git a/src/entrypoints/skills.ts b/src/entrypoints/skills.ts
new file mode 100644
index 0000000..eea1b44
--- /dev/null
+++ b/src/entrypoints/skills.ts
@@ -0,0 +1,127 @@
+// The Claude-skill entrypoint layer: thin wrappers that map a slash-command
+// (`/review`, `/security`, `/brainstorm`, `/consult`) onto the corresponding
+// `ensemble-ai <mode>` CLI invocation and tell Claude to summarize the result
+// in-session. The skill markdown files (entrypoints/skills/<name>/SKILL.md) are
+// the shipped artifacts; THIS module is the single source of truth for which CLI
+// command each skill runs, so the wrappers can't drift from the CLI + a unit test
+// can assert the shipped markdown invokes the right command. Pure — no I/O.
+
+import type { ModeName } from '../modes';
+
+// The `$ARGUMENTS` placeholder Claude Code substitutes with the user's raw text
+// when a skill is invoked (e.g. `/review --pr 12` → ARGUMENTS = `--pr 12`). The
+// wrappers forward it verbatim to the CLI so every CLI flag works from the skill.
+export const SKILL_ARGS_PLACEHOLDER = '$ARGUMENTS';
+
+export interface SkillSpec {
+  // What the user types the arg as — a diff source, a topic, or a question.
+  argHint: string;
+  // A one-line description of what convening the ensemble does for this skill.
+  blurb: string;
+  // The canonical CLI mode (post-alias) this skill runs.
+  mode: ModeName;
+  // The slash-command name (no leading slash), == the CLI mode/alias the user knows.
+  name: string;
+}
+
+// The four entrypoint skills. `name` is what the user types (and the CLI verb the
+// wrapper runs); `mode` is the canonical mode it resolves to (only ever an
+// IMPLEMENTED mode — asserted by the tests, so a skill can never point at a
+// planned-but-unbuilt mode).
+export const SKILL_SPECS: SkillSpec[] = [
+  {
+    argHint: '[diff source — default: current branch · --pr N · --staged · --diff-file <path>]',
+    blurb:
+      'Convene every configured cross-vendor reviewer (Codex + Grok) on a code diff, read-only, and collect typed findings grouped by severity.',
+    mode: 'review',
+    name: 'review',
+  },
+  {
+    argHint: '[diff source — default: current branch · --pr N · --staged · --diff-file <path>]',
+    blurb:
+      'Run the cross-vendor reviewers over a diff under a security-auditor lens (injection · XSS · authz · secret-leak · supply-chain · SSRF · path-traversal · crypto) plus a local dependency-surface flag.',
+    mode: 'security',
+    name: 'security',
+  },
+  {
+    argHint: '"<topic>" [--file <path> for shared context]',
+    blurb:
+      'Convene multiple AI voices (Codex + Grok + Claude) on a topic: each generates ideas independently, critiques the others, then one synthesizes a ranked, de-duplicated recommendation.',
+    mode: 'brainstorm',
+    name: 'brainstorm',
+  },
+  {
+    argHint: '"<question>" [--file <path> for context · --critique]',
+    blurb:
+      'Pose a question to the ensemble: each voice answers independently, then one synthesizes what they AGREE on (confident) vs where they DIVERGE (look closer) + a bottom-line recommendation.',
+    mode: 'consult',
+    name: 'consult',
+  },
+];
+
+export function findSkill(name: string): SkillSpec | undefined {
+  return SKILL_SPECS.find((s) => s.name === name);
+}
+
+// The exact CLI argv a skill runs: the mode followed by the user's raw args split
+// on whitespace. Returns the argv array (what a spawn would receive) so a caller
+// (and the test) sees precisely what the wrapper invokes — never a re-interpreted
+// command. Unknown skill name → error (fail closed, never a silent no-op).
+export function buildSkillCommand(
+  name: string,
+  userArgs: string[] = []
+): { argv: string[] } | { error: string } {
+  const spec = findSkill(name);
+  if (!spec) {
+    return {
+      error: `unknown skill "${name}" (known: ${SKILL_SPECS.map((s) => s.name).join(', ')})`,
+    };
+  }
+  // The skill name IS the CLI verb (review/security/brainstorm/consult), so the
+  // wrapper stays a pure pass-through; resolveMode confirms it maps to a real mode.
+  return { argv: [spec.name, ...userArgs] };
+}
+
+// The one-line shell invocation a SKILL.md tells Claude to run, forwarding the
+// user's `$ARGUMENTS` verbatim. The single source of truth for the shipped
+// markdown (a test asserts each SKILL.md contains exactly this line), so the
+// skill wrapper and the CLI can never drift.
+export function skillInvocationLine(spec: SkillSpec): string {
+  return `ensemble-ai ${spec.name} ${SKILL_ARGS_PLACEHOLDER}`;
+}
+
+// Render the full SKILL.md body from a spec — the frontmatter (name + description
+// Claude Code matches on) plus the minimal wrapper instructions. Generated from
+// the registry so the docs, the invocation, and the mode mapping are one thing.
+export function renderSkillDoc(spec: SkillSpec): string {
+  const description = `${spec.blurb} Use when Oskar says "/${spec.name}", asks to ${spec.name} something with the ensemble / cross-vendor / multiple models, or wants a second (and third) vendor's take.`;
+  return `---
+name: ${spec.name}
+description: ${description}
+---
+
+# /${spec.name} — cross-vendor ${spec.name} via ensemble-ai
+
+Thin wrapper over the \`ensemble-ai\` CLI. It convenes the cross-vendor AI ensemble
+and summarizes the result in this session — it does NOT re-implement the logic.
+
+**What to run** (forward the user's arguments verbatim):
+
+\`\`\`bash
+${skillInvocationLine(spec)}
+\`\`\`
+
+- Arguments: \`${spec.argHint}\`
+- The CLI is READ-ONLY (reviewers/voices run sandboxed) and LOCAL — nothing is
+  transmitted beyond the vendor model calls the CLI itself makes.
+- Prereq: the \`ensemble-ai\` CLI must be on \`PATH\` (see entrypoints/README.md).
+
+**Then, in-session:**
+1. Run the command above with the user's \`${SKILL_ARGS_PLACEHOLDER}\`.
+2. If it exits non-zero, report the exit code + the CLI's stderr (e.g. \`review\`/\`security\`
+   exit 4 = a HIGH finding is present — that is a real signal, not a crash).
+3. Summarize the CLI output for the user: lead with the headline (the findings /
+   the ranked recommendation / the AGREE-vs-DIVERGE), then the actionable detail.
+   Do not re-run or second-guess the ensemble — relay + synthesize what it returned.
+`;
+}
diff --git a/tsup.config.ts b/tsup.config.ts
index 9783591..9ec73a4 100644
--- a/tsup.config.ts
+++ b/tsup.config.ts
@@ -6,7 +6,14 @@ import { defineConfig } from 'tsup';
 // ZERO build step and ZERO transitive deps (the engine is node-built-ins only) —
 // the most robust shape for a consumer's `npm ci`. Rebuild with `npm run build`.
 export default defineConfig({
-  entry: ['src/index.ts', 'src/cli.ts', 'src/contracts.ts'],
+  entry: [
+    'src/index.ts',
+    'src/cli.ts',
+    'src/contracts.ts',
+    // The pre-PR review-gate hook (a Claude Code PreToolUse hook bin) — built with
+    // a shebang so it runs standalone as `ensemble-ai-pre-pr-gate` / node dist path.
+    'src/entrypoints/hook.ts',
+  ],
   format: ['esm'],
   target: 'node20',
   platform: 'node',


## Changed files (full content)
_(surrounding context for the diff hunks — UNAVAILABLE)_

(not available)

## Repo conventions (AGENTS.md)
_(house rules + known footguns the change must respect — UNAVAILABLE)_

(not available)

## Recent run history
_(what was fired against this repo lately — UNAVAILABLE)_

(not available)

## Your task
Find correctness bugs, security issues, broken conventions, and risky
choices IN THE DIFF. Be concrete and cite file + line. Do not nitpick style
the conventions already allow. Prefer a few high-signal findings over many
weak ones — false positives waste the arbiter’s time.

## Output format — STRICT
Respond with ONE fenced ```json block and NOTHING else, matching:
{
  "summary": "<one short paragraph: your overall read of the change>",
  "findings": [
    {
      "title": "<short title>",
      "body": "<the issue, why it matters, and the suggested fix>",
      "severity": "high" | "medium" | "low",
      "confidence": "high" | "medium" | "low",
      "evidence": { "file": "<a path from the diff>", "line": <number, or omit>, "detail": "<optional>" }
    }
  ]
}
Rules: cite a concrete file in every finding's "evidence" (an uncited finding is
discounted). "severity" = the impact IF the finding is real; "confidence" = how
sure you are it is real. If the change looks correct, return an empty "findings"
array with a "summary" that says so. Do not invent issues to fill the list.
