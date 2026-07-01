#!/usr/bin/env bash
# ensemble-ai entrypoints installer — copies the Claude skills + wires the pre-PR
# review-gate hook into a Claude Code config dir.
#
# RUN IT YOURSELF. It is deliberately NOT run by any agent unattended, and it never
# modifies a config dir you did not pass. Install into BOTH config dirs so the gate
# reaches your work diffs too (the gate is REVIEW-ONLY + purely LOCAL — it runs the
# local verifier and reads a local receipt store; it transmits nothing):
#
#   entrypoints/install.sh ~/.claude
#   entrypoints/install.sh ~/.claude-work
#
# With no argument it targets ${CLAUDE_CONFIG_DIR:-$HOME/.claude}.
#
# What it does, idempotently (safe to re-run):
#   1. copies entrypoints/skills/* into  <target>/skills/
#   2. merges a PreToolUse "Bash" hook into <target>/settings.json that runs the
#      built gate bin — node <repo>/dist/entrypoints/hook.js — on every Bash call
#      (the hook itself only acts on `gh pr create`; everything else passes through).
# settings.json is backed up to settings.json.bak before it is touched.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK_JS="$REPO/dist/entrypoints/hook.js"
SKILLS_SRC="$REPO/entrypoints/skills"
TARGET="${1:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}}"

command -v node >/dev/null 2>&1 || { echo "error: node is required (the hook + this installer use it)" >&2; exit 1; }
[ -f "$HOOK_JS" ] || { echo "error: $HOOK_JS not found — run 'npm run build' in $REPO first" >&2; exit 1; }
[ -d "$SKILLS_SRC" ] || { echo "error: $SKILLS_SRC not found" >&2; exit 1; }

echo "ensemble-ai entrypoints → $TARGET"
mkdir -p "$TARGET/skills"

# 1) skills
for dir in "$SKILLS_SRC"/*/; do
  # Skip anything that isn't a skill dir — a subdir without a SKILL.md, or (when the
  # glob matches nothing and stays literal) the non-existent "*/". Without this guard
  # `set -e` + a failing `cp` would abort the install half-applied (skills partly
  # copied, the gate hook never merged).
  [ -f "$dir/SKILL.md" ] || continue
  name="$(basename "$dir")"
  mkdir -p "$TARGET/skills/$name"
  cp "$dir/SKILL.md" "$TARGET/skills/$name/SKILL.md"
  echo "  skill: /$name  →  $TARGET/skills/$name/SKILL.md"
done

# 2) the pre-PR gate hook — merge into settings.json without clobbering other hooks.
SETTINGS="$TARGET/settings.json"
[ -f "$SETTINGS" ] && cp "$SETTINGS" "$SETTINGS.bak" && echo "  backup: $SETTINGS.bak"

# Single-quote the hook path IN the command string so a repo path with spaces still
# runs (the command is executed by a shell). Also escape any single quote in the path
# (e.g. an /Users/o'brien/... home) as the '\'' idiom, so the quoting stays valid
# instead of producing a broken command that silently never runs (fail-open gate).
HOOK_CMD="node '${HOOK_JS//\'/\'\\\'\'}'"
SETTINGS="$SETTINGS" HOOK_CMD="$HOOK_CMD" node <<'NODE'
const fs = require('fs');
const file = process.env.SETTINGS;
const cmd = process.env.HOOK_CMD;
let cfg = {};
// If settings.json EXISTS but is unparseable, ABORT — never silently reset it to
// {} and overwrite the user's config (the .bak was already made, but clobbering a
// present-but-broken file is data loss). A missing file is fine → start from {}.
if (fs.existsSync(file)) {
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(
      `error: ${file} exists but is not valid JSON (${e.message}) — fix it or move it aside; refusing to overwrite`
    );
    process.exit(1);
  }
}
cfg.hooks = cfg.hooks || {};
const pre = Array.isArray(cfg.hooks.PreToolUse) ? cfg.hooks.PreToolUse : [];
// Idempotent: drop any prior ensemble-ai gate group, then add a fresh one.
// Match either install form: the `node .../dist/entrypoints/hook.js` path this
// script writes, or the `ensemble-ai-pre-pr-gate` bin name the README documents for
// an npm-linked install — so re-running REPLACES our group instead of duplicating it.
const isOurs = (g) => Array.isArray(g.hooks) && g.hooks.some(
  (h) => typeof h.command === 'string' &&
    (h.command.includes('entrypoints/hook.js') || h.command.includes('ensemble-ai-pre-pr-gate'))
);
const kept = pre.filter((g) => !isOurs(g));
kept.push({ matcher: 'Bash', hooks: [{ type: 'command', command: cmd }] });
cfg.hooks.PreToolUse = kept;
fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
console.log('  hook:  PreToolUse Bash → ' + cmd);
NODE

cat <<EOF

Done. The pre-PR review gate is active for $TARGET.

  • It BLOCKS \`gh pr create\` unless the current diff has a valid, artifact-proven
    cross-vendor review receipt (\`ensemble-ai receipt verify --strict\`).
  • To earn a receipt, review with a STABLE trail dir and point the gate at it:
        ensemble-ai review --out .ensemble-ai/trail
        export ENSEMBLE_AI_TRAIL_DIR="\$PWD/.ensemble-ai/trail"   # or set once, globally
    (add .ensemble-ai/ to your .gitignore.)
  • Bypass a single PR:  append \`# ensemble-ai:skip-gate\` to the command,
    or set ENSEMBLE_AI_GATE_OVERRIDE=1  (the gate can never hard-brick PR creation).
  • Requires the \`ensemble-ai\` CLI on PATH; if it's missing the gate FAILS OPEN
    (allows) with a warning rather than blocking.

Install into your OTHER config dir too, e.g.:  entrypoints/install.sh ~/.claude-work
EOF
