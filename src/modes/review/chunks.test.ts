import { describe, expect, it } from 'vitest';

import {
  chunkLabel,
  type ChunksTrail,
  DEFAULT_MAX_CHUNKS,
  planChunks,
  renderChangeScope,
  renderCoverageOverview,
  renderLensScope,
} from './chunks';
import { computeCoverage, type FileDiff, parseDiffFiles } from './diff';

// A file section of a given byte size at a path — the raw is what planChunks packs by.
function file(path: string, bytes: number): string {
  const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,1 +1,1 @@\n+`;
  const body = 'x'.repeat(Math.max(1, bytes - header.length - 1));
  return `${header}${body}\n`;
}

function files(...specs: [string, number][]): FileDiff[] {
  return parseDiffFiles(specs.map(([p, b]) => file(p, b)).join(''));
}

describe('planChunks — a change over the ceiling is reviewed in whole parts, never cut', () => {
  it('plans ONE part in global admission order when everything fits (byte-identical to the single packet)', () => {
    const fs = files(['src/a.test.ts', 100], ['src/b.ts', 100]);
    const plan = planChunks(fs, 10_000, DEFAULT_MAX_CHUNKS);
    expect(plan.chunks).toHaveLength(1);
    expect(plan.overflow).toEqual([]);
    // non-test source first, then tests — the rule computeCoverage always shipped
    expect(plan.chunks[0].paths).toEqual(['src/b.ts', 'src/a.test.ts']);
    expect(plan.chunks[0].diff).toBe(fs[1].raw + fs[0].raw);
  });

  it('groups by top-level area and keeps an area whole when it fits a fresh part', () => {
    const fs = files(['backend/a.go', 300], ['backend/b.go', 300], ['web/c.ts', 300], ['web/d.ts', 300]);
    const plan = planChunks(fs, 650, DEFAULT_MAX_CHUNKS);
    expect(plan.chunks.map((c) => c.paths)).toEqual([
      ['backend/a.go', 'backend/b.go'],
      ['web/c.ts', 'web/d.ts'],
    ]);
    expect(plan.chunks.map((c) => c.index)).toEqual([1, 2]);
    expect(plan.chunks[0].label).toBe('backend');
    expect(plan.chunks[1].label).toBe('web');
  });

  it('splits an oversize area by its next directory and spills what still does not fit file by file', () => {
    const fs = files(
      ['backend/pkg/services/a.go', 300],
      ['backend/pkg/services/b.go', 300],
      ['backend/pkg/handler/c.go', 300],
      ['backend/pkg/handler/d.go', 300],
      ['backend/pkg/handler/e.go', 300]
    );
    const plan = planChunks(fs, 650, DEFAULT_MAX_CHUNKS);
    // services fits a part whole; handler (900 bytes) spills: two files, then one.
    expect(plan.chunks.map((c) => c.paths)).toEqual([
      ['backend/pkg/services/a.go', 'backend/pkg/services/b.go'],
      ['backend/pkg/handler/c.go', 'backend/pkg/handler/d.go'],
      ['backend/pkg/handler/e.go'],
    ]);
    expect(plan.chunks[0].label).toBe('backend/pkg/services');
  });

  it('puts tests after the source of their area within a part', () => {
    const fs = files(['backend/a_test.go', 200], ['backend/a.go', 200], ['web/b.ts', 500]);
    const plan = planChunks(fs, 450, DEFAULT_MAX_CHUNKS);
    expect(plan.chunks[0].paths).toEqual(['backend/a.go', 'backend/a_test.go']);
  });

  it('a single file over the ceiling gets a part of its own (a review of nothing is worse)', () => {
    const fs = files(['backend/huge.go', 2_000], ['web/b.ts', 200]);
    const plan = planChunks(fs, 500, DEFAULT_MAX_CHUNKS);
    expect(plan.chunks.map((c) => c.paths)).toEqual([['backend/huge.go'], ['web/b.ts']]);
  });

  it('caps the parts at maxChunks and returns the rest as NAMED overflow', () => {
    const fs = files(['a/x.ts', 300], ['b/y.ts', 300], ['c/z.ts', 300]);
    const plan = planChunks(fs, 350, 2);
    expect(plan.chunks).toHaveLength(2);
    expect(plan.overflow.map((f) => f.path)).toEqual(['c/z.ts']);
  });

  it('is deterministic: the same files and ceiling always yield the same parts', () => {
    const fs = files(['backend/a.go', 300], ['web/c.ts', 300], ['mobile/m.ts', 300]);
    const a = planChunks(fs, 650, 8);
    const b = planChunks(fs, 650, 8);
    expect(a.chunks.map((c) => c.paths)).toEqual(b.chunks.map((c) => c.paths));
  });
});

describe('chunkLabel', () => {
  it('names the shared directory and the next-level directories under it', () => {
    expect(chunkLabel(['backend/pkg/services/a.go', 'backend/pkg/handler/b.go'])).toBe('backend/pkg/{services, handler}');
    expect(chunkLabel(['backend/pkg/services/a.go', 'backend/pkg/services/b.go'])).toBe('backend/pkg/services');
    expect(chunkLabel(['a.ts', 'b.ts'])).toBe('.');
    expect(chunkLabel(['web/a.ts', 'mobile/b.ts'])).toBe('{web, mobile}');
  });
  it('caps the listing at four directories', () => {
    expect(chunkLabel(['x/a/1', 'x/b/1', 'x/c/1', 'x/d/1', 'x/e/1', 'x/f/1'])).toBe('x/{a, b, c, d, +2 more}');
  });
});

describe('computeCoverage with parts', () => {
  it('marks every included file with its part, ships the union, and records the part count', () => {
    const fs = files(['backend/a.go', 300], ['web/c.ts', 300], ['package-lock.json', 50]);
    const { coverage, includedDiff, plan } = computeCoverage(fs, 350);
    expect(plan.chunks).toHaveLength(2);
    expect(coverage.chunks).toBe(2);
    expect(coverage.files.find((f) => f.path === 'backend/a.go')?.chunk).toBe(1);
    expect(coverage.files.find((f) => f.path === 'web/c.ts')?.chunk).toBe(2);
    expect(coverage.files.find((f) => f.path === 'package-lock.json')).toMatchObject({ included: false, omitReason: 'generated' });
    expect(coverage.includedFiles).toBe(2);
    expect(coverage.omittedFiles).toBe(1);
    expect(includedDiff).toBe(plan.chunks[0].diff + plan.chunks[1].diff);
  });

  it('names files past the part cap as over-limit — the receipt then refuses, as before', () => {
    const fs = files(['a/x.ts', 300], ['b/y.ts', 300], ['c/z.ts', 300]);
    const { coverage } = computeCoverage(fs, 350, { maxChunks: 2 });
    expect(coverage.files.find((f) => f.path === 'c/z.ts')).toMatchObject({ included: false, kind: 'source', omitReason: 'over-limit' });
  });
});

describe('the scope notes', () => {
  const fs = files(['backend/a.go', 300], ['web/c.ts', 300], ['assets/logo.min.js', 50]);
  const { coverage, plan } = computeCoverage(fs, 350);

  it('tells part k what it carries, what the other parts carry, and what no reviewer sees', () => {
    const note = renderChangeScope({ coverage, plan }, 2);
    expect(note).toContain('PART 2 of 2');
    expect(note).toContain('Files in THIS part');
    expect(note).toContain('web/c.ts (+1/-0)');
    expect(note).toContain('Files in the OTHER parts');
    expect(note).toContain('part 1 — backend');
    expect(note).toContain('backend/a.go (+1/-0)');
    expect(note).toContain('NOT shipped to any reviewer');
    expect(note).toContain('assets/logo.min.js (+1/-0) — generated/generated');
    // the OTHER-parts clause tells the seat to read, not to assume
    expect(note).toContain('read the file as it exists at the PR head');
  });

  it('the lens note names the materialized parts and the ones to read at head', () => {
    const note = renderLensScope({ coverage, plan }, [1]);
    expect(note).toContain('reviewed in 2 part(s)');
    expect(note).toContain('part 1 — backend (hunks below)');
    expect(note).toContain('part 2 — web (hunks NOT below — read at head)');
    expect(note).toContain('web/c.ts (+1/-0)');
  });
});

describe('renderCoverageOverview — the one page a human reads first', () => {
  const trail: ChunksTrail = {
    ceilingBytes: 500_000,
    chunks: [
      {
        bytes: 400_000,
        files: [
          { added: 10, path: 'backend/a.go', removed: 2, test: false },
          { added: 5, path: 'backend/a_test.go', removed: 0, test: true },
        ],
        index: 1,
        label: 'backend',
        promptChars: 420_000,
        seats: { claude: { findings: 1, state: 'reviewed' }, codex: { findings: 2, state: 'reviewed' }, grok: { findings: 0, state: 'failed-reviewer', why: 'timed out' } },
      },
      {
        bytes: 300_000,
        files: [{ added: 7, path: 'web/c.ts', removed: 1, test: false }],
        index: 2,
        label: 'web',
        promptChars: 320_000,
        seats: { codex: { findings: 0, state: 'failed-reviewer', why: 'timed out' }, grok: { findings: 0, state: 'failed-reviewer', why: 'timed out' } },
      },
    ],
    maxChunks: 8,
    omitted: [
      { kind: 'generated', path: 'gen/ent/x.go', reason: 'generated' },
      { kind: 'source', path: 'mobile/z.ts', reason: 'over-limit' },
    ],
    schemaVersion: 1,
  };

  it('counts parts, reviewed files, skipped-by-kind and past-the-limit, and lists what nobody read', () => {
    const md = renderCoverageOverview(trail, { gateCounts: { agree: 2, false: 0, partial: 1, unverified: 0 }, headSha: 'abcdef1234567890', totalFiles: 5 });
    expect(md).toContain('# Coverage overview — abcdef123456');
    expect(md).toContain('5 changed file(s) · 2 part(s) planned');
    expect(md).toContain('1 part(s) reviewed by at least one seat · 2 file(s) read by a seat');
    expect(md).toContain('1 generated/binary file(s) skipped by kind · 1 file(s) past the part limit (NOT reviewed)');
    expect(md).toContain('Gate across all parts: 2 agree · 1 partial');
    expect(md).toContain('### Part 1 — backend');
    expect(md).toContain('codex ✓ 2 finding(s)');
    expect(md).toContain('grok ✗ failed-reviewer — timed out');
    expect(md).toContain('## Parts NO seat completed');
    expect(md).toContain('- part 2 — web (1 file(s))');
    expect(md).toContain('## Not reviewed — past the 8-part limit');
    expect(md).toContain('- mobile/z.ts (source)');
    expect(md).toContain('## Skipped by kind (generated / binary)');
    expect(md).toContain('- gen/ent/x.go (generated)');
  });
});

describe('planChunks — first-fit over open parts, distinct labels', () => {
  it('places an area into the first open part with room, so fewer parts are opened', () => {
    // in-order packing would open 4 parts (130|130|60+60|130+60); first-fit over open parts gives 3
    const fs = files(['a/x', 130], ['b/x', 130], ['c/x', 60], ['d/x', 60], ['e/x', 130], ['f/x', 60]);
    const plan = planChunks(fs, 200, 8);
    expect(plan.chunks.map((c) => c.paths)).toEqual([
      ['a/x', 'c/x'],
      ['b/x', 'd/x'],
      ['e/x', 'f/x'],
    ]);
  });

  it('numbers consecutive parts that spill out of one area', () => {
    const fs = files(['svc/ramp/a.go', 300], ['svc/ramp/b.go', 300], ['svc/ramp/c.go', 300]);
    const plan = planChunks(fs, 350, 8);
    expect(plan.chunks.map((c) => c.label)).toEqual(['svc/ramp', 'svc/ramp (2)', 'svc/ramp (3)']);
  });
});
