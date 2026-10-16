import { describe, expect, it } from 'vitest';

import {
  DOC_LINE_QUOTE_CAP,
  docContext,
  docHeadingPath,
  escapeDocMarkdown,
  findDocQuote,
  indexProductDocs,
  MIN_DOC_QUOTE_CHARS,
  nonNormativeHeading,
  normalizeDocLine,
  renderDocLine,
} from './product-docs';
import { PRODUCT_DOCS } from './product-fixture';

const IDX = indexProductDocs(PRODUCT_DOCS);

describe('indexProductDocs — the host records the sources and their sections itself', () => {
  it('finds every `## <key> — <title>` line and bounds each section to the next header', () => {
    expect(IDX.sources.map((s) => [s.key, s.header, s.start, s.end, s.stale])).toEqual([
      ['engineering/acme-billing-tdd', 3, 4, 17, false],
      ['ACME-12', 18, 19, 24, false],
      ['product/acme-billing-prd', 25, 26, 27, true],
    ]);
    expect(IDX.sources[2].title).toBe('Acme billing PRD (prd, rev 2026-08-01, mirror as of 2026-08-01 — refresh failed: no access)');
  });

  it('never reads the file header, a demoted `### ` line, or a CRLF file differently', () => {
    expect(IDX.sources.some((s) => s.key === 'product')).toBe(false);
    expect(indexProductDocs(PRODUCT_DOCS.replace(/\n/g, '\r\n')).sources.map((s) => s.key)).toEqual(IDX.sources.map((s) => s.key));
    expect(indexProductDocs('\uFEFF## K-1 — t (ticket, rev 2026-01-01)\nbody').sources.map((s) => s.key)).toEqual(['K-1']);
    expect(indexProductDocs('# product docs: none — no ticket; product seat not spawned\n').sources).toEqual([]);
  });
});

describe('normalizeDocLine — the same fold on both sides, case-sensitive, never a word', () => {
  it.each([
    ['ＡＣＭＥ ﬁle', 'ACME file'], // NFKC
    ['a\u00A0b\u2009c\u202Fd', 'a b c d'], // NBSP, thin, narrow NBSP
    ['ze\u200Bro\u200Dwidth\uFEFF', 'zerowidth'],
    ['“quoted” ‘single’', '"quoted" \'single\''],
    ['en – em — minus −', 'en - em - minus -'],
    ['- bullet', 'bullet'],
    ['* star', 'star'],
    ['+ plus', 'plus'],
    ['12. numbered', 'numbered'],
    ['> quoted', 'quoted'],
    ['> - nested', 'nested'],
    ['**1.** bold number', 'bold number'],
    ['**bold** and __under__ and `code`', 'bold and under and code'],
    ['  lots   of\twhitespace  ', 'lots of whitespace'],
    ['1.5 hours stays', '1.5 hours stays'],
  ])('%j → %j', (input, want) => {
    expect(normalizeDocLine(input)).toBe(want);
  });

  it('stays case-sensitive', () => {
    expect(normalizeDocLine('Must Return 403')).not.toBe(normalizeDocLine('must return 403'));
  });
});

describe('findDocQuote — complete lines of the named source, or nothing', () => {
  const at = (key: string, quote: string) => {
    const m = findDocQuote(IDX, key, quote);
    return m.ok ? [m.span.start, m.span.end] : m.reason;
  };

  it('matches a whole line however its markdown was copied', () => {
    expect(at('engineering/acme-billing-tdd', '- We keep the 403 declarations in `openapi.yaml` and update their descriptions.')).toEqual([7, 7]);
    expect(at('engineering/acme-billing-tdd', 'We keep the 403 declarations in openapi.yaml and update their descriptions.')).toEqual([7, 7]);
    expect(at('ACME-12', '2. Suspend writes the status "suspended" to the member record.')).toEqual([21, 21]);
  });

  it('matches a contiguous run of lines — across a blank line, with or without it — and a CRLF quote', () => {
    const run = 'Refunds are issued to the original payment method, not as store credit.\n\n### Alternatives considered';
    expect(at('engineering/acme-billing-tdd', run)).toEqual([8, 10]);
    expect(at('engineering/acme-billing-tdd', run.replace('\n\n', '\n'))).toEqual([8, 10]);
    expect(at('ACME-12', 'Acceptance criteria:\r\n1. A suspended member still gets 403 on every billing route.')).toEqual([19, 20]);
  });

  it('refuses a fragment, an elision, a paraphrase, a case change, and lines that are not contiguous', () => {
    for (const q of [
      'We keep the 403 declarations in openapi.yaml', // a fragment of line 7
      'We keep the 403 declarations … update their descriptions.', // elided
      'We retain the 403 declarations in openapi.yaml and update their descriptions.', // paraphrase
      'we keep the 403 declarations in openapi.yaml and update their descriptions.', // case
      'Acceptance criteria:\n2. Suspend writes the status "suspended" to the member record.', // skips line 20
    ])
      expect(at(q.startsWith('Acc') ? 'ACME-12' : 'engineering/acme-billing-tdd', q)).toMatch(/does not appear/);
  });

  it(`refuses a quote under ${MIN_DOC_QUOTE_CHARS} characters once normalised`, () => {
    expect(at('ACME-12', '1. A member gets 403')).toMatch(/under 20 characters/);
  });

  it('looks only inside the named source', () => {
    expect(at('ACME-12', 'We keep the 403 declarations in openapi.yaml and update their descriptions.')).toMatch(/does not appear/);
  });

  it('never cites a host line: the file header, a source header, or a cut notice — and never crosses a cut', () => {
    expect(at('engineering/acme-billing-tdd', IDX.lines[0])).toMatch(/does not appear/);
    expect(at('ACME-12', IDX.lines[17])).toMatch(/does not appear/);
    expect(at('ACME-12', '… [cut at 150 KB of 210 KB]')).toMatch(/does not appear/);
    expect(at('ACME-12', 'Suspend writes the status "suspended" to the member record.\nThe audit log keeps every status change for ninety days.')).toMatch(/does not appear/);
    // a run cannot cross into the next section either
    expect(at('engineering/acme-billing-tdd', 'Members on a paused plan keep read access to their invoices.\nAcceptance criteria:')).toMatch(/does not appear/);
  });
});

describe('docHeadingPath + nonNormativeHeading — where a quote sits decides whether it is a rule', () => {
  const span = (key: string, quote: string) => {
    const m = findDocQuote(IDX, key, quote);
    if (!m.ok) throw new Error(m.reason);
    return m;
  };

  it('a decision sits under its heading path, and that path is normative', () => {
    const m = span('engineering/acme-billing-tdd', 'We keep the 403 declarations in openapi.yaml and update their descriptions.');
    const p = docHeadingPath(IDX, m.source, m.span);
    expect(p.atStart).toEqual(['Acme billing', 'Decisions']);
    expect(nonNormativeHeading(p.all)).toBeNull();
  });

  it('an alternative weighed is not a rule — and a `#` inside a code block is not a heading', () => {
    const m = span('engineering/acme-billing-tdd', 'Return 404 for a suspended member instead of 403, to hide the account.');
    expect(nonNormativeHeading(docHeadingPath(IDX, m.source, m.span).all)).toBe('Alternatives considered');
    const after = span('engineering/acme-billing-tdd', 'Members on a paused plan keep read access to their invoices.');
    expect(docHeadingPath(IDX, after.source, after.span).atStart).toEqual(['Acme billing', 'Alternatives considered']);
  });

  it('a quote that runs into a non-normative heading is partly non-normative', () => {
    const m = span('engineering/acme-billing-tdd', 'Refunds are issued to the original payment method, not as store credit.\n### Alternatives considered');
    expect(nonNormativeHeading(docHeadingPath(IDX, m.source, m.span).all)).toBe('Alternatives considered');
  });

  it.each(['Non-goals', 'Non goals', 'Out of scope', 'Out-of-scope', 'Rejected options', 'Superseded', 'Deprecated', 'Draft', 'Open questions'])(
    '%s is non-normative',
    (h) => expect(nonNormativeHeading([h])).toBe(h)
  );
  it('a heading like "Goals" or "Rules" is not', () => expect(nonNormativeHeading(['Goals', 'Rules'])).toBeNull());
});

describe('docContext — the quote with ±8 lines of its own section, never the whole file', () => {
  it('clips to the section and marks the quoted lines', () => {
    const m = findDocQuote(IDX, 'ACME-12', '1. A suspended member still gets 403 on every billing route.');
    if (!m.ok) throw new Error(m.reason);
    const c = docContext(IDX, m.source, m.span);
    expect(c.lines[0].line).toBe(19); // the section's first line, not the header at 18
    expect(c.lines[c.lines.length - 1].line).toBe(24); // the section's last line
    expect(c.lines.filter((l) => l.quoted).map((l) => l.line)).toEqual([20]);
    expect(c.headingPath).toEqual([]);
  });

  it('caps a long context line, never a quoted one', () => {
    const long = `Context ${'x'.repeat(900)}`;
    const quoted = `The quoted rule ${'y'.repeat(900)}`;
    const idx = indexProductDocs(`## K-1 — t (ticket, rev 2026-01-01)\n${long}\n${quoted}`);
    const m = findDocQuote(idx, 'K-1', quoted);
    if (!m.ok) throw new Error(m.reason);
    const c = docContext(idx, m.source, m.span);
    expect(c.lines[0].text.length).toBe(501);
    expect(c.lines[1].text).toBe(quoted);
  });
});

describe('renderDocLine — a fixed template; the document controls no markup', () => {
  it('renders key + quote, newlines as " / "', () => {
    expect(renderDocLine({ key: 'ACME-12', quote: 'Acceptance criteria:\n1. A suspended member still gets 403.' })).toBe(
      '**Doc:** ACME-12 — "Acceptance criteria: / 1. A suspended member still gets 403."'
    );
  });

  it('escapes every character that could become markup, in the key and the quote', () => {
    expect(escapeDocMarkdown('\\ ` * _ [ ] ( ) < > # |')).toBe('\\\\ \\` \\* \\_ \\[ \\] \\( \\) \\< \\> \\# \\|');
    const line = renderDocLine({ key: 'docs/[x](y)', quote: '<!-- hide --> ![img](http://x) **bold** `code` # h | t' });
    expect(line).toBe('**Doc:** docs/\\[x\\]\\(y\\) — "\\<!-- hide --\\> !\\[img\\]\\(http://x\\) \\*\\*bold\\*\\* \\`code\\` \\# h \\| t"');
    // `\<` renders as a literal `<`: no comment can open, no tag can form.
    expect(line).not.toMatch(/(^|[^\\])</);
  });

  it(`cuts the quote at ${DOC_LINE_QUOTE_CAP} code points with "…", before escaping`, () => {
    const line = renderDocLine({ key: 'K-1', quote: `${'a'.repeat(400)}` });
    const quoted = line.slice(line.indexOf('"') + 1, -1);
    expect([...quoted].length).toBe(DOC_LINE_QUOTE_CAP);
    expect(quoted.endsWith('…')).toBe(true);
    // an escape is never split by the cut
    const esc = renderDocLine({ key: 'K-1', quote: '*'.repeat(400) });
    expect(esc.endsWith('\\*…"')).toBe(true);
  });

  it('scrubs control characters out of both halves', () => {
    expect(renderDocLine({ key: 'K-1\u0007', quote: 'a\u001b[31m rule that is long enough' })).toBe('**Doc:** K-1 — "a \\[31m rule that is long enough"');
  });
});

// REAL SHAPES (2026-10-16): a mirrored design doc is mostly markup — 675 of one real file's 1102
// lines. A model quotes what it READS; the host reduces both sides to visible text before comparing.
describe('markup → visible text, on both sides', () => {
  it.each([
    ['cell one<br>cell two', 'cell one cell two'],
    ['a<br/>b<BR />c', 'a b c'],
    ['<td>Status code for a suspended member</td>', 'Status code for a suspended member'],
    ['<table header-row="true">', ''],
    ['<empty-block/>', ''],
    ['Owner: <mention-user url="user://abc"/> signs off', 'Owner: signs off'],
    ['refunds &amp; credit notes &lt;b&gt; &quot;q&quot; it&#39;s&nbsp;here', 'refunds & credit notes <b> "q" it\'s here'],
    ['&amp;lt; stays one level deep', '&lt; stays one level deep'],
    ['see [the spec](https://example.invalid/spec) and ![shot](img.png) now', 'see the spec and now'],
    ['\\[DONE\\] \\*not bold\\* C:\\\\path', '[DONE] not bold C:\\path'],
    ['*italic* and ~~struck~~ text', 'italic and struck text'],
  ])('%j → %j', (input, want) => {
    expect(normalizeDocLine(input)).toBe(want);
  });

  const DOCS = [
    '# product docs: Acme bills TDD (rev 2026-10-10, refreshed 08:00Z) → the product seat',
    '',
    '## engineering/acme-bills-tdd — Acme bills TDD (tdd, rev 2026-10-10)',
    '### Acceptance',
    '1. **\\[DONE\\] ✅ <span discussion-urls="discussion://a1,discussion://b2">A person who cannot create bills sees the button disabled with a tooltip.</span>** Figma: <mention-page url="https://example.invalid/p/1"/>',
    '<empty-block/>',
    '<table header-row="true">',
    '<colgroup>',
    '<col width="200">',
    '</colgroup>',
    '<tr>',
    '<td>Status code for a suspended member</td>',
    '<td>403 Forbidden<br>never 404 on any billing route</td>',
    '</tr>',
    '</table>',
    'Owner: <mention-user url="user://abc"/> signs off on every refund &amp; credit note.',
  ].join('\n');
  const idx = indexProductDocs(DOCS);
  const at = (quote: string) => {
    const m = findDocQuote(idx, 'engineering/acme-bills-tdd', quote);
    return m.ok ? [m.span.start, m.span.end] : m.reason;
  };

  it('the visible text of a span-wrapped, escaped, emoji-marked numbered line verifies', () => {
    expect(at('1. [DONE] ✅ A person who cannot create bills sees the button disabled with a tooltip. Figma:')).toEqual([5, 5]);
    // a copy of the raw line, markup and all, folds to the same text
    expect(at(idx.lines[4])).toEqual([5, 5]);
  });

  it('a <td> cell, a cell with a <br>, and a line carrying a mention verify by their visible text', () => {
    expect(at('Status code for a suspended member')).toEqual([12, 12]);
    expect(at('403 Forbidden never 404 on any billing route')).toEqual([13, 13]);
    expect(at('Status code for a suspended member\n403 Forbidden never 404 on any billing route')).toEqual([12, 13]);
    expect(at('Owner: signs off on every refund & credit note.')).toEqual([16, 16]);
  });

  it('a fragment of a line still fails — markup removal never loosens the whole-line rule', () => {
    expect(at('A person who cannot create bills sees the button disabled with a tooltip.')).toMatch(/does not appear/);
    expect(at('403 Forbidden')).toMatch(/does not appear|under 20/);
    expect(at('signs off on every refund & credit note.')).toMatch(/does not appear/);
  });

  it('a line that was only tags is blank: it neither verifies nor breaks a run', () => {
    expect(at('<table header-row="true">')).toMatch(/under 20/);
  });
});
