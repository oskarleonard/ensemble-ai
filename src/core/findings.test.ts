import { describe, expect, it } from 'vitest';

import { extractJsonBlock, parseFindings } from './findings';

const ok = {
  findings: [
    {
      body: 'off-by-one',
      confidence: 'high',
      evidence: { file: 'lib/x.ts', line: 12 },
      severity: 'high',
      title: 'Bug',
    },
  ],
  summary: 'one issue',
};

describe('extractJsonBlock', () => {
  it('pulls JSON from a ```json fence wrapped in prose', () => {
    const raw = `Here is my review:\n\`\`\`json\n${JSON.stringify(ok)}\n\`\`\`\nthanks`;
    expect(extractJsonBlock(raw)).toEqual(ok);
  });

  it('falls back to the widest {…} span when unfenced', () => {
    expect(extractJsonBlock(`prefix ${JSON.stringify(ok)} suffix`)).toEqual(ok);
  });

  it('returns null when there is no JSON at all', () => {
    expect(extractJsonBlock('just prose, no json')).toBeNull();
  });
});

describe('parseFindings', () => {
  it('parses a well-formed review and assigns stable ids', () => {
    const r = parseFindings(`\`\`\`json\n${JSON.stringify(ok)}\n\`\`\``);
    expect(r.parseError).toBeUndefined();
    expect(r.summary).toBe('one issue');
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].id).toBe('f1');
    expect(r.findings[0].severity).toBe('high');
    expect(r.findings[0].confidence).toBe('high');
    expect(r.findings[0].evidence).toEqual({ file: 'lib/x.ts', line: 12 });
  });

  it('DOWNGRADES an uncited finding (no file) to low confidence + flags it', () => {
    const raw = JSON.stringify({
      findings: [
        {
          body: 'b',
          confidence: 'high',
          evidence: {},
          severity: 'high',
          title: 'X',
        },
      ],
      summary: '',
    });
    const r = parseFindings(raw);
    expect(r.findings[0].uncited).toBe(true);
    expect(r.findings[0].confidence).toBe('low'); // high → low because uncited
    expect(r.findings[0].severity).toBe('high'); // severity is NOT downgraded
  });

  it('returns a parseError when there is no parseable JSON', () => {
    const r = parseFindings('the reviewer rambled but emitted no json');
    expect(r.parseError).toBeDefined();
    expect(r.findings).toEqual([]);
  });

  it('is defensive: drops a malformed finding, keeps the valid ones', () => {
    const raw = JSON.stringify({
      findings: [
        null,
        {
          body: 'ok',
          evidence: { file: 'a.ts' },
          severity: 'low',
          title: 'Keep',
        },
      ],
      summary: '',
    });
    const r = parseFindings(raw);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].title).toBe('Keep');
  });

  it('coerces unknown severity/confidence to safe defaults', () => {
    const raw = JSON.stringify({
      findings: [
        {
          body: 'b',
          confidence: 'wat',
          evidence: { file: 'a.ts' },
          severity: 'nope',
          title: 'T',
        },
      ],
      summary: '',
    });
    const r = parseFindings(raw);
    expect(r.findings[0].severity).toBe('medium'); // unknown → medium
    expect(r.findings[0].confidence).toBe('low'); // unknown → low
  });

  it('treats an empty findings array as a clean review (no error)', () => {
    const r = parseFindings(
      JSON.stringify({ findings: [], summary: 'looks good' })
    );
    expect(r.parseError).toBeUndefined();
    expect(r.findings).toEqual([]);
    expect(r.summary).toBe('looks good');
  });
});
