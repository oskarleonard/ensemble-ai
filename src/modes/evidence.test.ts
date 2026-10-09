import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { composeEvidenceContext, EVIDENCE_CONTRACT, openEvidenceRoot } from './evidence';

const outside = fs.mkdtempSync(path.join('/private/tmp', 'evidence-root-'));
afterAll(() => fs.rmSync(outside, { force: true, recursive: true }));

describe('openEvidenceRoot', () => {
  it('accepts an absolute existing directory outside $HOME and reads INDEX.md', () => {
    fs.writeFileSync(path.join(outside, 'INDEX.md'), '# Evidence\n- `notion/prd.md` — PRD');
    const info = openEvidenceRoot(outside, '/Users/nobody');
    expect(info.root).toBe(fs.realpathSync(outside));
    expect(info.index).toContain('notion/prd.md');
  });
  it('refuses a relative path, a missing dir, and a root inside the home directory', () => {
    expect(() => openEvidenceRoot('relative/dir')).toThrow(/absolute/);
    expect(() => openEvidenceRoot('/definitely/missing/dir')).toThrow(/does not exist/);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-home-'));
    const inside = fs.mkdirSync(path.join(home, 'evidence'), { recursive: true }) ?? path.join(home, 'evidence');
    expect(() => openEvidenceRoot(inside as string, fs.realpathSync(home))).toThrow(/inside the home directory/);
    fs.rmSync(home, { force: true, recursive: true });
  });
});

describe('composeEvidenceContext', () => {
  it('keeps the document in full ahead of the contract and the index', () => {
    const doc = 'x'.repeat(50_000);
    const out = composeEvidenceContext(doc, { root: '/r/runs/abc', index: '- `doc.md`' });
    expect(out.startsWith(doc)).toBe(true);
    expect(out).toContain(EVIDENCE_CONTRACT);
    expect(out).toContain('Evidence index (abc/INDEX.md)');
  });
});
