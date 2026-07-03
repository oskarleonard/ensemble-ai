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
var truncationMarker = (droppedChars) => `\u2026[${droppedChars} chars truncated]\u2026`;
var TRUNCATION_MARKER_RE = /…\[\d+ chars truncated\]…/;
function segmentsWithoutTruncationSplices(body) {
  return body.split(/[^\n]*\n\n…\[\d+ chars truncated\]…\n\n[^\n]*/);
}
function truncate(text, budget) {
  if (text.length <= budget) return { text, truncated: false };
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  return {
    text: `${text.slice(0, head)}

${truncationMarker(text.length - budget)}

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
var DIFF_SECTION_TITLE = "The diff under review";
function reviewerVisibleDiff(packet) {
  const s = packet.sections.find((sec) => sec.title === DIFF_SECTION_TITLE);
  return { text: s?.body ?? "", truncated: s?.truncated ?? false };
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
    DIFF_SECTION_TITLE,
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
export {
  CONFIDENCES,
  DIFF_SECTION_TITLE,
  DIFF_USEFUL_FLOOR,
  FINDINGS_INSTRUCTIONS,
  PACKET_BUDGETS,
  REVIEWER_IDS,
  SEVERITIES,
  TERMINAL_STATES,
  TRUNCATION_MARKER_RE,
  assembleCodePacket,
  extractJsonBlock,
  isReviewerId,
  oneOf,
  parseFindings,
  parseReviewerIds,
  renderReviewPrompt,
  reviewerVisibleDiff,
  section,
  segmentsWithoutTruncationSplices,
  titleCase
};
