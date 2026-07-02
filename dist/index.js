var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

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

// src/modes/review/profile.ts
var REVIEW_PROFILES = ["code", "security"];
function isReviewProfile(v) {
  return REVIEW_PROFILES.includes(v);
}
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
function securityClassLabel(id) {
  return SECURITY_CLASSES.find((c) => c.id === id)?.label ?? id;
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

// src/core/conventions.ts
import fs from "fs";
import path from "path";
var DEFAULT_CAP_BYTES = 8e4;
var CAP_PROBE_MARGIN = 8;
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
    const probe = await reader.read(rel, capBytes + CAP_PROBE_MARGIN);
    if (probe === null) continue;
    const readTruncated = Buffer.byteLength(probe, "utf8") > capBytes;
    const content = readTruncated ? sliceBytes(probe, capBytes) : probe;
    const bytes = Buffer.byteLength(content, "utf8");
    if (visited >= maxFiles) {
      files.push({ path: rel, bytes, included: false, truncated: false, reason: "max-files" });
      break;
    }
    visited++;
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
      files.push(
        readTruncated ? { path: rel, bytes, included: true, truncated: true, reason: "over-cap" } : { path: rel, bytes, included: true, truncated: false }
      );
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
    async read(rel, maxBytes) {
      const abs = within(rel);
      if (!abs) return null;
      try {
        if (!fs.statSync(abs).isFile()) return null;
        if (maxBytes === void 0) return fs.readFileSync(abs, "utf8");
        const fd = fs.openSync(abs, "r");
        try {
          const buf = Buffer.alloc(maxBytes);
          const n = fs.readSync(fd, buf, 0, maxBytes, 0);
          return buf.subarray(0, n).toString("utf8").replace(/�$/, "");
        } finally {
          fs.closeSync(fd);
        }
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
function memoryConventionReader(fileMap) {
  return {
    async read(rel, maxBytes) {
      if (!Object.prototype.hasOwnProperty.call(fileMap, rel)) return null;
      const c = fileMap[rel];
      return maxBytes === void 0 ? c : sliceBytes(c, maxBytes);
    },
    async list(dirRel) {
      const prefix = dirRel === "" ? "" : `${dirRel}/`;
      return Object.keys(fileMap).filter(
        (p) => p.endsWith(".md") && p.startsWith(prefix) && !p.slice(prefix.length).includes("/")
      );
    }
  };
}

// src/core/reviewers.ts
import fs2 from "fs";
import os from "os";
import path2 from "path";
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
    return parseReviewers(JSON.parse(fs2.readFileSync(file, "utf8")));
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
import fs3 from "fs";
import path3 from "path";
function sanitizePathSegment(s) {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}
function reviewDir(baseDir, runId) {
  return path3.join(baseDir, sanitizePathSegment(runId) || "unknown");
}
function writeAtomic(dir, name, content) {
  fs3.mkdirSync(dir, { recursive: true, mode: 448 });
  let realDir = dir;
  try {
    realDir = fs3.realpathSync(dir);
  } catch {
  }
  const target = path3.join(realDir, name);
  const tmp = `${target}.tmp`;
  try {
    fs3.unlinkSync(tmp);
  } catch {
  }
  const flags = fs3.constants.O_WRONLY | fs3.constants.O_CREAT | fs3.constants.O_EXCL | fs3.constants.O_NOFOLLOW;
  const fd = fs3.openSync(tmp, flags, 384);
  try {
    fs3.writeFileSync(fd, content);
    fs3.fchmodSync(fd, 384);
  } finally {
    fs3.closeSync(fd);
  }
  fs3.renameSync(tmp, target);
}
function writeTrailFile(baseDir, runId, name, content) {
  const dir = reviewDir(baseDir, runId);
  writeAtomic(dir, name, content);
  return path3.join(dir, name);
}
function readJson(file) {
  try {
    return JSON.parse(fs3.readFileSync(file, "utf8"));
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
  const perId = readJson(path3.join(dir, reviewJson(reviewerId)));
  if (perId) return perId.reviewerId ? perId : { ...perId, reviewerId };
  if (reviewerId === "codex") {
    const legacy = readJson(path3.join(dir, "review.json"));
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
import path4 from "path";
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
  const outFile = path4.join(
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
import path5 from "path";
var GROK_BIN_CANDIDATES = [path5.join(os4.homedir(), ".grok", "bin", "grok")];
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
function ensureSandboxProfile(profile, file = path5.join(os4.homedir(), ".grok", "sandbox.toml")) {
  if (BUILTIN_SANDBOXES.has(profile) || profile !== REVIEW_PROFILE_NAME) return;
  try {
    const existing = fs6.existsSync(file) ? fs6.readFileSync(file, "utf8") : "";
    if (existing.includes(REVIEW_PROFILE_BLOCK)) return;
    fs6.mkdirSync(path5.dirname(file), { recursive: true });
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
  const cwd = fs6.mkdtempSync(path5.join(os4.tmpdir(), "grok-review-"));
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
function hasDepSurface(r) {
  return r.manifests.length > 0 || r.riskyImports.length > 0;
}

// src/modes/review/receipt.ts
import fs7 from "fs";
import os5 from "os";
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
  return process.env.ENSEMBLE_RECEIPTS_DIR || path6.join(os5.homedir(), ".ensemble-ai", "receipts");
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
function receiptIdentityMatches(receipt, key) {
  return receipt.repo === key.repo && receipt.baseSha === key.baseSha && receipt.headSha === key.headSha && receipt.policyHash === key.policyHash;
}
function writeReceipt(storeDir, receipt) {
  const file = receiptPath(storeDir, keyOf(receipt));
  fs7.mkdirSync(path6.dirname(file), { recursive: true, mode: 448 });
  const tmp = `${file}.tmp`;
  fs7.writeFileSync(tmp, JSON.stringify(receipt, null, 2), { mode: 384 });
  fs7.chmodSync(tmp, 384);
  fs7.renameSync(tmp, file);
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
      JSON.parse(fs7.readFileSync(receiptPath(storeDir, key), "utf8"))
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
import fs8 from "fs";
import os6 from "os";
import path7 from "path";

// src/modes/brainstorm/claude.ts
function resolveClaudeBin() {
  return resolveBin("claude", { envVar: "CLAUDE_BIN" });
}
var CLAUDE_EFFORTS = /* @__PURE__ */ new Set(["low", "medium", "high", "xhigh", "max"]);
function buildClaudeVoiceArgs(prompt, config) {
  const args = ["-p", prompt, "--output-format", "text", "--tools", ""];
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
var VOICES_FILE = process.env.ENSEMBLE_VOICES_FILE || path7.join(os6.homedir(), ".ensemble-ai", "voices.json");
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
    return parseVoices(JSON.parse(fs8.readFileSync(file, "utf8")));
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

// src/modes/consult/index.ts
var consult_exports = {};
__export(consult_exports, {
  DEFAULT_VOICE_TIMEOUT_MS: () => DEFAULT_VOICE_TIMEOUT_MS2,
  fallbackSynthesis: () => fallbackSynthesis2,
  pickSynthesizer: () => pickSynthesizer2,
  runConsultMode: () => runConsultMode
});

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
export {
  CONFIDENCES,
  CRITIQUE_STANCES,
  DEFAULT_COVERAGE_CEILING,
  DEFAULT_OBJECTIVE,
  DEFAULT_VOICE_TIMEOUT_MS,
  DIFF_USEFUL_FLOOR,
  FINDINGS_INSTRUCTIONS,
  IMPLEMENTED_MODES,
  MODES,
  MODE_ALIASES,
  PACKET_BUDGETS,
  REVIEWERS_FILE,
  REVIEWER_DEFAULTS,
  REVIEWER_IDS,
  REVIEW_ADAPTERS,
  REVIEW_PROFILES,
  REVIEW_TIMEOUT_MS,
  SECURITY_CLASSES,
  SECURITY_OBJECTIVE,
  SEVERITIES,
  TERMINAL_STATES,
  VOICES_FILE,
  VOICE_ADAPTERS,
  VOICE_DEFAULTS,
  VOICE_IDS,
  acquireDiff,
  assembleCodePacket,
  buildClaudeVoiceArgs,
  buildCodexReviewArgs,
  buildDiffReceipt,
  buildGrokReviewArgs,
  canonicalizeDiff,
  classifyFileKind,
  classifySecurityFinding,
  computeCoverage,
  computePolicyHash,
  consult_exports as consult,
  coverageCounts,
  coverageShortfall,
  defaultReceiptStore,
  diffDigest,
  ensureSandboxProfile,
  extractGrokText,
  extractJsonBlock,
  extractRefs,
  fallbackSynthesis,
  fsConventionReader,
  gatherConventions,
  hasDepSurface,
  isDiffReviewed,
  isImplemented,
  isMode,
  isReviewProfile,
  isReviewerId,
  isVoiceId,
  keyOf,
  killTree,
  listReviewers,
  listVoices,
  loadReviewers,
  loadVoices,
  makeEscalatingKill,
  memoryConventionReader,
  omittedLine,
  oneOf,
  parseCritique,
  parseDiffFiles,
  parseFindings,
  parseIdeas,
  parseReviewerIds,
  parseReviewers,
  parseSynthesis,
  parseVoiceIds,
  parseVoices,
  persistReview,
  pickSynthesizer,
  readReceipt,
  readReview,
  readReviewsForRun,
  receiptIdentityMatches,
  receiptKeyHash,
  receiptPath,
  renderCritiquePrompt,
  renderGeneratePrompt,
  renderReviewPrompt,
  renderSynthesisPrompt,
  resolveBase,
  resolveBin,
  resolveClaudeBin,
  resolveCodexBin,
  resolveGrokBin,
  resolveInRepo,
  resolveMode,
  resolveRepoId,
  resolveReviewSandbox,
  resolveReviewer,
  reviewDir,
  runBrainstormMode,
  runClaudeVoice,
  runCodexReview,
  runGrokReview,
  runReviewMode,
  runReviewerExec,
  sanitizePathSegment,
  scanDependencySurface,
  scanDiffForSecrets,
  section,
  securityClassLabel,
  sha256Hex,
  stripSecurityTag,
  summarizeCoverage,
  titleCase,
  validateReceiptShape,
  writeReceipt,
  writeTrailFile
};
