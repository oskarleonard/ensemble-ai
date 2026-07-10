import { SEVERITIES, type Severity } from '../../core/types';

// ── Postable text derivation (A+) ──────────────────────────────────────────────────────
//
// The gate produces the EXACT text that will be posted to a PR — deterministically, so the
// posting step never runs an LLM (no downstream paraphrase / whisper-hop). The gate does NOT
// write free prose; it returns EDIT-OPS over the reviewer's own body, and this module APPLIES
// them under invariants that make "minimal edit" a mechanism, not a request:
//   • agree    → the body is postable VERBATIM (byte-identical). Any edit op ⇒ malformed.
//   • partial  → the body MINUS the overstatement: strike/replace ops narrow it. Kept text is
//                byte-identical by construction (we only touch quoted spans); a replacement may
//                introduce NO new entity (symbol/path/number) absent from the body or its hunk.
//   • false / unverified → not postable (null); handled by the caller, never reaches here.
// Any op that does not validate FAILS CLOSED to an escalation — never a silent paraphrase.

export type PostableOp =
  | { op: 'strike'; quote: string; why?: string }
  | { op: 'replace'; quote: string; with: string; why?: string };

export type FixStatus = 'keep' | 'narrow' | 'strike';
export const FIX_STATUSES: readonly FixStatus[] = ['keep', 'narrow', 'strike'];

export type PostableStatus = 'postable' | 'escalated' | 'not-postable';

// WHERE a finding is allowed to land on a foreign PR (spec §6, the posting posture). The gate
// assigns it — the posting path never runs a model, it reads this. `bug` is the DEFAULT for a
// missing/unrecognized class: a grounded finding the gate forgot to label belongs where the
// author will see it (inline), not hidden in a collapsed section.
export const POSTABLE_CLASSES = ['bug', 'quality'] as const;
export type PostableClass = (typeof POSTABLE_CLASSES)[number];

// A gate-verified small replacement, postable as a GitHub ```suggestion``` block anchored at the
// finding's own cited line. Text ONLY — the anchor is the host's (`record.line`), never the
// model's, so a suggestion can never be applied to a line the finding did not cite.
export interface PostableSuggestion {
  replacement: string;
}

// A hostile-input ceiling, not the posting policy. The per-review CAP (2–3) and the per-suggestion
// line budget are CONSUMER config (posting-config.ts); this only bounds what a crafted gate reply
// can push into an artifact.
export const SUGGESTION_LINE_CEILING = 10;
const SUGGESTION_CHAR_CAP = 800;

// A replacement is rendered INSIDE a ```suggestion fence. A fence line within it closes ours early
// and hands the rest of the comment back to the markdown renderer — at worst opening a SECOND
// ```suggestion block, i.e. a one-click APPLY button on text the gate never verified. The
// no-new-entity rule cannot catch this: `entityTokens` scans `[A-Za-z0-9_$./-]{2,}`, so a backtick
// is invisible to it. Checked explicitly, fails closed.
//
// Exported because the posting path re-checks it: `planPlacement` reads `postableSuggestion` off a
// durable v4 trail record (or a hand-built one, via the exported library API), which never passed
// through this module's validation.
const FENCE_LINE_RE = /^[ \t]*(`{3,}|~{3,})/m;
export function containsFenceLine(s: string): boolean {
  return FENCE_LINE_RE.test(s);
}

export interface PostableResult {
  postableBody: string | null; // exact text to post; null ⇒ do not post
  postableFix: FixStatus | null; // disposition of the reviewer's suggested fix
  // A gate-verified one-click replacement; null ⇒ none offered or it failed validation.
  postableSuggestion: PostableSuggestion | null;
  rescoredSeverity: Severity | null; // gate's down-scored severity (never higher); null ⇒ unchanged
  postableStatus: PostableStatus;
  postableNote?: string; // escalation / audit reason
}

// A partial that strikes more than this fraction of its body wasn't "narrowed" — the reviewer
// was mostly wrong, which is `unverified`/`false` territory, not `partial`. Fail closed.
export const MAX_STRIKE_FRACTION = 0.6;

const escalate = (postableNote: string): PostableResult => ({
  postableBody: null,
  postableFix: null,
  postableStatus: 'escalated',
  postableSuggestion: null,
  rescoredSeverity: null,
  postableNote,
});

// An "entity" is a token a paraphrase must not invent: it carries a `.`/`/`/`_`/`$`, a digit,
// internal camelCase, or is an ALL-CAPS constant. Plain prose words are free to rephrase; a new
// symbol/path/number is drift and is rejected. Case-sensitive on purpose (identifiers are).
function isEntityLike(tok: string): boolean {
  if (/[._/$\d]/.test(tok)) return true; // path / member / number
  if (/[a-z][A-Z]/.test(tok)) return true; // camelCase / PascalCase boundary
  if (tok.length >= 2 && tok === tok.toUpperCase() && /[A-Z]/.test(tok)) return true; // CONSTANT
  return false;
}

function entityTokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const tok of s.match(/[A-Za-z0-9_$./-]{2,}/g) ?? []) if (isEntityLike(tok)) out.add(tok);
  return out;
}

// Collapse the whitespace/punctuation seam a strike leaves behind (" foo  ,bar" → "foo, bar")
// without touching interior text — purely cosmetic tidy of the cut edge.
function tidy(s: string): string {
  return s
    .replace(/\s+([,.;:])/g, '$1') // no space before punctuation
    .replace(/([([]) +/g, '$1') // no space after an opening bracket
    .replace(/ {2,}/g, ' ') // collapse runs
    .replace(/\s+\n/g, '\n')
    .trim();
}

// Apply the ops to the body. Each quote must be a UNIQUE substring of the CURRENT working body
// (ambiguity ⇒ fail closed — we won't guess which occurrence). Returns the narrowed body or an
// escalation note. `allowed` = entity tokens the reviewer body + cited hunk already contain.
function applyOps(body: string, ops: PostableOp[], allowed: Set<string>): { body: string } | { note: string } {
  let work = body;
  let struck = 0;
  for (const op of ops) {
    const at = work.indexOf(op.quote);
    if (at === -1) return { note: `op quote not found in body: "${op.quote.slice(0, 60)}"` };
    if (work.indexOf(op.quote, at + 1) !== -1) return { note: `op quote is ambiguous (>1 match): "${op.quote.slice(0, 60)}"` };
    if (op.op === 'strike') {
      struck += op.quote.length;
      work = work.slice(0, at) + work.slice(at + op.quote.length);
    } else {
      for (const tok of entityTokens(op.with)) {
        if (!allowed.has(tok)) return { note: `replacement introduces a new entity "${tok}" (not in body or hunk)` };
      }
      // a replace that shrinks the text counts its net deletion toward the strike budget
      struck += Math.max(0, op.quote.length - op.with.length);
      work = work.slice(0, at) + op.with + work.slice(at + op.quote.length);
    }
  }
  if (struck / Math.max(1, body.length) > MAX_STRIKE_FRACTION)
    return { note: `ops strike >${Math.round(MAX_STRIKE_FRACTION * 100)}% of the body — not a narrowing (should be unverified/false)` };
  const out = tidy(work);
  if (!out) return { note: 'ops reduced the body to empty' };
  return { body: out };
}

// Down-scored severity is honored ONLY when it's equal-or-less-severe than the host's stored
// severity — the gate may narrow, never inflate (the host owns severity). SEVERITIES is ordered
// most-severe-first, so a higher index = less severe.
function clampSeverity(original: Severity, rescored: Severity | undefined): Severity | null {
  if (!rescored || rescored === original) return null;
  return SEVERITIES.indexOf(rescored) > SEVERITIES.indexOf(original) ? rescored : null;
}

// Validate a gate-proposed one-click replacement under the SAME no-new-entity rule the edit-ops
// obey: a `suggestion` may only rearrange tokens the reviewer's body or its own cited hunk already
// contain. A replacement that invents an identifier, path, or number is drift — and drift with a
// one-click APPLY button is the most damaging robot comment there is. Fails closed to null.
//
// Offered ONLY on `agree` + `fixStatus: 'keep'` — i.e. the gate confirmed the finding as stated AND
// verified the reviewer's fix. The `agree` half is structural: the sole call site is derivePostable's
// `agree` branch, because a `partial` was narrowed and its fix no longer provably matches the
// narrowed claim (that branch hard-codes `postableSuggestion: null`); an unverified/false finding
// has nothing to fix.
function deriveSuggestion(
  suggestion: PostableSuggestion | undefined,
  fixStatus: FixStatus,
  allowed: Set<string>
): PostableSuggestion | null {
  if (!suggestion || fixStatus !== 'keep') return null;
  const replacement = suggestion.replacement.replace(/\s+$/, '');
  if (!replacement.trim()) return null;
  if (replacement.length > SUGGESTION_CHAR_CAP) return null;
  if (replacement.split('\n').length > SUGGESTION_LINE_CEILING) return null;
  if (containsFenceLine(replacement)) return null;
  for (const tok of entityTokens(replacement)) if (!allowed.has(tok)) return null;
  return { replacement };
}

// The entity tokens a gate reply may reuse: everything already present in the reviewer's own body
// plus its cited hunk. Shared by the edit-ops validator and the suggestion validator.
function allowedTokens(body: string, hunkCode: string[]): Set<string> {
  const allowed = entityTokens(body);
  for (const line of hunkCode) for (const t of entityTokens(line)) allowed.add(t);
  return allowed;
}

// Derive the postable text for one already-reconciled finding. Only agree/partial reach a
// postable outcome; everything else is not-postable. Pure.
export function derivePostable(input: {
  verdict: 'agree' | 'partial';
  body: string;
  hunkCode: string[];
  ops: PostableOp[];
  fixStatus: FixStatus | undefined;
  rescoredSeverity: Severity | undefined;
  severity: Severity;
  suggestion?: PostableSuggestion;
}): PostableResult {
  const { verdict, body, hunkCode, ops, fixStatus, rescoredSeverity, severity } = input;
  const trimmed = body.trim();
  if (!trimmed) return escalate('reviewer body is empty');

  if (verdict === 'agree') {
    // "confirmed as stated" ⇒ the whole body is grounded ⇒ post it verbatim. An edit op on an
    // agree is contradictory (if something needed striking it was partial) — fail closed.
    if (ops.length > 0) return escalate('agree verdict carried edit-ops (contradiction — should be partial)');
    const fix = fixStatus ?? 'keep';
    return {
      postableBody: trimmed,
      postableFix: fix,
      postableStatus: 'postable',
      postableSuggestion: deriveSuggestion(input.suggestion, fix, allowedTokens(trimmed, hunkCode)),
      rescoredSeverity: null,
    };
  }

  // partial: the body overstates ⇒ it MUST carry the edits that narrow it, else posting it
  // verbatim re-injects the overstatement the gate caught.
  if (ops.length === 0) return escalate('partial verdict carried no edit-ops to narrow the overstatement');
  const allowed = allowedTokens(trimmed, hunkCode);
  const applied = applyOps(trimmed, ops, allowed);
  if ('note' in applied) return escalate(applied.note);
  return {
    postableBody: applied.body,
    postableFix: fixStatus ?? 'narrow',
    postableStatus: 'postable',
    postableSuggestion: null, // a narrowed claim no longer provably supports the reviewer's fix
    rescoredSeverity: clampSeverity(severity, rescoredSeverity),
  };
}

// Parse the optional postable fields off one raw verdict entry — defensive, tolerant of
// absence (an old-shape reply simply yields []/undefined and the caller escalates a bare
// partial). Quotes/replacements are length-capped to bound a hostile reply.
const OP_QUOTE_CAP = 2000;
export function parsePostableOps(v: unknown): PostableOp[] {
  if (!Array.isArray(v)) return [];
  const out: PostableOp[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const quote = typeof e.quote === 'string' ? e.quote.slice(0, OP_QUOTE_CAP) : '';
    const why = typeof e.why === 'string' ? e.why.slice(0, 300) : undefined;
    if (!quote) continue;
    if (e.op === 'strike') out.push({ op: 'strike', quote, why });
    else if (e.op === 'replace' && typeof e.with === 'string')
      out.push({ op: 'replace', quote, why, with: e.with.slice(0, OP_QUOTE_CAP) });
  }
  return out;
}

export function parseFixStatus(v: unknown): FixStatus | undefined {
  return typeof v === 'string' && (FIX_STATUSES as readonly string[]).includes(v) ? (v as FixStatus) : undefined;
}

// The gate's placement class for one finding. An unrecognized value yields undefined and the
// caller defaults to `bug` — never silently demote a grounded finding into the quiet tier.
export function parsePostableClass(v: unknown): PostableClass | undefined {
  return typeof v === 'string' && (POSTABLE_CLASSES as readonly string[]).includes(v)
    ? (v as PostableClass)
    : undefined;
}

// Parse `{"suggestion": {"replacement": "..."}}` off a raw verdict entry. Length-capped here so a
// hostile reply cannot push an unbounded string into an artifact even before validation.
export function parseSuggestion(v: unknown): PostableSuggestion | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const replacement = (v as Record<string, unknown>).replacement;
  if (typeof replacement !== 'string' || !replacement.trim()) return undefined;
  return { replacement: replacement.slice(0, SUGGESTION_CHAR_CAP) };
}

export function parseSeverity(v: unknown): Severity | undefined {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v) ? (v as Severity) : undefined;
}
