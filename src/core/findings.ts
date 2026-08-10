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
array with a "summary" that says so. Do not invent issues to fill the list. You
see one diff, not the project's tracker: never assert a change is out-of-scope or
unsanctioned — state the code-level consequence and, at most, note the commit
boundary.`;

export interface ParsedReview {
  findings: ReviewFinding[];
  parseError?: string;
  summary: string;
}

// Coerce an untrusted value to a member of `set`, else `fallback` — the ONE
// membership-check rule, shared by the severity + confidence coercers (and the
// brainstorm stance coercer) so they can't drift.
export function oneOf<T extends string>(set: readonly T[], v: unknown, fallback: T): T {
  return (set as readonly string[]).includes(v as string) ? (v as T) : fallback;
}

// The severity display vocabulary + HIGH→MED→LOW render order — the ONE copy shared by every
// review renderer (the terminal gate/summary + the markdown PR comment) so a relabel or reorder
// happens once, not per-renderer. `SEVERITY_LABEL[s][0]` is the single-letter form the compact
// tally uses.
export const SEVERITY_LABEL: Record<Severity, string> = { high: 'HIGH', low: 'LOW', medium: 'MED' };
export const SEVERITY_ORDER: Severity[] = ['high', 'medium', 'low'];

// Format a finding's evidence as `file:line` (or just `file` when uncited-by-line), falling back
// to `(uncited)` when there is no file — the ONE definition of an idiom that was re-implemented
// across the CLI + every review renderer. `scrub` is applied to the file path (default identity: a
// renderer that scrubs control chars passes its scrubber in; a prompt that shows the raw host-owned
// path omits it). Line 0 renders as no line (line numbers are 1-based — matches every call site's
// `line ?` truthiness).
export function evidenceRef(
  file: string | undefined,
  line: number | null | undefined,
  scrub: (s: string) => string = (s) => s
): string {
  if (!file) return '(uncited)';
  const f = scrub(file);
  return line ? `${f}:${line}` : f;
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
// Remove trailing commas (`,` whose next non-whitespace is `}` or `]`) OUTSIDE string literals.
// The single most common way a model's otherwise-perfect JSON fails strict JSON.parse — lived on
// run 2026-08-10-20-10-54: one trailing comma in a 17KB gate envelope fail-closed 15 verdicts to
// unverified. String state is tracked with escape handling so a `",}"` INSIDE a string is never
// touched; the transform is only ever offered as a FALLBACK candidate after the strict parse fails.
export function stripTrailingCommas(s: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      out += ch;
      if (ch === '\\') {
        // consume the escaped char verbatim so an escaped quote can't flip the state
        if (i + 1 < s.length) out += s[++i];
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === ',') {
      let j = i + 1;
      while (j < s.length && /\s/.test(s[j])) j++;
      if (s[j] === '}' || s[j] === ']') continue; // drop the trailing comma
    }
    out += ch;
  }
  return out;
}

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
  // FALLBACK: the strict pass failed on every candidate — retry each with trailing commas
  // stripped. Kept as a second pass so well-formed JSON never goes through the transform.
  for (const c of candidates) {
    try {
      return JSON.parse(stripTrailingCommas(c));
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
  // A conforming review carries a `findings` ARRAY (possibly empty). A JSON object
  // that lacks one — `{}`, `{"error":"quota exceeded"}`, or prose that parsed to the
  // wrong braces — is NOT a review: return a parseError so the caller records
  // failed-reviewer, never a falsely-"reviewed" run with zero findings.
  if (!Array.isArray(o.findings)) {
    return {
      findings: [],
      parseError: 'reviewer output has no "findings" array — not a conforming review',
      summary,
    };
  }
  const rawFindings = o.findings;
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
