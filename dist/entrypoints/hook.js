#!/usr/bin/env node

// src/entrypoints/hook.ts
import { execFileSync } from "child_process";
import fs2 from "fs";
import path from "path";

// src/core/entrypoint.ts
import fs from "fs";
import { fileURLToPath } from "url";
function isEntrypoint(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

// src/entrypoints/hook.ts
var OVERRIDE_ENV = "ENSEMBLE_AI_GATE_OVERRIDE";
var INLINE_OVERRIDE_MARKER = "ensemble-ai:skip-gate";
var TRAIL_ENV = "ENSEMBLE_AI_TRAIL_DIR";
function matchesGuardedCommand(input) {
  if (input.toolName && input.toolName !== "Bash") return false;
  const cmd = input.command;
  if (!cmd) return false;
  return /(^|[\s;&|(])(?:[^\s;&|]*\/)?gh\s+pr\s+create($|[\s;&|)])/.test(cmd);
}
function hasInlineOverride(command) {
  const i = command.indexOf(INLINE_OVERRIDE_MARKER);
  if (i < 0) return false;
  const lineStart = command.lastIndexOf("\n", i) + 1;
  return command.lastIndexOf("#", i) >= lineStart;
}
function isOverridden(input, env) {
  const raw = env[OVERRIDE_ENV];
  const envOn = !!raw && raw !== "0" && raw.toLowerCase() !== "false";
  const inlineOn = !!input.command && hasInlineOverride(input.command);
  return envOn || inlineOn;
}
function decideGate(input, deps) {
  if (!matchesGuardedCommand(input)) {
    return { action: "allow", reason: "not a `gh pr create` command" };
  }
  if (deps.overridden) {
    return {
      action: "allow",
      reason: `gate overridden (${OVERRIDE_ENV} set or "${INLINE_OVERRIDE_MARKER}" in the command) \u2014 PR allowed WITHOUT a verified review`
    };
  }
  const res = deps.verify();
  if (!res.ran) {
    return {
      action: "allow",
      reason: `ensemble-ai review gate could not run the verifier (${res.error}) \u2014 failing OPEN so PR creation is not bricked; install the ensemble-ai CLI to enforce the gate`
    };
  }
  if (res.code === 0) {
    return {
      action: "allow",
      reason: "the current diff has a valid, current cross-vendor review receipt"
    };
  }
  return {
    action: "block",
    reason: `This PR has NO current cross-vendor review receipt for its diff. Review it first:
    ensemble-ai review --out .ensemble-ai/trail    # runs Codex + Grok, writes the receipt
then re-run \`gh pr create\`. To bypass this once: append \`# ${INLINE_OVERRIDE_MARKER}\` to the command, or set ${OVERRIDE_ENV}=1.
verify said:
` + indentBlock((res.output || "").trim())
  };
}
function indentBlock(s) {
  if (!s) return "    (no output)";
  return s.split("\n").map((l) => `    ${l}`).join("\n");
}
function parseHookPayload(raw) {
  try {
    const j = JSON.parse(raw);
    return {
      input: { command: j.tool_input?.command, toolName: j.tool_name },
      cwd: typeof j.cwd === "string" ? j.cwd : void 0
    };
  } catch {
    return { input: {} };
  }
}
function resolveTrailDir(cwd, env, exists = fs2.existsSync) {
  const fromEnv = env[TRAIL_ENV];
  if (fromEnv) return fromEnv;
  if (cwd) {
    const conventional = path.join(cwd, ".ensemble-ai", "trail");
    if (exists(conventional)) return conventional;
  }
  return void 0;
}
function buildVerifyArgs(trailDir) {
  const args = ["receipt", "verify", "--strict"];
  if (trailDir) args.push("--trail", trailDir);
  return args;
}
function classifyVerifyError(err) {
  const collectOutput = () => `${String(err.stdout ?? "")}${String(err.stderr ?? "")}`;
  if (typeof err.status === "number") {
    return { code: err.status, output: collectOutput(), ran: true };
  }
  if (err.signal != null || err.code === "ETIMEDOUT") {
    const detail = collectOutput().trim();
    return {
      code: 1,
      output: detail || `the review verifier was terminated before confirming the diff is reviewed (${err.code ?? err.signal})`,
      ran: true
    };
  }
  return { error: err.message || "could not spawn `ensemble-ai`", ran: false };
}
function runVerifyCli(cwd, env) {
  const trailDir = resolveTrailDir(cwd, env);
  const args = buildVerifyArgs(trailDir);
  try {
    const output = execFileSync("ensemble-ai", args, {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      env,
      // Bound it so a wedged verify can't hang PR creation forever (a timeout is then
      // classified as fail-CLOSED, not fail-open — see classifyVerifyError).
      timeout: 12e4
    });
    return { code: 0, output, ran: true };
  } catch (e) {
    return classifyVerifyError(e);
  }
}
function runHook(raw, io) {
  const { input, cwd } = parseHookPayload(raw);
  const decision = decideGate(input, {
    overridden: isOverridden(input, io.env),
    verify: () => runVerifyCli(cwd, io.env)
  });
  if (decision.action === "block") {
    io.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.reason
        }
      })
    );
    io.warn(`[ensemble-ai pre-PR gate] BLOCKED \u2014 ${decision.reason}`);
    return 2;
  }
  if (decision.reason.includes("overridden") || decision.reason.includes("could not run")) {
    io.warn(`[ensemble-ai pre-PR gate] ALLOW \u2014 ${decision.reason}`);
  }
  return 0;
}
if (isEntrypoint(import.meta.url)) {
  let raw = "";
  try {
    raw = fs2.readFileSync(0, "utf8");
  } catch {
    raw = "";
  }
  process.exitCode = runHook(raw, {
    env: process.env,
    log: (m) => console.log(m),
    warn: (m) => console.error(m)
  });
}
export {
  INLINE_OVERRIDE_MARKER,
  OVERRIDE_ENV,
  TRAIL_ENV,
  buildVerifyArgs,
  classifyVerifyError,
  decideGate,
  isOverridden,
  matchesGuardedCommand,
  parseHookPayload,
  resolveTrailDir,
  runHook,
  runVerifyCli
};
