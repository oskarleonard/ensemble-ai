import type { VoiceAnswerResult, VoiceCritiqueResult } from './types';

// A stateless voice has ONLY this prompt text, so every round embeds exactly what
// the voice may see and closes with a STRICT one-JSON-block output contract (the
// reply is machine-read, not freeform prose). Same discipline as review/brainstorm.

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
  return `\n## Context\n${body}\n`;
}

// Round 1 — ANSWER, INDEPENDENTLY. The voice sees ONLY the question (+ optional
// context), NEVER the other voices' answers, so the answers are genuinely
// independent (no anchoring). This is what makes agreement across voices MEAN
// something: if they concur without seeing each other, that is a real signal.
export function renderAnswerPrompt(question: string, fileContext?: string): string {
  return `You are an independent expert answering a question inside a multi-model
consultation. Work ENTIRELY ON YOUR OWN: you have no knowledge of anyone else's
answer — do not hedge toward, anticipate, or defer to a consensus. Give YOUR honest,
reasoned answer. Where you are uncertain, say so plainly.

## Question
${question.trim()}
${contextBlock(fileContext)}
## Output format — STRICT
${JSON_RULE}
{
  "summary": "<your bottom-line answer in one sentence>",
  "answer": "<your full reasoned answer: the recommendation and the WHY>",
  "keyPoints": ["<a discrete claim or consideration behind your answer>"]
}
Give 2-5 keyPoints — the load-bearing claims of your answer, each a standalone
sentence (these are what the ensemble compares across voices). Be decisive; do not
pad.
`;
}

// Render the peer answers a critic sees (the OTHER voices' answers, labelled by
// voice). The critic never sees its OWN answer — the caller filters it out before
// calling this, which is what makes round 2 a CROSS-critique.
function peerAnswersBlock(peers: VoiceAnswerResult[]): string {
  return peers
    .map(
      (p) =>
        `[${p.voiceId}] ${p.summary}\n${p.answer}${p.keyPoints.length ? `\n- ${p.keyPoints.join('\n- ')}` : ''}`
    )
    .join('\n\n');
}

// Optional round 2 — CROSS-CRITIQUE (off by default). Each voice reads the OTHERS'
// answers and notes where it agrees, where it pushes back, and where an answer needs
// refining. Feeds the synthesizer richer signal than the raw answers alone.
export function renderCritiquePrompt(
  question: string,
  peers: VoiceAnswerResult[],
  fileContext?: string
): string {
  return `You are a sharp, candid participant in a multi-model consultation. Below are
answers from the OTHER voices (you did not write these) to the question. For the
strongest points, say where you AGREE, where you have a CONCERN or disagree, and where
an answer should be REFINED. Be specific — this sharpens the final synthesis.

## Question
${question.trim()}
${contextBlock(fileContext)}
## Answers from the other voices
${peerAnswersBlock(peers)}

## Output format — STRICT
${JSON_RULE}
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

// Cap each untrusted free-text field folded into the synthesis prompt (answers are
// model output of unbounded length; the whole prompt is one argv element to the voice
// CLI, so a verbose round could grow it past OS limits). Generous — a real answer is
// a few hundred to low-thousands of chars.
const SYNTHESIS_FIELD_BUDGET = 2500;
function cap(s: string): string {
  return s.length > SYNTHESIS_FIELD_BUDGET
    ? `${s.slice(0, SYNTHESIS_FIELD_BUDGET)}…[truncated]`
    : s;
}

function answersBlock(answers: VoiceAnswerResult[]): string {
  return answers
    .filter((a) => a.ok)
    .map(
      (a) =>
        `[${a.voiceId}] ${cap(a.summary)}\n${cap(a.answer)}${a.keyPoints.length ? `\nkey points:\n- ${a.keyPoints.map(cap).join('\n- ')}` : ''}`
    )
    .join('\n\n');
}

function critiqueBlock(critique: VoiceCritiqueResult[]): string {
  const lines: string[] = [];
  for (const c of critique) {
    if (!c.ok) continue;
    for (const n of c.notes) {
      lines.push(`(${c.voiceId}) ${n.stance} on ${cap(n.target)}: ${cap(n.assessment)}`);
    }
  }
  return lines.length ? `\n\n## Cross-critique notes\n${lines.join('\n')}` : '';
}

// Round 3 — CONVERGE. One voice reads every independent answer (+ any critique) and
// separates SIGNAL: what the voices AGREE on (confident) vs where they DIVERGE (look
// closer), then gives a bottom-line recommendation. The agree/diverge split IS the
// product — a lone model can't produce it, only an ensemble can.
export function renderSynthesisPrompt(
  question: string,
  answers: VoiceAnswerResult[],
  critique: VoiceCritiqueResult[]
): string {
  return `You are the SYNTHESIZER for a multi-model consultation. Several models each
answered the SAME question INDEPENDENTLY (they did not see each other's answers).
Compare them and separate the signal:
- AGREEMENTS: substantive points the voices CONCUR on — these are the confident core.
- DIVERGENCES: points they answered DIFFERENTLY — flag these as "look closer", and
  record who took which position.
Then give ONE bottom-line recommendation, noting how much of it rests on agreement
vs on a judgement call between diverging views.

## Question
${question.trim()}

## Independent answers
${answersBlock(answers)}${critiqueBlock(critique)}

## Output format — STRICT
${JSON_RULE}
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
