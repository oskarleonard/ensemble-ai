import { scrubControl } from '../../core/sanitize';
import type { DocRef } from '../../core/types';

// THE PRODUCT DOCS FILE, as the HOST reads it (the product seat, ./product). The host that fires a
// review writes one markdown file of product and design documents: a `# product docs: …` header,
// then one SOURCE per `## <key> — <title>` line, each followed by that source's body. The seat reads
// the whole file; the gate never does. This module is the host's own reading of the PINNED copy
// (`product-docs.md` in the trail — the exact bytes the seat was handed):
//
//  · the INDEX — which sources exist, where each section starts and ends, which are STALE;
//  · TEXT EXISTENCE — does a quoted run of complete lines really appear in the named source;
//  · the CONTEXT the gate is shown for one finding (never the whole file);
//  · the one `**Doc:**` line a verified finding posts with.
//
// The host owns text existence; the gate owns meaning. Nothing here asks a model anything, and
// nothing a document says can choose a key, a verdict, a severity, or what posts. PURE.

export const PRODUCT_DOCS_TRAIL_FILE = 'product-docs.md';

// The source header, anchored per line. The writer demotes a body's own `## ` lines to `### `, so
// document text can never mint a source — only the host that wrote the file names keys.
const SOURCE_HEADER_RE = /^## (\S+) — (.+)$/;
// A header ending in this marks a source whose mirror copy is old AND failed to refresh.
const STALE_MARK = ' STALE';

export interface ProductSource {
  // The body: 1-based lines from the one after the header through the one before the next header
  // (or the end of the file). The host records these itself; `end < start` is an empty body.
  end: number;
  header: number;
  key: string;
  stale: boolean;
  start: number;
  title: string;
}

export interface ProductDocsIndex {
  lines: string[];
  sources: ProductSource[];
}

export function indexProductDocs(text: string): ProductDocsIndex {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const sources: ProductSource[] = [];
  lines.forEach((raw, i) => {
    // A BOM can only lead the file, and the file leads with its `# product docs:` line — but strip it
    // per line anyway so a header the writer emitted first can never be lost to an invisible char.
    const m = SOURCE_HEADER_RE.exec(raw.replace(/^\uFEFF/, '').trimEnd());
    if (!m) return;
    const prev = sources[sources.length - 1];
    if (prev) prev.end = i; // the line before this header (1-based i)
    const stale = m[2].endsWith(STALE_MARK);
    sources.push({
      end: lines.length,
      header: i + 1,
      key: m[1],
      stale,
      start: i + 2,
      title: (stale ? m[2].slice(0, -STALE_MARK.length) : m[2]).trim(),
    });
  });
  return { lines, sources };
}

// ── Normalisation (applied to BOTH sides, identically) ────────────────────────────────
//
// A model copying a line out of a document drifts in ways that change no meaning: a smart quote
// typed straight, a list bullet dropped, `**bold**` copied without its stars, a non-breaking space,
// a zero-width joiner from the editor the doc came out of. Each is folded the same way on the quote
// and on the document, so a faithful copy matches and an unfaithful one still cannot: the fold is
// case-sensitive and never touches a word.
//
// MARKUP FIRST. A mirrored design doc is mostly markup (one real file: 675 of 1102 lines) — prose
// wrapped as `1. **\[DONE\] ✅ <span discussion-urls="…">A person who …</span>**`, tables as one
// `<td>cell</td>` per line, `<br>` inside cells, mention and empty-block tags, backslash escapes. A
// model quotes what it READS, so before the folds both sides are reduced to visible text: a `<br>` is
// a space; every other tag goes (a line that was only tags is then blank, and skipped like one); the
// common entities decode; an image goes and a link keeps its text; a backslash escape keeps its
// character. A faithful copy of the raw line folds to the same text, so it still matches too.

const BR_RE = /<br\s*\/?>/gi;
// A TAG is `<` straight followed by a tag name (or `/name`), attributes free of `<` and `>`. Never
// any `<…>`: "amount < 5 and fee > 3" is prose, and erasing the span between the two signs would let
// a quote with different numbers in it match the real line — a false VERIFY, the one failure a fold
// may not cause.
const TAG_RE = /<\/?[A-Za-z][\w:-]*(?:\s[^<>]*)?\/?>/g;
const ENTITY_RE = /&(amp|lt|gt|quot|#39|nbsp);/g;
const ENTITIES: Record<string, string> = { '#39': "'", amp: '&', gt: '>', lt: '<', nbsp: ' ', quot: '"' };
const IMAGE_RE = /!\[[^\]]*\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]*)\]\([^)]*\)/g;
// A backslash before ASCII punctuation is a markdown escape: `\[DONE\]` reads `[DONE]`.
const BACKSLASH_ESCAPE_RE = /\\([\x21-\x2F\x3A-\x40\x5B-\x60\x7B-\x7E])/g;

export function visibleDocText(line: string): string {
  return line
    .replace(BR_RE, ' ')
    .replace(TAG_RE, '')
    .replace(ENTITY_RE, (_, name: string) => ENTITIES[name] ?? '')
    .replace(IMAGE_RE, '')
    .replace(LINK_RE, '$1')
    .replace(BACKSLASH_ESCAPE_RE, '$1');
}

const SPACES_RE = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
const ZERO_WIDTH_RE = /[\u200B-\u200D\u2060\uFEFF]/g;
const SINGLE_QUOTES_RE = /[\u2018\u2019\u201A\u201B]/g;
const DOUBLE_QUOTES_RE = /[\u201C\u201D\u201E\u201F]/g;
const DASHES_RE = /[\u2010-\u2015\u2212]/g;
// Emphasis: every `*` (bold and italic alike), `__`, `~~`, backticks. A struck-through line still
// VERIFIES as text — whether it is a rule in force is the gate's call, and the gate reads it raw.
const EMPHASIS_RE = /\*+|__|~~|`+/g;
// One leading list / blockquote marker. Stripped repeatedly, so `> - item` folds to `item`.
const LEADING_MARKER_RE = /^(?:[-*+]\s+|\d+\.\s+|>\s*)/;

export function normalizeDocLine(line: string): string {
  let s = visibleDocText(line)
    .normalize('NFKC')
    .replace(ZERO_WIDTH_RE, '')
    .replace(SPACES_RE, ' ')
    .replace(SINGLE_QUOTES_RE, "'")
    .replace(DOUBLE_QUOTES_RE, '"')
    .replace(DASHES_RE, '-')
    // Emphasis goes BEFORE the markers: `**1.** Rule` must fold like the `1. Rule` a model copies.
    .replace(EMPHASIS_RE, '')
    .trimStart();
  for (let prev = ''; prev !== s; ) {
    prev = s;
    s = s.replace(LEADING_MARKER_RE, '');
  }
  return s.replace(/\s+/g, ' ').trim();
}

// A quote as the matcher compares it: its non-empty normalised lines.
export function normalizeQuoteLines(quote: string): string[] {
  return quote.replace(/\r\n?/g, '\n').split('\n').map(normalizeDocLine).filter(Boolean);
}

// The host's own cut notice ("… [cut at N KB of M]"), as it reads once normalised (NFKC spells the
// ellipsis as three dots). It is never document text: inside a section it is a BARRIER no quote may
// cross, so a "quote" stitched from the text either side of a cut can never verify.
const CUT_NOTICE_RE = /\.\.\. ?\[cut at [^\]]+\]$/;

// The citable lines of one section, in order: a line's normalised text, or null for a barrier.
// Blank lines are skipped (a quote may span a paragraph break or leave it out).
function citableLines(index: ProductDocsIndex, source: ProductSource): ({ line: number; text: string } | null)[] {
  const out: ({ line: number; text: string } | null)[] = [];
  for (let n = source.start; n <= source.end; n++) {
    const text = normalizeDocLine(index.lines[n - 1] ?? '');
    if (CUT_NOTICE_RE.test(text)) out.push(null);
    else if (text) out.push({ line: n, text });
  }
  return out;
}

// ── Text existence ────────────────────────────────────────────────────────────────────

// Below this, once normalised, a quote anchors nothing ("must be 403" is in every API doc).
export const MIN_DOC_QUOTE_CHARS = 20;

export interface DocSpan {
  end: number; // 1-based file lines, inclusive
  start: number;
}

export type DocQuoteMatch =
  | { ok: true; source: ProductSource; span: DocSpan }
  | { ok: false; reason: string };

export function sourcesForKey(index: ProductDocsIndex, key: string): ProductSource[] {
  return index.sources.filter((s) => s.key === key);
}

// Does `quote` appear in source `key` as a CONTIGUOUS run of complete lines? Every non-empty
// normalised quote line must EQUAL the next non-empty normalised line of the section — so a
// fragment of a line, an elided quote ("… must …"), a paraphrase, a host header, or a run that
// crosses a section or a cut notice cannot match. The first occurrence wins.
export function findDocQuote(index: ProductDocsIndex, key: string, quote: string): DocQuoteMatch {
  const want = normalizeQuoteLines(quote);
  if (want.join(' ').length < MIN_DOC_QUOTE_CHARS)
    return { ok: false, reason: `the quote is under ${MIN_DOC_QUOTE_CHARS} characters once normalised — too little to anchor a document claim` };
  for (const source of sourcesForKey(index, key)) {
    const hay = citableLines(index, source);
    for (let i = 0; i + want.length <= hay.length; i++) {
      if (want.every((w, j) => hay[i + j]?.text === w)) {
        return { ok: true, source, span: { end: hay[i + want.length - 1]!.line, start: hay[i]!.line } };
      }
    }
  }
  return {
    ok: false,
    reason: `the quote does not appear in source "${key}" as complete lines (compared line for line after normalisation — a fragment, an elision or a paraphrase never matches)`,
  };
}

// ── Where the quote sits: its heading path ────────────────────────────────────────────

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const FENCE_RE = /^ {0,3}(?:```|~~~)/;

// The headings above a span, inside its section (the source title is NOT part of it: a title often
// says "draft" of a document whose rules are in force). `atStart` is the path to the quote's first
// line; `all` is every heading in force anywhere in the span — a quote that runs into a "Non-goals"
// heading is partly a non-goal. A `#` inside a fenced code block is code, not a heading.
export function docHeadingPath(index: ProductDocsIndex, source: ProductSource, span: DocSpan): { all: string[]; atStart: string[] } {
  const stack: { level: number; text: string }[] = [];
  const all = new Set<string>();
  let atStart: string[] = [];
  let inFence = false;
  for (let n = source.start; n <= span.end; n++) {
    const raw = index.lines[n - 1] ?? '';
    if (FENCE_RE.test(raw)) inFence = !inFence;
    const m = inFence ? null : HEADING_RE.exec(raw);
    if (m) {
      const level = m[1].length;
      while (stack.length > 0 && stack[stack.length - 1].level >= level) stack.pop();
      stack.push({ level, text: normalizeDocLine(m[2]) });
    }
    if (n === span.start) atStart = stack.map((h) => h.text);
    if (n >= span.start) for (const h of stack) all.add(h.text);
  }
  return { all: [...all], atStart };
}

// Headings under which a sentence is not a rule in force. A superset of the reviewed list (it also
// folds "out-of-scope", "non goals", "open questions"): a wider net here only ever DOWNGRADES.
//
// ANCHORED to the heading's start (after any "7.2" numbering the fold left): a heading that IS such a
// section, never one that uses the word as domain language — an invoicing or payments design has
// "Draft invoices", "Rejected payments" and "Alternative payment methods", and those rules ARE in
// force. "Non-goals for v1" / "Open questions (resolved)" still read as their section; the bare words
// that double as domain terms (alternative(s), draft(s), deprecated, superseded) count only as the
// whole heading. A miss here costs nothing: the gate still reads the heading path and judges it.
const NUMBERING = String.raw`(?:\d+(?:\.\d+)*\.?\s+)?`;
const NON_NORMATIVE_PREFIX_RE = new RegExp(
  `^${NUMBERING}(?:non[\\s-]?goals?|out[\\s-]of[\\s-]scope|open[\\s-]questions?|alternatives?\\s+(?:considered|explored|evaluated|rejected)|rejected\\s+(?:alternatives?|options?|approaches?|designs?|ideas?))\\b`,
  'i'
);
const NON_NORMATIVE_WHOLE_RE = new RegExp(`^${NUMBERING}(?:alternatives?|drafts?|deprecated|superseded)\\s*:?$`, 'i');

export function nonNormativeHeading(path: readonly string[]): string | null {
  return path.find((h) => NON_NORMATIVE_PREFIX_RE.test(h) || NON_NORMATIVE_WHOLE_RE.test(h)) ?? null;
}

// ── What the gate is shown for one finding ────────────────────────────────────────────

export const DOC_CONTEXT_RADIUS = 8;
// A context line is a paragraph at most; the QUOTED lines are shown whole (the parser bounds them).
const CONTEXT_LINE_CAP = 500;

export interface DocContext {
  headingPath: string[];
  lines: { line: number; quoted: boolean; text: string }[];
  source: ProductSource;
}

// The quoted lines with ±radius lines of their own section around them, plus the heading path.
// The gate reads the quote IN CONTEXT — "MUST return 403" under "Rejected alternatives" is not a
// rule — but it never receives the whole file.
export function docContext(index: ProductDocsIndex, source: ProductSource, span: DocSpan, radius = DOC_CONTEXT_RADIUS): DocContext {
  const from = Math.max(source.start, span.start - radius);
  const to = Math.min(source.end, span.end + radius);
  const lines: DocContext['lines'] = [];
  for (let n = from; n <= to; n++) {
    const raw = index.lines[n - 1] ?? '';
    const quoted = n >= span.start && n <= span.end;
    lines.push({ line: n, quoted, text: !quoted && raw.length > CONTEXT_LINE_CAP ? `${raw.slice(0, CONTEXT_LINE_CAP)}…` : raw });
  }
  return { headingPath: docHeadingPath(index, source, span).atStart, lines, source };
}

// ── The posted line ───────────────────────────────────────────────────────────────────

export const DOC_LINE_QUOTE_CAP = 300;
const MARKDOWN_SPECIALS_RE = /[\\`*_[\]()<>#|]/g;

// Escape every character that could turn document text into markup on a PR: a link, an image, a
// heading, a table cell, a code span, an HTML tag or comment. One pass, so a backslash is escaped
// exactly once.
export function escapeDocMarkdown(s: string): string {
  return s.replace(MARKDOWN_SPECIALS_RE, '\\$&');
}

// `**Doc:** <key> — "<quote>"` — a FIXED template: the key and the quote are data inside it, never
// structure. Newlines become " / " so the quote stays one line, and it is cut (by code point, the
// ellipsis counted) at DOC_LINE_QUOTE_CAP before escaping, so an escape is never split.
export function renderDocLine(ref: Pick<DocRef, 'key' | 'quote'>): string {
  const flat = ref.quote
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(scrubControl)
    .filter(Boolean)
    .join(' / ');
  const cps = [...flat];
  const cut = cps.length > DOC_LINE_QUOTE_CAP ? `${cps.slice(0, DOC_LINE_QUOTE_CAP - 1).join('').trimEnd()}…` : flat;
  return `**Doc:** ${escapeDocMarkdown(scrubControl(ref.key))} — "${escapeDocMarkdown(cut)}"`;
}
