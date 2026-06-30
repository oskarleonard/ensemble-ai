import {
  type Confidence,
  CONFIDENCES,
  type Evidence,
  type ReviewFinding,
  SEVERITIES,
  type Severity,
} from './types';

// The output contract embedded in the reviewer prompt. A stateless reviewer
// emits freeform prose by default (useless to machine-read); force ONE JSON
// block with a fixed schema so findings are a typed wire shape, not markdown.
export const FINDINGS_INSTRUCTIONS = `## Output format — STRICT
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

export interface ParsedReview {
  findings: ReviewFinding[];
  parseError?: string;
  summary: string;
}

// Coerce an untrusted value to a member of `set`, else `fallback` — the ONE
// membership-check rule, shared by the severity + confidence coercers so they
// can't drift.
function oneOf<T extends string>(set: readonly T[], v: unknown, fallback: T): T {
  return (set as readonly string[]).includes(v as string) ? (v as T) : fallback;
}

const asSeverity = (v: unknown): Severity => oneOf(SEVERITIES, v, 'medium');
const asConfidence = (v: unknown): Confidence => oneOf(CONFIDENCES, v, 'low');

function asEvidence(v: unknown): Evidence {
  if (!v || typeof v !== 'object') return {};
  const e = v as Record<string, unknown>;
  return {
    detail: typeof e.detail === 'string' ? e.detail : undefined,
    file:
      typeof e.file === 'string' && e.file.trim() ? e.file.trim() : undefined,
    line:
      typeof e.line === 'number' && Number.isInteger(e.line) && e.line > 0
        ? e.line
        : undefined,
  };
}

// Pull the JSON object out of a reply that may wrap it in a ```json fence and/or
// surrounding prose. Prefer the LAST fenced block (models often think aloud then
// emit the final block); else the widest {…} span that parses.
export function extractJsonBlock(raw: string): unknown {
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  let fenced: string | null = null;
  while ((m = fence.exec(raw))) fenced = m[1];
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced);
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// Parse the reviewer's reply into typed findings. Defensive at element
// granularity (a malformed finding is dropped, never trusted). Assigns stable
// ids and DOWNGRADES uncited findings (confidence → low, uncited flag) so the
// arbiter weighs them at a discount. A reply with no parseable JSON returns a
// parseError → the caller records `failed-reviewer`.
export function parseFindings(raw: string): ParsedReview {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== 'object') {
    return {
      findings: [],
      parseError: 'no parseable JSON block in the reviewer output',
      summary: '',
    };
  }
  const o = obj as Record<string, unknown>;
  const summary = typeof o.summary === 'string' ? o.summary : '';
  const rawFindings = Array.isArray(o.findings) ? o.findings : [];
  const findings: ReviewFinding[] = [];
  rawFindings.forEach((rf, i) => {
    if (!rf || typeof rf !== 'object') return;
    const f = rf as Record<string, unknown>;
    const evidence = asEvidence(f.evidence);
    const uncited = !evidence.file;
    findings.push({
      body: typeof f.body === 'string' ? f.body : '',
      confidence: uncited ? 'low' : asConfidence(f.confidence),
      evidence,
      id: `f${i + 1}`,
      severity: asSeverity(f.severity),
      title:
        typeof f.title === 'string' && f.title.trim()
          ? f.title.trim()
          : `Finding ${i + 1}`,
      uncited: uncited || undefined,
    });
  });
  return { findings, summary };
}
