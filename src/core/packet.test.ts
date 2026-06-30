import { describe, expect, it } from 'vitest';

import { assembleCodePacket, PACKET_BUDGETS, type PacketInput } from './packet';

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
