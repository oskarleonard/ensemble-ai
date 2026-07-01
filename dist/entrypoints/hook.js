#!/usr/bin/env node

// src/entrypoints/hook.ts
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
var OVERRIDE_ENV = "ENSEMBLE_AI_GATE_OVERRIDE";
var INLINE_OVERRIDE_MARKER = "ensemble-ai:skip-gate";
var TRAIL_ENV = "ENSEMBLE_AI_TRAIL_DIR";
function matchesGuardedCommand(input) {
  if (input.toolName && input.toolName !== "Bash") return false;
  const cmd = input.command;
  if (!cmd) return false;
  return /(^|[\s;&|(])(?:[^\s;&|]*\/)?gh\s+pr\s+create(\s|$)/.test(cmd);
}
function isOverridden(input, env) {
  const raw = env[OVERRIDE_ENV];
  const envOn = !!raw && raw !== "0" && raw.toLowerCase() !== "false";
  const inlineOn = !!input.command && input.command.includes(INLINE_OVERRIDE_MARKER);
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
function resolveTrailDir(cwd, env, exists = fs.existsSync) {
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
function runVerifyCli(cwd, env) {
  const trailDir = resolveTrailDir(cwd, env);
  const args = buildVerifyArgs(trailDir);
  try {
    const output = execFileSync("ensemble-ai", args, {
      cwd: cwd || process.cwd(),
      encoding: "utf8",
      env,
      // Bound it so a wedged verify can't hang PR creation forever.
      timeout: 12e4
    });
    return { code: 0, output, ran: true };
  } catch (e) {
    const err = e;
    if (typeof err.status === "number") {
      const out = `${String(err.stdout ?? "")}${String(err.stderr ?? "")}`;
      return { code: err.status, output: out, ran: true };
    }
    return {
      error: err.message || "could not spawn `ensemble-ai`",
      ran: false
    };
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
function isEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (isEntrypoint()) {
  let raw = "";
  try {
    raw = fs.readFileSync(0, "utf8");
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
  decideGate,
  isOverridden,
  matchesGuardedCommand,
  parseHookPayload,
  resolveTrailDir,
  runHook,
  runVerifyCli
};
