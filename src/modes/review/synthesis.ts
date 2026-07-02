// The Claude SYNTHESIS pass for `--with-claude` review — "review the reviews".
// One Claude reads every voice's independent findings over the SAME diff and
// separates signal: dedupe · AGREE (≥2 voices concur → confident) vs DISAGREE
// (one voice only / a conflict → look closer) · a per-finding sanity-check
// (likely-real / look-closer / likely-false) · a bottom-line. This is the
// portable, REVIEW-ONLY sibling of the dashboard's arbiter — it emits an
// insight structure, never a mutation or a merge gate. No node imports (pure —
// prompt/parse/fallback are unit-tested over injected outputs).

import { extractJsonBlock, oneOf } from '../../core/findings';
import type { ReviewFinding } from '../../core/types';

// One voice's review of the diff, labeled by voice id (codex/grok/claude), reduced
// to what the synthesizer needs. Built from a StoredReview (codex/grok) or the
// claude voice review. `ok` = the voice produced a parseable review.
export interface VoiceReview {
  findings: ReviewFinding[];
  ok: boolean;
  summary: string;
  voiceId: string;
}

// A finding ≥2 voices independently flagged — the confident core. `voices` credits
// who concurred.
export interface ReviewAgreement {
  point: string;
  voices: string[];
}

// A finding only one voice raised, or where the voices conflict — flagged "look
// closer". `positions` records who-said-what so a reader can judge.
export interface ReviewDisagreement {
  point: string;
  positions: string[];
}

export const SANITY_VERDICTS = ['likely-real', 'look-closer', 'likely-false'] as const;
export type SanityVerdict = (typeof SANITY_VERDICTS)[number];

// The synthesizer's judgment on ONE distinct finding — the check that catches a
// reviewer hallucination before it reaches the human.
export interface FindingSanityCheck {
  finding: string;
  note: string;
  verdict: SanityVerdict;
}

// The converged review. `agreements`/`disagreements` are the AGREE-vs-look-closer
// map; `sanityChecks` is per-finding; `bottomLine` is the headline verdict.
// `degraded` = the synthesizer voice was unavailable and this was assembled
// DETERMINISTICALLY from the raw voice reviews (no model judgment) — a reader must
// not read confidence into it.
export interface ReviewSynthesis {
  agreements: ReviewAgreement[];
  bottomLine: string;
  by: string | null;
  degraded: boolean;
  disagreements: ReviewDisagreement[];
  error?: string;
  ok: boolean;
  raw: string | null;
  sanityChecks: FindingSanityCheck[];
  summary: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(str).filter(Boolean))];
}

// Cap each untrusted free-text field folded into the synthesis prompt — voice output
// is unbounded and the whole prompt is one argv element to the CLI. Generous.
const FIELD_BUDGET = 2000;
function cap(s: string): string {
  return s.length > FIELD_BUDGET ? `${s.slice(0, FIELD_BUDGET)}…[truncated]` : s;
}

// The per-voice findings block for the synthesis prompt: each finding labeled by
// voice + severity + file:line so the synthesizer can align the same issue across
// voices and sanity-check the evidence.
function voiceReviewsBlock(reviews: VoiceReview[]): string {
  return reviews
    .filter((r) => r.ok)
    .map((r) => {
      const head = `[${r.voiceId}] ${cap(r.summary) || '(no summary)'}`;
      if (r.findings.length === 0) return `${head}\n  (no findings — looks correct)`;
      const lines = r.findings.map((f) => {
        const where = f.evidence.file
          ? `${f.evidence.file}${f.evidence.line ? `:${f.evidence.line}` : ''}`
          : '(uncited)';
        return `  - [${f.severity}/${f.confidence}] ${where} — ${cap(f.title)}: ${cap(f.body)}`;
      });
      return `${head}\n${lines.join('\n')}`;
    })
    .join('\n\n');
}

// Render the synthesis prompt. One Claude reads every voice's independent review and
// separates signal. STRICT one-JSON-block output, same discipline as consult.
export function renderReviewSynthesisPrompt(reviews: VoiceReview[]): string {
  return `You are the SYNTHESIZER for a multi-model CODE REVIEW. Several AI reviewers
each reviewed the SAME diff INDEPENDENTLY (they did not see each other's findings).
Review-only: do NOT propose editing the code here — your job is to make sense of the
findings. Separate the signal:
- DEDUPE: collapse the SAME underlying issue reported by multiple reviewers into one.
- AGREEMENTS: findings ≥2 reviewers independently raised — the confident core.
- DISAGREEMENTS: a finding only ONE reviewer raised, or where reviewers conflict — flag
  these "look closer" and record who took which position.
- SANITY-CHECK each distinct finding: is it likely-real, look-closer, or likely-false
  (a probable hallucination / false positive)? Reviewers do hallucinate — catch it.
- BOTTOM LINE: the headline — is this diff safe to merge, and what must change first.

## The reviewers' independent findings
${voiceReviewsBlock(reviews)}

## Output format — STRICT
Respond with ONE fenced \`\`\`json block and NOTHING else, matching:
{
  "summary": "<2-3 sentence overall read of the change>",
  "agreements": [
    { "point": "<a finding ≥2 reviewers concur on>", "voices": ["codex", "grok"] }
  ],
  "disagreements": [
    { "point": "<a finding one reviewer raised or they split on>", "positions": ["codex: real", "claude: false positive"] }
  ],
  "sanityChecks": [
    { "finding": "<the distinct finding>", "verdict": "likely-real" | "look-closer" | "likely-false", "note": "<why>" }
  ],
  "bottomLine": "<merge-safe? what must change first, and how confident given agree vs a judgment call>"
}
Only list a REAL agreement (genuine concurrence) and a REAL disagreement (a substantive
split). Empty arrays are fine. Do not invent findings.`;
}

function parseAgreements(v: unknown): ReviewAgreement[] {
  if (!Array.isArray(v)) return [];
  const out: ReviewAgreement[] = [];
  for (const ra of v) {
    if (!ra || typeof ra !== 'object') continue;
    const a = ra as Record<string, unknown>;
    const point = str(a.point);
    if (!point) continue;
    out.push({ point, voices: strList(a.voices) });
  }
  return out;
}

function parseDisagreements(v: unknown): ReviewDisagreement[] {
  if (!Array.isArray(v)) return [];
  const out: ReviewDisagreement[] = [];
  for (const rd of v) {
    if (!rd || typeof rd !== 'object') continue;
    const d = rd as Record<string, unknown>;
    const point = str(d.point);
    if (!point) continue;
    out.push({ point, positions: strList(d.positions) });
  }
  return out;
}

function parseSanityChecks(v: unknown): FindingSanityCheck[] {
  if (!Array.isArray(v)) return [];
  const out: FindingSanityCheck[] = [];
  for (const rs of v) {
    if (!rs || typeof rs !== 'object') continue;
    const s = rs as Record<string, unknown>;
    const finding = str(s.finding);
    if (!finding) continue;
    out.push({
      finding,
      note: str(s.note),
      verdict: oneOf(SANITY_VERDICTS, s.verdict, 'look-closer'),
    });
  }
  return out;
}

export interface ParsedReviewSynthesis {
  agreements: ReviewAgreement[];
  bottomLine: string;
  disagreements: ReviewDisagreement[];
  parseError?: string;
  sanityChecks: FindingSanityCheck[];
  summary: string;
}

// Parse the synthesizer's reply into the typed structure. Defensive at element
// granularity (a malformed entry is dropped). A reply with NEITHER a bottomLine NOR a
// summary is not a synthesis → parseError → the orchestrator uses the fallback.
export function parseReviewSynthesis(raw: string): ParsedReviewSynthesis {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== 'object') {
    return {
      agreements: [],
      bottomLine: '',
      disagreements: [],
      parseError: 'no parseable JSON block in the synthesis output',
      sanityChecks: [],
      summary: '',
    };
  }
  const o = obj as Record<string, unknown>;
  const summary = str(o.summary);
  const bottomLine = str(o.bottomLine);
  const agreements = parseAgreements(o.agreements);
  const disagreements = parseDisagreements(o.disagreements);
  const sanityChecks = parseSanityChecks(o.sanityChecks);
  if (!bottomLine && !summary) {
    return {
      agreements,
      bottomLine: '',
      disagreements,
      parseError: 'synthesis output has no "bottomLine" or "summary"',
      sanityChecks,
      summary: '',
    };
  }
  return { agreements, bottomLine, disagreements, sanityChecks, summary };
}

// Guard against a synthesizer that fabricates CONFIDENT CONSENSUS. An AGREEMENT is only
// legitimate if ≥2 DISTINCT voices that ACTUALLY produced a review concur — so we
// validate the synthesizer's claims against the real per-voice reviews, never trusting
// the model's self-report. For each agreement: drop any credited voice id that did not
// review (a hallucinated/phantom voice — e.g. crediting "claude" when it never ran), and
// if fewer than 2 real voices remain, DEMOTE it to a disagreement ("look closer") rather
// than silently presenting invented agreement as high-signal. Voice ids match
// case-insensitively (the model may echo a different case). Returns the corrected
// synthesis + the demotion count (for logging). The deterministic fallback already makes
// no agreement claim, so it passes through untouched.
export function reconcileSynthesis(
  synth: ReviewSynthesis,
  reviews: VoiceReview[]
): { synthesis: ReviewSynthesis; demoted: number } {
  if (synth.degraded) return { synthesis: synth, demoted: 0 };
  const realVoices = new Set(
    reviews.filter((r) => r.ok).map((r) => r.voiceId.trim().toLowerCase())
  );
  const isReal = (v: string): boolean => realVoices.has(v.trim().toLowerCase());

  const agreements: ReviewAgreement[] = [];
  const demoted: ReviewDisagreement[] = [];
  for (const a of synth.agreements) {
    const credited = [...new Set(a.voices)].filter(isReal);
    if (credited.length >= 2) {
      agreements.push({ point: a.point, voices: credited });
    } else {
      demoted.push({
        point: a.point,
        positions:
          credited.length > 0
            ? credited.map((v) => `${v}: raised`)
            : ['unverified — no reviewing voice corroborates this as a shared finding'],
      });
    }
  }
  // Always return the CLEANED agreements (phantom voice ids stripped) even when nothing
  // was demoted, so a kept agreement never credits a voice that did not review.
  return {
    synthesis: {
      ...synth,
      agreements,
      disagreements: demoted.length ? [...synth.disagreements, ...demoted] : synth.disagreements,
    },
    demoted: demoted.length,
  };
}

// Deterministic synthesis when the synthesizer voice is unavailable/unparseable:
// present each voice's findings as-is (as "look closer" positions), make NO agreement
// claim, and flag degraded=true — separating signal needs a model, and a reader must
// not read confidence into a mechanical list.
export function fallbackReviewSynthesis(reviews: VoiceReview[]): ReviewSynthesis {
  const ok = reviews.filter((r) => r.ok);
  const disagreements: ReviewDisagreement[] = [];
  for (const r of ok) {
    for (const f of r.findings) {
      disagreements.push({
        point: f.title,
        positions: [`${r.voiceId}: [${f.severity}] ${f.evidence.file ?? '(uncited)'}`],
      });
    }
  }
  return {
    agreements: [],
    bottomLine:
      ok.length > 0
        ? 'Synthesizer unavailable — each reviewer\'s findings shown as-is, NOT deduped or cross-confirmed. Read each voice directly.'
        : 'No reviewer produced a usable review.',
    by: null,
    degraded: true,
    disagreements,
    ok: false,
    raw: null,
    sanityChecks: [],
    summary:
      ok.length > 0
        ? `${ok.length} reviewer(s) produced findings; synthesizer unavailable, so they are NOT compared for agreement.`
        : 'No reviews to synthesize.',
  };
}
