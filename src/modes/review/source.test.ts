import { describe, expect, it } from 'vitest';

import { isDiffSourceError, selectDiffSource } from './source';

describe('selectDiffSource — diff-source resolution', () => {
  it('no flags, no stdin → commit mode (current branch vs base)', () => {
    expect(selectDiffSource({})).toEqual({ kind: 'commit' });
  });

  it('no explicit source but stdin piped → stdin', () => {
    expect(selectDiffSource({ stdinPiped: true })).toEqual({ kind: 'stdin' });
  });

  it('--staged → staged', () => {
    expect(selectDiffSource({ staged: true })).toEqual({ kind: 'staged' });
  });

  it('--working-tree → working-tree', () => {
    expect(selectDiffSource({ workingTree: true })).toEqual({
      kind: 'working-tree',
    });
  });

  it('--diff-file <path> → diff-file, carrying the path', () => {
    expect(selectDiffSource({ diffFile: '/tmp/x.diff' })).toEqual({
      diffFile: '/tmp/x.diff',
      kind: 'diff-file',
    });
  });

  it('--pr <N> → pr, parsing the number', () => {
    expect(selectDiffSource({ pr: '42' })).toEqual({ kind: 'pr', pr: 42 });
  });

  it('an explicit source WINS over a piped stdin', () => {
    expect(selectDiffSource({ staged: true, stdinPiped: true })).toEqual({
      kind: 'staged',
    });
  });

  it('--pr with a non-numeric / non-positive value → error (no silent commit-mode)', () => {
    for (const bad of ['abc', '0', '-3', '1.5', '']) {
      const r = selectDiffSource({ pr: bad });
      expect(isDiffSourceError(r)).toBe(true);
    }
  });

  it('--pr rejects hex / exponent / whitespace-padded values that Number() would accept', () => {
    for (const bad of ['0x10', '1e3', ' 5 ', '5abc', '+5']) {
      const r = selectDiffSource({ pr: bad });
      expect(isDiffSourceError(r)).toBe(true);
    }
  });

  it('two explicit sources → conflict error naming BOTH flags', () => {
    const r = selectDiffSource({ pr: '5', staged: true });
    expect(isDiffSourceError(r)).toBe(true);
    if (isDiffSourceError(r)) {
      expect(r.error).toContain('--pr');
      expect(r.error).toContain('--staged');
    }
  });

  it('--diff-file + --working-tree → conflict error', () => {
    const r = selectDiffSource({ diffFile: 'x', workingTree: true });
    expect(isDiffSourceError(r)).toBe(true);
  });
});
