#!/usr/bin/env node

// src/cli.ts
import { execFileSync as execFileSync3 } from "child_process";
import crypto2 from "crypto";
import fs8 from "fs";
import os7 from "os";
import path7 from "path";
import { fileURLToPath } from "url";
import { parseArgs } from "util";

// src/core/types.ts
var REVIEWER_IDS = ["codex", "grok"];
function isReviewerId(v) {
  return REVIEWER_IDS.includes(v);
}
function parseReviewerIds(raw) {
  if (!Array.isArray(raw)) return void 0;
  const ids = [...new Set(raw.filter(isReviewerId))];
  return ids.length > 0 ? ids : void 0;
}
var SEVERITIES = ["high", "medium", "low"];
var CONFIDENCES = ["high", "medium", "low"];

// src/core/findings.ts
var FINDINGS_INSTRUCTIONS = `## Output format \u2014 STRICT
Respond with ONE fenced \`\`\`json block and NOTHING else, matching:
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
array with a "summary" that says so. Do not invent issues to fill the list.`;
function oneOf(set, v, fallback) {
  return set.includes(v) ? v : fallback;
}
var asSeverity = (v) => oneOf(SEVERITIES, v, "medium");
var asConfidence = (v) => oneOf(CONFIDENCES, v, "low");
function asEvidence(v) {
  if (!v || typeof v !== "object") return {};
  const e = v;
  return {
    detail: typeof e.detail === "string" ? e.detail : void 0,
    file: typeof e.file === "string" && e.file.trim() ? e.file.trim() : void 0,
    line: typeof e.line === "number" && Number.isInteger(e.line) && e.line > 0 ? e.line : void 0
  };
}
function extractJsonBlock(raw) {
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m;
  let fenced = null;
  while (m = fence.exec(raw)) fenced = m[1];
  const candidates = [];
  if (fenced) candidates.push(fenced);
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
    }
  }
  return null;
}
function parseFindings(raw) {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== "object") {
    return {
      findings: [],
      parseError: "no parseable JSON block in the reviewer output",
      summary: ""
    };
  }
  const o = obj;
  const summary = typeof o.summary === "string" ? o.summary : "";
  if (!Array.isArray(o.findings)) {
    return {
      findings: [],
      parseError: 'reviewer output has no "findings" array \u2014 not a conforming review',
      summary
    };
  }
  const rawFindings = o.findings;
  const findings = [];
  rawFindings.forEach((rf, i) => {
    if (!rf || typeof rf !== "object") return;
    const f = rf;
    const evidence = asEvidence(f.evidence);
    const uncited = !evidence.file;
    findings.push({
      body: typeof f.body === "string" ? f.body : "",
      confidence: uncited ? "low" : asConfidence(f.confidence),
      evidence,
      id: `f${i + 1}`,
      severity: asSeverity(f.severity),
      title: typeof f.title === "string" && f.title.trim() ? f.title.trim() : `Finding ${i + 1}`,
      uncited: uncited || void 0
    });
  });
  return { findings, summary };
}

// src/modes/brainstorm/types.ts
var VOICE_IDS = ["codex", "grok", "claude"];
function isVoiceId(v) {
  return VOICE_IDS.includes(v);
}
function parseVoiceIds(raw) {
  const arr = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const ids = [
    ...new Set(
      arr.map((s) => typeof s === "string" ? s.trim() : s).filter(isVoiceId)
    )
  ];
  return ids.length > 0 ? ids : void 0;
}
var CRITIQUE_STANCES = ["support", "concern", "extend"];

// src/modes/brainstorm/parse.ts
function str(v) {
  return typeof v === "string" ? v.trim() : "";
}
function asStance(v) {
  return oneOf(CRITIQUE_STANCES, v, "concern");
}
function parseRawIdeas(arr, placeholder) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  arr.forEach((ri, i) => {
    if (!ri || typeof ri !== "object") return;
    const r = ri;
    const title = str(r.title);
    const body = str(r.body);
    if (!title && !body) return;
    out.push({ body, title: title || `${placeholder} ${i + 1}` });
  });
  return out;
}
function parseIdeas(raw) {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== "object") {
    return { ideas: [], parseError: "no parseable JSON block in the output", summary: "" };
  }
  const o = obj;
  const summary = str(o.summary);
  if (!Array.isArray(o.ideas)) {
    return { ideas: [], parseError: 'output has no "ideas" array', summary };
  }
  return { ideas: parseRawIdeas(o.ideas, "Idea"), summary };
}
function parseCritique(raw) {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== "object") {
    return {
      critiques: [],
      extensions: [],
      parseError: "no parseable JSON block in the output",
      summary: ""
    };
  }
  const o = obj;
  const summary = str(o.summary);
  const critiques = [];
  if (Array.isArray(o.critiques)) {
    for (const rc of o.critiques) {
      if (!rc || typeof rc !== "object") continue;
      const c = rc;
      const target = str(c.target);
      const assessment = str(c.assessment);
      if (!target && !assessment) continue;
      critiques.push({
        assessment,
        stance: asStance(c.stance),
        target: target || "(unspecified)"
      });
    }
  }
  return { critiques, extensions: parseRawIdeas(o.extensions, "Extension"), summary };
}
function asContributors(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(str).filter(Boolean))];
}
function parseSynthesis(raw) {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== "object") {
    return { parseError: "no parseable JSON block in the output", ranked: [], summary: "" };
  }
  const o = obj;
  const summary = str(o.summary);
  if (!Array.isArray(o.ranked)) {
    return { parseError: 'output has no "ranked" array', ranked: [], summary };
  }
  const ranked = [];
  o.ranked.forEach((rr) => {
    if (!rr || typeof rr !== "object") return;
    const r = rr;
    const title = str(r.title);
    const why = str(r.why);
    if (!title && !why) return;
    const risks = str(r.risks);
    ranked.push({
      contributors: asContributors(r.contributors),
      rank: ranked.length + 1,
      title: title || `Recommendation ${ranked.length + 1}`,
      why,
      ...risks ? { risks } : {}
    });
  });
  return { ranked, summary };
}

// src/modes/brainstorm/prompt.ts
var JSON_RULE = "Respond with ONE fenced ```json block and NOTHING else, matching:";
var FILE_CONTEXT_BUDGET = 24e3;
function contextBlock(fileContext) {
  if (!fileContext || !fileContext.trim()) return "";
  const trimmed = fileContext.trimEnd();
  const body = trimmed.length > FILE_CONTEXT_BUDGET ? `${trimmed.slice(0, FILE_CONTEXT_BUDGET)}
\u2026[context truncated]` : trimmed;
  return `
## Shared context
${body}
`;
}
function renderGeneratePrompt(topic, fileContext) {
  return `You are an independent idea generator in a multi-model brainstorm. Work
ENTIRELY ON YOUR OWN: you have no knowledge of anyone else's ideas \u2014 do not assume,
anticipate, or hedge toward a consensus. Bring range and non-obvious angles.

## Topic
${topic.trim()}
${contextBlock(fileContext)}
## Output format \u2014 STRICT
${JSON_RULE}
{
  "summary": "<one short paragraph: your overall angle on the topic>",
  "ideas": [
    { "title": "<short, specific>", "body": "<the idea: how it works and why it could win>" }
  ]
}
Return 4\u20136 DISTINCT ideas. Do not pad with weak ideas to fill the list.
`;
}
function peerIdeasBlock(peerIdeas) {
  return peerIdeas.map((i) => `[${i.id}] ${i.title}
${i.body}`).join("\n\n");
}
function renderCritiquePrompt(topic, peerIdeas, fileContext) {
  return `You are a sharp, constructive critic in a multi-model brainstorm. Below are
ideas from the OTHER contributors (you did not write these). Assess the strongest
few candidly \u2014 where each is strong, where it is weak or risky \u2014 then EXTEND the
set: add ideas the others missed, or combinations better than any single one.

## Topic
${topic.trim()}
${contextBlock(fileContext)}
## Ideas from the other voices
${peerIdeasBlock(peerIdeas)}

## Output format \u2014 STRICT
${JSON_RULE}
{
  "summary": "<your overall read of these ideas>",
  "critiques": [
    {
      "target": "<the [id] or title you are assessing>",
      "stance": "support" | "concern" | "extend",
      "assessment": "<concrete: what works, what breaks, how to improve>"
    }
  ],
  "extensions": [
    { "title": "<short>", "body": "<a new or combined idea the others missed>" }
  ]
}
Be specific and cite the idea ids. An empty "extensions" array is fine if you have nothing to add.
`;
}
function allIdeasBlock(allIdeas) {
  return allIdeas.map((i) => `[${i.id}] (${i.voiceId ?? "?"}) ${i.title}: ${i.body}`).join("\n");
}
function critiquesBlock(critiqueResults) {
  const lines = [];
  for (const c of critiqueResults) {
    if (!c.ok) continue;
    for (const cr of c.critiques) {
      lines.push(`(${c.voiceId}) ${cr.stance} on ${cr.target}: ${cr.assessment}`);
    }
    for (const ex of c.extensions) {
      lines.push(`(${c.voiceId}) extension \u2014 ${ex.title}: ${ex.body}`);
    }
  }
  return lines.length ? lines.join("\n") : "(no critiques)";
}
function renderSynthesisPrompt(topic, allIdeas, critiqueResults) {
  return `You are the SYNTHESIZER for a multi-model brainstorm. You are given every
idea (with its author) and every critique. Produce ONE consolidated recommendation:
DEDUPE overlapping ideas into a single entry, weigh the critiques, and RANK what
remains best-first. For each ranked item say why it wins, which contributors backed
it, and its main risk.

## Topic
${topic.trim()}

## All ideas
${allIdeasBlock(allIdeas)}

## Critiques
${critiquesBlock(critiqueResults)}

## Output format \u2014 STRICT
${JSON_RULE}
{
  "summary": "<the headline recommendation in 2-3 sentences>",
  "ranked": [
    {
      "title": "<short>",
      "why": "<why this ranks here>",
      "contributors": ["codex", "grok"],
      "risks": "<the main risk, or omit>"
    }
  ]
}
Rank best-first. Merge duplicates into one entry crediting all contributors. Prefer
a tight ranked list of the genuinely strong ideas over a long one.
`;
}

// src/modes/brainstorm/voices.ts
import fs4 from "fs";
import os4 from "os";
import path3 from "path";

// src/reviewers/codex.ts
import os2 from "os";
import path from "path";

// src/core/spawn.ts
import { spawn } from "child_process";
import fs2 from "fs";
import os from "os";

// src/core/bin.ts
import { execFileSync } from "child_process";
import fs from "fs";
var binCache = /* @__PURE__ */ new Map();
function resolveBin(name, opts = {}) {
  const cached = binCache.get(name);
  if (cached) return cached;
  const candidates = [
    opts.envVar ? process.env[opts.envVar] : void 0,
    ...opts.candidates ?? []
  ].filter((c) => Boolean(c));
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      binCache.set(name, c);
      return c;
    }
  }
  const found = execFileSync("/bin/zsh", ["-ic", `whence -p ${name}`], {
    encoding: "utf8"
  }).trim().split("\n").pop();
  if (!found) throw new Error(`${name} binary not found`);
  binCache.set(name, found);
  return found;
}

// src/core/spawn.ts
function resolveCodexBin() {
  return resolveBin("codex", { envVar: "CODEX_BIN" });
}
var KILL_GRACE_MS = 3e3;
var EXIT_DRAIN_GRACE_MS = 250;
function makeEscalatingKill(child, graceMs, schedule = setTimeout, cancel = clearTimeout) {
  let hard = null;
  return {
    clear: () => {
      if (hard) cancel(hard);
      hard = null;
    },
    kill: () => {
      child.kill("SIGTERM");
      if (!hard) hard = schedule(() => child.kill("SIGKILL"), graceMs);
    }
  };
}
function killTree(child, signal, signalGroup = (pid, sig) => process.kill(-pid, sig)) {
  const pid = child.pid;
  if (typeof pid === "number" && pid > 0) {
    try {
      signalGroup(pid, signal);
      return;
    } catch {
    }
  }
  try {
    child.kill(signal);
  } catch {
  }
}
function runReviewerExec(opts) {
  const { bin, args, outFile, timeoutMs, stderrLimit, onSpawn } = opts;
  const capture2 = opts.capture ?? "outfile";
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: os.tmpdir(),
      detached: true,
      // stdout is piped ONLY when we read the reply from it (grok); codex keeps
      // it 'ignore' (its reply is the -o file) exactly as the proven path did.
      stdio: ["ignore", capture2 === "stdout" ? "pipe" : "ignore", "pipe"]
    });
    const killer = makeEscalatingKill(
      { kill: (sig) => killTree(child, sig) },
      KILL_GRACE_MS
    );
    onSpawn?.(killer.kill);
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      killer.kill();
    }, timeoutMs);
    let stderrTail = "";
    child.stderr?.on("data", (chunk) => {
      stderrTail = (stderrTail + chunk.toString("utf8")).slice(-stderrLimit);
    });
    let stdoutBuf = "";
    if (capture2 === "stdout") {
      child.stdout?.on("data", (chunk) => {
        stdoutBuf += chunk.toString("utf8");
      });
    }
    let settled = false;
    let exitDrain = null;
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(backstop);
      if (exitDrain) clearTimeout(exitDrain);
      killer.clear();
      let raw = null;
      if (capture2 === "stdout") {
        const text = stdoutBuf.trim();
        if (text) raw = text;
      } else {
        try {
          const text = fs2.readFileSync(outFile ?? "", "utf8").trim();
          if (text) raw = text;
          fs2.unlinkSync(outFile ?? "");
        } catch {
        }
      }
      resolve({ raw, stderrTail, timedOut });
    };
    const backstop = setTimeout(settle, timeoutMs + KILL_GRACE_MS + 5e3);
    child.on(
      "exit",
      capture2 === "stdout" ? () => {
        exitDrain = setTimeout(settle, EXIT_DRAIN_GRACE_MS);
      } : settle
    );
    child.on("close", settle);
    child.on("error", settle);
  });
}

// src/reviewers/codex.ts
var REVIEW_TIMEOUT_MS = 72e4;
function buildCodexReviewArgs(config, outFile, prompt) {
  return [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color",
    "never",
    "-s",
    "read-only",
    "-m",
    config.model,
    "-c",
    `model_reasoning_effort="${config.effort}"`,
    "-o",
    outFile,
    prompt
  ];
}
function runCodexReview(prompt, config, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
  const outFile = path.join(
    os2.tmpdir(),
    `codex-review-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
  );
  return runReviewerExec({
    bin: resolveCodexBin(),
    args: buildCodexReviewArgs(config, outFile, prompt),
    outFile,
    timeoutMs,
    stderrLimit: 2e3,
    onSpawn: opts.onSpawn
  }).then(({ raw, stderrTail, timedOut }) => ({
    ok: raw !== null,
    raw,
    stderrTail,
    timedOut
  }));
}

// src/reviewers/grok.ts
import fs3 from "fs";
import os3 from "os";
import path2 from "path";
var GROK_BIN_CANDIDATES = [path2.join(os3.homedir(), ".grok", "bin", "grok")];
function resolveGrokBin() {
  return resolveBin("grok", {
    candidates: GROK_BIN_CANDIDATES,
    envVar: "GROK_BIN"
  });
}
var BUILTIN_SANDBOXES = /* @__PURE__ */ new Set([
  "off",
  "workspace",
  "devbox",
  "read-only",
  "strict"
]);
var DENY_BY_DEFAULT_SANDBOXES = /* @__PURE__ */ new Set(["strict", "ensemble-review"]);
var DEFAULT_REVIEW_SANDBOX = "ensemble-review";
function resolveReviewSandbox(configured) {
  return configured && DENY_BY_DEFAULT_SANDBOXES.has(configured) ? configured : DEFAULT_REVIEW_SANDBOX;
}
var REVIEW_PROFILE_NAME = "ensemble-review";
var REVIEW_PROFILE_HEADER = `[profiles.${REVIEW_PROFILE_NAME}]`;
var REVIEW_PROFILE_BLOCK = `${REVIEW_PROFILE_HEADER}
extends = "strict"
deny = ["**/.env", "**/.env.*", "**/secrets.env", "**/*.pem", "**/*.key", "**/id_rsa", "**/id_ed25519", "**/auth.json", "**/.netrc"]`;
var REVIEW_PROFILE = `# ${REVIEW_PROFILE_NAME} \u2014 the cross-vendor reviewer's sandbox (ensemble-ai).
# deny-by-default reads (strict base) + kernel-deny secret reads. Safe to edit;
# auto-provisioned + kept current by ensemble-ai. Add deny globs as needed.
${REVIEW_PROFILE_BLOCK}
`;
function replaceReviewSection(content) {
  const lines = content.split("\n");
  const header = lines.findIndex((l) => l.trim() === REVIEW_PROFILE_HEADER);
  if (header === -1) return null;
  let from = header;
  while (from > 0 && lines[from - 1].trimStart().startsWith(`# ${REVIEW_PROFILE_NAME}`)) {
    from--;
  }
  let to = header + 1;
  while (to < lines.length && !lines[to].trimStart().startsWith("[")) to++;
  const before = lines.slice(0, from).join("\n").replace(/\n+$/, "");
  const after = lines.slice(to).join("\n").replace(/^\n+/, "");
  return [before, REVIEW_PROFILE.trimEnd(), after].filter((s) => s.length > 0).join("\n\n") + "\n";
}
function ensureSandboxProfile(profile, file = path2.join(os3.homedir(), ".grok", "sandbox.toml")) {
  if (BUILTIN_SANDBOXES.has(profile) || profile !== REVIEW_PROFILE_NAME) return;
  try {
    const existing = fs3.existsSync(file) ? fs3.readFileSync(file, "utf8") : "";
    if (existing.includes(REVIEW_PROFILE_BLOCK)) return;
    fs3.mkdirSync(path2.dirname(file), { recursive: true });
    const updated = existing.includes(REVIEW_PROFILE_HEADER) ? replaceReviewSection(existing) : null;
    const content = updated ?? (existing.trim() ? `${existing.trimEnd()}

${REVIEW_PROFILE}` : REVIEW_PROFILE);
    const tmp = `${file}.tmp`;
    fs3.writeFileSync(tmp, content);
    fs3.renameSync(tmp, file);
  } catch {
  }
}
function buildGrokReviewArgs(config, prompt, cwd) {
  return [
    "-p",
    prompt,
    "--output-format",
    "json",
    "-m",
    config.model,
    "--effort",
    config.effort,
    "--sandbox",
    resolveReviewSandbox(config.sandbox),
    "--cwd",
    cwd,
    "--disable-web-search",
    "--disallowed-tools",
    "bash,search_replace",
    "--no-memory"
  ];
}
function extractGrokText(stdout) {
  try {
    const env = JSON.parse(stdout);
    return typeof env.text === "string" && env.text.trim() ? env.text : null;
  } catch {
  }
  const trimmed = stdout.trim();
  return trimmed || null;
}
function runGrokReview(prompt, config, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
  const sandbox = resolveReviewSandbox(config.sandbox);
  ensureSandboxProfile(sandbox);
  const cwd = fs3.mkdtempSync(path2.join(os3.tmpdir(), "grok-review-"));
  return runReviewerExec({
    args: buildGrokReviewArgs({ ...config, sandbox }, prompt, cwd),
    bin: resolveGrokBin(),
    capture: "stdout",
    onSpawn: opts.onSpawn,
    stderrLimit: 2e3,
    timeoutMs
  }).then(({ raw, stderrTail, timedOut }) => {
    try {
      fs3.rmSync(cwd, { force: true, recursive: true });
    } catch {
    }
    const text = raw ? extractGrokText(raw) : null;
    return { ok: text !== null, raw: text, stderrTail, timedOut };
  });
}

// src/modes/brainstorm/claude.ts
function resolveClaudeBin() {
  return resolveBin("claude", { envVar: "CLAUDE_BIN" });
}
function buildClaudeVoiceArgs(prompt) {
  return ["-p", prompt, "--output-format", "text"];
}
function runClaudeVoice(prompt, _config, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
  return runReviewerExec({
    args: buildClaudeVoiceArgs(prompt),
    bin: resolveClaudeBin(),
    capture: "stdout",
    onSpawn: opts.onSpawn,
    stderrLimit: 2e3,
    timeoutMs
  }).then(({ raw, stderrTail, timedOut }) => ({
    ok: raw !== null && !timedOut,
    raw,
    stderrTail,
    timedOut
  }));
}

// src/modes/brainstorm/voices.ts
var VOICE_DEFAULTS = {
  claude: {
    cmd: "claude",
    effort: "default",
    id: "claude",
    model: "default",
    vendor: "anthropic"
  },
  codex: {
    cmd: "codex",
    effort: "high",
    id: "codex",
    model: "gpt-5.5",
    vendor: "openai"
  },
  grok: {
    cmd: "grok",
    effort: "high",
    id: "grok",
    model: "grok-build",
    sandbox: "ensemble-review",
    vendor: "xai"
  }
};
function toReviewerConfig(c) {
  return {
    cmd: c.cmd,
    effort: c.effort,
    id: c.id,
    model: c.model,
    vendor: c.vendor,
    ...c.sandbox ? { sandbox: c.sandbox } : {}
  };
}
var VOICE_ADAPTERS = {
  claude: (p, c, o) => runClaudeVoice(p, c, o),
  codex: (p, c, o) => runCodexReview(p, toReviewerConfig(c), o),
  grok: (p, c, o) => runGrokReview(p, toReviewerConfig(c), o)
};
var VOICES_FILE = process.env.ENSEMBLE_VOICES_FILE || path3.join(os4.homedir(), ".ensemble-ai", "voices.json");
function str2(v, fallback) {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}
function parseVoices(raw) {
  const out = { ...VOICE_DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  const o = raw;
  for (const id of VOICE_IDS) {
    const e = o[id];
    if (!e || typeof e !== "object") continue;
    const r = e;
    const sandbox = str2(r.sandbox, VOICE_DEFAULTS[id].sandbox ?? "");
    out[id] = {
      cmd: str2(r.cmd, VOICE_DEFAULTS[id].cmd),
      effort: str2(r.effort, VOICE_DEFAULTS[id].effort),
      id,
      model: str2(r.model, VOICE_DEFAULTS[id].model),
      vendor: str2(r.vendor, VOICE_DEFAULTS[id].vendor),
      ...sandbox ? { sandbox } : {}
    };
  }
  return out;
}
function loadVoices(file = VOICES_FILE) {
  try {
    return parseVoices(JSON.parse(fs4.readFileSync(file, "utf8")));
  } catch {
    return { ...VOICE_DEFAULTS };
  }
}

// src/modes/brainstorm/index.ts
var DEFAULT_VOICE_TIMEOUT_MS = 3e5;
async function runGenerate(voiceId, adapters, configs, prompt, timeoutMs, log) {
  const config = configs[voiceId];
  log(`  \xB7 ${voiceId} (${config.vendor} \xB7 ${config.model}) generating\u2026`);
  let res;
  try {
    res = await adapters[voiceId](prompt, config, { timeoutMs });
  } catch (e) {
    log(`  \xB7 ${voiceId}: failed to run \u2014 ${e.message}`);
    return { error: e.message, ideas: [], ok: false, raw: null, summary: "", voiceId };
  }
  if (!res.raw || res.timedOut) {
    const error = res.timedOut ? "timed out" : "produced no output";
    log(`  \xB7 ${voiceId}: ${error}`);
    return { error, ideas: [], ok: false, raw: res.raw, summary: "", timedOut: res.timedOut, voiceId };
  }
  const parsed = parseIdeas(res.raw);
  if (parsed.parseError || parsed.ideas.length === 0) {
    const error = parsed.parseError ?? "no ideas in the output";
    log(`  \xB7 ${voiceId}: ${error}`);
    return { error, ideas: [], ok: false, raw: res.raw, summary: parsed.summary, voiceId };
  }
  const ideas = parsed.ideas.map((i, n) => ({
    body: i.body,
    id: `${voiceId}-${n + 1}`,
    title: i.title,
    voiceId
  }));
  log(`  \xB7 ${voiceId}: ${ideas.length} idea(s)`);
  return { ideas, ok: true, raw: res.raw, summary: parsed.summary, voiceId };
}
async function runCritique(voiceId, adapters, configs, topic, allIdeas, fileContext, timeoutMs, log) {
  const config = configs[voiceId];
  const peerIdeas = allIdeas.filter((i) => i.voiceId !== voiceId);
  const prompt = renderCritiquePrompt(topic, peerIdeas, fileContext);
  log(`  \xB7 ${voiceId} critiquing ${peerIdeas.length} peer idea(s)\u2026`);
  let res;
  try {
    res = await adapters[voiceId](prompt, config, { timeoutMs });
  } catch (e) {
    return { critiques: [], error: e.message, extensions: [], ok: false, raw: null, summary: "", voiceId };
  }
  if (!res.raw || res.timedOut) {
    const error = res.timedOut ? "timed out" : "produced no output";
    return { critiques: [], error, extensions: [], ok: false, raw: res.raw, summary: "", timedOut: res.timedOut, voiceId };
  }
  const parsed = parseCritique(res.raw);
  if (parsed.parseError) {
    return { critiques: [], error: parsed.parseError, extensions: [], ok: false, raw: res.raw, summary: parsed.summary, voiceId };
  }
  log(`  \xB7 ${voiceId}: ${parsed.critiques.length} critique(s), ${parsed.extensions.length} extension(s)`);
  return {
    critiques: parsed.critiques,
    extensions: parsed.extensions,
    ok: true,
    raw: res.raw,
    summary: parsed.summary,
    voiceId
  };
}
function dedupeKey(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function fallbackSynthesis(allIdeas) {
  const seen = /* @__PURE__ */ new Map();
  for (const idea of allIdeas) {
    const key = dedupeKey(idea.title) || idea.id;
    const existing = seen.get(key);
    if (existing) {
      if (idea.voiceId && !existing.contributors.includes(idea.voiceId)) {
        existing.contributors.push(idea.voiceId);
      }
      continue;
    }
    seen.set(key, {
      contributors: idea.voiceId ? [idea.voiceId] : [],
      rank: 0,
      title: idea.title,
      why: idea.body
    });
  }
  const ranked = [...seen.values()].map((r, i) => ({ ...r, rank: i + 1 }));
  return {
    by: null,
    degraded: true,
    ok: false,
    ranked,
    raw: null,
    summary: ranked.length > 0 ? `Synthesis voice unavailable \u2014 ${ranked.length} de-duplicated idea(s) from the voices, not ranked by merit.` : "No ideas were generated."
  };
}
async function runSynthesis(synthId, adapters, configs, topic, allIdeas, critiqueResults, timeoutMs, log) {
  if (!synthId || allIdeas.length === 0) return fallbackSynthesis(allIdeas);
  const prompt = renderSynthesisPrompt(topic, allIdeas, critiqueResults);
  log(`Round 3 \xB7 synthesizing with ${synthId}\u2026`);
  let res;
  try {
    res = await adapters[synthId](prompt, configs[synthId], { timeoutMs });
  } catch (e) {
    log(`  \xB7 synthesis failed (${synthId}) \u2014 using the deterministic fallback`);
    return { ...fallbackSynthesis(allIdeas), error: e.message };
  }
  if (!res.raw || res.timedOut) {
    log(`  \xB7 synthesis produced no usable output \u2014 using the deterministic fallback`);
    return {
      ...fallbackSynthesis(allIdeas),
      error: res.timedOut ? "synthesis timed out" : "synthesis produced no output"
    };
  }
  const parsed = parseSynthesis(res.raw);
  if (parsed.parseError || parsed.ranked.length === 0) {
    log(`  \xB7 synthesis output not parseable \u2014 using the deterministic fallback`);
    return {
      ...fallbackSynthesis(allIdeas),
      error: parsed.parseError ?? "no ranked ideas parsed",
      raw: res.raw
    };
  }
  log(`  \xB7 synthesis: ${parsed.ranked.length} ranked recommendation(s)`);
  return { by: synthId, degraded: false, ok: true, ranked: parsed.ranked, raw: res.raw, summary: parsed.summary };
}
function pickSynthesizer(roster, requested, generate) {
  if (requested && roster.includes(requested)) return requested;
  const healthy = generate.filter((g) => g.ok).map((g) => g.voiceId);
  if (healthy.includes("claude")) return "claude";
  return healthy[0] ?? null;
}
async function runBrainstormMode(opts) {
  const log = opts.onProgress ?? (() => {
  });
  const roster = opts.voices && opts.voices.length > 0 ? opts.voices : [...VOICE_IDS];
  const adapters = opts.adapters ?? VOICE_ADAPTERS;
  const configs = opts.voiceConfigs ?? loadVoices(opts.voicesFile);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS;
  log(`Round 1 \xB7 independent ideation \u2014 ${roster.length} voice(s): ${roster.join(", ")}`);
  const genPrompt = renderGeneratePrompt(opts.topic, opts.fileContext);
  const generate = await Promise.all(
    roster.map((id) => runGenerate(id, adapters, configs, genPrompt, timeoutMs, log))
  );
  const allIdeas = generate.flatMap((g) => g.ideas);
  const participants = generate.filter((g) => g.ok).map((g) => g.voiceId);
  let critique = [];
  if (participants.length >= 2) {
    log(`Round 2 \xB7 cross-critique \u2014 ${participants.length} voice(s)`);
    critique = await Promise.all(
      participants.map(
        (id) => runCritique(id, adapters, configs, opts.topic, allIdeas, opts.fileContext, timeoutMs, log)
      )
    );
  } else {
    log(`Round 2 \xB7 skipped \u2014 need \u22652 voices with ideas (have ${participants.length})`);
  }
  const synthId = pickSynthesizer(roster, opts.synthesizer, generate);
  const synthesis = await runSynthesis(
    synthId,
    adapters,
    configs,
    opts.topic,
    allIdeas,
    critique,
    timeoutMs,
    log
  );
  return { critique, generate, roster, synthesis, topic: opts.topic };
}

// src/modes/index.ts
var MODES = ["review", "brainstorm", "security"];
var IMPLEMENTED_MODES = [
  "review",
  "security",
  "brainstorm"
];
function isMode(v) {
  return MODES.includes(v);
}
function isImplemented(mode) {
  return IMPLEMENTED_MODES.includes(mode);
}

// src/core/artifacts.ts
import fs5 from "fs";
import path4 from "path";
function sanitizePathSegment(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function reviewDir(baseDir, runId) {
  return path4.join(baseDir, sanitizePathSegment(runId) || "unknown");
}
function writeAtomic(dir, name, content) {
  fs5.mkdirSync(dir, { recursive: true });
  const target = path4.join(dir, name);
  const tmp = `${target}.tmp`;
  fs5.writeFileSync(tmp, content);
  fs5.renameSync(tmp, target);
}
function manifestOf(packet) {
  return packet.sections.map((s) => ({
    included: s.included,
    note: s.note,
    title: s.title,
    truncated: s.truncated
  }));
}
function reviewJson(reviewerId) {
  return `review.${reviewerId}.json`;
}
function persistReview(baseDir, input) {
  const dir = reviewDir(baseDir, input.runId);
  const id = input.reviewer.id;
  writeAtomic(dir, `packet.${id}.json`, JSON.stringify(input.packet, null, 2));
  writeAtomic(dir, `prompt.${id}.md`, input.prompt);
  if (input.raw !== null) writeAtomic(dir, `${id}-review.raw.md`, input.raw);
  writeAtomic(
    dir,
    `findings.${id}.json`,
    JSON.stringify(input.findings, null, 2)
  );
  const stored = {
    findings: input.findings,
    packet: {
      complete: input.packet.complete,
      manifest: manifestOf(input.packet)
    },
    reviewer: {
      effort: input.reviewer.effort,
      model: input.reviewer.model,
      vendor: input.reviewer.vendor
    },
    reviewerId: id,
    runId: input.runId,
    summary: input.summary,
    terminalState: input.terminalState
  };
  writeAtomic(dir, reviewJson(id), JSON.stringify(stored, null, 2));
  return stored;
}

// src/core/packet.ts
var PACKET_BUDGETS = {
  agents: 12e3,
  constraints: 4e3,
  diff: 2e5,
  files: 4e4,
  history: 4e3,
  objective: 2e3,
  summary: 4e3,
  tests: 8e3
};
var DIFF_USEFUL_FLOOR = 200;
function truncate(text, budget) {
  if (text.length <= budget) return { text, truncated: false };
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  return {
    text: `${text.slice(0, head)}

\u2026[${text.length - budget} chars truncated]\u2026

${text.slice(-tail)}`,
    truncated: true
  };
}
function section(title, why, body, budget) {
  const present = body.trim().length > 0;
  const cut = present ? truncate(body, budget) : { text: "", truncated: false };
  const note = !present ? `${why} \u2014 UNAVAILABLE` : cut.truncated ? `${why} (truncated to ${budget} chars)` : why;
  return {
    body: cut.text,
    included: present,
    note,
    title,
    truncated: cut.truncated
  };
}
function assembleCodePacket(input) {
  const sections = [
    section(
      "Objective",
      "why this review was fired",
      input.objective,
      PACKET_BUDGETS.objective
    )
  ];
  if (input.directive) {
    sections.push(
      section(
        "Original directive / PR description",
        "the author's stated intent",
        input.directive,
        PACKET_BUDGETS.objective
      )
    );
  }
  if (input.authorSummary) {
    sections.push(
      section(
        "Author summary",
        "what the author says the change does + why \u2014 weigh, don\u2019t trust",
        input.authorSummary,
        PACKET_BUDGETS.summary
      )
    );
  }
  const diff = section(
    "The diff under review",
    "the change itself \u2014 review THIS, not the whole repo",
    input.diff,
    PACKET_BUDGETS.diff
  );
  sections.push(
    diff,
    section(
      "Changed files (full content)",
      "surrounding context for the diff hunks",
      input.surroundingFiles ?? "",
      PACKET_BUDGETS.files
    ),
    section(
      "Repo conventions (AGENTS.md)",
      "house rules + known footguns the change must respect",
      input.agentsMd ?? "",
      PACKET_BUDGETS.agents
    )
  );
  if (input.constraints) {
    sections.push(
      section(
        "Known constraints",
        "constraints the change must respect",
        input.constraints,
        PACKET_BUDGETS.constraints
      )
    );
  }
  if (input.testOutput) {
    sections.push(
      section(
        "Test output",
        "the author's test run \u2014 does the change pass?",
        input.testOutput,
        PACKET_BUDGETS.tests
      )
    );
  }
  sections.push(
    section(
      "Recent run history",
      "what was fired against this repo lately",
      input.runHistory ?? "",
      PACKET_BUDGETS.history
    )
  );
  return {
    complete: diff.included && diff.body.length >= DIFF_USEFUL_FLOOR,
    objective: input.objective,
    pr: input.pr,
    repo: input.repo,
    sections
  };
}

// src/modes/review/profile.ts
var SECURITY_OBJECTIVE = "Adversarial cross-vendor SECURITY audit of a code diff \u2014 hunt for exploitable vulnerabilities a same-vendor author might miss: injection, XSS, broken authn/authz, secret leakage, supply-chain risk, unsafe deserialization/eval, SSRF, path traversal, and crypto misuse.";
var SECURITY_CLASSES = [
  {
    id: "injection",
    label: "Injection",
    keywords: ["sql", "sqli", "injection", "command inject", "shell inject", "os command", "unsanitiz", "parameteriz", "prepared statement"]
  },
  {
    id: "xss",
    label: "XSS",
    keywords: ["xss", "cross-site script", "innerhtml", "dangerouslysetinnerhtml", "unescaped", "html escap"]
  },
  {
    id: "authz",
    label: "AuthN/AuthZ",
    keywords: ["authoriz", "authentic", "permission", "access control", "privilege", "idor", "rbac", "session fixation", "jwt", "auth bypass", "unauthenticated"]
  },
  {
    id: "secret-leak",
    label: "Secret leak",
    keywords: ["secret", "credential", "api key", "apikey", "hardcoded password", "hardcoded", "token leak", "private key", "leaked"]
  },
  {
    id: "supply-chain",
    label: "Supply chain",
    keywords: ["supply chain", "dependency", "transitive", "malicious package", "typosquat", "postinstall", "lockfile", "unpinned"]
  },
  {
    id: "deserialization",
    label: "Unsafe deserialization/eval",
    keywords: ["deserializ", "eval(", "new function", "pickle", "yaml.load", "unserialize", "unmarshal", "vm.runin", "arbitrary code", "rce", "code execution"]
  },
  {
    id: "ssrf",
    label: "SSRF",
    keywords: ["ssrf", "server-side request", "request forgery", "open redirect", "url allowlist", "url validation"]
  },
  {
    id: "path-traversal",
    label: "Path traversal",
    keywords: ["path traversal", "directory traversal", "zip slip", "arbitrary file read", "arbitrary file write", "../"]
  },
  {
    id: "crypto",
    label: "Crypto misuse",
    keywords: ["crypto", "cipher", "md5", "sha1", "insecure random", "weak hash", "weak algorithm", "ecb mode", "hardcoded iv", "static iv", "nonce reuse", "certificate valid"]
  },
  { id: "other", label: "Other", keywords: [] }
];
var KNOWN_CLASS_IDS = new Set(SECURITY_CLASSES.map((c) => c.id));
var LEADING_TAG = /^\s*\[([a-z-]+)\]\s*/i;
function classifySecurityFinding(f) {
  const tag = f.title.match(LEADING_TAG)?.[1]?.toLowerCase();
  if (tag && KNOWN_CLASS_IDS.has(tag)) return tag;
  const hay = `${f.title} ${f.body}`.toLowerCase();
  for (const c of SECURITY_CLASSES) {
    if (c.keywords.some((k) => hay.includes(k))) return c.id;
  }
  return "other";
}
function stripSecurityTag(title) {
  const tag = title.match(LEADING_TAG)?.[1]?.toLowerCase();
  return tag && KNOWN_CLASS_IDS.has(tag) ? title.replace(LEADING_TAG, "") : title;
}

// src/core/prompt.ts
var CODE_ASK = [
  "## Your task",
  "Find correctness bugs, security issues, broken conventions, and risky",
  "choices IN THE DIFF. Be concrete and cite file + line. Do not nitpick style",
  "the conventions already allow. Prefer a few high-signal findings over many",
  "weak ones \u2014 false positives waste the arbiter\u2019s time."
].join("\n");
function securityAsk() {
  const classes = SECURITY_CLASSES.filter((c) => c.id !== "other").map((c) => `  - [${c.id}] ${c.label}`).join("\n");
  return [
    "## Your task \u2014 SECURITY AUDIT",
    "You are auditing this diff ADVERSARIALLY for exploitable security",
    "vulnerabilities a same-vendor author might miss. Think like an attacker:",
    "how could untrusted input reach a dangerous sink? Focus on these classes:",
    classes,
    "",
    'For EACH finding, lead the "title" with the matching class tag in brackets,',
    'e.g. "[injection] user id concatenated into SQL". Cite the exact file + line',
    "and name the attack: the untrusted source, the sink, and the exploit. Prefer a",
    "few high-signal, exploitable findings over many theoretical ones \u2014 but do NOT",
    "stay silent on a real vulnerability to keep the list short. Pure code-quality",
    "nits that are not security-relevant belong in a normal review, not here."
  ].join("\n");
}
function renderReviewPrompt(packet, profile = "code") {
  const subject = packet.pr > 0 ? `Repository: ${packet.repo} \xB7 Pull request #${packet.pr}` : packet.subject ? `Under review: ${packet.subject}` : `Repository: ${packet.repo || "(a working tree)"} \xB7 reviewing the diff below`;
  const role = profile === "security" ? "You are an adversarial SECURITY auditor from a DIFFERENT vendor than the author." : "You are an adversarial code reviewer from a DIFFERENT vendor than the author.";
  const head = [
    role,
    "You have NO prior memory: your own memory, the repository, and every earlier",
    "conversation are unknown to you EXCEPT what is embedded below. Review only",
    "what is here; do not assume facts not present.",
    "",
    subject
  ].join("\n");
  const body = packet.sections.map((s) => {
    const header = `## ${s.title}
_(${s.note})_`;
    return s.included ? `${header}

${s.body}` : `${header}

(not available)`;
  }).join("\n\n");
  const ask = [
    profile === "security" ? securityAsk() : CODE_ASK,
    "",
    FINDINGS_INSTRUCTIONS
  ].join("\n");
  return `${head}

${body}

${ask}
`;
}

// src/core/reviewers.ts
import fs6 from "fs";
import os5 from "os";
import path5 from "path";
var REVIEWERS_FILE = process.env.ENSEMBLE_REVIEWERS_FILE || path5.join(os5.homedir(), ".ensemble-ai", "reviewers.json");
var REVIEWER_DEFAULTS = {
  codex: {
    cmd: "codex",
    effort: "xhigh",
    id: "codex",
    model: "gpt-5.5",
    vendor: "openai"
  },
  // Grok (xAI) — the second cross-vendor lens. grok-build is the stronger of the
  // two CLI-available models; `sandbox` names the OS-enforced read-only profile it
  // runs under (kernel-blocked writes + secret-read deny — see reviewers/grok.ts).
  grok: {
    cmd: "grok",
    effort: "high",
    id: "grok",
    model: "grok-build",
    sandbox: "ensemble-review",
    vendor: "xai"
  }
};
function str3(v, fallback) {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}
function parseReviewers(raw) {
  const out = { ...REVIEWER_DEFAULTS };
  if (!raw || typeof raw !== "object") return out;
  const o = raw;
  for (const id of REVIEWER_IDS) {
    const e = o[id];
    if (!e || typeof e !== "object") continue;
    const r = e;
    const sandbox = str3(r.sandbox, REVIEWER_DEFAULTS[id].sandbox ?? "");
    out[id] = {
      cmd: str3(r.cmd, REVIEWER_DEFAULTS[id].cmd),
      effort: str3(r.effort, REVIEWER_DEFAULTS[id].effort),
      id,
      model: str3(r.model, REVIEWER_DEFAULTS[id].model),
      vendor: str3(r.vendor, REVIEWER_DEFAULTS[id].vendor),
      ...sandbox ? { sandbox } : {}
    };
  }
  return out;
}
function loadReviewers(file = REVIEWERS_FILE) {
  try {
    return parseReviewers(JSON.parse(fs6.readFileSync(file, "utf8")));
  } catch {
    return { ...REVIEWER_DEFAULTS };
  }
}

// src/reviewers/registry.ts
var REVIEW_ADAPTERS = {
  codex: runCodexReview,
  grok: runGrokReview
};

// src/modes/review/diff.ts
import { execFileSync as execFileSync2 } from "child_process";

// src/core/hash.ts
import crypto from "crypto";
function sha256Hex(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

// src/modes/review/diff.ts
var DEFAULT_COVERAGE_CEILING = 2e5;
var GENERATED_PATTERNS = [
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)yarn\.lock$/,
  /(^|\/)bun\.lockb$/,
  /(^|\/)Cargo\.lock$/,
  /(^|\/)go\.sum$/,
  /(^|\/)poetry\.lock$/,
  /(^|\/)Gemfile\.lock$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)(dist|build|out|coverage|node_modules|vendor)\//,
  /(^|\/)\.next\//,
  /\.min\.(js|css)$/,
  /\.(js|css)\.map$/,
  /\.snap$/
];
function classifyFileKind(path8, isBinary) {
  if (isBinary) return "binary";
  return GENERATED_PATTERNS.some((re) => re.test(path8)) ? "generated" : "source";
}
function pathOfSection(section2) {
  const plus = section2.match(/^\+\+\+ b\/(.+)$/m);
  if (plus && plus[1] !== "dev/null") return plus[1].trim();
  const renameTo = section2.match(/^rename to (.+)$/m);
  if (renameTo) return renameTo[1].trim();
  const minus = section2.match(/^--- a\/(.+)$/m);
  if (minus && minus[1] !== "dev/null") return minus[1].trim();
  const header = section2.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (header) return header[2].trim();
  return "unknown";
}
function parseDiffFiles(raw) {
  if (!raw.trim()) return [];
  const parts = raw.split(/^(?=diff --git )/m).filter((s) => s.trim());
  return parts.map((section2) => {
    const isBinary = /^Binary files .* differ$/m.test(section2) || /^GIT binary patch$/m.test(section2);
    const path8 = pathOfSection(section2);
    let added = 0;
    let removed = 0;
    for (const line of section2.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    return {
      added,
      bytes: Buffer.byteLength(section2, "utf8"),
      isBinary,
      kind: classifyFileKind(path8, isBinary),
      path: path8,
      raw: section2,
      removed
    };
  });
}
function computeCoverage(files, ceilingBytes = DEFAULT_COVERAGE_CEILING) {
  const entries = [];
  const includedSections = [];
  let includedBytes = 0;
  for (const f of files) {
    const base = {
      added: f.added,
      bytes: f.bytes,
      kind: f.kind,
      path: f.path,
      removed: f.removed
    };
    if (f.kind === "binary") {
      entries.push({ ...base, included: false, omitReason: "binary" });
      continue;
    }
    if (f.kind === "generated") {
      entries.push({ ...base, included: false, omitReason: "generated" });
      continue;
    }
    if (includedBytes + f.bytes > ceilingBytes && includedBytes > 0) {
      entries.push({ ...base, included: false, omitReason: "over-limit" });
      continue;
    }
    entries.push({ ...base, included: true });
    includedSections.push(f.raw);
    includedBytes += f.bytes;
  }
  const coverage = {
    files: entries,
    includedBytes,
    includedFiles: entries.filter((e) => e.included).length,
    omittedFiles: entries.filter((e) => !e.included).length,
    totalBytes: files.reduce((n, f) => n + f.bytes, 0),
    totalFiles: files.length
  };
  return { coverage, includedDiff: includedSections.join("") };
}
function canonicalizeDiff(raw) {
  return raw.replace(/\r\n?/g, "\n").replace(/\n*$/, "\n");
}
function diffDigest(raw) {
  return `sha256:${sha256Hex(canonicalizeDiff(raw))}`;
}
function git(cwd, args) {
  return execFileSync2("git", args, { cwd, encoding: "utf8" });
}
function gitOrNull(cwd, args) {
  try {
    return git(cwd, args).trim();
  } catch {
    return null;
  }
}
function resolveRepoId(cwd) {
  const remote = gitOrNull(cwd, ["remote", "get-url", "origin"]);
  if (remote) {
    return remote.replace(/^git@([^:]+):/, "https://$1/").replace(/\.git$/, "").replace(/\/$/, "");
  }
  return gitOrNull(cwd, ["rev-parse", "--show-toplevel"]);
}
function resolveBase(cwd, explicit) {
  if (explicit) return explicit;
  const originHead = gitOrNull(cwd, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD"
  ]);
  if (originHead) return originHead.replace(/^refs\//, "");
  for (const ref of ["origin/main", "origin/master", "main", "master"]) {
    if (gitOrNull(cwd, ["rev-parse", "--verify", "--quiet", ref]) !== null) {
      return ref;
    }
  }
  return null;
}
function acquireDiff(opts) {
  const ceiling = opts.ceilingBytes ?? DEFAULT_COVERAGE_CEILING;
  const repoId = resolveRepoId(opts.cwd);
  let mode;
  let rawDiff;
  let baseRef = null;
  let baseSha = null;
  let headSha;
  if (opts.diffText !== void 0) {
    mode = opts.diffMode ?? "raw";
    rawDiff = opts.diffText;
    headSha = mode === "pr" ? "gh pr diff (no local commit identity)" : "raw diff (no commit identity)";
  } else if (opts.staged) {
    mode = "staged";
    rawDiff = git(opts.cwd, ["diff", "--cached"]);
    baseSha = gitOrNull(opts.cwd, ["rev-parse", "HEAD"]);
    baseRef = "HEAD";
    headSha = "staged/index (no commit identity)";
  } else if (opts.workingTree) {
    mode = "working-tree";
    rawDiff = git(opts.cwd, ["diff", "HEAD"]);
    baseSha = gitOrNull(opts.cwd, ["rev-parse", "HEAD"]);
    baseRef = "HEAD";
    headSha = "working-tree (no commit identity)";
  } else {
    mode = "commit";
    const base = resolveBase(opts.cwd, opts.base);
    if (!base) {
      throw new Error(
        "could not resolve a base ref (no --base, no origin/HEAD, no main/master) \u2014 refusing to review an undefined range"
      );
    }
    baseRef = base;
    baseSha = gitOrNull(opts.cwd, ["rev-parse", base]);
    headSha = gitOrNull(opts.cwd, ["rev-parse", "HEAD"]) ?? "working-tree (no commit identity)";
    rawDiff = git(opts.cwd, ["diff", `${base}...HEAD`]);
  }
  const files = parseDiffFiles(rawDiff);
  const { coverage, includedDiff } = computeCoverage(files, ceiling);
  return {
    baseRef,
    baseSha,
    canonicalDigest: diffDigest(rawDiff),
    coverage,
    // The COVERED diff ONLY — never fall back to rawDiff. When coverage included
    // nothing (every file generated/binary), includedDiff is '' and the packet must
    // stay empty → incomplete → skipped, NOT silently carry the omitted files the
    // manifest swears the reviewer never saw (and possibly blow the prompt budget).
    diff: includedDiff,
    files,
    headSha,
    mode,
    rawDiff,
    repoId
  };
}

// src/modes/review/dep-surface.ts
var MANIFEST_PATTERNS = [
  { label: "npm", re: /(^|\/)package\.json$/ },
  { label: "npm-lock", lock: true, re: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json)$/ },
  { label: "yarn-lock", lock: true, re: /(^|\/)yarn\.lock$/ },
  { label: "pnpm-lock", lock: true, re: /(^|\/)pnpm-lock\.yaml$/ },
  { label: "bun-lock", lock: true, re: /(^|\/)bun\.lockb$/ },
  { label: "python-requirements", re: /(^|\/)requirements[^/]*\.txt$/ },
  { label: "python-pyproject", re: /(^|\/)pyproject\.toml$/ },
  { label: "python-pipfile", re: /(^|\/)Pipfile$/ },
  { label: "python-pipfile-lock", lock: true, re: /(^|\/)Pipfile\.lock$/ },
  { label: "go-mod", re: /(^|\/)go\.mod$/ },
  { label: "go-sum", lock: true, re: /(^|\/)go\.sum$/ },
  { label: "rust-cargo", re: /(^|\/)Cargo\.toml$/ },
  { label: "rust-cargo-lock", lock: true, re: /(^|\/)Cargo\.lock$/ },
  { label: "ruby-gemfile", re: /(^|\/)Gemfile$/ },
  { label: "ruby-gemfile-lock", lock: true, re: /(^|\/)Gemfile\.lock$/ },
  { label: "php-composer", re: /(^|\/)composer\.json$/ },
  { label: "php-composer-lock", lock: true, re: /(^|\/)composer\.lock$/ },
  { label: "gradle", re: /(^|\/)build\.gradle(\.kts)?$/ },
  { label: "maven", re: /(^|\/)pom\.xml$/ }
];
var RISKY_PATTERNS = [
  { cls: "deserialization", label: "eval()", re: /\beval\s*\(/ },
  { cls: "deserialization", label: "new Function()", re: /\bnew\s+Function\s*\(/ },
  { cls: "deserialization", label: "vm module", re: /\bvm\.runIn|require\(\s*['"]vm['"]\s*\)|from\s+['"]vm['"]/ },
  { cls: "deserialization", label: "pickle.load (py)", re: /\bpickle\.loads?\s*\(/ },
  { cls: "deserialization", label: "yaml.load (py, unsafe)", re: /\byaml\.load\s*\(/ },
  { cls: "deserialization", label: "unserialize (php)", re: /\bunserialize\s*\(/ },
  { cls: "injection", label: "child_process", re: /\bchild_process\b|\bexecSync?\s*\(|\bspawnSync?\s*\(|\bexecFileSync?\s*\(/ },
  { cls: "injection", label: "os.system / subprocess (py)", re: /\bos\.system\s*\(|\bsubprocess\.(Popen|call|run|check_output)\s*\(/ },
  { cls: "xss", label: "dangerouslySetInnerHTML", re: /dangerouslySetInnerHTML/ },
  { cls: "xss", label: "innerHTML assignment", re: /\.innerHTML\s*=/ },
  { cls: "xss", label: "document.write", re: /document\.write\s*\(/ }
];
function addedContentLines(section2) {
  const out = [];
  let newLine = 0;
  for (const l of section2.split("\n")) {
    const hunk = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      newLine = Number(hunk[1]);
      continue;
    }
    if (l.startsWith("+++")) continue;
    if (l.startsWith("+")) {
      out.push({ line: newLine, text: l.slice(1) });
      newLine++;
    } else if (l.startsWith("-") && !l.startsWith("---")) {
    } else if (l.startsWith(" ")) {
      newLine++;
    }
  }
  return out;
}
function scanDependencySurface(files) {
  const manifests = [];
  const riskyImports = [];
  for (const f of files) {
    if (f.isBinary) continue;
    const added = addedContentLines(f.raw);
    const m = MANIFEST_PATTERNS.find((p) => p.re.test(f.path));
    if (m) {
      manifests.push({
        added: added.length,
        isLockfile: Boolean(m.lock),
        label: m.label,
        path: f.path,
        samples: m.lock ? [] : added.map((a) => a.text.trim()).filter(Boolean).slice(0, 5)
      });
    }
    if (f.kind !== "source") continue;
    const seen = /* @__PURE__ */ new Set();
    for (const a of added) {
      for (const r of RISKY_PATTERNS) {
        if (!seen.has(r.label) && r.re.test(a.text)) {
          seen.add(r.label);
          riskyImports.push({
            cls: r.cls,
            label: r.label,
            line: a.line || void 0,
            path: f.path
          });
        }
      }
    }
  }
  return { manifests, riskyImports };
}

// src/modes/review/receipt.ts
import fs7 from "fs";
import os6 from "os";
import path6 from "path";
function computePolicyHash(args) {
  const canonical = JSON.stringify({
    coveragePolicy: args.coveragePolicy,
    diffMode: args.diffMode,
    reviewerPolicy: [...args.reviewerPolicy].sort()
  });
  return `sha256:${sha256Hex(canonical)}`;
}
function receiptKeyHash(key) {
  const canonical = JSON.stringify({
    baseSha: key.baseSha,
    diffDigest: key.diffDigest,
    headSha: key.headSha,
    policyHash: key.policyHash,
    repo: key.repo
  });
  return sha256Hex(canonical);
}
function slug(s) {
  return sanitizePathSegment(s ?? "unknown").slice(0, 80) || "x";
}
function defaultReceiptStore() {
  return process.env.ENSEMBLE_RECEIPTS_DIR || path6.join(os6.homedir(), ".ensemble-ai", "receipts");
}
function receiptPath(storeDir, key) {
  return path6.join(
    storeDir,
    slug(key.repo),
    slug(key.headSha),
    `${receiptKeyHash(key)}.json`
  );
}
function keyOf(receipt) {
  return {
    baseSha: receipt.baseSha,
    diffDigest: receipt.diffDigest,
    headSha: receipt.headSha,
    policyHash: receipt.policyHash,
    repo: receipt.repo
  };
}
function writeReceipt(storeDir, receipt) {
  const file = receiptPath(storeDir, keyOf(receipt));
  fs7.mkdirSync(path6.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs7.writeFileSync(tmp, JSON.stringify(receipt, null, 2));
  fs7.renameSync(tmp, file);
  return file;
}
function coverageShortfall(coverage) {
  return coverage.omitted.filter((o) => o.kind !== "generated" && o.kind !== "binary").map((o) => o.path);
}
function summarizeCoverage(coverage) {
  return {
    includedFiles: coverage.includedFiles,
    omitted: coverage.files.filter((f) => !f.included).map((f) => ({
      kind: f.kind,
      path: f.path,
      reason: f.omitReason ?? "omitted"
    })),
    omittedFiles: coverage.omittedFiles,
    totalFiles: coverage.totalFiles
  };
}
function buildDiffReceipt(args) {
  const summary = summarizeCoverage(args.coverage);
  const shortfall = coverageShortfall(summary);
  if (shortfall.length > 0) {
    return {
      error: `coverage incomplete \u2014 omitted source file(s): ${shortfall.join(", ")}`,
      ok: false
    };
  }
  if (args.diffTruncated) {
    return {
      error: "coverage incomplete \u2014 the diff exceeded the prompt budget and was truncated, so the reviewer saw only its head+tail, not the whole change",
      ok: false
    };
  }
  const vendors = [];
  for (const id of args.required) {
    const r = args.reviews.find((x) => x.reviewerId === id);
    if (!r || r.terminalState !== "reviewed") {
      return { error: `not qualified \u2014 ${id} did not complete`, ok: false };
    }
    vendors.push(r.reviewer.vendor);
  }
  return {
    ok: true,
    receipt: {
      baseRef: args.baseRef,
      baseSha: args.baseSha,
      completed: [...args.required],
      coverage: summary,
      diffDigest: args.diffDigest,
      diffMode: args.diffMode,
      headSha: args.headSha,
      policyHash: computePolicyHash({
        coveragePolicy: args.coveragePolicy,
        diffMode: args.diffMode,
        reviewerPolicy: args.required
      }),
      repo: args.repo,
      reviewerPolicy: [...args.required],
      runId: args.runId,
      vendors: [...new Set(vendors)]
    }
  };
}

// src/modes/review/secret-scan.ts
var SENSITIVE_PATH_PATTERNS = [
  { label: "dotenv", re: /(^|\/)\.env(\.[^/]+)?$/ },
  { label: "secrets-env", re: /(^|\/)secrets\.env$/ },
  { label: "pem", re: /\.pem$/ },
  { label: "private-key", re: /\.key$/ },
  { label: "ssh-key", re: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/ },
  { label: "auth-json", re: /(^|\/)auth\.json$/ },
  { label: "netrc", re: /(^|\/)\.netrc$/ },
  { label: "aws-credentials", re: /(^|\/)\.aws\/credentials$/ },
  { label: "npmrc", re: /(^|\/)\.npmrc$/ },
  { label: "pypirc", re: /(^|\/)\.pypirc$/ },
  { label: "git-credentials", re: /(^|\/)\.git-credentials$/ },
  { label: "pkcs12", re: /\.(p12|pfx)$/ }
];
var INLINE_SECRET_PATTERNS = [
  { label: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: "aws-access-key", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: "openai-key", re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { label: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ }
];
function payloadLines(section2) {
  return section2.split("\n").filter(
    (l) => l.startsWith("+") && !l.startsWith("+++") || l.startsWith("-") && !l.startsWith("---") || l.startsWith(" ")
  ).map((l) => l.slice(1));
}
function scanDiffForSecrets(files, opts = {}) {
  const sensitivePaths = [];
  const inlineSecrets = [];
  for (const f of files) {
    for (const { label, re } of SENSITIVE_PATH_PATTERNS) {
      if (re.test(f.path)) sensitivePaths.push({ label, path: f.path });
    }
    if (f.isBinary) continue;
    const lines = payloadLines(f.raw);
    for (const { label, re } of INLINE_SECRET_PATTERNS) {
      if (lines.some((line) => re.test(line))) {
        inlineSecrets.push({ label, path: f.path });
      }
    }
  }
  const hasRisk = sensitivePaths.length > 0 || inlineSecrets.length > 0;
  const overridden = Boolean(opts.allowSensitive);
  return {
    blocked: hasRisk && !overridden,
    inlineSecrets,
    overridden,
    sensitivePaths
  };
}

// src/modes/review/index.ts
var DEFAULT_OBJECTIVE = "Adversarial cross-vendor review of a code diff \u2014 find correctness, security, and convention issues a same-vendor author might miss.";
async function reviewOne(out, runId, reviewer, prompt, packetComplete, packet) {
  if (!packetComplete) {
    return persistReview(out, {
      findings: [],
      packet,
      prompt,
      raw: null,
      reviewer,
      runId,
      summary: `Did not review with ${reviewer.id} \u2014 the diff could not be assembled (incomplete packet), so no trustworthy review ran. Surfaced for review.`,
      terminalState: "failed-reviewer"
    });
  }
  const adapter = REVIEW_ADAPTERS[reviewer.id];
  let result;
  try {
    result = await adapter(prompt, reviewer);
  } catch (e) {
    return persistReview(out, {
      findings: [],
      packet,
      prompt,
      raw: null,
      reviewer,
      runId,
      summary: `The ${reviewer.id} reviewer could not run: ${e.message}`,
      terminalState: "failed-reviewer"
    });
  }
  const parsed = result.raw ? parseFindings(result.raw) : null;
  const terminalState = parsed && !parsed.parseError && !result.timedOut ? "reviewed" : "failed-reviewer";
  const summary = result.timedOut ? "The reviewer timed out before completing \u2014 its output is incomplete and not trusted." : parsed?.summary || "The reviewer produced no parseable findings.";
  return persistReview(out, {
    findings: parsed?.findings ?? [],
    packet,
    prompt,
    raw: result.raw,
    reviewer,
    runId,
    summary,
    terminalState
  });
}
async function runReviewMode(opts) {
  const log = opts.onProgress ?? (() => {
  });
  const ceilingBytes = opts.ceilingBytes ?? DEFAULT_COVERAGE_CEILING;
  const profile = opts.profile ?? "code";
  const reviewers = opts.reviewers && opts.reviewers.length > 0 ? opts.reviewers : [...REVIEWER_IDS];
  const sourceLabel = opts.diffText !== void 0 ? opts.diffMode ?? "raw" : opts.staged ? "staged" : opts.workingTree ? "working-tree" : "commit";
  log(`Acquiring diff (${sourceLabel} mode)\u2026`);
  const acquired = acquireDiff({
    base: opts.base,
    ceilingBytes,
    cwd: opts.cwd,
    diffMode: opts.diffMode,
    diffText: opts.diffText,
    staged: opts.staged,
    workingTree: opts.workingTree
  });
  log(
    `Diff: ${acquired.coverage.totalFiles} file(s), ${acquired.coverage.includedFiles} covered, ${acquired.coverage.omittedFiles} omitted \xB7 digest ${acquired.canonicalDigest.slice(0, 19)}\u2026`
  );
  const depSurface = profile === "security" ? scanDependencySurface(acquired.files) : void 0;
  const secretScan = scanDiffForSecrets(acquired.files, {
    allowSensitive: opts.allowSensitive
  });
  if (secretScan.blocked) {
    const paths = [
      ...secretScan.sensitivePaths.map((p) => `${p.path} (${p.label})`),
      ...secretScan.inlineSecrets.map((s) => `${s.path} (${s.label})`)
    ];
    const reason = `diff carries sensitive content: ${paths.join(", ")} \u2014 pass --allow-sensitive to review anyway`;
    log(`BLOCKED \u2014 ${reason}`);
    return {
      acquired,
      blocked: true,
      blockedReason: reason,
      depSurface,
      reviews: [],
      secretScan
    };
  }
  const packet = assembleCodePacket({
    agentsMd: opts.agentsMd,
    authorSummary: opts.authorSummary,
    diff: acquired.diff,
    objective: opts.objective ?? (profile === "security" ? SECURITY_OBJECTIVE : DEFAULT_OBJECTIVE),
    pr: 0,
    repo: acquired.repoId ?? ""
  });
  const prompt = renderReviewPrompt(packet, profile);
  if (!packet.complete) {
    log("Packet incomplete (no usable diff) \u2014 persisting an empty review.");
  }
  log(`Running ${reviewers.length} reviewer(s): ${reviewers.join(", ")}\u2026`);
  const resolved = loadReviewers(opts.reviewersFile);
  const reviews = await Promise.all(
    reviewers.map(async (id) => {
      const reviewer = {
        ...resolved[id],
        ...opts.sandbox ? { sandbox: opts.sandbox } : {}
      };
      log(`  \xB7 ${id} (${reviewer.vendor} \xB7 ${reviewer.model})\u2026`);
      const r = await reviewOne(
        opts.out,
        opts.runId,
        reviewer,
        prompt,
        packet.complete,
        packet
      );
      log(
        `  \xB7 ${id}: ${r.terminalState} \u2014 ${r.findings.length} finding(s)`
      );
      return r;
    })
  );
  const built = buildDiffReceipt({
    baseRef: acquired.baseRef,
    baseSha: acquired.baseSha,
    coverage: acquired.coverage,
    coveragePolicy: { ceilingBytes },
    diffDigest: acquired.canonicalDigest,
    diffMode: acquired.mode,
    // The covered diff is truncated in the packet when it exceeds the diff budget;
    // a truncated payload must not qualify a receipt (the reviewer saw head+tail).
    diffTruncated: acquired.diff.length > PACKET_BUDGETS.diff,
    headSha: acquired.headSha,
    repo: acquired.repoId,
    required: reviewers,
    reviews,
    runId: opts.runId
  });
  if (built.ok && built.receipt) {
    const store = opts.receiptStore ?? defaultReceiptStore();
    const file = writeReceipt(store, built.receipt);
    log(`Receipt written: ${file}`);
    return { acquired, blocked: false, depSurface, receipt: built.receipt, receiptPath: file, reviews, secretScan };
  }
  log(`No receipt \u2014 ${built.error}`);
  return { acquired, blocked: false, depSurface, receiptError: built.error, reviews, secretScan };
}

// src/modes/review/source.ts
function isDiffSourceError(v) {
  return "error" in v;
}
var FLAG_LABEL = {
  "diff-file": "--diff-file",
  pr: "--pr",
  staged: "--staged",
  "working-tree": "--working-tree"
};
function hasExplicitSource(flags) {
  return flags.pr !== void 0 || flags.diffFile !== void 0 || Boolean(flags.staged) || Boolean(flags.workingTree);
}
function selectDiffSource(flags) {
  const explicit = [];
  if (flags.pr !== void 0) explicit.push("pr");
  if (flags.diffFile !== void 0) explicit.push("diff-file");
  if (flags.staged) explicit.push("staged");
  if (flags.workingTree) explicit.push("working-tree");
  if (explicit.length > 1) {
    return {
      error: `choose at most ONE diff source \u2014 got ${explicit.map((k) => FLAG_LABEL[k]).join(", ")}`
    };
  }
  if (explicit.length === 1) {
    const kind = explicit[0];
    if (kind === "pr") {
      if (!/^[1-9][0-9]*$/.test(String(flags.pr))) {
        return { error: `--pr must be a positive integer (got "${flags.pr}")` };
      }
      return { kind, pr: Number(flags.pr) };
    }
    if (kind === "diff-file") return { diffFile: flags.diffFile, kind };
    return { kind };
  }
  if (flags.stdinPiped) return { kind: "stdin" };
  return { kind: "commit" };
}

// src/cli.ts
var USAGE = `ensemble-ai \u2014 convene multiple AI models on a task, read-only.

Usage:
  ensemble-ai <mode> [options]

Modes:
  review       Cross-vendor review of a code diff (implemented).
  security     Cross-vendor SECURITY audit of a code diff (implemented) \u2014
               the review engine with a security-auditor lens + a local
               dependency-surface flag; findings tagged by security class.
  brainstorm   Cross-vendor ideation on a TOPIC (implemented) \u2014 each voice
               generates ideas independently, critiques the others, then one
               synthesizes a ranked, de-duplicated recommendation.

Run \`ensemble-ai review --help\`, \`ensemble-ai security --help\`, or
\`ensemble-ai brainstorm --help\` for options.`;
var REVIEW_USAGE = `ensemble-ai review \u2014 review a diff with ALL configured AI reviewers.

Runs every reviewer in the registry (codex + grok) by default and prints their
findings grouped by severity. With NO source flag it reviews the current branch.

Diff source (give at most ONE; default = current branch):
  (default)            <base>...HEAD \u2014 the current branch vs its merge-base with
                       the default branch (origin/main; resolved like \`gh pr create\`)
  --pr <N>             the diff of GitHub PR #N (via \`gh pr diff <N>\`)
  --staged             staged changes (\`git diff --cached\`)
  --working-tree       uncommitted tracked changes vs HEAD (\`git diff HEAD\`)
  --diff-file <path>   a raw unified diff read from a file
  (stdin)              a piped diff, e.g. \`git diff main...HEAD | ensemble-ai review\`

Options:
  --base <ref>          base ref for the default (commit) mode
  --reviewers <ids>     comma-separated reviewer ids (default: all configured)
  --no-fail-on-high     do NOT exit non-zero when a HIGH finding is present
  --out <dir>           trail output dir (default: a temp dir, printed)
  --sandbox <profile>   reviewer sandbox profile override (deny-by-default only)
  --allow-sensitive     review even if the diff carries secrets/sensitive paths
  --ceiling <bytes>     coverage byte ceiling (default 200000)
  --cwd <dir>           repo working dir (default: cwd)
  --run-id <id>         trail/receipt run id (default: generated)
  -h, --help            this help

Exit codes: 0 = completed, no HIGH (or gate disabled) \xB7 1 = a reviewer failed
(crash/timeout/no-parse) \xB7 2 = blocked by the secret-scan \xB7 3 = usage / no diff \xB7
4 = completed WITH a HIGH finding (the gate; disable with --no-fail-on-high).`;
var SECURITY_USAGE = `ensemble-ai security \u2014 adversarial SECURITY audit of a diff with ALL reviewers.

A thin PROFILE over \`review\`: the SAME engine + diff sources + receipt + HIGH gate,
but the reviewers run under a security-auditor lens (injection \xB7 XSS \xB7 authn/authz \xB7
secret-leak \xB7 supply-chain \xB7 unsafe deserialization/eval \xB7 SSRF \xB7 path-traversal \xB7
crypto misuse) and findings are tagged by security class in the grouped output. It
also runs a LOCAL dependency-surface flag (manifest changes + risky imports in the
diff \u2014 NO network / no vuln DB) and reuses the engine's secret-scan.

Diff source (give at most ONE; default = current branch):
  (default)            <base>...HEAD \u2014 the current branch vs its merge-base with
                       the default branch (origin/main; resolved like \`gh pr create\`)
  --pr <N>             the diff of GitHub PR #N (via \`gh pr diff <N>\`)
  --staged             staged changes (\`git diff --cached\`)
  --working-tree       uncommitted tracked changes vs HEAD (\`git diff HEAD\`)
  --diff-file <path>   a raw unified diff read from a file
  (stdin)              a piped diff, e.g. \`git diff main...HEAD | ensemble-ai security\`

Options + exit codes are identical to \`ensemble-ai review\` (run \`review --help\`).`;
function genRunId() {
  const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${crypto2.randomBytes(4).toString("hex")}`;
}
function readStdinIfPiped() {
  if (process.stdin.isTTY) return void 0;
  try {
    const s = fs8.readFileSync(0, "utf8");
    return s.trim() ? s : void 0;
  } catch {
    return void 0;
  }
}
function capture(cmd, cmdArgs, cwd) {
  try {
    const text = execFileSync3(cmd, cmdArgs, {
      cwd,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      // Bound the call so a wedged `gh` (auth prompt, network hang) can't hang the
      // gate forever — fail with a clear error instead.
      timeout: 12e4
    });
    return { ok: true, text };
  } catch (e) {
    const err = e;
    const stderr = err.stderr ? String(err.stderr).trim() : "";
    return { error: stderr || err.message || "command failed", ok: false };
  }
}
function resolveSource(selection, cwd, stdinContent) {
  switch (selection.kind) {
    case "pr": {
      const cap = capture("gh", ["pr", "diff", String(selection.pr)], cwd);
      if (!cap.ok) {
        console.error(
          `ensemble-ai review: \`gh pr diff ${selection.pr}\` failed: ${cap.error}`
        );
        return { code: 3 };
      }
      if (!cap.text.trim()) {
        console.error(`ensemble-ai review: PR #${selection.pr} has an empty diff`);
        return { code: 3 };
      }
      return { diffMode: "pr", diffText: cap.text };
    }
    case "diff-file": {
      let text;
      try {
        text = fs8.readFileSync(String(selection.diffFile), "utf8");
      } catch (e) {
        console.error(
          `ensemble-ai review: cannot read --diff-file: ${e.message}`
        );
        return { code: 3 };
      }
      if (!text.trim()) {
        console.error(
          `ensemble-ai review: --diff-file ${selection.diffFile} is empty`
        );
        return { code: 3 };
      }
      return { diffText: text };
    }
    case "stdin":
      return { diffText: stdinContent };
    case "staged":
      return { staged: true };
    case "working-tree":
      return { workingTree: true };
    case "commit":
      return {};
  }
}
var SEVERITY_LABEL = {
  high: "HIGH",
  low: "LOW",
  medium: "MED"
};
var SEVERITY_ORDER = ["high", "medium", "low"];
function hasHighFinding(reviews) {
  return reviews.some(
    (r) => r.terminalState === "reviewed" && r.findings.some((f) => f.severity === "high")
  );
}
function reviewerTally(r) {
  const id = r.reviewerId ?? r.reviewer.vendor;
  if (r.terminalState !== "reviewed") return `${id} failed`;
  const counts = { high: 0, low: 0, medium: 0 };
  for (const f of r.findings) counts[f.severity]++;
  const parts = SEVERITY_ORDER.filter((s) => counts[s] > 0).map(
    (s) => `${counts[s]}${SEVERITY_LABEL[s][0]}`
  );
  return `${id} ${parts.length ? parts.join("/") : "clean"}`;
}
function oneLineSummary(result) {
  const tallies = result.reviews.map(reviewerTally).join(" \xB7 ");
  const receipt = result.receipt ? `receipt ${result.receipt.diffDigest.slice(0, 19)}\u2026` : "receipt none";
  return `${tallies} \xB7 ${receipt}`;
}
function clean(s) {
  return s.replace(/[\x00-\x1f\x7f]+/g, " ").replace(/\s+/g, " ").trim();
}
function evidenceRef(file, line) {
  if (!file) return "(uncited)";
  const f = clean(file);
  return line ? `${f}:${line}` : f;
}
function findingLine(f, profile) {
  const ref = evidenceRef(f.evidence.file, f.evidence.line);
  if (profile === "security") {
    const cls = classifySecurityFinding(f);
    return `       [${cls}] ${ref}  ${clean(stripSecurityTag(f.title))}`;
  }
  return `       ${ref}  ${clean(f.title)}`;
}
function reviewerBlock(r, profile) {
  const id = r.reviewerId ?? r.reviewer.vendor;
  const out = [];
  out.push("");
  out.push(
    `  \u2500\u2500 ${id} [${r.reviewer.vendor} \xB7 ${r.reviewer.model}] \u2014 ${r.terminalState} \u2500\u2500`
  );
  if (r.terminalState !== "reviewed") {
    out.push(`     ${clean(r.summary).slice(0, 200)}`);
    return out;
  }
  if (r.findings.length === 0) {
    out.push("     no findings");
    return out;
  }
  for (const sev of SEVERITY_ORDER) {
    const group = r.findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    out.push(`     ${SEVERITY_LABEL[sev]}`);
    for (const f of group) out.push(findingLine(f, profile));
  }
  return out;
}
function depSurfaceBlock(d) {
  const out = ["  dependency surface:"];
  if (d.manifests.length === 0 && d.riskyImports.length === 0) {
    out.push("     none \u2014 no manifest changes or risky imports in the diff");
    return out;
  }
  for (const m of d.manifests) {
    const kind = m.isLockfile ? "lockfile" : "manifest";
    out.push(`     ${kind} ${m.label}: ${clean(m.path)} (+${m.added} line(s))`);
    for (const s of m.samples) out.push(`         + ${clean(s).slice(0, 100)}`);
  }
  for (const r of d.riskyImports) {
    out.push(`     risky [${r.cls}] ${r.label} \u2014 ${evidenceRef(r.path, r.line)}`);
  }
  return out;
}
function printSummary(result, profile) {
  const a = result.acquired;
  const out = [];
  out.push("");
  out.push(`ensemble-ai ${profile === "security" ? "security" : "review"} \u2014 ${a.mode} mode`);
  if (a.repoId) out.push(`  repo:    ${a.repoId}`);
  if (a.baseRef) out.push(`  base:    ${a.baseRef} (${a.baseSha ?? "?"})`);
  out.push(`  head:    ${a.headSha}`);
  out.push(`  digest:  ${a.canonicalDigest}`);
  out.push(
    `  files:   ${a.coverage.totalFiles} total \xB7 ${a.coverage.includedFiles} reviewed \xB7 ${a.coverage.omittedFiles} omitted`
  );
  for (const f of a.coverage.files.filter((x) => !x.included)) {
    out.push(`             omitted: ${f.path} (${f.omitReason}/${f.kind})`);
  }
  const ss = result.secretScan;
  if (ss.sensitivePaths.length || ss.inlineSecrets.length) {
    out.push(
      `  secrets: ${ss.sensitivePaths.length} sensitive path(s), ${ss.inlineSecrets.length} inline${ss.overridden ? " (overridden)" : ""}`
    );
  }
  if (result.depSurface) out.push(...depSurfaceBlock(result.depSurface));
  if (result.blocked) {
    out.push(`  BLOCKED: ${result.blockedReason}`);
    console.error(out.join("\n"));
    return;
  }
  for (const r of result.reviews) out.push(...reviewerBlock(r, profile));
  out.push("");
  if (result.receipt) {
    out.push(`  receipt: ${result.receiptPath}`);
    out.push(
      `           completed: ${result.receipt.completed.join(", ")} \xB7 vendors: ${result.receipt.vendors.join(", ")}`
    );
  } else {
    out.push(`  receipt: none \u2014 ${result.receiptError ?? "not qualified"}`);
  }
  out.push("");
  out.push(`  ${oneLineSummary(result)}`);
  out.push("");
  console.log(out.join("\n"));
}
async function reviewCommand(args, profile = "code") {
  const usage = profile === "security" ? SECURITY_USAGE : REVIEW_USAGE;
  const cmd = profile === "security" ? "security" : "review";
  let values;
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      options: {
        "allow-sensitive": { type: "boolean" },
        base: { type: "string" },
        ceiling: { type: "string" },
        cwd: { type: "string" },
        "diff-file": { type: "string" },
        help: { short: "h", type: "boolean" },
        "no-fail-on-high": { type: "boolean" },
        out: { type: "string" },
        pr: { type: "string" },
        reviewers: { type: "string" },
        "run-id": { type: "string" },
        sandbox: { type: "string" },
        staged: { type: "boolean" },
        "working-tree": { type: "boolean" }
      }
    }));
  } catch (e) {
    console.error(`ensemble-ai ${cmd}: ${e.message}`);
    console.error(usage);
    return 3;
  }
  if (values.help) {
    console.log(usage);
    return 0;
  }
  const cwd = values.cwd ? path7.resolve(String(values.cwd)) : process.cwd();
  const sourceFlags = {
    diffFile: typeof values["diff-file"] === "string" ? values["diff-file"] : void 0,
    pr: typeof values.pr === "string" ? values.pr : void 0,
    staged: Boolean(values.staged),
    workingTree: Boolean(values["working-tree"])
  };
  const stdinContent = hasExplicitSource(sourceFlags) ? void 0 : readStdinIfPiped();
  const selection = selectDiffSource({ ...sourceFlags, stdinPiped: stdinContent !== void 0 });
  if (isDiffSourceError(selection)) {
    console.error(`ensemble-ai ${cmd}: ${selection.error}`);
    return 3;
  }
  const source = resolveSource(selection, cwd, stdinContent);
  if ("code" in source) return source.code;
  let reviewers;
  if (typeof values.reviewers === "string") {
    const requested = values.reviewers.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = requested.filter((id) => !isReviewerId(id));
    if (unknown.length > 0 || requested.length === 0) {
      console.error(
        `ensemble-ai ${cmd}: --reviewers "${values.reviewers}" ${unknown.length ? `has unknown id(s): ${unknown.join(", ")}` : "is empty"} (known: ${REVIEWER_IDS.join(", ")})`
      );
      return 3;
    }
    reviewers = parseReviewerIds(requested);
  }
  const runId = typeof values["run-id"] === "string" ? values["run-id"] : genRunId();
  const out = typeof values.out === "string" ? path7.resolve(values.out) : path7.join(os7.tmpdir(), "ensemble-ai", runId);
  const ceilingBytes = typeof values.ceiling === "string" ? Number(values.ceiling) : void 0;
  if (ceilingBytes !== void 0 && (!Number.isFinite(ceilingBytes) || ceilingBytes <= 0)) {
    console.error(`ensemble-ai ${cmd}: --ceiling must be a positive number`);
    return 3;
  }
  let result;
  try {
    result = await runReviewMode({
      allowSensitive: Boolean(values["allow-sensitive"]),
      base: typeof values.base === "string" ? values.base : void 0,
      ceilingBytes,
      cwd,
      diffMode: source.diffMode,
      diffText: source.diffText,
      onProgress: (m) => console.error(`\xB7 ${m}`),
      out,
      profile,
      reviewers,
      runId,
      sandbox: typeof values.sandbox === "string" ? values.sandbox : void 0,
      staged: source.staged,
      workingTree: source.workingTree
    });
  } catch (e) {
    console.error(`ensemble-ai ${cmd}: ${e.message}`);
    return 3;
  }
  printSummary(result, profile);
  console.error(`trail: ${out}`);
  if (result.blocked) return 2;
  const allReviewed = result.reviews.length > 0 && result.reviews.every((r) => r.terminalState === "reviewed");
  if (!allReviewed) return 1;
  if (!values["no-fail-on-high"] && hasHighFinding(result.reviews)) return 4;
  return 0;
}
var BRAINSTORM_USAGE = `ensemble-ai brainstorm \u2014 convene multiple AI voices on a TOPIC.

Usage:
  ensemble-ai brainstorm "<topic>" [options]

Three rounds: (1) each voice generates ideas INDEPENDENTLY (no anchoring), (2) each
critiques + extends the OTHERS' ideas, (3) one voice synthesizes a ranked,
de-duplicated recommendation. Voices: codex + grok + claude by default (Claude joins
as a voice here \u2014 there is no independence concern, unlike review).

Options:
  --file <path>         include a file's contents as shared context for every voice
  --voices <ids>        comma-separated voice ids (default: codex,grok,claude)
  --synthesizer <id>    which voice runs round 3 (default: claude if present)
  --timeout <seconds>   per-voice timeout (default 300)
  --voices-file <path>  voices config json (default ~/.ensemble-ai/voices.json)
  --json                print the full result as JSON instead of formatted text
  --cwd <dir>           working dir for --file resolution (default: cwd)
  -h, --help            this help

Exit codes: 0 = produced ideas (synthesis printed) \xB7 1 = no usable output (every
voice failed) \xB7 3 = usage or an unexpected operational error.`;
function printBrainstorm(r) {
  const out = [];
  out.push("");
  out.push(`ensemble-ai brainstorm \u2014 ${clean(r.topic).slice(0, 200)}`);
  out.push(`  voices: ${r.roster.join(", ")}`);
  out.push("");
  out.push("Round 1 \xB7 independent ideas");
  for (const g of r.generate) {
    out.push("");
    out.push(`  \u2500\u2500 ${g.voiceId} \u2500\u2500`);
    if (!g.ok) {
      out.push(`     (no ideas \u2014 ${clean(g.error ?? "failed").slice(0, 160)})`);
      continue;
    }
    if (g.summary) out.push(`     ${clean(g.summary).slice(0, 240)}`);
    for (const idea of g.ideas) {
      out.push(`     \u2022 [${idea.id}] ${clean(idea.title)}`);
      if (idea.body) out.push(`         ${clean(idea.body).slice(0, 300)}`);
    }
  }
  if (r.critique.length > 0) {
    out.push("");
    out.push("Round 2 \xB7 cross-critique");
    for (const c of r.critique) {
      out.push("");
      out.push(`  \u2500\u2500 ${c.voiceId} \u2500\u2500`);
      if (!c.ok) {
        out.push(`     (no critique \u2014 ${clean(c.error ?? "failed").slice(0, 160)})`);
        continue;
      }
      for (const cr of c.critiques) {
        out.push(`     [${cr.stance}] ${clean(cr.target)} \u2014 ${clean(cr.assessment).slice(0, 260)}`);
      }
      for (const ex of c.extensions) {
        out.push(`     + ${clean(ex.title)}`);
        if (ex.body) out.push(`         ${clean(ex.body).slice(0, 260)}`);
      }
    }
  }
  out.push("");
  const s = r.synthesis;
  out.push(
    `Round 3 \xB7 synthesis${s.by ? ` (by ${s.by})` : ""}${s.degraded ? " \u2014 DEGRADED (deterministic fallback)" : ""}`
  );
  if (s.summary) out.push(`  ${clean(s.summary).slice(0, 400)}`);
  for (const ri of s.ranked) {
    out.push("");
    out.push(
      `  ${ri.rank}. ${clean(ri.title)}${ri.contributors.length ? `  [${ri.contributors.map(clean).join(", ")}]` : ""}`
    );
    if (ri.why) out.push(`     why:  ${clean(ri.why).slice(0, 300)}`);
    if (ri.risks) out.push(`     risk: ${clean(ri.risks).slice(0, 240)}`);
  }
  out.push("");
  console.log(out.join("\n"));
}
async function brainstormCommand(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        cwd: { type: "string" },
        file: { type: "string" },
        help: { short: "h", type: "boolean" },
        json: { type: "boolean" },
        synthesizer: { type: "string" },
        timeout: { type: "string" },
        voices: { type: "string" },
        "voices-file": { type: "string" }
      }
    });
  } catch (e) {
    console.error(`ensemble-ai brainstorm: ${e.message}`);
    console.error(BRAINSTORM_USAGE);
    return 3;
  }
  const { positionals, values } = parsed;
  if (values.help) {
    console.log(BRAINSTORM_USAGE);
    return 0;
  }
  const topic = positionals.join(" ").trim();
  if (!topic) {
    console.error(
      'ensemble-ai brainstorm: a topic is required, e.g. ensemble-ai brainstorm "naming options for X"'
    );
    console.error(BRAINSTORM_USAGE);
    return 3;
  }
  const cwd = values.cwd ? path7.resolve(String(values.cwd)) : process.cwd();
  let fileContext;
  if (typeof values.file === "string") {
    try {
      fileContext = fs8.readFileSync(path7.resolve(cwd, values.file), "utf8");
    } catch (e) {
      console.error(
        `ensemble-ai brainstorm: cannot read --file ${values.file}: ${e.message}`
      );
      return 3;
    }
  }
  let voices;
  if (typeof values.voices === "string") {
    const requested = values.voices.split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = requested.filter((id) => !isVoiceId(id));
    if (unknown.length > 0 || requested.length === 0) {
      console.error(
        `ensemble-ai brainstorm: --voices "${values.voices}" ${unknown.length ? `has unknown id(s): ${unknown.join(", ")}` : "is empty"} (known: ${VOICE_IDS.join(", ")})`
      );
      return 3;
    }
    voices = parseVoiceIds(requested);
  }
  let synthesizer;
  if (typeof values.synthesizer === "string") {
    if (!isVoiceId(values.synthesizer)) {
      console.error(
        `ensemble-ai brainstorm: --synthesizer "${values.synthesizer}" is not a known voice (known: ${VOICE_IDS.join(", ")})`
      );
      return 3;
    }
    synthesizer = values.synthesizer;
  }
  const roster = voices ?? VOICE_IDS;
  if (synthesizer && !roster.includes(synthesizer)) {
    console.error(
      `ensemble-ai brainstorm: --synthesizer "${synthesizer}" is not in the voices roster (${roster.join(", ")})`
    );
    return 3;
  }
  let timeoutMs;
  if (typeof values.timeout === "string") {
    const secs = Number(values.timeout);
    if (!Number.isFinite(secs) || secs <= 0) {
      console.error("ensemble-ai brainstorm: --timeout must be a positive number of seconds");
      return 3;
    }
    timeoutMs = Math.round(secs * 1e3);
    if (timeoutMs < 1) {
      console.error("ensemble-ai brainstorm: --timeout is too small (rounds to 0ms)");
      return 3;
    }
  }
  let result;
  try {
    result = await runBrainstormMode({
      fileContext,
      onProgress: (m) => console.error(`\xB7 ${m}`),
      synthesizer,
      timeoutMs,
      topic,
      voices,
      voicesFile: typeof values["voices-file"] === "string" ? values["voices-file"] : void 0
    });
  } catch (e) {
    console.error(`ensemble-ai brainstorm: ${e.message}`);
    return 3;
  }
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else printBrainstorm(result);
  const anyIdeas = result.generate.some((g) => g.ok && g.ideas.length > 0);
  return anyIdeas ? 0 : 1;
}
async function main(argv) {
  const mode = argv[0];
  if (!mode || mode === "-h" || mode === "--help") {
    console.log(USAGE);
    return mode ? 0 : 1;
  }
  if (mode === "review") return reviewCommand(argv.slice(1), "code");
  if (mode === "security") return reviewCommand(argv.slice(1), "security");
  if (mode === "brainstorm") return brainstormCommand(argv.slice(1));
  if (isMode(mode) && !isImplemented(mode)) {
    console.error(`ensemble-ai: mode "${mode}" is planned but not implemented yet.`);
    return 3;
  }
  console.error(`ensemble-ai: unknown mode "${mode}".
`);
  console.error(USAGE);
  return 3;
}
function isEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path7.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
if (isEntrypoint()) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      console.error(`ensemble-ai: ${e.stack ?? e}`);
      process.exitCode = 1;
    }
  );
}
export {
  main
};
