import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { conventionsAwareReader, CONVENTIONS_IN_TREE_REL, isConventionsDoc, verifySiteAtHead, worktreeReader } from './holistic-gate';
import { CONVENTIONS_IN_TREE_DIR, CONVENTIONS_IN_TREE_FILE } from './index';

// The citation seam (2026-10-13): the lens reads `.ensemble-conventions/CONVENTIONS.md`; the
// worktree no longer holds the stripped CLAUDE.md / AGENTS.md docs. A citation must verify both
// ways — by the in-tree file, and by the ORIGINAL doc path served from its section.
const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-reader-'));
fs.mkdirSync(path.join(tree, CONVENTIONS_IN_TREE_DIR));
fs.mkdirSync(path.join(tree, 'docs'));
fs.writeFileSync(path.join(tree, 'docs', 'release.md'), 'release line one\nrelease line two\n');
const inTree = path.join(tree, CONVENTIONS_IN_TREE_DIR, CONVENTIONS_IN_TREE_FILE);
fs.writeFileSync(
  inTree,
  ['# Conventions index', '- backend/CLAUDE.md — line 5', '', '', '===== backend/CLAUDE.md =====', 'Always wrap errors with context.', 'Never log secrets.', '', '', '===== docs/release.md =====', 'release line one', 'release line two'].join('\n')
);
afterAll(() => fs.rmSync(tree, { force: true, recursive: true }));

describe('the in-tree conventions file is a conventions doc, and the two spellings agree', () => {
  it('accepts the repo-relative path and the absolute location the prompt printed', () => {
    expect(isConventionsDoc(CONVENTIONS_IN_TREE_REL)).toBe(true);
    expect(isConventionsDoc(`/var/folders/x/ensemble-worktree-abc/head/${CONVENTIONS_IN_TREE_REL}`)).toBe(true);
    expect(isConventionsDoc('node_modules/pkg/CONVENTIONS.md', ['backend/CLAUDE.md'])).toBe(false); // not gathered, not the in-tree file
  });
  it('the gate and the mode spell the file the same way', () => {
    expect(CONVENTIONS_IN_TREE_REL).toBe(`${CONVENTIONS_IN_TREE_DIR}/${CONVENTIONS_IN_TREE_FILE}`);
  });
});

describe('conventionsAwareReader', () => {
  const read = conventionsAwareReader(worktreeReader(tree), inTree, ['backend/CLAUDE.md', 'docs/release.md']);
  it('serves a STRIPPED doc from its section of the in-tree file, line-for-line from the doc\'s line 1', () => {
    expect(read('backend/CLAUDE.md')).toEqual(['Always wrap errors with context.', 'Never log secrets.', '', '']);
    expect(verifySiteAtHead({ file: 'backend/CLAUDE.md', line: 2, quote: 'Never log secrets.' }, read).ok).toBe(true);
  });
  it('still reads an unstripped doc from the worktree first', () => {
    expect(read('docs/release.md')).toEqual(['release line one', 'release line two', '']);
  });
  it('serves the in-tree file whole, by either spelling', () => {
    expect(read(CONVENTIONS_IN_TREE_REL)?.[0]).toBe('# Conventions index');
    expect(verifySiteAtHead({ file: `/abs/head/${CONVENTIONS_IN_TREE_REL}`, line: 7, quote: 'Never log secrets.' }, read).ok).toBe(true);
  });
  it('a path that is neither in the tree nor gathered stays unreadable', () => {
    expect(read('backend/AGENTS.md')).toBeNull();
    expect(conventionsAwareReader(worktreeReader(tree), null, ['backend/CLAUDE.md'])('backend/CLAUDE.md')).toBeNull();
  });
});
