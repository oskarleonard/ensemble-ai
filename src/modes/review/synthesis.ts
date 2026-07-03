// The human SYNTHESIS PROSE the verified gate still emits — "make sense of the reviews".
// The gate reads every voice's independent findings over the SAME diff and separates signal:
// dedupe · AGREE (≥2 voices concur → confident) vs DISAGREE (one voice / a conflict → look
// closer) · a bottom-line. The per-finding sanity-check (likely-real/look-closer/likely-false)
// is GONE — replaced by the grounded verdict TAGS in ./gate (agree/partial/false/unverified),
// which are host-reconciled and durably trailed. This module keeps the prose types + the
// agreement-corroboration guard (reconcileSynthesis) + the deterministic fallback; the gate
// prompt + envelope parse live in ./gate-prompt and ./gate. No node imports (pure).

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

// The converged review prose. `agreements`/`disagreements` are the AGREE-vs-look-closer
// map; `bottomLine` is the headline verdict; `summary` is an optional overall read.
// `degraded` = the gate voice was unavailable and this was assembled DETERMINISTICALLY from
// the raw voice reviews (no model judgment) — a reader must not read confidence into it. The
// grounded per-finding verdicts are carried separately (./gate GateVerdictRecord[]).
export interface ReviewSynthesis {
  agreements: ReviewAgreement[];
  bottomLine: string;
  by: string | null;
  degraded: boolean;
  disagreements: ReviewDisagreement[];
  error?: string;
  ok: boolean;
  raw: string | null;
  summary: string;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(str).filter(Boolean))];
}

// Parse the synthesis sub-object's agreements/disagreements — exported so the gate envelope
// parser reuses the SAME element-granular, defensive coercion (a malformed entry is dropped).
export function parseAgreements(v: unknown): ReviewAgreement[] {
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

export function parseDisagreements(v: unknown): ReviewDisagreement[] {
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

// Significant tokens of a string, for corroboration matching: lowercased word tokens of
// length ≥3, minus a small structural stopword set (articles/conjunctions/prepositions),
// deduped. Kept lexical + deliberately lenient (a legitimate paraphrase shares content
// words like the symbol/file/keyword) — this is a fabrication guard, not a semantic match.
const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'are', 'was', 'not', 'but', 'its',
  'into', 'from', 'when', 'then', 'than', 'has', 'have', 'you', 'your', 'can', 'will',
]);
function significantTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const t of s.toLowerCase().match(/[a-z0-9_]+/g) ?? []) {
    if (t.length >= 3 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

// Does a voice ACTUALLY corroborate a claimed agreement point? True only when the voice has
// at least one finding whose text (title + body + cited file + detail) shares a significant
// token with the point — i.e. it plausibly raised THE SAME issue, not merely "some" finding.
// This is what makes an agreement DERIVED from the real findings rather than asserted: a
// point about an issue no voice's findings mention corroborates nobody, so it can't survive
// as confident consensus.
function voiceCorroboratesPoint(review: VoiceReview, pointTokens: Set<string>): boolean {
  if (pointTokens.size === 0) return false;
  for (const f of review.findings) {
    const hay = significantTokens(
      `${f.title} ${f.body} ${f.evidence.file ?? ''} ${f.evidence.detail ?? ''}`
    );
    for (const t of pointTokens) if (hay.has(t)) return true;
  }
  return false;
}

// Guard against a synthesizer that fabricates CONFIDENT CONSENSUS. An AGREEMENT is a
// concurrence on a FINDING, so it is only legitimate if ≥2 DISTINCT voices that ACTUALLY
// RAISED THE SAME finding concur — we validate the synthesizer's claims against the real
// per-voice findings, never trusting the model's self-report. For each agreement a voice is
// credited ONLY if it (a) reviewed (ok) with ≥1 finding AND (b) has a finding that actually
// corroborates the agreement POINT (lexical overlap — see voiceCorroboratesPoint), so a
// phantom voice (never ran), a clean/no-findings voice (raised nothing), OR a voice whose
// findings are about something ELSE cannot prop up an invented agreement. If fewer than 2
// corroborating voices remain, DEMOTE it to a disagreement ("look closer") rather than
// presenting invented agreement as high-signal. Voice ids match case-insensitively (the
// model may echo a different case). Returns the corrected synthesis + the demotion count
// (for logging). The deterministic fallback makes no agreement claim → passes through.
export function reconcileSynthesis(
  synth: ReviewSynthesis,
  reviews: VoiceReview[]
): { demoted: number; synthesis: ReviewSynthesis } {
  if (synth.degraded) return { demoted: 0, synthesis: synth };
  // A voice can corroborate a finding-agreement ONLY if it both reviewed (ok) AND actually
  // produced at least one finding — a clean/no-findings review raised nothing to agree on.
  const findingVoices = new Map(
    reviews
      .filter((r) => r.ok && r.findings.length > 0)
      .map((r) => [r.voiceId.trim().toLowerCase(), r] as const)
  );

  const agreements: ReviewAgreement[] = [];
  const demoted: ReviewDisagreement[] = [];
  for (const a of synth.agreements) {
    const pointTokens = significantTokens(a.point);
    // Credit by the CANONICAL voiceId of the corroborating review, deduped — so case /
    // whitespace variants of ONE voice ("codex" + "Codex") resolve to the same reviewer and
    // can't be counted as two, which would slip a single-voice claim past the ≥2-DISTINCT bar.
    const credited = [
      ...new Set(
        a.voices
          .map((v) => findingVoices.get(v.trim().toLowerCase()))
          .filter(
            (review): review is VoiceReview =>
              review !== undefined && voiceCorroboratesPoint(review, pointTokens)
          )
          .map((review) => review.voiceId)
      ),
    ];
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
    demoted: demoted.length,
    synthesis: {
      ...synth,
      agreements,
      disagreements: demoted.length ? [...synth.disagreements, ...demoted] : synth.disagreements,
    },
  };
}

// Deterministic synthesis when the gate voice is unavailable/unparseable: present each
// voice's findings as-is (as "look closer" positions), make NO agreement claim, and flag
// degraded=true — separating signal needs a model, and a reader must not read confidence
// into a mechanical list.
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
        ? 'Gate unavailable — each reviewer\'s findings shown as-is, NOT deduped or cross-confirmed. Read each voice directly.'
        : 'No reviewer produced a usable review.',
    by: null,
    degraded: true,
    disagreements,
    ok: false,
    raw: null,
    summary:
      ok.length > 0
        ? `${ok.length} reviewer(s) produced findings; gate unavailable, so they are NOT compared for agreement.`
        : 'No reviews to synthesize.',
  };
}
