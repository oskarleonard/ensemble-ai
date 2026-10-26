import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { conventionsIndex, gatherConventions, memoryConventionReader, readConventionsLayout, type ConventionManifest } from './conventions';

const body = ['', '', '===== CLAUDE.md =====', 'root rule', '', '', '===== backend/.claude/rules/testing.md =====', 'test rule', 'second', '', '', '===== backend/docs/architecture.md =====', 'arch page', '', '', '===== web/CLAUDE.md =====', 'web rule'].join('\n');
const manifest: ConventionManifest = {
  capBytes: 350_000,
  totalBytes: 40,
  files: [
    { bytes: 9, included: true, path: 'CLAUDE.md', tier: 0, truncated: false },
    { bytes: 16, included: true, path: 'backend/.claude/rules/testing.md', tier: 0, truncated: false },
    { bytes: 9, included: true, path: 'backend/docs/architecture.md', tier: 1, truncated: false },
    { bytes: 8, included: true, path: 'web/CLAUDE.md', tier: 0, truncated: false },
    { bytes: 9_000, included: false, path: 'web/docs/ARCHITECTURE.md', reason: 'over-cap', tier: 1, truncated: false },
    { bytes: 9, included: false, path: 'backend/AGENTS.md', reason: 'duplicate', duplicateOf: 'AGENTS.md', tier: 0, truncated: false },
  ],
};

describe('conventionsIndex — the block at the top of the in-tree conventions file', () => {
  const index = conventionsIndex(body, manifest, ['backend/pkg/x.go', 'backend/pkg/x_test.go']);
  const lines = index.text.split('\n');
  it('separates the rules chain to read IN FULL from the nearest docs to open by grep, and names what was left out', () => {
    expect(index.readInFull).toEqual(['backend/.claude/rules/testing.md', 'CLAUDE.md']);
    expect(index.jumpTo).toEqual(['backend/docs/architecture.md']);
    expect(lines[2]).toBe('Read IN FULL (the CLAUDE.md / AGENTS.md / rules chain for the files this change touches, and the root rules): backend/.claude/rules/testing.md · CLAUDE.md');
    expect(lines[3]).toBe('Open by grep when a hunk touches their subject (nearest docs): backend/docs/architecture.md');
    expect(lines[4]).toContain('Not gathered (1');
    expect(index.text).not.toContain('backend/AGENTS.md'); // a duplicate is not "left out"
    expect(index.text).not.toContain('web/CLAUDE.md ·'); // not on the touched path, not root
  });
  it('every span is the doc\'s body in the FINAL file, starting at the doc\'s own line 1', () => {
    const final = (index.text + body).split('\n');
    for (const sp of index.spans) {
      expect(final[sp.startLine - 2]).toBe(`===== ${sp.path} =====`);
      expect(final[sp.startLine - 1]).not.toMatch(/^=====/);
      expect(sp.endLine).toBeGreaterThanOrEqual(sp.startLine);
    }
    const testing = index.spans.find((s) => s.path === 'backend/.claude/rules/testing.md')!;
    expect(final.slice(testing.startLine - 1, testing.endLine)).toEqual(['test rule', 'second']);
    expect(final[index.indexEndLine]).toBe(''); // the index ends; two blank lines precede the first header
    expect(final[index.indexEndLine + 2]).toBe('===== CLAUDE.md =====');
  });
  it('the layout read back off the file agrees with the layout the writer computed', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-layout-'));
    const file = path.join(dir, 'CONVENTIONS.md');
    fs.writeFileSync(file, index.text + body);
    const back = readConventionsLayout(file);
    expect(back?.indexEndLine).toBe(index.indexEndLine);
    expect(back?.spans).toEqual(index.spans);
    expect(readConventionsLayout(path.join(dir, 'missing.md'))).toBeNull();
    fs.rmSync(dir, { force: true, recursive: true });
  });
  it('the read-back agrees with the writer on REAL gathered output, where the first header sits right under the index', async () => {
    // gatherConventions strips its leading newlines, so unlike the fixture above the body starts
    // with its first header: `line − 3` put the index end two rows early here (Munin, engine ask
    // 2026-10-24) and a read of the index's last two rows scored as `read` with no docs.
    const gathered = await gatherConventions(
      memoryConventionReader({
        'CLAUDE.md': 'root rule, see docs/arch.md',
        'backend/CLAUDE.md': 'backend rule',
        'docs/arch.md': 'arch page',
      }),
      ['backend/pkg/x.go']
    );
    expect(gathered.text.startsWith('=====')).toBe(true);
    const idx = conventionsIndex(gathered.text, gathered.manifest, ['backend/pkg/x.go']);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-layout-real-'));
    const file = path.join(dir, 'CONVENTIONS.md');
    fs.writeFileSync(file, idx.text + gathered.text);
    const final = fs.readFileSync(file, 'utf8').split('\n');
    expect(final[idx.indexEndLine]).toMatch(/^===== /); // no blank line between index and body
    const back = readConventionsLayout(file);
    expect(back?.indexEndLine).toBe(idx.indexEndLine);
    expect(back?.spans).toEqual(idx.spans);
    fs.rmSync(dir, { force: true, recursive: true });
  });
  it('a change at the root has nothing below the root to read in full besides the root rules', () => {
    expect(conventionsIndex(body, manifest, ['README.md']).readInFull).toEqual(['CLAUDE.md']);
  });
});
