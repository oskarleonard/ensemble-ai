// THE LEAD (2026-10-15): a plain-language line a doc-review synthesizer writes ABOVE each point —
// the PR findings' `tldr`, carried over to brainstorm/consult. A dashboard renders it as the row
// and folds the grounded text under it. Additive on every output shape: a model that omits it
// costs nothing (the host derives a line from the point's own text), and an old trail reads as
// before. The contract is the gate's: short, no paths/identifiers/section marks, what the reader
// hits, then the fix as "Let's …".
export const LEAD_MAX = 280;

export const LEAD_FIELD_DOC = `"lead": 1–2 sentences, at most ${LEAD_MAX} characters, in plain conversational English a reader of the
document follows without the code — no file paths, no identifiers (nothing in snake_case or
camelCase), no section marks (§), no backticks. Say what the reader hits or what is left open,
then the fix as "Let's …". Add nothing the point itself does not say.`;

/** Host cap: a chatty model cannot push an essay into the trail. */
export function capLead(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.length > LEAD_MAX ? `${t.slice(0, LEAD_MAX - 1).trimEnd()}…` : t;
}
