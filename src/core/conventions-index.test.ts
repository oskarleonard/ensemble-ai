import { describe, expect, it } from 'vitest';

import { conventionsIndex, type ConventionManifest } from './conventions';

const body = ['', '', '===== CLAUDE.md =====', 'root rule', '', '', '===== backend/.claude/rules/testing.md =====', 'test rule', '', '', '===== web/CLAUDE.md =====', 'web rule'].join('\n');
const manifest: ConventionManifest = {
  capBytes: 350_000,
  totalBytes: 30,
  files: [
    { bytes: 9, included: true, path: 'CLAUDE.md', tier: 0, truncated: false },
    { bytes: 9, included: true, path: 'backend/.claude/rules/testing.md', tier: 0, truncated: false },
    { bytes: 8, included: true, path: 'web/CLAUDE.md', tier: 0, truncated: false },
    { bytes: 9_000, included: false, path: 'web/docs/ARCHITECTURE.md', reason: 'over-cap', tier: 1, truncated: false },
    { bytes: 9, included: false, path: 'backend/AGENTS.md', reason: 'duplicate', duplicateOf: 'AGENTS.md', tier: 0, truncated: false },
  ],
};

describe('conventionsIndex — the block at the top of the in-tree conventions file', () => {
  const index = conventionsIndex(body, manifest, ['backend/pkg/x.go', 'backend/pkg/x_test.go']);
  const lines = index.split('\n');
  it('names the docs nearest the touched files first, the root rules apart, and what was left out', () => {
    expect(lines[2]).toBe('Nearest to the files this change touches — read these in full first: backend/.claude/rules/testing.md');
    expect(lines[3]).toBe('Root rules (every change): CLAUDE.md');
    expect(lines[4]).toContain('Not gathered (1');
    expect(lines[4]).toContain('web/docs/ARCHITECTURE.md');
    expect(index).not.toContain('backend/AGENTS.md'); // a duplicate is not "left out"
  });
  it('every doc\'s line number points at its first content line in the FINAL file', () => {
    const final = (index + body).split('\n');
    for (const f of manifest.files.filter((x) => x.included)) {
      const row = lines.find((l) => l.startsWith(`- ${f.path} `));
      const n = Number(row?.match(/line ([\d,]+)/)?.[1].replace(/,/g, ''));
      expect(final[n - 2]).toBe(`===== ${f.path} =====`); // the header is the line before
    }
    expect(final[Number(lines.find((l) => l.startsWith('- CLAUDE.md'))!.match(/line (\d+)/)![1]) - 1]).toBe('root rule');
  });
  it('a change at the root has no "nearest" doc below the root', () => {
    expect(conventionsIndex(body, manifest, ['README.md']).split('\n')[2]).toContain('none below the root');
  });
});
