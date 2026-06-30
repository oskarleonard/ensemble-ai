// src/core/types.ts
var REVIEWER_IDS = ["codex", "grok"];
function isReviewerId(v) {
  return REVIEWER_IDS.includes(v);
}
function titleCase(id) {
  return id ? id[0].toUpperCase() + id.slice(1) : id;
}
function parseReviewerIds(raw) {
  if (!Array.isArray(raw)) return void 0;
  const ids = [...new Set(raw.filter(isReviewerId))];
  return ids.length > 0 ? ids : void 0;
}
var SEVERITIES = ["high", "medium", "low"];
var CONFIDENCES = ["high", "medium", "low"];
var TERMINAL_STATES = ["reviewed", "failed-reviewer"];

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

// src/core/prompt.ts
function renderReviewPrompt(packet) {
  const subject = packet.pr > 0 ? `Repository: ${packet.repo} \xB7 Pull request #${packet.pr}` : packet.subject ? `Under review: ${packet.subject}` : `Repository: ${packet.repo || "(a working tree)"} \xB7 reviewing the diff below`;
  const head = [
    "You are an adversarial code reviewer from a DIFFERENT vendor than the author.",
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
    "## Your task",
    "Find correctness bugs, security issues, broken conventions, and risky",
    "choices IN THE DIFF. Be concrete and cite file + line. Do not nitpick style",
    "the conventions already allow. Prefer a few high-signal findings over many",
    "weak ones \u2014 false positives waste the arbiter\u2019s time.",
    "",
    FINDINGS_INSTRUCTIONS
  ].join("\n");
  return `${head}

${body}

${ask}
`;
}

// src/core/reviewers.ts
import fs from "fs";
import os from "os";
import path from "path";
var REVIEWERS_FILE = process.env.ENSEMBLE_REVIEWERS_FILE || path.join(os.homedir(), ".ensemble-ai", "reviewers.json");
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
    return parseReviewers(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return { ...REVIEWER_DEFAULTS };
  }
}
function resolveReviewer(id, file = REVIEWERS_FILE) {
  return loadReviewers(file)[id] ?? REVIEWER_DEFAULTS[id];
}
function listReviewers(file = REVIEWERS_FILE) {
  const all = loadReviewers(file);
  return REVIEWER_IDS.map((id) => all[id]);
}

// src/core/artifacts.ts
import fs2 from "fs";
import path2 from "path";
function sanitizePathSegment(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function reviewDir(baseDir, runId) {
  return path2.join(baseDir, sanitizePathSegment(runId) || "unknown");
}
function writeAtomic(dir, name, content) {
  fs2.mkdirSync(dir, { recursive: true });
  const target = path2.join(dir, name);
  const tmp = `${target}.tmp`;
  fs2.writeFileSync(tmp, content);
  fs2.renameSync(tmp, target);
}
function readJson(file) {
  try {
    return JSON.parse(fs2.readFileSync(file, "utf8"));
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
  const perId = readJson(path2.join(dir, reviewJson(reviewerId)));
  if (perId) return perId.reviewerId ? perId : { ...perId, reviewerId };
  if (reviewerId === "codex") {
    const legacy = readJson(path2.join(dir, "review.json"));
    if (legacy) return { ...legacy, reviewerId: "codex" };
  }
  return null;
}
function readReviewsForRun(baseDir, runId) {
  const out = [];
  for (const id of REVIEWER_IDS) {
    const r = readReview(baseDir, runId, id);
    if (r) out.push(r);
  }
  return out;
}

// src/core/spawn.ts
import { spawn } from "child_process";
import fs4 from "fs";
import os2 from "os";

// src/core/bin.ts
import { execFileSync } from "child_process";
import fs3 from "fs";
var binCache = /* @__PURE__ */ new Map();
function resolveBin(name, opts = {}) {
  const cached = binCache.get(name);
  if (cached) return cached;
  const candidates = [
    opts.envVar ? process.env[opts.envVar] : void 0,
    ...opts.candidates ?? []
  ].filter((c) => Boolean(c));
  for (const c of candidates) {
    if (fs3.existsSync(c)) {
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
  const capture = opts.capture ?? "outfile";
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd: os2.tmpdir(),
      detached: true,
      // stdout is piped ONLY when we read the reply from it (grok); codex keeps
      // it 'ignore' (its reply is the -o file) exactly as the proven path did.
      stdio: ["ignore", capture === "stdout" ? "pipe" : "ignore", "pipe"]
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
    if (capture === "stdout") {
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
      if (capture === "stdout") {
        const text = stdoutBuf.trim();
        if (text) raw = text;
      } else {
        try {
          const text = fs4.readFileSync(outFile ?? "", "utf8").trim();
          if (text) raw = text;
          fs4.unlinkSync(outFile ?? "");
        } catch {
        }
      }
      resolve({ raw, stderrTail, timedOut });
    };
    const backstop = setTimeout(settle, timeoutMs + KILL_GRACE_MS + 5e3);
    child.on(
      "exit",
      capture === "stdout" ? () => {
        exitDrain = setTimeout(settle, EXIT_DRAIN_GRACE_MS);
      } : settle
    );
    child.on("close", settle);
    child.on("error", settle);
  });
}

// src/core/hash.ts
import crypto from "crypto";
function sha256Hex(input) {
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

// src/reviewers/codex.ts
import os3 from "os";
import path3 from "path";
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
import fs5 from "fs";
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
    const existing = fs5.existsSync(file) ? fs5.readFileSync(file, "utf8") : "";
    if (existing.includes(REVIEW_PROFILE_BLOCK)) return;
    fs5.mkdirSync(path4.dirname(file), { recursive: true });
    const updated = existing.includes(REVIEW_PROFILE_HEADER) ? replaceReviewSection(existing) : null;
    const content = updated ?? (existing.trim() ? `${existing.trimEnd()}

${REVIEW_PROFILE}` : REVIEW_PROFILE);
    const tmp = `${file}.tmp`;
    fs5.writeFileSync(tmp, content);
    fs5.renameSync(tmp, file);
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
  const cwd = fs5.mkdtempSync(path4.join(os4.tmpdir(), "grok-review-"));
  return runReviewerExec({
    args: buildGrokReviewArgs({ ...config, sandbox }, prompt, cwd),
    bin: resolveGrokBin(),
    capture: "stdout",
    onSpawn: opts.onSpawn,
    stderrLimit: 2e3,
    timeoutMs
  }).then(({ raw, stderrTail, timedOut }) => {
    try {
      fs5.rmSync(cwd, { force: true, recursive: true });
    } catch {
    }
    const text = raw ? extractGrokText(raw) : null;
    return { ok: text !== null, raw: text, stderrTail, timedOut };
  });
}

// src/reviewers/registry.ts
var REVIEW_ADAPTERS = {
  codex: runCodexReview,
  grok: runGrokReview
};

// src/modes/review/diff.ts
import { execFileSync as execFileSync2 } from "child_process";
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
function classifyFileKind(path6, isBinary) {
  if (isBinary) return "binary";
  return GENERATED_PATTERNS.some((re) => re.test(path6)) ? "generated" : "source";
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
    const path6 = pathOfSection(section2);
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
      kind: classifyFileKind(path6, isBinary),
      path: path6,
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
    headSha = mode === "pr" ? "gh pr diff (no local commit identity)" : "working-tree (no commit identity)";
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

// src/modes/review/receipt.ts
import fs6 from "fs";
import os5 from "os";
import path5 from "path";
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
  return process.env.ENSEMBLE_RECEIPTS_DIR || path5.join(os5.homedir(), ".ensemble-ai", "receipts");
}
function receiptPath(storeDir, key) {
  return path5.join(
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
  fs6.mkdirSync(path5.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs6.writeFileSync(tmp, JSON.stringify(receipt, null, 2));
  fs6.renameSync(tmp, file);
  return file;
}
function readReceipt(storeDir, key) {
  try {
    return JSON.parse(
      fs6.readFileSync(receiptPath(storeDir, key), "utf8")
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
      reviews: [],
      secretScan
    };
  }
  const packet = assembleCodePacket({
    agentsMd: opts.agentsMd,
    authorSummary: opts.authorSummary,
    diff: acquired.diff,
    objective: opts.objective ?? DEFAULT_OBJECTIVE,
    pr: 0,
    repo: acquired.repoId ?? ""
  });
  const prompt = renderReviewPrompt(packet);
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
    return { acquired, blocked: false, receipt: built.receipt, receiptPath: file, reviews, secretScan };
  }
  log(`No receipt \u2014 ${built.error}`);
  return { acquired, blocked: false, receiptError: built.error, reviews, secretScan };
}

// src/modes/index.ts
var MODES = ["review", "brainstorm", "security"];
var IMPLEMENTED_MODES = ["review"];
function isMode(v) {
  return MODES.includes(v);
}
function isImplemented(mode) {
  return IMPLEMENTED_MODES.includes(mode);
}
export {
  CONFIDENCES,
  DEFAULT_COVERAGE_CEILING,
  DIFF_USEFUL_FLOOR,
  FINDINGS_INSTRUCTIONS,
  IMPLEMENTED_MODES,
  MODES,
  PACKET_BUDGETS,
  REVIEWERS_FILE,
  REVIEWER_DEFAULTS,
  REVIEWER_IDS,
  REVIEW_ADAPTERS,
  REVIEW_TIMEOUT_MS,
  SEVERITIES,
  TERMINAL_STATES,
  acquireDiff,
  assembleCodePacket,
  buildCodexReviewArgs,
  buildDiffReceipt,
  buildGrokReviewArgs,
  canonicalizeDiff,
  classifyFileKind,
  computeCoverage,
  computePolicyHash,
  coverageShortfall,
  defaultReceiptStore,
  diffDigest,
  ensureSandboxProfile,
  extractGrokText,
  extractJsonBlock,
  isDiffReviewed,
  isImplemented,
  isMode,
  isReviewerId,
  keyOf,
  killTree,
  listReviewers,
  loadReviewers,
  makeEscalatingKill,
  parseDiffFiles,
  parseFindings,
  parseReviewerIds,
  parseReviewers,
  persistReview,
  readReceipt,
  readReview,
  readReviewsForRun,
  receiptKeyHash,
  receiptPath,
  renderReviewPrompt,
  resolveBase,
  resolveBin,
  resolveCodexBin,
  resolveGrokBin,
  resolveRepoId,
  resolveReviewSandbox,
  resolveReviewer,
  reviewDir,
  runCodexReview,
  runGrokReview,
  runReviewMode,
  runReviewerExec,
  sanitizePathSegment,
  scanDiffForSecrets,
  section,
  sha256Hex,
  summarizeCoverage,
  titleCase,
  writeReceipt
};
