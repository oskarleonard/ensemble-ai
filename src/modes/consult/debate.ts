import { extractJsonBlock, oneOf } from '../../core/findings';

import { cap, contextBlock, JSON_RULE } from './prompt';
import {
  type ConsultSynthesis,
  DEBATE_STANCES,
  type DebateEntry,
  type DebateEvidence,
  type DebateRound,
  type DebateSplit,
  type DebateStance,
  RULING_OUTCOMES,
  type RulingOutcome,
  type SplitRuling,
  type VoiceAnswerResult,
  type VoiceId,
} from './types';

// The DEBATE rounds and the JUDGE — prompts, parsers and the pure round rules. The
// orchestration (spawning, timing, logging) stays in index.ts; everything here is
// deterministic and unit-testable without a voice. Design notes live on the types.

// ── Prompts ──────────────────────────────────────────────────────────────────

function splitsBlock(splits: DebateSplit[]): string {
  return splits
    .map((s) => `[${s.id}] ${cap(s.point)}\n${s.positions.map((p) => `  - ${cap(p)}`).join('\n')}`)
    .join('\n\n');
}

function evidenceLines(ev: DebateEvidence[]): string {
  if (ev.length === 0) return '    evidence: none brought';
  return ev.map((e) => `    evidence (${cap(e.source)}): "${cap(e.quote)}" — ${cap(e.bearing)}`).join('\n');
}

function entryBlock(e: DebateEntry): string {
  const lines = [`    position: ${cap(e.position)}`, `    stance: ${e.stance}`, evidenceLines(e.evidence)];
  if (e.rebuttal) lines.push(`    rebuttal: ${cap(e.rebuttal)}`);
  if (e.movedBecause) lines.push(`    moved because: ${cap(e.movedBecause)}`);
  if (e.wouldChangeMind) lines.push(`    would change mind: ${cap(e.wouldChangeMind)}`);
  return lines.join('\n');
}

// What a voice sees of the LAST round on the splits still open: the other side's entries in
// full (that is what it must answer) and its own last position (so it argues from where it
// stood, not from scratch).
function priorRoundBlock(voiceId: VoiceId, last: DebateRound | undefined, splitIds: string[]): string {
  if (!last) return '';
  const out: string[] = [];
  for (const id of splitIds) {
    const theirs = last.voices.filter((v) => v.ok && v.voiceId !== voiceId);
    const mine = last.voices.find((v) => v.ok && v.voiceId === voiceId)?.entries.find((e) => e.splitId === id);
    const lines: string[] = [`[${id}]`];
    for (const v of theirs) {
      const e = v.entries.find((x) => x.splitId === id);
      if (e) lines.push(`  ${v.voiceId}, last round:\n${entryBlock(e)}`);
    }
    if (mine) lines.push(`  you, last round: ${cap(mine.position)} (${mine.stance})`);
    if (lines.length > 1) out.push(lines.join('\n'));
  }
  return out.length ? `\n## Last round (round ${last.round}) on the splits still open\n${out.join('\n\n')}\n` : '';
}

function ownAnswerBlock(own: VoiceAnswerResult | undefined): string {
  if (!own || !own.ok) return '';
  const kp = own.keyPoints.length ? `\n- ${own.keyPoints.map(cap).join('\n- ')}` : '';
  return `\n## Your original answer\n${cap(own.summary)}${kp}\n`;
}

export function renderDebatePrompt(args: {
  fileContext?: string;
  maxRounds: number;
  own: VoiceAnswerResult | undefined;
  prior: DebateRound[];
  question: string;
  round: number;
  splits: DebateSplit[];
  voiceId: VoiceId;
}): string {
  const { fileContext, maxRounds, own, prior, question, round, splits, voiceId } = args;
  const last = prior[prior.length - 1];
  return `You are [${voiceId}], one side in an evidence DEBATE inside a multi-model consultation.
The voices answered a question independently; a synthesizer found the points below where
you and the other side DIVERGED. Argue YOUR side of each split — with PROOF — and answer
the other side. Round ${round} of ${maxRounds}.

Rules:
- Evidence first. For every split bring the strongest CHECKABLE evidence you can: a quote
  from the document (source "doc §<section>"), a web source (source "web <url>", and what
  it states), or a mechanism argument (source "reasoning"). Use your tools — search, fetch —
  wherever a fact can be checked; a claim nobody checked is worth little to the judge.
- You may MOVE or CONCEDE only by naming the evidence that moved you (movedBecause).
  Agreeing to be agreeable is a failure. Holding without evidence is also a failure — if
  no evidence exists either way, say so in wouldChangeMind.
- In rebuttal, answer the other side's actual evidence, not its wording.
- One or two sentences per field; quotes may be longer.

## Question
${question.trim()}
${contextBlock(fileContext)}${ownAnswerBlock(own)}
## The splits
${splitsBlock(splits)}
${priorRoundBlock(voiceId, last, splits.map((s) => s.id))}
## Output format — STRICT
${JSON_RULE}
{
  "splits": [
    {
      "id": "<split id, exactly as listed>",
      "position": "<your position after this round>",
      "stance": "hold" | "move" | "concede",
      "evidence": [
        { "source": "doc §3.2 | web <url> | reasoning", "quote": "<what it says>", "bearing": "<what it shows for this split>" }
      ],
      "rebuttal": "<your answer to the other side's position and evidence>",
      "movedBecause": "<required when stance is move or concede: the evidence that moved you>",
      "wouldChangeMind": "<what would change your mind, or what you could not verify>"
    }
  ]
}
Cover every split id listed. "concede" = you now agree with the other side; "move" = you
changed part of your position; "hold" = you stand, with evidence.
`;
}

function roundsBlock(rounds: DebateRound[], splits: DebateSplit[]): string {
  return splits
    .map((s) => {
      const lines = [`[${s.id}] ${cap(s.point)}`, ...s.positions.map((p) => `  opening: ${cap(p)}`)];
      for (const r of rounds) {
        if (!r.splitIds.includes(s.id)) continue;
        for (const v of r.voices) {
          if (!v.ok) {
            lines.push(`  round ${r.round}, ${v.voiceId}: (no entry — ${cap(v.error ?? 'failed')})`);
            continue;
          }
          const e = v.entries.find((x) => x.splitId === s.id);
          if (e) lines.push(`  round ${r.round}, ${v.voiceId}:\n${entryBlock(e)}`);
        }
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

function draftBlock(draft: ConsultSynthesis): string {
  const agree = draft.agreements.length
    ? `\nagreements (not in dispute):\n- ${draft.agreements.map((a) => cap(a.point)).join('\n- ')}`
    : '';
  return `${cap(draft.summary)}${agree}\n\ndraft recommendation:\n${cap(draft.recommendation)}`;
}

// THE BLIND JUDGE (2026-10-09, hugin spec doc-review-evidence "judge impartiality"): the judge
// never sees which model argued which side. Every voice id in the splits, the rounds and the
// draft is replaced by a neutral label ("Voice A", "Voice B", …) before the prompt is built, and
// the rulings are mapped back to the ids afterwards (deanonymizeJudgeText). A judge that is a
// different model of the same vendor still leans toward its own house's review when it can
// recognise it; with the labels, it rules on the evidence or on nothing.
export type VoiceAlias = Record<string, string>;

/** Deterministic labels in roster order — letters carry no vendor. */
export function voiceAliases(voiceIds: readonly string[]): VoiceAlias {
  const out: VoiceAlias = {};
  voiceIds.forEach((id, i) => (out[id] = `Voice ${String.fromCharCode(65 + (i % 26))}`));
  return out;
}

/** Replace every voice id (whole word, any case) in a text with its label. */
export function anonymizeVoiceText(text: string, alias: VoiceAlias): string {
  let out = text;
  for (const [id, label] of Object.entries(alias)) out = out.replace(new RegExp(`\\b${id}\\b`, 'gi'), label);
  return out;
}

/**
 * The inverse: labels back to ids, so rulings name the voices for the reader. The full label
 * ("Voice A", any case/spacing) always maps back. Judges also shorten to a bare letter — "A/C's
 * distinction stands, and B concedes" (hugin run b27c794b, 2026-10-09, 21 leaks) — and a bare
 * capital letter is only mapped back where the surrounding words make it a voice and not the
 * article or an initial: a possessive, a slash chain (A/B/C), a conjunction chain with another
 * label (A, B and C), a preposition before it (by C, toward B), a colon/paren label, or one of
 * the debate verbs after it (A moved, C demonstrates). "A separate guard …" stays as written.
 */
export function deanonymizeJudgeText(text: string, alias: VoiceAlias): string {
  let out = text;
  const letterOf: Record<string, string> = {};
  for (const [id, label] of Object.entries(alias)) {
    out = out.replace(new RegExp(label.replace(/\s/g, '\\s*'), 'gi'), id);
    const letter = label.replace(/^Voice\s*/i, '');
    if (letter.length === 1) letterOf[letter.toUpperCase()] = id;
  }
  const letters = Object.keys(letterOf);
  if (letters.length === 0) return out;
  const L = `[${letters.join('')}]`;
  const re = new RegExp(`(?<![A-Za-z0-9§#_])(${L})(?![a-z0-9_])`, 'g');
  const verbs =
    'moved|moves|move|concedes|conceded|concede|demonstrates|demonstrated|agrees|agreed|holds|held|stands|stood|argues|argued|cites|cited|shows|showed|claims|claimed|answered|answers|proposed|proposes|notes|noted|asserts|asserted|maintains|maintained|accepts|accepted|disputes|disputed|rejects|rejected|misreads|misread|overstates|overstated|conflates|conflated|relies|relied|points|pointed|treats|treated|reads|read|identifies|identified|offers|offered|presents|presented|prevails|prevailed|yields|yielded|initially|rightly|correctly|wrongly';
  const preps = 'by|with|to|toward|towards|from|than|against|between|unlike|like|versus|vs\\.?|of|for|both|neither|either|nor|per';
  const afterOk = new RegExp(`^(?:['’]s\\b|\\s*/\\s*${L}\\b|\\s*,\\s*${L}\\b|\\s+(?:and|or)\\s+${L}\\b|\\s*:|\\)|\\s+(?:${verbs})\\b)`);
  const beforeOk = new RegExp(`(?:${L}\\s*/\\s*|${L}\\s*,\\s*|${L}\\s+(?:and|or)\\s+|\\b(?:${preps})\\s+|\\()$`, 'i');
  return out.replace(re, (m, letter: string, at: number, whole: string) => {
    const id = letterOf[letter];
    if (!id) return m;
    const after = whole.slice(at + 1, at + 40);
    const before = whole.slice(Math.max(0, at - 40), at);
    return afterOk.test(after) || beforeOk.test(before) ? id : m;
  });
}

export function renderJudgePrompt(args: {
  draft: ConsultSynthesis;
  fileContext?: string;
  question: string;
  rounds: DebateRound[];
  splits: DebateSplit[];
  /** When given, every voice id in the splits/rounds/draft is replaced by its label. */
  alias?: VoiceAlias;
}): string {
  const { draft, fileContext, question, rounds, splits, alias } = args;
  const hide = (t: string) => (alias ? anonymizeVoiceText(t, alias) : t);
  return `You are the JUDGE of a multi-model consultation. You took NO part in it. Several
models answered a question independently; a synthesizer separated what they agree on from
where they diverge; the diverging voices then argued each split with evidence over
${rounds.length} round(s). Rule on EVERY split BY THE EVIDENCE — never by which argument is
longer, which model wrote it, or your own prior — then write the final recommendation in
light of your rulings.${alias ? ' The voices are labelled Voice A, Voice B, … — you are not told which model is which, on purpose. Always write the full label ("Voice A"), never a bare letter.' : ''}

Outcomes:
- "settled": the evidence decides it. Say which position stands and why, citing the evidence.
- "converged": a voice moved or conceded for a stated reason. Record where they landed.
- "judgement": both positions are reasonable and the evidence does not decide. Do NOT pick a
  winner: state the trade-off in one line and a default.
- "unverified": it turns on a fact nobody checked. Say what would settle it and a default.
A ruling that cites no evidence is not a ruling — if you find yourself choosing on taste,
the outcome is "judgement".

## Question
${question.trim()}
${contextBlock(fileContext)}
## The splits, with every round
${hide(roundsBlock(rounds, splits))}

## The synthesizer's draft (before the debate)
${hide(draftBlock(draft))}

## Output format — STRICT
${JSON_RULE}
{
  "summary": "<how the debate changed the picture, 2-3 sentences>",
  "rulings": [
    {
      "splitId": "<split id, exactly as listed>",
      "outcome": "settled" | "converged" | "judgement" | "unverified",
      "direction": "<settled/converged: the position that stands, and whose · judgement: the trade-off · unverified: the unchecked fact>",
      "why": "<the ruling's reason, resting on the evidence>",
      "evidenceCited": ["<voice>: <source>"],
      "whatWouldSettle": "<unverified only: the data, test or author's answer that would settle it>",
      "defaultIfUndecided": "<judgement/unverified: the default to take if the human does not decide>"
    }
  ],
  "recommendation": "<verdict sentence(s)\\n\\n1. <action or blocker>\\n2. …\\n\\n<how confident, given what is settled vs still a judgement call>"
}
Cover every split id. Keep the agreements as they are — they were not in dispute.
`;
}

// ── Parsers ──────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(str).filter(Boolean))];
}

function parseEvidence(v: unknown): DebateEvidence[] {
  if (!Array.isArray(v)) return [];
  const out: DebateEvidence[] = [];
  for (const re of v) {
    if (!re || typeof re !== 'object') continue;
    const e = re as Record<string, unknown>;
    const source = str(e.source);
    const quote = str(e.quote);
    const bearing = str(e.bearing);
    if (!source && !quote) continue;
    out.push({ bearing, quote, source: source || 'unstated' });
  }
  return out;
}

export interface ParsedDebateReply {
  // Moves the parser downgraded to holds for lack of a stated reason — surfaced on the log.
  downgraded: string[];
  entries: DebateEntry[];
  parseError?: string;
}

// One voice's debate reply → entries for the split ids this round argued. Unknown ids are
// dropped (a voice cannot open a split of its own); a move/concede with no movedBecause is
// downgraded to a hold, since a move the voice cannot ground is the sycophancy the rules forbid.
export function parseDebateReply(raw: string, splitIds: readonly string[]): ParsedDebateReply {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== 'object') {
    return { downgraded: [], entries: [], parseError: 'no parseable JSON block in the output' };
  }
  const o = obj as Record<string, unknown>;
  if (!Array.isArray(o.splits)) return { downgraded: [], entries: [], parseError: 'output has no "splits" array' };
  const known = new Set(splitIds);
  const seen = new Set<string>();
  const entries: DebateEntry[] = [];
  const downgraded: string[] = [];
  for (const rs of o.splits) {
    if (!rs || typeof rs !== 'object') continue;
    const s = rs as Record<string, unknown>;
    const id = str(s.id);
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    const position = str(s.position);
    const rebuttal = str(s.rebuttal);
    if (!position && !rebuttal) continue;
    let stance: DebateStance = oneOf(DEBATE_STANCES, s.stance, 'hold');
    const movedBecause = str(s.movedBecause);
    if (stance !== 'hold' && !movedBecause) {
      stance = 'hold';
      downgraded.push(id);
    }
    const wouldChangeMind = str(s.wouldChangeMind);
    entries.push({
      evidence: parseEvidence(s.evidence),
      ...(stance !== 'hold' ? { movedBecause } : {}),
      position,
      rebuttal,
      splitId: id,
      stance,
      ...(wouldChangeMind ? { wouldChangeMind } : {}),
    });
  }
  if (entries.length === 0) return { downgraded, entries, parseError: 'output covers none of the splits' };
  return { downgraded, entries };
}

export interface ParsedJudgeReply {
  parseError?: string;
  recommendation: string;
  rulings: SplitRuling[];
  summary: string;
}

export function parseJudgeReply(raw: string, splitIds: readonly string[]): ParsedJudgeReply {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== 'object') {
    return { parseError: 'no parseable JSON block in the output', recommendation: '', rulings: [], summary: '' };
  }
  const o = obj as Record<string, unknown>;
  const summary = str(o.summary);
  const recommendation = str(o.recommendation);
  const known = new Set(splitIds);
  const seen = new Set<string>();
  const rulings: SplitRuling[] = [];
  if (Array.isArray(o.rulings)) {
    for (const rr of o.rulings) {
      if (!rr || typeof rr !== 'object') continue;
      const r = rr as Record<string, unknown>;
      const splitId = str(r.splitId);
      if (!known.has(splitId) || seen.has(splitId)) continue;
      const direction = str(r.direction);
      const why = str(r.why);
      if (!direction && !why) continue;
      seen.add(splitId);
      const outcome: RulingOutcome = oneOf(RULING_OUTCOMES, r.outcome, 'judgement');
      const evidenceCited = strList(r.evidenceCited);
      const whatWouldSettle = str(r.whatWouldSettle);
      const defaultIfUndecided = str(r.defaultIfUndecided);
      rulings.push({
        ...(defaultIfUndecided ? { defaultIfUndecided } : {}),
        direction,
        evidenceCited,
        // A "settled" ruling that cites nothing is the taste call the prompt forbids — it is a
        // judgement call for the reader, and the UI says so.
        outcome: outcome === 'settled' && evidenceCited.length === 0 ? 'judgement' : outcome,
        splitId,
        ...(whatWouldSettle ? { whatWouldSettle } : {}),
        why,
      });
    }
  }
  if (rulings.length === 0 && !recommendation && !summary) {
    return { parseError: 'output has no "rulings", "recommendation" or "summary"', recommendation: '', rulings: [], summary: '' };
  }
  return { recommendation, rulings, summary };
}

// ── Round rules ──────────────────────────────────────────────────────────────

// Which splits go to another round: a split closes when a voice moved or conceded on it
// (there is nothing left to argue), or when nobody brought evidence this round (another
// round would be rhetoric). Otherwise there is unanswered evidence on the table — argue on.
export function splitsStillOpen(round: DebateRound, openIds: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of openIds) {
    const entries = round.voices.filter((v) => v.ok).flatMap((v) => v.entries.filter((e) => e.splitId === id));
    if (entries.length === 0) continue;
    const moved = entries.some((e) => e.stance !== 'hold');
    const evidence = entries.some((e) => e.evidence.length > 0);
    if (!moved && evidence) out.push(id);
  }
  return out;
}

export function splitsFromSynthesis(synthesis: ConsultSynthesis): DebateSplit[] {
  return synthesis.divergences.map((d, i) => ({ id: `split-${i + 1}`, point: d.point, positions: d.positions }));
}

// "3 settled, 1 converged, 2 judgement, 1 unverified" — the log line and the CLI's summary.
export function rulingsTally(rulings: readonly SplitRuling[]): string {
  const counts = new Map<RulingOutcome, number>();
  for (const r of rulings) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  return RULING_OUTCOMES.filter((o) => counts.has(o))
    .map((o) => `${counts.get(o)} ${o}`)
    .join(', ');
}
