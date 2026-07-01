#!/usr/bin/env node

// src/cli.ts
import { execFileSync as execFileSync3 } from "child_process";
import crypto2 from "crypto";
import fs11 from "fs";
import os8 from "os";
import path9 from "path";
import { parseArgs } from "util";

// src/core/conventions.ts
import fs from "fs";
import path from "path";
var DEFAULT_CAP_BYTES = 8e4;
var DEFAULT_MAX_FILES = 60;
var ENTRY_FILES = ["CLAUDE.md", "AGENTS.md"];
var COMMON_DOCS = ["CONTRIBUTING.md", "ARCHITECTURE.md", "TECH_DESIGN.md"];
var SWEEP_DIRS = ["docs", "ai-spec"];
function resolveInRepo(fromDir, ref) {
  const first = ref.trim().split(/[#?\s]/)[0];
  if (!first) return null;
  if (first.startsWith("/") || first.startsWith("~")) return null;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(first)) return null;
  const joined = path.posix.normalize(path.posix.join(fromDir || ".", first));
  if (joined === ".." || joined.startsWith("../")) return null;
  if (joined.startsWith("/")) return null;
  return joined === "." ? "" : joined.replace(/^\.\//, "");
}
function dirOf(relPath) {
  const d = path.posix.dirname(relPath);
  return d === "." ? "" : d;
}
function joinDir(dir, file) {
  return dir === "" ? file : `${dir}/${file}`;
}
function ancestorDirs(relPath) {
  const dirs = [];
  let d = dirOf(relPath);
  for (; ; ) {
    dirs.push(d);
    if (d === "") break;
    d = dirOf(d);
  }
  return dirs;
}
function extractRefs(content) {
  const refs = /* @__PURE__ */ new Set();
  for (const m of content.matchAll(/(?:^|\s)@([^\s)]+\.md)/gm)) refs.add(m[1]);
  for (const m of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) refs.add(m[1]);
  for (const m of content.matchAll(/\b(?:see|read|per|in)\s+`?([\w./-]+\.md)`?/gi)) {
    refs.add(m[1]);
  }
  return [...refs];
}
function sliceBytes(s, maxBytes) {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString("utf8").replace(/�$/, "");
}
function fileHeader(rel) {
  return `

===== ${rel} =====
`;
}
async function gatherConventions(reader, changedPaths, config = {}) {
  const capBytes = config.capBytes ?? DEFAULT_CAP_BYTES;
  const maxFiles = config.maxFiles ?? DEFAULT_MAX_FILES;
  const dirs = /* @__PURE__ */ new Set([""]);
  for (const p of changedPaths) {
    const rel = resolveInRepo("", p);
    if (rel === null || rel === "") continue;
    for (const d of ancestorDirs(rel)) dirs.add(d);
  }
  const orderedDirs = [...dirs].sort(
    (a, b) => a.length - b.length || (a < b ? -1 : 1)
  );
  const seen = /* @__PURE__ */ new Set();
  const queue = [];
  const enqueue = (rel) => {
    if (!rel || !rel.endsWith(".md")) return;
    if (seen.has(rel)) return;
    seen.add(rel);
    queue.push(rel);
  };
  for (const d of orderedDirs) {
    for (const f of ENTRY_FILES) enqueue(joinDir(d, f));
  }
  for (const c of config.conventions ?? []) enqueue(resolveInRepo("", c));
  for (const d of orderedDirs) {
    for (const f of COMMON_DOCS) enqueue(joinDir(d, f));
    for (const sweepDir of SWEEP_DIRS) {
      for (const item of await reader.list(joinDir(d, sweepDir))) {
        enqueue(resolveInRepo("", item));
      }
    }
  }
  const files = [];
  const chunks = [];
  let used = 0;
  let visited = 0;
  while (queue.length > 0) {
    const rel = queue.shift();
    const content = await reader.read(rel);
    if (content === null) continue;
    if (visited >= maxFiles) break;
    visited++;
    const bytes = Buffer.byteLength(content, "utf8");
    const dir = dirOf(rel);
    for (const ref of extractRefs(content)) enqueue(resolveInRepo(dir, ref));
    const remaining = capBytes - used;
    const header = fileHeader(rel);
    const headerBytes = Buffer.byteLength(header, "utf8");
    if (remaining <= headerBytes) {
      files.push({ path: rel, bytes, included: false, truncated: false, reason: "over-cap" });
      continue;
    }
    if (headerBytes + bytes <= remaining) {
      chunks.push(header + content);
      used += headerBytes + bytes;
      files.push({ path: rel, bytes, included: true, truncated: false });
    } else {
      const noticeFor = (n) => `

\u2026[${n} bytes truncated \u2014 over the ${capBytes}-byte conventions cap]\u2026
`;
      const noticeReserve = Buffer.byteLength(noticeFor(bytes), "utf8");
      const contentBudget = remaining - headerBytes - noticeReserve;
      if (contentBudget <= 0) {
        files.push({ path: rel, bytes, included: false, truncated: false, reason: "over-cap" });
        continue;
      }
      const head = sliceBytes(content, contentBudget);
      const headBytes = Buffer.byteLength(head, "utf8");
      const notice = noticeFor(bytes - headBytes);
      chunks.push(`${header}${head}${notice}`);
      used += headerBytes + headBytes + Buffer.byteLength(notice, "utf8");
      files.push({ path: rel, bytes, included: true, truncated: true, reason: "over-cap" });
    }
  }
  return {
    text: chunks.join("").replace(/^\n+/, ""),
    manifest: { capBytes, files, totalBytes: used }
  };
}
function fsConventionReader(repoRoot) {
  const root = path.resolve(repoRoot);
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = root;
  }
  const within = (rel) => {
    const abs = path.resolve(root, rel);
    const back = path.relative(root, abs);
    if (back.startsWith("..") || path.isAbsolute(back)) return null;
    let real;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return null;
    }
    const realBack = path.relative(realRoot, real);
    if (realBack.startsWith("..") || path.isAbsolute(realBack)) return null;
    return real;
  };
  return {
    async read(rel) {
      const abs = within(rel);
      if (!abs) return null;
      try {
        if (!fs.statSync(abs).isFile()) return null;
        return fs.readFileSync(abs, "utf8");
      } catch {
        return null;
      }
    },
    async list(dirRel) {
      const abs = within(dirRel);
      if (!abs) return [];
      try {
        return fs.readdirSync(abs).filter((n) => n.endsWith(".md")).map((n) => joinDir(dirRel, n));
      } catch {
        return [];
      }
    }
  };
}

// src/core/entrypoint.ts
import fs2 from "fs";
import { fileURLToPath } from "url";
function isEntrypoint(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return fs2.realpathSync(entry) === fs2.realpathSync(fileURLToPath(importMetaUrl));
  } catch {
    return false;
  }
}

// src/core/reviewers.ts
import fs3 from "fs";
import os from "os";
import path2 from "path";

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

// src/core/reviewers.ts
var REVIEWERS_FILE = process.env.ENSEMBLE_REVIEWERS_FILE || path2.join(os.homedir(), ".ensemble-ai", "reviewers.json");
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
function str(v, fallback) {
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
    const sandbox = str(r.sandbox, REVIEWER_DEFAULTS[id].sandbox ?? "");
    out[id] = {
      cmd: str(r.cmd, REVIEWER_DEFAULTS[id].cmd),
      effort: str(r.effort, REVIEWER_DEFAULTS[id].effort),
      id,
      model: str(r.model, REVIEWER_DEFAULTS[id].model),
      vendor: str(r.vendor, REVIEWER_DEFAULTS[id].vendor),
      ...sandbox ? { sandbox } : {}
    };
  }
  return out;
}
function loadReviewers(file = REVIEWERS_FILE) {
  try {
    return parseReviewers(JSON.parse(fs3.readFileSync(file, "utf8")));
  } catch {
    return { ...REVIEWER_DEFAULTS };
  }
}
function listReviewers(file = REVIEWERS_FILE) {
  const all = loadReviewers(file);
  return REVIEWER_IDS.map((id) => all[id]);
}

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
function str2(v) {
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
    const title = str2(r.title);
    const body = str2(r.body);
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
  const summary = str2(o.summary);
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
  const summary = str2(o.summary);
  if (!Array.isArray(o.critiques) && !Array.isArray(o.extensions)) {
    return {
      critiques: [],
      extensions: [],
      parseError: 'output has neither a "critiques" nor an "extensions" array',
      summary
    };
  }
  const critiques = [];
  if (Array.isArray(o.critiques)) {
    for (const rc of o.critiques) {
      if (!rc || typeof rc !== "object") continue;
      const c = rc;
      const target = str2(c.target);
      const assessment = str2(c.assessment);
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
  return [...new Set(v.map(str2).filter(Boolean))];
}
function parseSynthesis(raw) {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== "object") {
    return { parseError: "no parseable JSON block in the output", ranked: [], summary: "" };
  }
  const o = obj;
  const summary = str2(o.summary);
  if (!Array.isArray(o.ranked)) {
    return { parseError: 'output has no "ranked" array', ranked: [], summary };
  }
  const ranked = [];
  o.ranked.forEach((rr) => {
    if (!rr || typeof rr !== "object") return;
    const r = rr;
    const title = str2(r.title);
    const why = str2(r.why);
    if (!title && !why) return;
    const risks = str2(r.risks);
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
var SYNTHESIS_FIELD_BUDGET = 2e3;
function cap(s) {
  return s.length > SYNTHESIS_FIELD_BUDGET ? `${s.slice(0, SYNTHESIS_FIELD_BUDGET)}\u2026[truncated]` : s;
}
function allIdeasBlock(allIdeas) {
  return allIdeas.map((i) => `[${i.id}] (${i.voiceId ?? "?"}) ${cap(i.title)}: ${cap(i.body)}`).join("\n");
}
function critiquesBlock(critiqueResults) {
  const lines = [];
  for (const c of critiqueResults) {
    if (!c.ok) continue;
    for (const cr of c.critiques) {
      lines.push(`(${c.voiceId}) ${cr.stance} on ${cap(cr.target)}: ${cap(cr.assessment)}`);
    }
    for (const ex of c.extensions) {
      lines.push(`(${c.voiceId}) extension \u2014 ${cap(ex.title)}: ${cap(ex.body)}`);
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
import fs7 from "fs";
import os5 from "os";
import path5 from "path";

// src/reviewers/codex.ts
import os3 from "os";
import path3 from "path";

// src/core/spawn.ts
import { spawn } from "child_process";
import fs5 from "fs";
import os2 from "os";

// src/core/bin.ts
import { execFileSync } from "child_process";
import fs4 from "fs";
var binCache = /* @__PURE__ */ new Map();
function resolveBin(name, opts = {}) {
  const cached = binCache.get(name);
  if (cached) return cached;
  const candidates = [
    opts.envVar ? process.env[opts.envVar] : void 0,
    ...opts.candidates ?? []
  ].filter((c) => Boolean(c));
  for (const c of candidates) {
    if (fs4.existsSync(c)) {
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
      cwd: os2.tmpdir(),
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
          const text = fs5.readFileSync(outFile ?? "", "utf8").trim();
          if (text) raw = text;
          fs5.unlinkSync(outFile ?? "");
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
  const outFile = path3.join(
    os3.tmpdir(),
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
import fs6 from "fs";
import os4 from "os";
import path4 from "path";
var GROK_BIN_CANDIDATES = [path4.join(os4.homedir(), ".grok", "bin", "grok")];
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
function ensureSandboxProfile(profile, file = path4.join(os4.homedir(), ".grok", "sandbox.toml")) {
  if (BUILTIN_SANDBOXES.has(profile) || profile !== REVIEW_PROFILE_NAME) return;
  try {
    const existing = fs6.existsSync(file) ? fs6.readFileSync(file, "utf8") : "";
    if (existing.includes(REVIEW_PROFILE_BLOCK)) return;
    fs6.mkdirSync(path4.dirname(file), { recursive: true });
    const updated = existing.includes(REVIEW_PROFILE_HEADER) ? replaceReviewSection(existing) : null;
    const content = updated ?? (existing.trim() ? `${existing.trimEnd()}

${REVIEW_PROFILE}` : REVIEW_PROFILE);
    const tmp = `${file}.tmp`;
    fs6.writeFileSync(tmp, content);
    fs6.renameSync(tmp, file);
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
  const cwd = fs6.mkdtempSync(path4.join(os4.tmpdir(), "grok-review-"));
  return runReviewerExec({
    args: buildGrokReviewArgs({ ...config, sandbox }, prompt, cwd),
    bin: resolveGrokBin(),
    capture: "stdout",
    onSpawn: opts.onSpawn,
    stderrLimit: 2e3,
    timeoutMs
  }).then(({ raw, stderrTail, timedOut }) => {
    try {
      fs6.rmSync(cwd, { force: true, recursive: true });
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
var CLAUDE_EFFORTS = /* @__PURE__ */ new Set(["low", "medium", "high", "xhigh", "max"]);
var CLAUDE_READONLY_ARGS = [
  "--tools",
  "",
  "--disallowed-tools",
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "--permission-mode",
  "default"
];
function buildClaudeVoiceArgs(prompt, config) {
  const args = ["-p", prompt, "--output-format", "text", ...CLAUDE_READONLY_ARGS];
  if (config?.model && config.model !== "default") args.push("--model", config.model);
  if (config && CLAUDE_EFFORTS.has(config.effort)) args.push("--effort", config.effort);
  return args;
}
function runClaudeVoice(prompt, config, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
  return runReviewerExec({
    args: buildClaudeVoiceArgs(prompt, config),
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
var VOICES_FILE = process.env.ENSEMBLE_VOICES_FILE || path5.join(os5.homedir(), ".ensemble-ai", "voices.json");
function str3(v, fallback) {
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
    const sandbox = str3(r.sandbox, VOICE_DEFAULTS[id].sandbox ?? "");
    out[id] = {
      cmd: str3(r.cmd, VOICE_DEFAULTS[id].cmd),
      effort: str3(r.effort, VOICE_DEFAULTS[id].effort),
      id,
      model: str3(r.model, VOICE_DEFAULTS[id].model),
      vendor: str3(r.vendor, VOICE_DEFAULTS[id].vendor),
      ...sandbox ? { sandbox } : {}
    };
  }
  return out;
}
function loadVoices(file = VOICES_FILE) {
  try {
    return parseVoices(JSON.parse(fs7.readFileSync(file, "utf8")));
  } catch {
    return { ...VOICE_DEFAULTS };
  }
}
function listVoices(file = VOICES_FILE) {
  const all = loadVoices(file);
  return VOICE_IDS.map((id) => all[id]);
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

// src/modes/consult/parse.ts
function str4(v) {
  return typeof v === "string" ? v.trim() : "";
}
function asStance2(v) {
  return oneOf(CRITIQUE_STANCES, v, "concern");
}
function strList(v) {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(str4).filter(Boolean))];
}
function parseAnswer(raw) {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== "object") {
    return { answer: "", keyPoints: [], parseError: "no parseable JSON block in the output", summary: "" };
  }
  const o = obj;
  const summary = str4(o.summary);
  const answer = str4(o.answer);
  const keyPoints = strList(o.keyPoints);
  if (!summary && !answer) {
    return { answer: "", keyPoints, parseError: 'output has no "answer" or "summary"', summary: "" };
  }
  return { answer, keyPoints, summary };
}
function parseCritique2(raw) {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== "object") {
    return { notes: [], parseError: "no parseable JSON block in the output", summary: "" };
  }
  const o = obj;
  const summary = str4(o.summary);
  if (!Array.isArray(o.notes)) {
    return { notes: [], parseError: 'output has no "notes" array', summary };
  }
  const notes = [];
  for (const rn of o.notes) {
    if (!rn || typeof rn !== "object") continue;
    const n = rn;
    const target = str4(n.target);
    const assessment = str4(n.assessment);
    if (!target && !assessment) continue;
    notes.push({ assessment, stance: asStance2(n.stance), target: target || "(unspecified)" });
  }
  return { notes, summary };
}
function parseAgreements(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const ra of v) {
    if (!ra || typeof ra !== "object") continue;
    const a = ra;
    const point = str4(a.point);
    if (!point) continue;
    out.push({ point, voices: strList(a.voices) });
  }
  return out;
}
function parseDivergences(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const rd of v) {
    if (!rd || typeof rd !== "object") continue;
    const d = rd;
    const point = str4(d.point);
    if (!point) continue;
    out.push({ point, positions: strList(d.positions) });
  }
  return out;
}
function parseConsultSynthesis(raw) {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== "object") {
    return {
      agreements: [],
      divergences: [],
      parseError: "no parseable JSON block in the output",
      recommendation: "",
      summary: ""
    };
  }
  const o = obj;
  const summary = str4(o.summary);
  const recommendation = str4(o.recommendation);
  const agreements = parseAgreements(o.agreements);
  const divergences = parseDivergences(o.divergences);
  if (!recommendation && !summary) {
    return {
      agreements,
      divergences,
      parseError: 'output has no "recommendation" or "summary"',
      recommendation: "",
      summary: ""
    };
  }
  return { agreements, divergences, recommendation, summary };
}

// src/modes/consult/prompt.ts
var JSON_RULE2 = "Respond with ONE fenced ```json block and NOTHING else, matching:";
var FILE_CONTEXT_BUDGET2 = 24e3;
function contextBlock2(fileContext) {
  if (!fileContext || !fileContext.trim()) return "";
  const trimmed = fileContext.trimEnd();
  const body = trimmed.length > FILE_CONTEXT_BUDGET2 ? `${trimmed.slice(0, FILE_CONTEXT_BUDGET2)}
\u2026[context truncated]` : trimmed;
  return `
## Context
${body}
`;
}
function renderAnswerPrompt(question, fileContext) {
  return `You are an independent expert answering a question inside a multi-model
consultation. Work ENTIRELY ON YOUR OWN: you have no knowledge of anyone else's
answer \u2014 do not hedge toward, anticipate, or defer to a consensus. Give YOUR honest,
reasoned answer. Where you are uncertain, say so plainly.

## Question
${question.trim()}
${contextBlock2(fileContext)}
## Output format \u2014 STRICT
${JSON_RULE2}
{
  "summary": "<your bottom-line answer in one sentence>",
  "answer": "<your full reasoned answer: the recommendation and the WHY>",
  "keyPoints": ["<a discrete claim or consideration behind your answer>"]
}
Give 2-5 keyPoints \u2014 the load-bearing claims of your answer, each a standalone
sentence (these are what the ensemble compares across voices). Be decisive; do not
pad.
`;
}
function peerAnswersBlock(peers) {
  return peers.map(
    (p) => `[${p.voiceId}] ${p.summary}
${p.answer}${p.keyPoints.length ? `
- ${p.keyPoints.join("\n- ")}` : ""}`
  ).join("\n\n");
}
function renderCritiquePrompt2(question, peers, fileContext) {
  return `You are a sharp, candid participant in a multi-model consultation. Below are
answers from the OTHER voices (you did not write these) to the question. For the
strongest points, say where you AGREE, where you have a CONCERN or disagree, and where
an answer should be REFINED. Be specific \u2014 this sharpens the final synthesis.

## Question
${question.trim()}
${contextBlock2(fileContext)}
## Answers from the other voices
${peerAnswersBlock(peers)}

## Output format \u2014 STRICT
${JSON_RULE2}
{
  "summary": "<your overall read of where the voices land>",
  "notes": [
    {
      "target": "<the [voice] or claim you are addressing>",
      "stance": "support" | "concern" | "extend",
      "assessment": "<concrete: what you agree with, what you doubt, how to refine>"
    }
  ]
}
An empty "notes" array is fine if you have nothing to add.
`;
}
var SYNTHESIS_FIELD_BUDGET2 = 2500;
function cap2(s) {
  return s.length > SYNTHESIS_FIELD_BUDGET2 ? `${s.slice(0, SYNTHESIS_FIELD_BUDGET2)}\u2026[truncated]` : s;
}
function answersBlock(answers) {
  return answers.filter((a) => a.ok).map(
    (a) => `[${a.voiceId}] ${cap2(a.summary)}
${cap2(a.answer)}${a.keyPoints.length ? `
key points:
- ${a.keyPoints.map(cap2).join("\n- ")}` : ""}`
  ).join("\n\n");
}
function critiqueBlock(critique) {
  const lines = [];
  for (const c of critique) {
    if (!c.ok) continue;
    for (const n of c.notes) {
      lines.push(`(${c.voiceId}) ${n.stance} on ${cap2(n.target)}: ${cap2(n.assessment)}`);
    }
  }
  return lines.length ? `

## Cross-critique notes
${lines.join("\n")}` : "";
}
function renderSynthesisPrompt2(question, answers, critique) {
  return `You are the SYNTHESIZER for a multi-model consultation. Several models each
answered the SAME question INDEPENDENTLY (they did not see each other's answers).
Compare them and separate the signal:
- AGREEMENTS: substantive points the voices CONCUR on \u2014 these are the confident core.
- DIVERGENCES: points they answered DIFFERENTLY \u2014 flag these as "look closer", and
  record who took which position.
Then give ONE bottom-line recommendation, noting how much of it rests on agreement
vs on a judgement call between diverging views.

## Question
${question.trim()}

## Independent answers
${answersBlock(answers)}${critiqueBlock(critique)}

## Output format \u2014 STRICT
${JSON_RULE2}
{
  "summary": "<the headline answer in 2-3 sentences>",
  "agreements": [
    { "point": "<a substantive point the voices agree on>", "voices": ["codex", "grok"] }
  ],
  "divergences": [
    { "point": "<the question they split on>", "positions": ["codex: X", "grok: Y"] }
  ],
  "recommendation": "<the bottom-line answer, and how confident given agree vs diverge>"
}
Only list a REAL agreement (genuine concurrence, not a superficial overlap) and a
REAL divergence (a substantive split, not wording). Empty arrays are fine.
`;
}

// src/modes/consult/index.ts
var DEFAULT_VOICE_TIMEOUT_MS2 = 3e5;
async function runAnswer(voiceId, adapters, configs, prompt, timeoutMs, log) {
  const config = configs[voiceId];
  log(`  \xB7 ${voiceId} (${config.vendor} \xB7 ${config.model}) answering\u2026`);
  let res;
  try {
    res = await adapters[voiceId](prompt, config, { timeoutMs });
  } catch (e) {
    log(`  \xB7 ${voiceId}: failed to run \u2014 ${e.message}`);
    return { answer: "", error: e.message, keyPoints: [], ok: false, raw: null, summary: "", voiceId };
  }
  if (!res.raw || res.timedOut) {
    const error = res.timedOut ? "timed out" : "produced no output";
    log(`  \xB7 ${voiceId}: ${error}`);
    return { answer: "", error, keyPoints: [], ok: false, raw: res.raw, summary: "", timedOut: res.timedOut, voiceId };
  }
  const parsed = parseAnswer(res.raw);
  if (parsed.parseError) {
    log(`  \xB7 ${voiceId}: ${parsed.parseError}`);
    return { answer: "", error: parsed.parseError, keyPoints: [], ok: false, raw: res.raw, summary: parsed.summary, voiceId };
  }
  log(`  \xB7 ${voiceId}: answered (${parsed.keyPoints.length} key point(s))`);
  return {
    answer: parsed.answer,
    keyPoints: parsed.keyPoints,
    ok: true,
    raw: res.raw,
    summary: parsed.summary,
    voiceId
  };
}
async function runCritique2(voiceId, adapters, configs, question, answers, fileContext, timeoutMs, log) {
  const config = configs[voiceId];
  const peers = answers.filter((a) => a.ok && a.voiceId !== voiceId);
  const prompt = renderCritiquePrompt2(question, peers, fileContext);
  log(`  \xB7 ${voiceId} reviewing ${peers.length} peer answer(s)\u2026`);
  let res;
  try {
    res = await adapters[voiceId](prompt, config, { timeoutMs });
  } catch (e) {
    return { error: e.message, notes: [], ok: false, raw: null, summary: "", voiceId };
  }
  if (!res.raw || res.timedOut) {
    const error = res.timedOut ? "timed out" : "produced no output";
    return { error, notes: [], ok: false, raw: res.raw, summary: "", timedOut: res.timedOut, voiceId };
  }
  const parsed = parseCritique2(res.raw);
  if (parsed.parseError) {
    return { error: parsed.parseError, notes: [], ok: false, raw: res.raw, summary: parsed.summary, voiceId };
  }
  log(`  \xB7 ${voiceId}: ${parsed.notes.length} note(s)`);
  return { notes: parsed.notes, ok: true, raw: res.raw, summary: parsed.summary, voiceId };
}
function fallbackSynthesis2(answers) {
  const ok = answers.filter((a) => a.ok);
  return {
    agreements: [],
    by: null,
    degraded: true,
    divergences: ok.map((a) => ({
      point: a.summary || `${a.voiceId}'s answer`,
      positions: [`${a.voiceId}: ${(a.summary || a.answer).slice(0, 200)}`]
    })),
    ok: false,
    raw: null,
    recommendation: "",
    summary: ok.length > 0 ? `Synthesizer unavailable \u2014 ${ok.length} answer(s) shown as-is, NOT compared for agreement.` : "No answers were produced."
  };
}
async function runSynthesis2(synthId, adapters, configs, question, answers, critique, timeoutMs, log) {
  const okAnswers = answers.filter((a) => a.ok);
  if (!synthId || okAnswers.length === 0) return fallbackSynthesis2(answers);
  const prompt = renderSynthesisPrompt2(question, answers, critique);
  log(`Synthesizing with ${synthId} \u2014 agreement vs divergence\u2026`);
  let res;
  try {
    res = await adapters[synthId](prompt, configs[synthId], { timeoutMs });
  } catch (e) {
    log(`  \xB7 synthesis failed (${synthId}) \u2014 using the deterministic fallback`);
    return { ...fallbackSynthesis2(answers), error: e.message };
  }
  if (!res.raw || res.timedOut) {
    log(`  \xB7 synthesis produced no usable output \u2014 using the deterministic fallback`);
    return {
      ...fallbackSynthesis2(answers),
      error: res.timedOut ? "synthesis timed out" : "synthesis produced no output"
    };
  }
  const parsed = parseConsultSynthesis(res.raw);
  if (parsed.parseError) {
    log(`  \xB7 synthesis output not parseable \u2014 using the deterministic fallback`);
    return { ...fallbackSynthesis2(answers), error: parsed.parseError, raw: res.raw };
  }
  log(
    `  \xB7 synthesis: ${parsed.agreements.length} agreement(s), ${parsed.divergences.length} divergence(s)`
  );
  return {
    agreements: parsed.agreements,
    by: synthId,
    degraded: false,
    divergences: parsed.divergences,
    ok: true,
    raw: res.raw,
    recommendation: parsed.recommendation,
    summary: parsed.summary
  };
}
function pickSynthesizer2(roster, requested, answers) {
  if (requested && roster.includes(requested)) return requested;
  const healthy = answers.filter((a) => a.ok).map((a) => a.voiceId);
  if (healthy.includes("claude")) return "claude";
  return healthy[0] ?? null;
}
async function runConsultMode(opts) {
  const log = opts.onProgress ?? (() => {
  });
  const roster = opts.voices && opts.voices.length > 0 ? opts.voices : [...VOICE_IDS];
  const adapters = opts.adapters ?? VOICE_ADAPTERS;
  const configs = opts.voiceConfigs ?? loadVoices(opts.voicesFile);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VOICE_TIMEOUT_MS2;
  log(`Round 1 \xB7 independent answers \u2014 ${roster.length} voice(s): ${roster.join(", ")}`);
  const answerPrompt = renderAnswerPrompt(opts.question, opts.fileContext);
  const answers = await Promise.all(
    roster.map((id) => runAnswer(id, adapters, configs, answerPrompt, timeoutMs, log))
  );
  const participants = answers.filter((a) => a.ok).map((a) => a.voiceId);
  let critique = [];
  if (opts.critique && participants.length >= 2) {
    log(`Round 2 \xB7 cross-critique \u2014 ${participants.length} voice(s)`);
    critique = await Promise.all(
      participants.map(
        (id) => runCritique2(id, adapters, configs, opts.question, answers, opts.fileContext, timeoutMs, log)
      )
    );
  } else if (opts.critique) {
    log(`Round 2 \xB7 skipped \u2014 need \u22652 voices with answers (have ${participants.length})`);
  }
  const synthId = pickSynthesizer2(roster, opts.synthesizer, answers);
  const synthesis = await runSynthesis2(
    synthId,
    adapters,
    configs,
    opts.question,
    answers,
    critique,
    timeoutMs,
    log
  );
  return { answers, critique, question: opts.question, roster, synthesis };
}

// src/modes/index.ts
var MODES = ["review", "brainstorm", "security", "consult"];
var IMPLEMENTED_MODES = [
  "review",
  "security",
  "brainstorm",
  "consult"
];
var MODE_ALIASES = { ask: "consult" };
function resolveMode(v) {
  return MODE_ALIASES[v] ?? v;
}
function isMode(v) {
  return MODES.includes(v);
}
function isImplemented(mode) {
  return IMPLEMENTED_MODES.includes(mode);
}

// src/core/artifacts.ts
import fs8 from "fs";
import path6 from "path";
function sanitizePathSegment(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function reviewDir(baseDir, runId) {
  return path6.join(baseDir, sanitizePathSegment(runId) || "unknown");
}
function writeAtomic(dir, name, content) {
  fs8.mkdirSync(dir, { recursive: true });
  const target = path6.join(dir, name);
  const tmp = `${target}.tmp`;
  fs8.writeFileSync(tmp, content);
  fs8.renameSync(tmp, target);
}
function readJson(file) {
  try {
    return JSON.parse(fs8.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
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
function readReview(baseDir, runId, reviewerId = "codex") {
  const dir = reviewDir(baseDir, runId);
  const perId = readJson(path6.join(dir, reviewJson(reviewerId)));
  if (perId) return perId.reviewerId ? perId : { ...perId, reviewerId };
  if (reviewerId === "codex") {
    const legacy = readJson(path6.join(dir, "review.json"));
    if (legacy) return { ...legacy, reviewerId: "codex" };
  }
  return null;
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
function classifyFileKind(path10, isBinary) {
  if (isBinary) return "binary";
  return GENERATED_PATTERNS.some((re) => re.test(path10)) ? "generated" : "source";
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
    const path10 = pathOfSection(section2);
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
      kind: classifyFileKind(path10, isBinary),
      path: path10,
      raw: section2,
      removed
    };
  });
}
function coverageCounts(c) {
  return `${c.totalFiles} total \xB7 ${c.includedFiles} reviewed \xB7 ${c.omittedFiles} omitted`;
}
function omittedLine(o) {
  return `omitted: ${o.path} (${o.reason ?? "omitted"}/${o.kind})`;
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
function git(cwd, args, opts) {
  return execFileSync2("git", args, {
    cwd,
    encoding: "utf8",
    stdio: opts?.quiet ? ["ignore", "pipe", "ignore"] : ["pipe", "pipe", "inherit"]
  });
}
function gitOrNull(cwd, args) {
  try {
    return git(cwd, args, { quiet: true }).trim();
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
    headSha = opts.headShaOverride ?? (mode === "pr" ? "gh pr diff (no local commit identity)" : "raw diff (no commit identity)");
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
import fs9 from "fs";
import os6 from "os";
import path7 from "path";
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
  return process.env.ENSEMBLE_RECEIPTS_DIR || path7.join(os6.homedir(), ".ensemble-ai", "receipts");
}
function receiptPath(storeDir, key) {
  return path7.join(
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
function receiptIdentityMatches(receipt, key) {
  return receipt.repo === key.repo && receipt.baseSha === key.baseSha && receipt.headSha === key.headSha && receipt.policyHash === key.policyHash;
}
function writeReceipt(storeDir, receipt) {
  const file = receiptPath(storeDir, keyOf(receipt));
  fs9.mkdirSync(path7.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs9.writeFileSync(tmp, JSON.stringify(receipt, null, 2));
  fs9.renameSync(tmp, file);
  return file;
}
function validateReceiptShape(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("receipt is not a JSON object");
  }
  const o = value;
  const isStr = (v) => typeof v === "string";
  const isStrOrNull = (v) => v === null || typeof v === "string";
  const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");
  const errs = [];
  if (!isStr(o.diffDigest)) errs.push("diffDigest (string)");
  if (!isStr(o.diffMode)) errs.push("diffMode (string)");
  if (!isStr(o.headSha)) errs.push("headSha (string)");
  if (!isStr(o.policyHash)) errs.push("policyHash (string)");
  if (!isStr(o.runId)) errs.push("runId (string)");
  if (!isStrOrNull(o.repo)) errs.push("repo (string|null)");
  if (!isStrOrNull(o.baseRef)) errs.push("baseRef (string|null)");
  if (!isStrOrNull(o.baseSha)) errs.push("baseSha (string|null)");
  if (!isStrArr(o.completed)) errs.push("completed (string[])");
  if (!isStrArr(o.reviewerPolicy)) errs.push("reviewerPolicy (string[])");
  if (!isStrArr(o.vendors)) errs.push("vendors (string[])");
  const c = o.coverage;
  if (c === null || typeof c !== "object" || Array.isArray(c)) {
    errs.push("coverage (object)");
  } else {
    const cov = c;
    if (typeof cov.totalFiles !== "number") errs.push("coverage.totalFiles (number)");
    if (typeof cov.includedFiles !== "number") errs.push("coverage.includedFiles (number)");
    if (typeof cov.omittedFiles !== "number") errs.push("coverage.omittedFiles (number)");
    if (!Array.isArray(cov.omitted)) errs.push("coverage.omitted (array)");
  }
  if (errs.length > 0) {
    throw new Error(`malformed receipt \u2014 missing/invalid field(s): ${errs.join(", ")}`);
  }
  return value;
}
function readReceipt(storeDir, key) {
  try {
    return validateReceiptShape(
      JSON.parse(fs9.readFileSync(receiptPath(storeDir, key), "utf8"))
    );
  } catch {
    return null;
  }
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
function isDiffReviewed(live, deps) {
  const receipt = deps.readReceipt(live.key);
  if (!receipt) return { reason: "no-receipt", receipt: null, reviewed: false };
  if (receipt.diffDigest !== live.key.diffDigest) {
    return { reason: "stale", receipt, reviewed: false };
  }
  if (!live.required.every((id) => receipt.completed.includes(id))) {
    return { reason: "incomplete-policy", receipt, reviewed: false };
  }
  if (coverageShortfall(summarizeCoverage(live.coverage)).length > 0) {
    return { reason: "incomplete-coverage", receipt, reviewed: false };
  }
  for (const id of live.required) {
    const r = deps.readReview(receipt.runId, id);
    if (!r || r.terminalState !== "reviewed") {
      return { reason: "artifact-missing", receipt, reviewed: false };
    }
  }
  return { reason: "reviewed", receipt, reviewed: true };
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
    headShaOverride: opts.headShaOverride,
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
  let agentsMd = opts.agentsMd;
  let conventionManifest;
  if (!opts.noConventions && opts.conventionReader) {
    const changed = acquired.files.map((f) => f.path).filter((p) => p && p !== "unknown");
    const gathered = await gatherConventions(opts.conventionReader, changed, {
      capBytes: opts.conventionCapBytes,
      conventions: opts.conventionPaths
    });
    if (gathered.text.trim()) agentsMd = gathered.text;
    conventionManifest = gathered.manifest;
    const inc = gathered.manifest.files.filter((f) => f.included).length;
    log(
      `Conventions: ${inc}/${gathered.manifest.files.length} file(s), ${gathered.manifest.totalBytes} bytes gathered`
    );
  }
  const packet = assembleCodePacket({
    agentsMd,
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
    return { acquired, blocked: false, conventionManifest, depSurface, prompt, receipt: built.receipt, receiptPath: file, reviews, secretScan };
  }
  log(`No receipt \u2014 ${built.error}`);
  return { acquired, blocked: false, conventionManifest, depSurface, prompt, receiptError: built.error, reviews, secretScan };
}

// src/modes/review/trail-boundary.ts
import fs10 from "fs";
import os7 from "os";
import path8 from "path";
function realpathBestEffort(p) {
  let cur = path8.resolve(p);
  const tail = [];
  for (; ; ) {
    try {
      const real = fs10.realpathSync(cur);
      return tail.length ? path8.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path8.dirname(cur);
      if (parent === cur) return path8.resolve(p);
      tail.push(path8.basename(cur));
      cur = parent;
    }
  }
}
function isUnderWorkPath(p) {
  return realpathBestEffort(p).split(path8.sep).some((seg) => seg === "_work" || seg.startsWith("_work-"));
}
function trailBoundaryViolation(cwd, outDir, brainRoots) {
  if (!isUnderWorkPath(cwd)) return false;
  const out = realpathBestEffort(outDir);
  return brainRoots.some((root) => {
    const r = realpathBestEffort(root);
    return out === r || out.startsWith(r + path8.sep);
  });
}
function resolveBrainRoots() {
  const roots = /* @__PURE__ */ new Set();
  const candidates = [
    path8.join(os7.homedir(), "brain"),
    path8.join(os7.homedir(), "programming", "projects", "_personal", "my-brain")
  ];
  for (const c of candidates) {
    try {
      roots.add(fs10.realpathSync(c));
    } catch {
    }
    roots.add(path8.resolve(c));
  }
  return [...roots];
}
function enforceTrailBoundary(cwd, outDir, runId, brainRoots = resolveBrainRoots()) {
  if (trailBoundaryViolation(cwd, outDir, brainRoots)) {
    return { out: path8.join(os7.tmpdir(), "ensemble-ai", runId), overridden: true };
  }
  return { out: outDir, overridden: false };
}

// src/modes/review/source.ts
function parsePrUrl(s) {
  const m = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/([1-9][0-9]*)(?:\/(?:files|commits))?\/?(?:[?#].*)?$/i.exec(
    s.trim()
  );
  if (!m) return null;
  return { owner: m[1], pr: Number(m[3]), repo: m[2] };
}
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
      const raw = String(flags.pr);
      if (/^[1-9][0-9]*$/.test(raw)) {
        return { kind, pr: Number(raw) };
      }
      const ref = parsePrUrl(raw);
      if (ref) {
        return { kind, owner: ref.owner, pr: ref.pr, repo: ref.repo };
      }
      return {
        error: `--pr must be a positive integer or a GitHub PR URL (https://github.com/<owner>/<repo>/pull/<N>) \u2014 got "${raw}"`
      };
    }
    if (kind === "diff-file") return { diffFile: flags.diffFile, kind };
    return { kind };
  }
  if (flags.stdinPiped) return { kind: "stdin" };
  return { kind: "commit" };
}

// src/plumbing/diff-preview.ts
function buildPacketPreview(acquired, profile, agentsMd) {
  const packet = assembleCodePacket({
    agentsMd,
    diff: acquired.diff,
    objective: profile === "security" ? SECURITY_OBJECTIVE : DEFAULT_OBJECTIVE,
    pr: 0,
    repo: acquired.repoId ?? ""
  });
  return { packet, prompt: renderReviewPrompt(packet, profile) };
}
function renderConventionManifest(m) {
  const out = [];
  const inc = m.files.filter((f) => f.included).length;
  out.push(
    `  conventions:  ${inc}/${m.files.length} file(s) gathered, ${m.totalBytes} bytes (cap ${m.capBytes})`
  );
  for (const f of m.files) {
    const flag = f.included ? f.truncated ? "~" : "\u2713" : "\xB7";
    const tag = f.truncated ? " (truncated \u2014 over cap)" : !f.included ? " (omitted \u2014 over cap)" : "";
    out.push(`    ${flag} ${f.path} (${f.bytes} bytes)${tag}`);
  }
  return out;
}
function renderPacketPreview(acquired, preview, opts) {
  const c = acquired.coverage;
  const out = [];
  out.push("");
  out.push(`ensemble-ai diff \u2014 the assembled ${opts.profile} review packet (no reviewer run)`);
  if (acquired.repoId) out.push(`  repo:    ${acquired.repoId}`);
  if (acquired.baseRef) out.push(`  base:    ${acquired.baseRef} (${acquired.baseSha ?? "?"})`);
  out.push(`  head:    ${acquired.headSha}`);
  out.push(`  mode:    ${acquired.mode}`);
  out.push(`  digest:  ${acquired.canonicalDigest}`);
  out.push(
    `  files:   ${coverageCounts(c)} \xB7 ${c.includedBytes}/${c.totalBytes} bytes covered`
  );
  for (const f of c.files.filter((x) => !x.included)) {
    out.push(`             ${omittedLine({ kind: f.kind, path: f.path, reason: f.omitReason })}`);
  }
  out.push("");
  out.push("  packet sections (what the reviewer sees):");
  for (const s of preview.packet.sections) {
    const flag = s.included ? s.truncated ? "~" : "\u2713" : "\xB7";
    out.push(`    ${flag} ${s.title} \u2014 ${s.note}`);
  }
  if (opts.conventions) {
    out.push("");
    out.push(...renderConventionManifest(opts.conventions));
  }
  out.push("");
  out.push(`  packet complete: ${preview.packet.complete ? "yes" : "NO \u2014 a blind review (diff missing/too small)"}`);
  out.push(
    `  cost preview:    ~${preview.prompt.length} prompt chars \xD7 ${opts.reviewers.length} reviewer(s) [${opts.reviewers.join(", ")}]`
  );
  if (opts.full) {
    out.push("");
    out.push("  \u2500\u2500 rendered prompt \u2500\u2500");
    out.push(preview.prompt);
  } else {
    out.push("  (pass --full to print the entire rendered prompt)");
  }
  out.push("");
  return out.join("\n");
}

// src/plumbing/registry.ts
function agentLine(c) {
  const sandbox = c.sandbox ? ` \xB7 sandbox ${c.sandbox}` : "";
  return `    ${c.id.padEnd(7)} ${c.vendor} \xB7 ${c.model} @ ${c.effort}${sandbox}`;
}
function sourceNote(file, exists) {
  return exists ? file : `${file} \u2014 not present, using baked defaults`;
}
function renderRegistry(view) {
  const out = [];
  out.push("");
  out.push("ensemble-ai registry \u2014 the configured cross-vendor agents (read-only)");
  out.push("");
  out.push("  review \xB7 security  (reviewers \u2014 the other vendor arbitrated by Munin)");
  out.push(`    config: ${sourceNote(view.reviewersFile, view.reviewersFileExists)}`);
  for (const r of view.reviewers) out.push(agentLine(r));
  out.push("");
  out.push("  brainstorm \xB7 consult  (voices \u2014 Claude joins; no independence concern)");
  out.push(`    config: ${sourceNote(view.voicesFile, view.voicesFileExists)}`);
  for (const v of view.voices) out.push(agentLine(v));
  out.push("");
  return out.join("\n");
}

// src/plumbing/verify.ts
function receiptBackedReadReview(receipt) {
  return (runId, id) => receipt.completed.includes(id) ? {
    findings: [],
    packet: { complete: true, manifest: [] },
    reviewer: { effort: "", model: "", vendor: "" },
    reviewerId: id,
    runId,
    summary: "receipt-backed (no trail dir provided)",
    terminalState: "reviewed"
  } : null;
}
function isAttestedOnly(deps) {
  return !deps.strict && !deps.trailDir;
}
function verifyReceipt(live, deps) {
  const receipt = deps.readReceipt(live.key);
  const trailDir = deps.trailDir;
  const readReviewFn = trailDir ? (runId, id) => readReview(trailDir, runId, id) : deps.strict ? () => null : receipt ? receiptBackedReadReview(receipt) : () => null;
  return isDiffReviewed(live, {
    readReceipt: () => receipt,
    readReview: readReviewFn
  });
}
function verifyExitCode(state) {
  return state.reviewed ? 0 : 3;
}
var REASON_EXPLANATION = {
  "artifact-missing": "ARTIFACT MISSING \u2014 a required reviewer artifact is absent or did not complete (pass --trail <dir>)",
  "incomplete-coverage": "INCOMPLETE COVERAGE \u2014 the current diff omits a source file the review did not cover",
  "incomplete-policy": "INCOMPLETE POLICY \u2014 the receipt does not cover every required reviewer",
  "no-receipt": "NO RECEIPT \u2014 the current diff identity has no review receipt; it has not been reviewed",
  reviewed: "VALID & CURRENT \u2014 the current diff matches a qualifying cross-vendor review receipt",
  stale: "STALE \u2014 a receipt exists but its diff digest no longer matches the current state (commits since review)"
};
function formatVerify(state, key) {
  const out = [];
  out.push("");
  out.push(`ensemble-ai receipt verify \u2014 ${state.reviewed ? "PASS" : "FAIL"}`);
  out.push(`  repo:    ${key.repo ?? "(none)"}`);
  out.push(`  head:    ${key.headSha}`);
  out.push(`  digest:  ${key.diffDigest}`);
  out.push(`  verdict: ${REASON_EXPLANATION[state.reason]}`);
  if (state.receipt) {
    out.push(
      `  receipt: runId ${state.receipt.runId} \xB7 completed ${state.receipt.completed.join(", ")} \xB7 vendors ${state.receipt.vendors.join(", ")}`
    );
  }
  out.push("");
  return out.join("\n");
}
function formatReceipt(receipt) {
  const c = receipt.coverage;
  const out = [];
  out.push("");
  out.push("ensemble-ai receipt show");
  out.push(`  repo:      ${receipt.repo ?? "(none)"}`);
  out.push(`  base:      ${receipt.baseRef ?? "(none)"} (${receipt.baseSha ?? "?"})`);
  out.push(`  head:      ${receipt.headSha}`);
  out.push(`  mode:      ${receipt.diffMode}`);
  out.push(`  digest:    ${receipt.diffDigest}`);
  out.push(`  policy:    ${receipt.policyHash}`);
  out.push(`  reviewers: ${receipt.reviewerPolicy.join(", ")} (policy)`);
  out.push(`  completed: ${receipt.completed.join(", ")}`);
  out.push(`  vendors:   ${receipt.vendors.join(", ")}`);
  out.push(`  runId:     ${receipt.runId}`);
  out.push(`  coverage:  ${coverageCounts(c)}`);
  for (const o of c.omitted) {
    out.push(`               ${omittedLine({ kind: o.kind, path: o.path, reason: o.reason })}`);
  }
  out.push("");
  return out.join("\n");
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
  consult      Cross-vendor Q&A on a QUESTION (implemented; alias: ask) \u2014 each
               voice answers independently, then one synthesizes what they AGREE
               on (confident) vs where they DIVERGE (look closer).

Plumbing (no reviewer runs \u2014 inspect the engine):
  receipt      verify | show a content-tied diff receipt (the pre-PR gate primitive):
               \`receipt verify\` exits 0 iff the current diff is reviewed & current.
  reviewers    (alias: config) list the configured cross-vendor registry (read-only).
  diff         show the assembled review packet that WOULD be sent \u2014 cost-preview/debug.

Run \`ensemble-ai <mode|command> --help\` for options.`;
var REVIEW_USAGE = `ensemble-ai review \u2014 review a diff with ALL configured AI reviewers.

Runs every reviewer in the registry (codex + grok) by default and prints their
findings grouped by severity. With NO source flag it reviews the current branch.

Usage:
  ensemble-ai review [<pr-url>] [options]

Diff source (give at most ONE; default = current branch):
  (default)            <base>...HEAD \u2014 the current branch vs its merge-base with
                       the default branch (origin/main; resolved like \`gh pr create\`)
  <pr-url>             a positional GitHub PR URL \u2014 sugar for \`--pr <url>\`, so you
                       can \`ensemble-ai review https://github.com/o/r/pull/7\` from ANY dir
  --pr <N|url>         the diff of a GitHub PR. A bare integer N \u2192 \`gh pr diff <N>\`
                       in the cwd's repo; a full URL (github.com/<owner>/<repo>/pull/<N>)
                       \u2192 \`gh pr diff <N> -R <owner>/<repo>\`, reviewable from ANY
                       directory with NO branch checkout
  --staged             staged changes (\`git diff --cached\`)
  --working-tree       uncommitted tracked changes vs HEAD (\`git diff HEAD\`)
  --diff-file <path>   a raw unified diff read from a file
  (stdin)              a piped diff, e.g. \`git diff main...HEAD | ensemble-ai review\`

Options:
  --base <ref>          base ref for the default (commit) mode
  --reviewers <ids>     comma-separated reviewer ids to subset the roster (default: all
                        configured \u2014 codex, grok)
  --conventions <paths> extra convention files to gather (comma-separated, in-repo)
  --no-conventions      do NOT gather the repo's conventions into the packet
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

Usage:
  ensemble-ai security [<pr-url>] [options]

Diff source (give at most ONE; default = current branch):
  (default)            <base>...HEAD \u2014 the current branch vs its merge-base with
                       the default branch (origin/main; resolved like \`gh pr create\`)
  <pr-url>             a positional GitHub PR URL \u2014 sugar for \`--pr <url>\`
  --pr <N|url>         the diff of a GitHub PR. A bare integer N \u2192 \`gh pr diff <N>\`
                       in the cwd's repo; a full URL (github.com/<owner>/<repo>/pull/<N>)
                       \u2192 \`gh pr diff <N> -R <owner>/<repo>\`, reviewable from ANY dir
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
    const s = fs11.readFileSync(0, "utf8");
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
function gitToplevel(cwd) {
  try {
    const top = execFileSync3("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
    return top || null;
  } catch {
    return null;
  }
}
function ghConventionReader(repoSlug, ref, cwd) {
  return {
    async read(rel) {
      const cap3 = capture(
        "gh",
        ["api", `repos/${repoSlug}/contents/${rel}?ref=${ref}`, "--jq", ".content"],
        cwd
      );
      if (!cap3.ok || !cap3.text.trim()) return null;
      try {
        return Buffer.from(cap3.text.replace(/\s/g, ""), "base64").toString("utf8");
      } catch {
        return null;
      }
    },
    async list(dirRel) {
      const cap3 = capture(
        "gh",
        ["api", `repos/${repoSlug}/contents/${dirRel}?ref=${ref}`, "--jq", ".[].path"],
        cwd
      );
      if (!cap3.ok) return [];
      return cap3.text.split("\n").map((s) => s.trim()).filter((s) => s.endsWith(".md"));
    }
  };
}
function buildConventionReader(cwd, ctx) {
  if (ctx) return ghConventionReader(ctx.repoSlug, ctx.ref, cwd);
  const root = gitToplevel(cwd);
  return root ? fsConventionReader(root) : null;
}
function resolveSource(selection, cwd, stdinContent, cmd = "review") {
  switch (selection.kind) {
    case "pr": {
      const prResult = (cap4, label2, headShaOverride) => {
        if (!cap4.ok) {
          console.error(`ensemble-ai ${cmd}: \`${label2}\` failed: ${cap4.error}`);
          return { code: 3 };
        }
        if (!cap4.text.trim()) {
          console.error(`ensemble-ai ${cmd}: PR #${selection.pr} has an empty diff`);
          return { code: 3 };
        }
        return { diffMode: "pr", diffText: cap4.text, headShaOverride };
      };
      if (selection.owner && selection.repo) {
        const repoSlug = `${selection.owner}/${selection.repo}`;
        const meta = capture(
          "gh",
          [
            "api",
            `repos/${repoSlug}/pulls/${selection.pr}`,
            "--jq",
            "{base: .base.sha, head: .head.sha}"
          ],
          cwd
        );
        let baseSha;
        let headSha;
        if (meta.ok) {
          try {
            const o = JSON.parse(meta.text);
            if (typeof o.base === "string" && o.base.trim()) baseSha = o.base.trim();
            if (typeof o.head === "string" && o.head.trim()) headSha = o.head.trim();
          } catch {
          }
        }
        if (baseSha && headSha) {
          const label3 = `gh api repos/${repoSlug}/compare/${baseSha.slice(0, 7)}...${headSha.slice(0, 7)}`;
          const cmp = capture(
            "gh",
            [
              "api",
              `repos/${repoSlug}/compare/${baseSha}...${headSha}`,
              "-H",
              "Accept: application/vnd.github.diff"
            ],
            cwd
          );
          const r2 = prResult(cmp, label3, headSha);
          return "code" in r2 ? r2 : { ...r2, conventionsCtx: { ref: headSha, repoSlug } };
        }
        const label2 = `gh pr diff ${selection.pr} -R ${repoSlug}`;
        const cap4 = capture(
          "gh",
          ["pr", "diff", String(selection.pr), "-R", repoSlug],
          cwd
        );
        const r = prResult(cap4, label2);
        return "code" in r ? r : { ...r, noLocalConventions: true };
      }
      const label = `gh pr diff ${selection.pr}`;
      const cap3 = capture("gh", ["pr", "diff", String(selection.pr)], cwd);
      return prResult(cap3, label);
    }
    case "diff-file": {
      let text;
      try {
        text = fs11.readFileSync(String(selection.diffFile), "utf8");
      } catch (e) {
        console.error(
          `ensemble-ai ${cmd}: cannot read --diff-file: ${e.message}`
        );
        return { code: 3 };
      }
      if (!text.trim()) {
        console.error(
          `ensemble-ai ${cmd}: --diff-file ${selection.diffFile} is empty`
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
  out.push(`  files:   ${coverageCounts(a.coverage)}`);
  for (const f of a.coverage.files.filter((x) => !x.included)) {
    out.push(`             ${omittedLine({ kind: f.kind, path: f.path, reason: f.omitReason })}`);
  }
  if (result.conventionManifest && result.conventionManifest.files.length > 0) {
    out.push(...renderConventionManifest(result.conventionManifest));
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
function resolvePositionalPr(positionals, prFlag, cmd) {
  if (positionals.length === 0) return { pr: prFlag };
  if (positionals.length > 1) {
    return {
      error: `too many arguments (expected at most one GitHub PR URL): ${positionals.join(" ")}`
    };
  }
  const arg = positionals[0].trim();
  if (!/^https?:\/\//i.test(arg)) {
    return {
      error: `unexpected argument "${arg}" \u2014 a positional accepts only a GitHub PR URL (https://github.com/<owner>/<repo>/pull/<N>); use \`${cmd} --pr <N>\` for a PR number`
    };
  }
  if (prFlag !== void 0) {
    return { error: "choose at most ONE diff source \u2014 got a positional URL AND --pr" };
  }
  return { pr: arg };
}
function resolveDiffSourceForCommand(values, positionals, cmd, cwd) {
  const positionalPr = resolvePositionalPr(
    positionals,
    typeof values.pr === "string" ? values.pr : void 0,
    cmd
  );
  if ("error" in positionalPr) {
    console.error(`ensemble-ai ${cmd}: ${positionalPr.error}`);
    return { code: 3 };
  }
  const sourceFlags = {
    diffFile: typeof values["diff-file"] === "string" ? values["diff-file"] : void 0,
    pr: positionalPr.pr,
    staged: Boolean(values.staged),
    workingTree: Boolean(values["working-tree"])
  };
  const stdinContent = hasExplicitSource(sourceFlags) ? void 0 : readStdinIfPiped();
  const selection = selectDiffSource({ ...sourceFlags, stdinPiped: stdinContent !== void 0 });
  if (isDiffSourceError(selection)) {
    console.error(`ensemble-ai ${cmd}: ${selection.error}`);
    return { code: 3 };
  }
  return resolveSource(selection, cwd, stdinContent, cmd);
}
async function reviewCommand(args, profile = "code") {
  const usage = profile === "security" ? SECURITY_USAGE : REVIEW_USAGE;
  const cmd = profile === "security" ? "security" : "review";
  let values;
  let positionals;
  try {
    ({ positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        "allow-sensitive": { type: "boolean" },
        base: { type: "string" },
        ceiling: { type: "string" },
        conventions: { type: "string" },
        cwd: { type: "string" },
        "diff-file": { type: "string" },
        help: { short: "h", type: "boolean" },
        "no-conventions": { type: "boolean" },
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
  const cwd = values.cwd ? path9.resolve(String(values.cwd)) : process.cwd();
  const source = resolveDiffSourceForCommand(values, positionals, cmd, cwd);
  if ("code" in source) return source.code;
  const noConventions = Boolean(values["no-conventions"]);
  const conventionPaths = parseConventionPaths(values.conventions);
  if (source.noLocalConventions && !noConventions) {
    console.error(
      "\xB7 conventions: skipped \u2014 a URL PR's head SHA was unresolvable, so its conventions can't be fetched and the local repo's belong to a DIFFERENT repo"
    );
  }
  const conventionReader = noConventions || source.noLocalConventions ? null : buildConventionReader(cwd, source.conventionsCtx);
  let reviewers;
  if (typeof values.reviewers === "string") {
    const parsed = parseReviewerList(values.reviewers, cmd);
    if ("code" in parsed) return parsed.code;
    reviewers = parsed;
  }
  const runId = typeof values["run-id"] === "string" ? values["run-id"] : genRunId();
  let out = typeof values.out === "string" ? path9.resolve(values.out) : path9.join(os8.tmpdir(), "ensemble-ai", runId);
  const boundary = enforceTrailBoundary(cwd, out, runId);
  if (boundary.overridden) {
    console.error(
      `\xB7 trail: a _work repo's trail is fenced OUT of the personal brain \u2192 ${boundary.out}`
    );
    out = boundary.out;
  }
  const ceiling = positiveCeiling(
    typeof values.ceiling === "string" ? values.ceiling : void 0,
    cmd
  );
  if (typeof ceiling === "object") return ceiling.code;
  const ceilingBytes = ceiling;
  let result;
  try {
    result = await runReviewMode({
      allowSensitive: Boolean(values["allow-sensitive"]),
      base: typeof values.base === "string" ? values.base : void 0,
      ceilingBytes,
      conventionPaths,
      conventionReader,
      cwd,
      diffMode: source.diffMode,
      diffText: source.diffText,
      headShaOverride: source.headShaOverride,
      noConventions,
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
  if (result.blocked) {
    printSummary(result, profile);
    return 2;
  }
  if (result.conventionManifest) {
    try {
      fs11.mkdirSync(out, { recursive: true });
      fs11.writeFileSync(
        path9.join(out, "conventions.json"),
        JSON.stringify(result.conventionManifest, null, 2)
      );
    } catch {
    }
  }
  if (result.prompt) {
    try {
      fs11.mkdirSync(out, { recursive: true });
      fs11.writeFileSync(path9.join(out, "packet.md"), result.prompt);
    } catch {
    }
  }
  printSummary(result, profile);
  console.error(`trail: ${out}`);
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
var MAX_BRAINSTORM_FILE_BYTES = 10 * 1024 * 1024;
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
  const cwd = values.cwd ? path9.resolve(String(values.cwd)) : process.cwd();
  let fileContext;
  if (typeof values.file === "string") {
    const filePath = path9.resolve(cwd, values.file);
    try {
      const bytes = fs11.statSync(filePath).size;
      if (bytes > MAX_BRAINSTORM_FILE_BYTES) {
        console.error(
          `ensemble-ai brainstorm: --file ${values.file} is too large (${bytes} bytes > ${MAX_BRAINSTORM_FILE_BYTES}-byte cap)`
        );
        return 3;
      }
      fileContext = fs11.readFileSync(filePath, "utf8");
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
var CONSULT_USAGE = `ensemble-ai consult \u2014 convene multiple AI voices on a QUESTION.

Usage:
  ensemble-ai consult "<question>" [options]
  ensemble-ai ask "<question>" [options]      (alias)

Each voice answers the question INDEPENDENTLY (no anchoring), then one voice
synthesizes: what the voices AGREE on (the confident core) vs where they DIVERGE
(flagged "look closer", with who took which position) + a bottom-line
recommendation. Voices: codex + grok + claude by default. For decisions + research.

Options:
  --file <path>         include a file's contents as shared context for every voice
  --critique            run an extra round where each voice reviews the others'
                        answers before synthesis (default: off \u2014 answer\u2192synthesize)
  --voices <ids>        comma-separated voice ids (default: codex,grok,claude)
  --synthesizer <id>    which voice runs the synthesis (default: claude if present)
  --timeout <seconds>   per-voice timeout (default 300)
  --voices-file <path>  voices config json (default ~/.ensemble-ai/voices.json)
  --json                print the full result as JSON instead of formatted text
  --cwd <dir>           working dir for --file resolution (default: cwd)
  -h, --help            this help

Exit codes: 0 = produced answers (synthesis printed) \xB7 1 = no usable output (every
voice failed) \xB7 3 = usage or an unexpected operational error.`;
function printConsult(r) {
  const out = [];
  out.push("");
  out.push(`ensemble-ai consult \u2014 ${clean(r.question).slice(0, 200)}`);
  out.push(`  voices: ${r.roster.join(", ")}`);
  out.push("");
  out.push("Independent answers");
  for (const a of r.answers) {
    out.push("");
    out.push(`  \u2500\u2500 ${a.voiceId} \u2500\u2500`);
    if (!a.ok) {
      out.push(`     (no answer \u2014 ${clean(a.error ?? "failed").slice(0, 160)})`);
      continue;
    }
    if (a.summary) out.push(`     ${clean(a.summary).slice(0, 240)}`);
    if (a.answer) out.push(`     ${clean(a.answer).slice(0, 400)}`);
    for (const kp of a.keyPoints) out.push(`       \xB7 ${clean(kp).slice(0, 200)}`);
  }
  if (r.critique.length > 0) {
    out.push("");
    out.push("Cross-critique");
    for (const c of r.critique) {
      out.push("");
      out.push(`  \u2500\u2500 ${c.voiceId} \u2500\u2500`);
      if (!c.ok) {
        out.push(`     (no notes \u2014 ${clean(c.error ?? "failed").slice(0, 160)})`);
        continue;
      }
      for (const n of c.notes) {
        out.push(`     [${n.stance}] ${clean(n.target)} \u2014 ${clean(n.assessment).slice(0, 260)}`);
      }
    }
  }
  out.push("");
  const s = r.synthesis;
  out.push(
    `Synthesis${s.by ? ` (by ${s.by})` : ""}${s.degraded ? " \u2014 DEGRADED (deterministic fallback, NOT compared for agreement)" : ""}`
  );
  if (s.summary) out.push(`  ${clean(s.summary).slice(0, 400)}`);
  if (s.agreements.length > 0) {
    out.push("");
    out.push("  \u2713 AGREE (confident)");
    for (const a of s.agreements) {
      out.push(`     \u2022 ${clean(a.point).slice(0, 300)}${a.voices.length ? `  [${a.voices.map(clean).join(", ")}]` : ""}`);
    }
  }
  if (s.divergences.length > 0) {
    out.push("");
    out.push("  \u26A0 DIVERGE (look closer)");
    for (const d of s.divergences) {
      out.push(`     \u2022 ${clean(d.point).slice(0, 300)}`);
      for (const p of d.positions) out.push(`         \u2212 ${clean(p).slice(0, 240)}`);
    }
  }
  if (s.recommendation) {
    out.push("");
    out.push("  \u2192 Recommendation");
    out.push(`     ${clean(s.recommendation).slice(0, 500)}`);
  }
  out.push("");
  console.log(out.join("\n"));
}
async function consultCommand(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        critique: { type: "boolean" },
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
    console.error(`ensemble-ai consult: ${e.message}`);
    console.error(CONSULT_USAGE);
    return 3;
  }
  const { positionals, values } = parsed;
  if (values.help) {
    console.log(CONSULT_USAGE);
    return 0;
  }
  const question = positionals.join(" ").trim();
  if (!question) {
    console.error(
      'ensemble-ai consult: a question is required, e.g. ensemble-ai consult "should I use Postgres or SQLite for X?"'
    );
    console.error(CONSULT_USAGE);
    return 3;
  }
  const cwd = values.cwd ? path9.resolve(String(values.cwd)) : process.cwd();
  let fileContext;
  if (typeof values.file === "string") {
    const filePath = path9.resolve(cwd, values.file);
    try {
      const bytes = fs11.statSync(filePath).size;
      if (bytes > MAX_BRAINSTORM_FILE_BYTES) {
        console.error(
          `ensemble-ai consult: --file ${values.file} is too large (${bytes} bytes > ${MAX_BRAINSTORM_FILE_BYTES}-byte cap)`
        );
        return 3;
      }
      fileContext = fs11.readFileSync(filePath, "utf8");
    } catch (e) {
      console.error(
        `ensemble-ai consult: cannot read --file ${values.file}: ${e.message}`
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
        `ensemble-ai consult: --voices "${values.voices}" ${unknown.length ? `has unknown id(s): ${unknown.join(", ")}` : "is empty"} (known: ${VOICE_IDS.join(", ")})`
      );
      return 3;
    }
    voices = parseVoiceIds(requested);
  }
  let synthesizer;
  if (typeof values.synthesizer === "string") {
    if (!isVoiceId(values.synthesizer)) {
      console.error(
        `ensemble-ai consult: --synthesizer "${values.synthesizer}" is not a known voice (known: ${VOICE_IDS.join(", ")})`
      );
      return 3;
    }
    synthesizer = values.synthesizer;
  }
  const roster = voices ?? VOICE_IDS;
  if (synthesizer && !roster.includes(synthesizer)) {
    console.error(
      `ensemble-ai consult: --synthesizer "${synthesizer}" is not in the voices roster (${roster.join(", ")})`
    );
    return 3;
  }
  let timeoutMs;
  if (typeof values.timeout === "string") {
    const secs = Number(values.timeout);
    if (!Number.isFinite(secs) || secs <= 0) {
      console.error("ensemble-ai consult: --timeout must be a positive number of seconds");
      return 3;
    }
    timeoutMs = Math.round(secs * 1e3);
    if (timeoutMs < 1) {
      console.error("ensemble-ai consult: --timeout is too small (rounds to 0ms)");
      return 3;
    }
  }
  let result;
  try {
    result = await runConsultMode({
      critique: Boolean(values.critique),
      fileContext,
      onProgress: (m) => console.error(`\xB7 ${m}`),
      question,
      synthesizer,
      timeoutMs,
      voices,
      voicesFile: typeof values["voices-file"] === "string" ? values["voices-file"] : void 0
    });
  } catch (e) {
    console.error(`ensemble-ai consult: ${e.message}`);
    return 3;
  }
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else printConsult(result);
  const anyAnswers = result.answers.some((a) => a.ok);
  return anyAnswers ? 0 : 1;
}
function parseReviewerList(raw, cmd) {
  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = requested.filter((id) => !isReviewerId(id));
  if (unknown.length > 0 || requested.length === 0) {
    console.error(
      `ensemble-ai ${cmd}: --reviewers "${raw}" ${unknown.length ? `has unknown id(s): ${unknown.join(", ")}` : "is empty"} (known: ${REVIEWER_IDS.join(", ")})`
    );
    return { code: 3 };
  }
  return parseReviewerIds(requested);
}
function parseRequiredReviewers(raw, cmd) {
  return raw === void 0 ? [...REVIEWER_IDS] : parseReviewerList(raw, cmd);
}
function parseConventionPaths(raw) {
  if (typeof raw !== "string") return void 0;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? list : void 0;
}
function positiveCeiling(raw, cmd) {
  if (raw === void 0) return void 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`ensemble-ai ${cmd}: --ceiling must be a positive number`);
    return { code: 3 };
  }
  return n;
}
var RECEIPT_USAGE = `ensemble-ai receipt \u2014 the content-tied diff-receipt gate primitive.

Usage:
  ensemble-ai receipt verify [<path>] [options]   check the CURRENT diff is reviewed
  ensemble-ai receipt show   [<path>] [options]   pretty-print a receipt

verify recomputes the current diff's identity (repo \xB7 base/head \xB7 content digest)
and checks it against the stored (or --path) receipt: exit 0 = reviewed & current;
NON-ZERO (3) = missing / stale (commits since review) / under-policy / under-coverage,
with the reason printed. This is what a pre-PR \`gh pr create\` hook calls.
show prints a receipt's fields (given a <path>, else looked up for the current diff).

TRUST: by default a pass is TRUSTED BY ATTESTATION (the receipt's completed[]), NOT
proven by reviewer artifacts \u2014 a hand-written receipt with a matching diff digest
would also pass, so verify prints a loud warning. A pre-PR gate MUST use --strict
(--require-artifacts) with --trail <dir>, which requires the real per-reviewer
artifacts and FAILS CLOSED (non-zero) on an attestation-only receipt. (Cryptographic
receipt signing \u2014 proof against a fabricated receipt+artifacts \u2014 is a documented v2.)

Options:
  --base <ref>          base ref for the current-branch diff (default: origin/HEAD)
  --staged              use the staged diff (\`git diff --cached\`) as the current state
  --working-tree        use uncommitted tracked changes (\`git diff HEAD\`)
  --reviewers <ids>     required reviewer policy (default: all configured)
  --ceiling <bytes>     coverage byte ceiling (default 200000)
  --store <dir>         receipt store dir (default: ~/.ensemble-ai/receipts)
  --trail <dir>         a run trail dir to PROVE the immutable reviewer artifacts
                        (default: trust the receipt's completed[] \u2014 see receipt.ts)
  --strict, --require-artifacts
                        REQUIRE the real trail artifacts (use with --trail): an
                        attestation-only receipt FAILS CLOSED. The pre-PR hook's mode.
  --cwd <dir>           repo working dir (default: cwd)
  -h, --help            this help`;
async function receiptCommand(args) {
  const sub = args[0];
  if (!sub || sub === "-h" || sub === "--help") {
    console.log(RECEIPT_USAGE);
    return sub ? 0 : 3;
  }
  if (sub !== "verify" && sub !== "show") {
    console.error(
      `ensemble-ai receipt: unknown subcommand "${sub}" (expected: verify | show)`
    );
    console.error(RECEIPT_USAGE);
    return 3;
  }
  let values;
  let positionals;
  try {
    ({ positionals, values } = parseArgs({
      args: args.slice(1),
      allowPositionals: true,
      options: {
        base: { type: "string" },
        ceiling: { type: "string" },
        cwd: { type: "string" },
        help: { short: "h", type: "boolean" },
        "require-artifacts": { type: "boolean" },
        reviewers: { type: "string" },
        staged: { type: "boolean" },
        store: { type: "string" },
        strict: { type: "boolean" },
        trail: { type: "string" },
        "working-tree": { type: "boolean" }
      }
    }));
  } catch (e) {
    console.error(`ensemble-ai receipt: ${e.message}`);
    console.error(RECEIPT_USAGE);
    return 3;
  }
  if (values.help) {
    console.log(RECEIPT_USAGE);
    return 0;
  }
  const receiptPathArg = typeof positionals[0] === "string" ? path9.resolve(positionals[0]) : void 0;
  const readReceiptFile = (p) => {
    let raw;
    try {
      raw = fs11.readFileSync(p, "utf8");
    } catch (e) {
      return { error: `cannot read receipt ${p}: ${e.message}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return { error: `receipt ${p} is not valid JSON: ${e.message}` };
    }
    try {
      return { receipt: validateReceiptShape(parsed) };
    } catch (e) {
      return { error: `receipt ${p}: ${e.message}` };
    }
  };
  if (sub === "show" && receiptPathArg) {
    const res = readReceiptFile(receiptPathArg);
    if ("error" in res) {
      console.error(`ensemble-ai receipt show: ${res.error}`);
      return 3;
    }
    console.log(formatReceipt(res.receipt));
    return 0;
  }
  const required = parseRequiredReviewers(
    typeof values.reviewers === "string" ? values.reviewers : void 0,
    "receipt"
  );
  if ("code" in required) return required.code;
  const ceiling = positiveCeiling(
    typeof values.ceiling === "string" ? values.ceiling : void 0,
    "receipt"
  );
  if (typeof ceiling === "object") return ceiling.code;
  const ceilingBytes = ceiling ?? DEFAULT_COVERAGE_CEILING;
  const cwd = values.cwd ? path9.resolve(String(values.cwd)) : process.cwd();
  if (Boolean(values.staged) && Boolean(values["working-tree"])) {
    console.error(
      `ensemble-ai receipt ${sub}: choose at most one of --staged / --working-tree`
    );
    return 3;
  }
  let acquired;
  try {
    acquired = acquireDiff({
      base: typeof values.base === "string" ? values.base : void 0,
      ceilingBytes,
      cwd,
      staged: Boolean(values.staged),
      workingTree: Boolean(values["working-tree"])
    });
  } catch (e) {
    console.error(`ensemble-ai receipt ${sub}: ${e.message}`);
    return 3;
  }
  const key = {
    baseSha: acquired.baseSha,
    diffDigest: acquired.canonicalDigest,
    headSha: acquired.headSha,
    policyHash: computePolicyHash({
      coveragePolicy: { ceilingBytes },
      diffMode: acquired.mode,
      reviewerPolicy: required
    }),
    repo: acquired.repoId
  };
  const store = values.store ? path9.resolve(String(values.store)) : defaultReceiptStore();
  if (sub === "show") {
    const receipt = readReceipt(store, key);
    if (!receipt) {
      console.error(
        `ensemble-ai receipt show: no receipt for the current diff (repo ${key.repo ?? "(none)"}, head ${key.headSha}) in ${store}`
      );
      return 3;
    }
    console.log(formatReceipt(receipt));
    return 0;
  }
  let explicit = null;
  if (receiptPathArg) {
    const res = readReceiptFile(receiptPathArg);
    if ("error" in res) {
      console.error(`ensemble-ai receipt verify: ${res.error}`);
      return 3;
    }
    explicit = res.receipt;
  }
  const verifyDeps = {
    // An explicit --path receipt must still match the FULL live identity — repo + both
    // SHAs + policyHash — exactly as the store lookup binds it (the store file is
    // addressed by the full-key hash). Without this, `verify <path>` degrades to a
    // digest-only check, a strictly weaker gate than `verify` (store). The digest stays
    // with isDiffReviewed so a digest-only drift still reports `stale`.
    readReceipt: receiptPathArg ? (k) => explicit && receiptIdentityMatches(explicit, k) ? explicit : null : (k) => readReceipt(store, k),
    strict: Boolean(values.strict || values["require-artifacts"]),
    trailDir: typeof values.trail === "string" ? path9.resolve(values.trail) : void 0
  };
  const state = verifyReceipt({ coverage: acquired.coverage, key, required }, verifyDeps);
  console.log(formatVerify(state, key));
  if (state.reviewed && isAttestedOnly(verifyDeps)) {
    console.error(
      "WARNING: this PASS is TRUSTED BY ATTESTATION (the receipt's completed[]), NOT proven by reviewer artifacts \u2014 a hand-written receipt with a matching diff digest would also pass. For an artifact-proven gate (e.g. a pre-PR hook) run with --strict (--require-artifacts) and --trail <run-trail-dir>."
    );
  }
  return verifyExitCode(state);
}
var REVIEWERS_USAGE = `ensemble-ai reviewers \u2014 list the configured cross-vendor registry (read-only).

Usage:
  ensemble-ai reviewers [options]
  ensemble-ai config    [options]      (alias)

Prints the review/security reviewers (from reviewers.json) and the brainstorm/
consult voices (from voices.json) \u2014 id \xB7 vendor \xB7 model \xB7 effort \xB7 sandbox \u2014 plus
which config file each came from (or "baked defaults"). No mutation.

Options:
  --reviewers-file <path>   reviewers config (default ~/.ensemble-ai/reviewers.json)
  --voices-file <path>      voices config (default ~/.ensemble-ai/voices.json)
  --json                    print the resolved registry as JSON
  -h, --help                this help`;
async function reviewersCommand(args) {
  let values;
  try {
    ({ values } = parseArgs({
      args,
      allowPositionals: false,
      options: {
        help: { short: "h", type: "boolean" },
        json: { type: "boolean" },
        "reviewers-file": { type: "string" },
        "voices-file": { type: "string" }
      }
    }));
  } catch (e) {
    console.error(`ensemble-ai reviewers: ${e.message}`);
    console.error(REVIEWERS_USAGE);
    return 3;
  }
  if (values.help) {
    console.log(REVIEWERS_USAGE);
    return 0;
  }
  const reviewersFile = typeof values["reviewers-file"] === "string" ? path9.resolve(values["reviewers-file"]) : REVIEWERS_FILE;
  const voicesFile = typeof values["voices-file"] === "string" ? path9.resolve(values["voices-file"]) : VOICES_FILE;
  const view = {
    reviewers: listReviewers(reviewersFile),
    reviewersFile,
    reviewersFileExists: fs11.existsSync(reviewersFile),
    voices: listVoices(voicesFile),
    voicesFile,
    voicesFileExists: fs11.existsSync(voicesFile)
  };
  if (values.json) console.log(JSON.stringify(view, null, 2));
  else console.log(renderRegistry(view));
  return 0;
}
var DIFF_USAGE = `ensemble-ai diff \u2014 show the assembled review packet WITHOUT running a reviewer.

Usage:
  ensemble-ai diff [<pr-url>] [options]

A cost-preview / debug of the EXACT packet the reviewers would receive: the diff
identity + coverage, the per-section manifest (what the reviewer sees), and the
prompt size \u2014 no vendor is called, nothing is spent.

Diff source (give at most ONE; default = current branch, like \`ensemble-ai review\`):
  (default)            <base>...HEAD \u2014 the current branch vs origin/HEAD
  <pr-url>             a positional GitHub PR URL \u2014 sugar for \`--pr <url>\`
  --pr <N|url>         the diff of a GitHub PR: a bare integer N (\`gh pr diff <N>\` in
                       the cwd) OR a full URL \u2192 \`gh pr diff <N> -R <owner>/<repo>\`
  --staged             staged changes (\`git diff --cached\`)
  --working-tree       uncommitted tracked changes vs HEAD
  --diff-file <path>   a raw unified diff from a file
  (stdin)              a piped diff

Options:
  --base <ref>          base ref for the default (commit) mode
  --profile <p>         packet profile: code (default) | security
  --reviewers <ids>     reviewers to size the cost preview against (default: all)
  --conventions <paths> extra convention files to gather (comma-separated, in-repo)
  --no-conventions      do NOT gather the repo's conventions into the packet
  --ceiling <bytes>     coverage byte ceiling (default 200000)
  --full                print the ENTIRE rendered prompt (the literal payload)
  --json                print { packet, prompt } as JSON
  --cwd <dir>           repo working dir (default: cwd)
  -h, --help            this help`;
async function diffCommand(args) {
  let values;
  let positionals;
  try {
    ({ positionals, values } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        base: { type: "string" },
        ceiling: { type: "string" },
        conventions: { type: "string" },
        cwd: { type: "string" },
        "diff-file": { type: "string" },
        full: { type: "boolean" },
        help: { short: "h", type: "boolean" },
        json: { type: "boolean" },
        "no-conventions": { type: "boolean" },
        pr: { type: "string" },
        profile: { type: "string" },
        reviewers: { type: "string" },
        staged: { type: "boolean" },
        "working-tree": { type: "boolean" }
      }
    }));
  } catch (e) {
    console.error(`ensemble-ai diff: ${e.message}`);
    console.error(DIFF_USAGE);
    return 3;
  }
  if (values.help) {
    console.log(DIFF_USAGE);
    return 0;
  }
  let profile = "code";
  if (typeof values.profile === "string") {
    if (values.profile !== "code" && values.profile !== "security") {
      console.error(
        `ensemble-ai diff: --profile must be "code" or "security" (got "${values.profile}")`
      );
      return 3;
    }
    profile = values.profile;
  }
  const reviewers = parseRequiredReviewers(
    typeof values.reviewers === "string" ? values.reviewers : void 0,
    "diff"
  );
  if ("code" in reviewers) return reviewers.code;
  const ceiling = positiveCeiling(
    typeof values.ceiling === "string" ? values.ceiling : void 0,
    "diff"
  );
  if (typeof ceiling === "object") return ceiling.code;
  const cwd = values.cwd ? path9.resolve(String(values.cwd)) : process.cwd();
  const source = resolveDiffSourceForCommand(values, positionals, "diff", cwd);
  if ("code" in source) return source.code;
  let acquired;
  try {
    acquired = acquireDiff({
      base: typeof values.base === "string" ? values.base : void 0,
      ceilingBytes: ceiling,
      cwd,
      diffMode: source.diffMode,
      diffText: source.diffText,
      headShaOverride: source.headShaOverride,
      staged: source.staged,
      workingTree: source.workingTree
    });
  } catch (e) {
    console.error(`ensemble-ai diff: ${e.message}`);
    return 3;
  }
  let agentsMd;
  let conventions;
  if (!values["no-conventions"] && !source.noLocalConventions) {
    const reader = buildConventionReader(cwd, source.conventionsCtx);
    if (reader) {
      const changed = acquired.files.map((f) => f.path).filter((p) => p && p !== "unknown");
      const gathered = await gatherConventions(reader, changed, {
        conventions: parseConventionPaths(values.conventions)
      });
      if (gathered.text.trim()) agentsMd = gathered.text;
      conventions = gathered.manifest;
    }
  }
  const preview = buildPacketPreview(acquired, profile, agentsMd);
  if (values.json) {
    console.log(
      JSON.stringify(
        { conventions, packet: preview.packet, prompt: preview.prompt },
        null,
        2
      )
    );
  } else {
    console.log(
      renderPacketPreview(acquired, preview, {
        conventions,
        full: Boolean(values.full),
        profile,
        reviewers
      })
    );
  }
  return 0;
}
async function main(argv) {
  const raw = argv[0];
  if (!raw || raw === "-h" || raw === "--help") {
    console.log(USAGE);
    return raw ? 0 : 1;
  }
  if (raw === "receipt") return receiptCommand(argv.slice(1));
  if (raw === "reviewers" || raw === "config") return reviewersCommand(argv.slice(1));
  if (raw === "diff") return diffCommand(argv.slice(1));
  const mode = resolveMode(raw);
  if (mode === "review") return reviewCommand(argv.slice(1), "code");
  if (mode === "security") return reviewCommand(argv.slice(1), "security");
  if (mode === "brainstorm") return brainstormCommand(argv.slice(1));
  if (mode === "consult") return consultCommand(argv.slice(1));
  if (isMode(mode) && !isImplemented(mode)) {
    console.error(`ensemble-ai: mode "${mode}" is planned but not implemented yet.`);
    return 3;
  }
  console.error(`ensemble-ai: unknown mode "${mode}".
`);
  console.error(USAGE);
  return 3;
}
if (isEntrypoint(import.meta.url)) {
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
