import { describe, expect, it } from 'vitest';

import {
  assembleCodePacket,
  DIFF_SECTION_TITLE,
  PACKET_BUDGETS,
  type PacketInput,
  reviewerVisibleDiff,
  segmentsWithoutTruncationSplices,
  TRUNCATION_MARKER_RE,
} from './packet';

const base: PacketInput = {
  diff: 'diff --git a/x b/x\n'.repeat(20),
  objective: 'review it',
  pr: 7,
  repo: 'acme/web',
};

describe('assembleCodePacket', () => {
  it('always includes objective + the diff, and marks a present diff complete', () => {
    const p = assembleCodePacket(base);
    const titles = p.sections.map((s) => s.title);
    expect(titles).toContain('Objective');
    expect(titles).toContain('The diff under review');
    expect(p.complete).toBe(true);
    expect(p.pr).toBe(7);
    expect(p.repo).toBe('acme/web');
  });

  it('marks the packet INCOMPLETE when the diff is empty (a blind review)', () => {
    const p = assembleCodePacket({ ...base, diff: '' });
    expect(p.complete).toBe(false);
    const diff = p.sections.find((s) => s.title === 'The diff under review');
    expect(diff?.included).toBe(false);
    expect(diff?.note).toMatch(/UNAVAILABLE/);
  });

  it('marks INCOMPLETE when the diff is below the usefulness floor', () => {
    const p = assembleCodePacket({ ...base, diff: 'tiny' });
    expect(p.complete).toBe(false);
  });

  it('records absent optional context in the manifest without failing complete', () => {
    const p = assembleCodePacket(base); // no agentsMd / files / history
    expect(p.complete).toBe(true);
    const agents = p.sections.find((s) => s.title.includes('AGENTS.md'));
    expect(agents?.included).toBe(false);
    expect(agents?.note).toMatch(/UNAVAILABLE/);
  });

  it('truncates an over-budget section and flags it in the manifest', () => {
    const huge = 'x'.repeat(PACKET_BUDGETS.diff + 5_000);
    const p = assembleCodePacket({ ...base, diff: huge });
    const diff = p.sections.find((s) => s.title === 'The diff under review');
    expect(diff?.truncated).toBe(true);
    expect(diff?.body.length).toBeLessThan(huge.length);
    expect(diff?.body).toContain('chars truncated');
    expect(diff?.note).toMatch(/truncated/);
    // A truncated-but-still-large diff is still useful → complete stays true.
    expect(p.complete).toBe(true);
  });

  it('includes the directive section only when a directive is given', () => {
    expect(
      assembleCodePacket(base).sections.some((s) =>
        s.title.startsWith('Original directive')
      )
    ).toBe(false);
    expect(
      assembleCodePacket({ ...base, directive: 'do X' }).sections.some((s) =>
        s.title.startsWith('Original directive')
      )
    ).toBe(true);
  });

  it('adds the supplementary worker sections only when supplied', () => {
    const titles = (p: PacketInput) =>
      assembleCodePacket(p).sections.map((s) => s.title);
    // the author-summary section is absent unless authorSummary is supplied
    expect(titles(base)).not.toContain('Author summary');
    expect(titles(base)).not.toContain('Test output');
    expect(titles(base)).not.toContain('Known constraints');
    // present when the worker supplies them
    const full = titles({
      ...base,
      authorSummary: 'refactored the gate',
      constraints: 'no new deps',
      testOutput: '703 passed',
    });
    expect(full).toContain('Author summary');
    expect(full).toContain('Test output');
    expect(full).toContain('Known constraints');
    // the diff stays the required, completeness-bearing section
    expect(assembleCodePacket({ ...base, testOutput: 'x' }).complete).toBe(
      true
    );
  });
});

// ── Binding fix #1 — the reviewer-visible diff + truncation-splice splitter ─────────────
describe('reviewerVisibleDiff + segmentsWithoutTruncationSplices (binding fix #1)', () => {
  it('reviewerVisibleDiff returns the diff-SECTION body — exactly what the reviewer saw', () => {
    const p = assembleCodePacket(base);
    const section = p.sections.find((s) => s.title === DIFF_SECTION_TITLE)!;
    const v = reviewerVisibleDiff(p);
    expect(v.text).toBe(section.body);
    expect(v.truncated).toBe(false);
  });

  it('a diff over the budget ⇒ truncated bytes that carry a splice marker', () => {
    const huge = 'diff --git a/big b/big\n' + 'x'.repeat(PACKET_BUDGETS.diff + 5_000);
    const v = reviewerVisibleDiff(assembleCodePacket({ ...base, diff: huge }));
    expect(v.truncated).toBe(true);
    expect(v.text.length).toBeLessThan(huge.length);
    expect(TRUNCATION_MARKER_RE.test(v.text)).toBe(true);
  });

  it('no marker ⇒ ONE segment (byte-identical to the input — the common path)', () => {
    const d = 'diff --git a/x b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n';
    expect(segmentsWithoutTruncationSplices(d)).toEqual([d]);
  });

  it('splits at a splice, DROPPING the marker AND the partial line on each side of the cut', () => {
    const spliced =
      'headContentLine\npartialHeadCut\n\n…[42 chars truncated]…\n\npartialTailResume\ntailContentLine';
    const segs = segmentsWithoutTruncationSplices(spliced);
    expect(segs).toEqual(['headContentLine\n', '\ntailContentLine']);
    const joined = segs.join('|');
    expect(joined).not.toContain('truncated');
    expect(joined).not.toContain('partialHeadCut');
    expect(joined).not.toContain('partialTailResume');
  });
});
