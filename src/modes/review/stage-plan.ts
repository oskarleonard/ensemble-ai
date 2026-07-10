import { SEVERITIES, type Severity } from '../../core/types';
import { scrubControl } from '../../core/sanitize';

import type { GateVerdictRecord } from './gate';
import { containsFenceLine, type PostableSuggestion } from './gate-postable';
import { meetsInlineFloor, type PostingPosture } from './posting-config';

// THE FOREIGN POSTING POSTURE — placement, not deletion (spec §6). PURE: every decision here is a
// function of the gate's stored records + the consumer's posture. NO model runs in the posting
// path; the text posted is the gate's own `postableBody`, and this module only decides WHERE it
// lands and wraps it.
//
//   • verified bugs        → INLINE comments (the main event)
//   • quality findings     → a COLLAPSED section of the summary body, never inline prose
//   • gate-verified small replacements → inline ```suggestion``` blocks, HARD-CAPPED (posture)
//   • zero bugs            → still a staged review: the friendly summary body, zero inline
//
// One review, one voice: findings are grouped by ISSUE (the dedup machinery already elected one
// representative per cluster), never by tool, and each carries its own corroboration line.

// Marks a review body as OURS. A pending review carrying it may be replaced by a re-run
// (idempotency); one that does not is a human's work and is never touched.
export const STAGE_MARKER = '<!-- ensemble-ai:staged-review v1 -->';
const TRAILER_RE = /<!--\s*ensemble-ai:finding\s+(\{[\s\S]*?\})\s*-->/g;

// ── Untrusted-text neutralization ─────────────────────────────────────────────────────
//
// A reviewer's title/body is UNTRUSTED: a crafted diff steers what a reviewer writes, and the gate
// only certifies that the body's CLAIMS are grounded — not that its MARKUP is inert. Two vectors
// matter once that text crosses into a GitHub review:
//
//   1. `<!--` opens an HTML comment. A crafted body could forge our own machine trailer (stealing
//      a findingId, or making a re-run believe a finding is already staged) or hide the rest of the
//      review under an unclosed comment. Escaping the opener renders it as literal text and closes
//      both. GitHub's markdown renders `<\!--` as `<!--`.
//   2. ```` ```suggestion ```` opens a ONE-CLICK APPLY block. Only the HOST may emit one, and only
//      for a replacement the gate verified against the hunk. A reviewer-authored fence would put an
//      apply button on text nothing verified — the most damaging robot comment there is. Retag it.
//
// Both are byte-changing, and both fire ONLY on hostile-looking content: the `agree`-posts-verbatim
// guarantee is preserved for every body that does not try to forge markup.
export function defuseUntrusted(s: string): string {
  return s
    .replace(/<!--/g, '<\\!--')
    .replace(/^(\s*)(`{3,}|~{3,})[ \t]*suggestion\b/gim, '$1$2text');
}

// One-line reviewer text (a title) rendered into markdown flow. Capped by CODE POINT, so a title
// truncated mid-emoji does not leave a lone surrogate behind.
function titleText(s: string): string {
  return [...defuseUntrusted(scrubControl(s))].slice(0, 200).join('');
}

// A model-controlled path rendered as a `code span`. Two things must go: a backtick would CLOSE the
// span and hand the rest to the markdown renderer, and a `<!--` would then open a forged
// `<!-- ensemble-ai:finding … -->` trailer. Defuse first (so the opener is escaped even if the
// backtick strip changes nothing), then strip the backticks — a path never legitimately holds one.
function codeSpan(file: string): string {
  return defuseUntrusted(scrubControl(file)).replace(/`/g, '');
}

// ── The machine trailer ───────────────────────────────────────────────────────────────

// An invisible, per-finding provenance record, so a machine reader (the author's own AI assistant,
// the Hugin dashboard) can consume a staged review as DATA rather than scraping its prose. Keys are
// emitted in a fixed (alphabetical) order, so the same finding always renders the same bytes.
//
// It is NOT what makes a re-run idempotent — `stageReview` replaces our prior pending review whole,
// keyed on STAGE_MARKER in the summary body (see stage.ts). The trailers are read back only by
// `parseTrailerIds`, which the tests use to prove one finding renders exactly once per review.
export function findingTrailer(r: GateVerdictRecord): string {
  const payload = {
    anchors: { file: r.file, line: r.line },
    corroborators: r.cluster?.corroborators ?? [],
    findingId: r.findingId,
    fixStatus: r.postableFix,
    severity: r.rescoredSeverity ?? r.severity,
    verdict: r.effectiveVerdict,
  };
  // `file` and `findingId` are model-controlled, and JSON.stringify escapes neither `-` nor `>`.
  // A path like `a-->b.ts` would close the HTML comment early and spill the remainder into the
  // rendered review. Rewriting the angle brackets as their \u escapes keeps the payload valid JSON
  // (it parses back to the same string) while making an early `-->` unrepresentable.
  const json = JSON.stringify(payload).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
  return `<!-- ensemble-ai:finding ${json} -->`;
}

// Every findingId a rendered review body/comment already carries. Used to prove idempotency: the
// same finding appears exactly once across a staged review.
export function parseTrailerIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(TRAILER_RE)) {
    try {
      const id = (JSON.parse(m[1]) as { findingId?: unknown }).findingId;
      if (typeof id === 'string') out.push(id);
    } catch {
      /* a forged / malformed trailer is not a finding we staged */
    }
  }
  return out;
}

export function isEnsembleStagedReview(body: string | null | undefined): boolean {
  return typeof body === 'string' && body.includes(STAGE_MARKER);
}

// ── Placement ─────────────────────────────────────────────────────────────────────────

export interface PlacedFinding {
  record: GateVerdictRecord;
  // Non-null ⇒ this inline comment carries a ```suggestion``` block (within the posture's cap).
  suggestion: PostableSuggestion | null;
}

export interface StageCounts {
  inline: number;
  quality: number;
  reviewersRun: number;
  suggestions: number;
  // Postable findings with no usable line anchor (or a cite outside the reviewed diff) — they
  // still post, in the summary body, so nothing verified is silently dropped.
  unanchored: number;
}

export interface StagePlan {
  counts: StageCounts;
  inline: PlacedFinding[];
  quality: GateVerdictRecord[];
  unanchored: GateVerdictRecord[];
}

function effectiveSeverity(r: GateVerdictRecord): Severity {
  return r.rescoredSeverity ?? r.severity;
}

// Deterministic order: most severe first, then stable id order. Returns 0 for two records that
// compare equal, so the comparator is a total order even if a duplicate findingId ever reaches it.
function bySeverityThenId(a: GateVerdictRecord, b: GateVerdictRecord): number {
  return (
    SEVERITIES.indexOf(effectiveSeverity(a)) - SEVERITIES.indexOf(effectiveSeverity(b)) ||
    (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0)
  );
}

// A finding may be anchored inline only when the gate resolved its cite to a line on the diff's
// RIGHT — an added or context line at the reviewed head. GitHub rejects a review comment whose
// (path, line, side) is not in the diff with a 422, and the create-review call is ATOMIC, so ONE
// bad anchor throws away the whole staged review (summary and every other inline comment). This is
// a correctness fence, not a preference.
//
// `anchorSide: 'old'` is the trap: a cite landing in a deletion-only hunk resolves against old-side
// line numbers (gate-hunks.ts's second pass), so `line` names a line that exists only on the LEFT —
// e.g. a reviewer flagging "you deleted the mutex release" on a wholly-deleted file, where EVERY
// line is old-side. Such a finding is real and still posts, in the summary body, rather than
// 422-ing the review. (Posting it inline with `side: 'LEFT'` is what GitHub supports and is the
// natural follow-up; it is not done here because nothing in this session can prove the LEFT
// anchor against the live API, and a wrong side is the same 422 we are fixing.)
function anchorable(r: GateVerdictRecord): boolean {
  return r.anchorSide === 'new' && typeof r.line === 'number';
}

// Decide where each postable finding lands. Only the CLUSTER PRIMARY posts — the corroborating
// duplicates stay in the trail and lend their count to "flagged by N of M".
export function planPlacement(
  records: GateVerdictRecord[],
  opts: { posture: PostingPosture; reviewersRun: number }
): StagePlan {
  const postable = records
    .filter((r) => r.postableStatus === 'postable' && r.postableBody)
    .filter((r) => !r.cluster || r.cluster.primary)
    .sort(bySeverityThenId);

  // Suggestions first: they are the scarcest slot (HARD CAP), so they are allocated by severity
  // across ALL postable findings — a `quality` finding with a verified one-click fix outranks a
  // low-severity bug with none (spec §6's explicit exception).
  const suggestionOf = new Map<string, PostableSuggestion>();
  for (const r of postable) {
    if (suggestionOf.size >= opts.posture.suggestionCap) break;
    const s = r.postableSuggestion;
    if (!s || !anchorable(r)) continue;
    if (s.replacement.split('\n').length > opts.posture.maxSuggestionLines) continue;
    // Re-check the fence here, not only in the gate: these records arrive off a durable trail
    // artifact (or a hand-built one, via the exported library API), so nothing guarantees they went
    // through derivePostable's validation. A fence inside the replacement would break out of the
    // ```suggestion block this is about to be rendered into.
    if (containsFenceLine(s.replacement)) continue;
    suggestionOf.set(r.findingId, s);
  }

  const inline: PlacedFinding[] = [];
  const quality: GateVerdictRecord[] = [];
  const unanchored: GateVerdictRecord[] = [];
  for (const r of postable) {
    const suggestion = suggestionOf.get(r.findingId) ?? null;
    if (suggestion) {
      inline.push({ record: r, suggestion });
      continue;
    }
    if (r.postableClass === 'quality') {
      quality.push(r);
      continue;
    }
    // A verified bug: inline when it is anchorable AND clears the consumer's severity floor.
    // Otherwise it still posts — in the summary — because dropping a verified bug is never the
    // conservative choice.
    if (anchorable(r) && meetsInlineFloor(effectiveSeverity(r), opts.posture.inlineSeverityFloor)) {
      inline.push({ record: r, suggestion: null });
    } else {
      unanchored.push(r);
    }
  }

  return {
    counts: {
      inline: inline.length,
      quality: quality.length,
      reviewersRun: opts.reviewersRun,
      suggestions: suggestionOf.size,
      unanchored: unanchored.length,
    },
    inline,
    quality,
    unanchored,
  };
}

// ── Rendering ─────────────────────────────────────────────────────────────────────────

// "flagged by N of M" — the corroboration signal the dedup machinery earned. A single-seat finding
// says `1 of 3`, honestly; it never borrows confidence it does not have.
function corroborationLine(r: GateVerdictRecord, reviewersRun: number): string {
  const n = r.cluster?.corroboration ?? 1;
  return `<sub>flagged by ${n} of ${reviewersRun} reviewers · gate: ${r.effectiveVerdict}</sub>`;
}

// One inline review comment: the gate's grounded text, an optional verified one-click fix, the
// corroboration line, and the machine trailer. The body is the gate's `postableBody` — no model
// touches it here.
export function renderInlineComment(placed: PlacedFinding, reviewersRun: number): string {
  const { record: r, suggestion } = placed;
  const out = [
    `**[${effectiveSeverity(r)}]** ${titleText(r.title)}`,
    '',
    defuseUntrusted(r.postableBody ?? ''),
  ];
  if (suggestion) {
    out.push('', '```suggestion', suggestion.replacement, '```');
  }
  out.push('', corroborationLine(r, reviewersRun), findingTrailer(r));
  return out.join('\n');
}

// A collapsed `<details>` section — the author reads or ignores it in ONE gesture, while their AI
// assistant consumes all of it, evidence included.
function collapsed(summary: string, records: GateVerdictRecord[], reviewersRun: number): string[] {
  if (records.length === 0) return [];
  const out = ['', `<details>`, `<summary>${summary}</summary>`, ''];
  for (const r of records) {
    const file = codeSpan(r.file);
    const where = r.line ? `\`${file}:${r.line}\`` : `\`${file || '(no file)'}\``;
    out.push(
      `**[${effectiveSeverity(r)}]** ${titleText(r.title)} — ${where}`,
      '',
      defuseUntrusted(r.postableBody ?? ''),
      '',
      corroborationLine(r, reviewersRun),
      findingTrailer(r),
      '',
      '---',
      ''
    );
  }
  out.push('</details>');
  return out;
}

export interface SummaryBodyInput {
  // The run's realized per-seat evidence, one line. A staged review whose seats fell back to the
  // diff-only packet SAYS so in its own footer (spec §8) — the author reading it must never have to
  // infer that a review claiming whole-project context saw less than the whole project. Absent in
  // packet mode, where there is nothing new to state.
  evidenceNote?: string;
  headSha: string;
  plan: StagePlan;
  reviewerIds: string[];
}

// The review SUMMARY body. Always rendered — a zero-bug run still stages a review carrying only
// this, so the posting-authority property is absolute: nothing appears under the user's account
// without their submit click, including "LGTM".
export function renderSummaryBody(input: SummaryBodyInput): string {
  const { headSha, plan, reviewerIds } = input;
  const { counts } = plan;
  const bugs = counts.inline - counts.suggestions;
  const out: string[] = [
    '## 🔭 ensemble-ai — cross-vendor review',
    STAGE_MARKER,
    '',
    `Reviewed at \`${headSha}\` by ${counts.reviewersRun} reviewer(s): ${reviewerIds.join(', ')}.`,
    '',
    `- **${bugs}** verified bug(s) commented inline`,
    `- **${counts.suggestions}** one-click suggestion(s)`,
    `- **${counts.quality}** structural simplification(s)`,
    `- **${counts.unanchored}** further verified finding(s) without a line anchor`,
  ];
  if (counts.inline === 0 && counts.quality === 0 && counts.unanchored === 0) {
    out.push('', 'No verified bugs. Every reviewer finding was either refuted by the gate or could not be grounded in the diff, so nothing is commented inline.');
  }
  out.push(...collapsed(`${counts.quality} structural simplification opportunit${counts.quality === 1 ? 'y' : 'ies'} (verified)`, plan.quality, counts.reviewersRun));
  out.push(...collapsed(`${counts.unanchored} further verified finding(s)`, plan.unanchored, counts.reviewersRun));
  const evidence = input.evidenceNote ? ` ${defuseUntrusted(input.evidenceNote)}.` : '';
  out.push(
    '',
    '---',
    `<sub>Cross-vendor AI review by [ensemble-ai](https://github.com/oskarleonard/ensemble-ai) — ${reviewerIds.join(' · ')}. Every finding above was gate-verified against the diff at \`${headSha}\`; claims the gate could not ground were dropped, not posted. Deduped across reviewers, so one issue is one comment.${evidence}</sub>`
  );
  return out.join('\n');
}

// ── The GitHub payload ────────────────────────────────────────────────────────────────

export interface StagedComment {
  body: string;
  line: number;
  path: string;
  side: 'RIGHT';
}

// A PENDING review: `event` is OMITTED. GitHub's create-review API treats a missing `event` as
// PENDING — author-private until the user submits it in GitHub's own UI. `event` is NEVER sent,
// so this tool can never Approve or Request-Changes anywhere.
export interface StagedReviewPayload {
  body: string;
  comments: StagedComment[];
  commit_id: string;
}

export function buildStagedReviewPayload(input: SummaryBodyInput): StagedReviewPayload {
  return {
    body: renderSummaryBody(input),
    comments: input.plan.inline.map((p) => ({
      body: renderInlineComment(p, input.plan.counts.reviewersRun),
      line: p.record.line as number, // anchorable() proved it
      path: p.record.file,
      side: 'RIGHT',
    })),
    commit_id: input.headSha,
  };
}
