import type { Idea, VoiceCritiqueResult } from './types';

// A stateless voice (no memory of the topic, the repo, or the other voices) has
// ONLY this prompt text — so every round embeds exactly what the voice may see, and
// closes with a STRICT one-JSON-block output contract so the reply is machine-read,
// not freeform prose. Same discipline as the review prompt.

const JSON_RULE =
  'Respond with ONE fenced ```json block and NOTHING else, matching:';

// Cap embedded file context so a huge file can't blow the prompt budget; the voice
// sees the head, clearly marked as truncated.
const FILE_CONTEXT_BUDGET = 24_000;

function contextBlock(fileContext?: string): string {
  if (!fileContext || !fileContext.trim()) return '';
  const trimmed = fileContext.trimEnd();
  const body =
    trimmed.length > FILE_CONTEXT_BUDGET
      ? `${trimmed.slice(0, FILE_CONTEXT_BUDGET)}\n…[context truncated]`
      : trimmed;
  return `\n## Shared context\n${body}\n`;
}

// Round 1 — GENERATE, INDEPENDENTLY. The voice sees ONLY the topic (+ optional
// shared context), NEVER the other voices' ideas, so the first round is genuinely
// divergent (no anchoring). Asks for a handful of distinct, non-obvious ideas.
export function renderGeneratePrompt(
  topic: string,
  fileContext?: string
): string {
  return `You are an independent idea generator in a multi-model brainstorm. Work
ENTIRELY ON YOUR OWN: you have no knowledge of anyone else's ideas — do not assume,
anticipate, or hedge toward a consensus. Bring range and non-obvious angles.

## Topic
${topic.trim()}
${contextBlock(fileContext)}
## Output format — STRICT
${JSON_RULE}
{
  "summary": "<one short paragraph: your overall angle on the topic>",
  "ideas": [
    { "title": "<short, specific>", "body": "<the idea: how it works and why it could win>" }
  ]
}
Return 4–6 DISTINCT ideas. Do not pad with weak ideas to fill the list.
`;
}

// Render the peer ideas a critic sees (the OTHER voices' ideas, by their assigned
// id + title + body). The critic never sees its OWN ideas — the caller filters them
// out before calling this, which is what makes round 2 a CROSS-critique.
function peerIdeasBlock(peerIdeas: Idea[]): string {
  return peerIdeas
    .map((i) => `[${i.id}] ${i.title}\n${i.body}`)
    .join('\n\n');
}

// Round 2 — CRITIQUE + EXTEND. Each voice sees the others' ideas and gives a candid
// assessment (support / concern / extend) plus NEW ideas the others missed or
// better combinations. "They talk to each other."
export function renderCritiquePrompt(
  topic: string,
  peerIdeas: Idea[],
  fileContext?: string
): string {
  return `You are a sharp, constructive critic in a multi-model brainstorm. Below are
ideas from the OTHER contributors (you did not write these). Assess the strongest
few candidly — where each is strong, where it is weak or risky — then EXTEND the
set: add ideas the others missed, or combinations better than any single one.

## Topic
${topic.trim()}
${contextBlock(fileContext)}
## Ideas from the other voices
${peerIdeasBlock(peerIdeas)}

## Output format — STRICT
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

// Cap each free-text field folded into the round-3 synthesis prompt. Ideas and
// critiques are UNTRUSTED model output of unbounded length; only the file context was
// budgeted before, so a verbose round 1/2 could grow the synthesis prompt (passed as a
// single argv element to the voice CLI) past sane/OS limits. Generous — a real idea
// body or assessment is a few hundred chars.
const SYNTHESIS_FIELD_BUDGET = 2000;
function cap(s: string): string {
  return s.length > SYNTHESIS_FIELD_BUDGET
    ? `${s.slice(0, SYNTHESIS_FIELD_BUDGET)}…[truncated]`
    : s;
}

// Render every idea (with its author) and every critique (with its critic) for the
// synthesizer. Authors/critics ARE labelled here (round 1's independence already
// happened) so the synthesis can credit contributors.
function allIdeasBlock(allIdeas: Idea[]): string {
  return allIdeas
    .map((i) => `[${i.id}] (${i.voiceId ?? '?'}) ${cap(i.title)}: ${cap(i.body)}`)
    .join('\n');
}

function critiquesBlock(critiqueResults: VoiceCritiqueResult[]): string {
  const lines: string[] = [];
  for (const c of critiqueResults) {
    if (!c.ok) continue;
    for (const cr of c.critiques) {
      lines.push(`(${c.voiceId}) ${cr.stance} on ${cap(cr.target)}: ${cap(cr.assessment)}`);
    }
    for (const ex of c.extensions) {
      lines.push(`(${c.voiceId}) extension — ${cap(ex.title)}: ${cap(ex.body)}`);
    }
  }
  return lines.length ? lines.join('\n') : '(no critiques)';
}

// Round 3 — CONVERGE. One voice reads every idea + every critique and produces a
// single ranked, DE-DUPLICATED recommendation: merge overlaps, weigh the critiques,
// rank best-first, and credit the contributors behind each winner.
export function renderSynthesisPrompt(
  topic: string,
  allIdeas: Idea[],
  critiqueResults: VoiceCritiqueResult[]
): string {
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

## Output format — STRICT
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
