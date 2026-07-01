import { describe, expect, it } from 'vitest';

import {
  hasExplicitSource,
  isDiffSourceError,
  parsePrUrl,
  selectDiffSource,
} from './source';

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

  it('--pr <N> → pr, parsing the number (bare int, no owner/repo)', () => {
    expect(selectDiffSource({ pr: '42' })).toEqual({ kind: 'pr', pr: 42 });
  });

  it('--pr <github PR url> → pr, carrying owner/repo (reviewable from any dir)', () => {
    expect(
      selectDiffSource({ pr: 'https://github.com/oskarleonard/munin-dashboard/pull/133' })
    ).toEqual({ kind: 'pr', owner: 'oskarleonard', pr: 133, repo: 'munin-dashboard' });
  });

  it('--pr <url> tolerates a trailing /files sub-tab + query/hash', () => {
    expect(
      selectDiffSource({ pr: 'https://github.com/o/r/pull/7/files?w=1#diff-abc' })
    ).toEqual({ kind: 'pr', owner: 'o', pr: 7, repo: 'r' });
  });

  it('--pr with a github URL that is NOT a valid PR URL → clear error', () => {
    for (const bad of [
      'https://github.com/o/r/pull/abc',
      'https://github.com/o/r/pull/0',
      'https://github.com/o/r/issues/5',
      'https://gitlab.com/o/r/pull/5',
      'https://github.com/o/r/pull/',
      'not-a-url',
    ]) {
      const r = selectDiffSource({ pr: bad });
      expect(isDiffSourceError(r), bad).toBe(true);
    }
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

describe('parsePrUrl — GitHub PR URL → {owner, repo, pr}', () => {
  it('parses a canonical PR URL', () => {
    expect(parsePrUrl('https://github.com/oskarleonard/munin-dashboard/pull/133')).toEqual(
      { owner: 'oskarleonard', pr: 133, repo: 'munin-dashboard' }
    );
  });

  it('tolerates http, a trailing slash, /files, /commits, query + hash', () => {
    const cases: [string, number][] = [
      ['http://github.com/o/r/pull/1', 1],
      ['https://github.com/o/r/pull/2/', 2],
      ['https://github.com/o/r/pull/3/files', 3],
      ['https://github.com/o/r/pull/4/commits', 4],
      ['https://github.com/o/r/pull/5/files/', 5],
      ['https://github.com/o/r/pull/6?diff=split', 6],
      ['https://github.com/o/r/pull/7/files#diff-xyz', 7],
    ];
    for (const [url, pr] of cases) {
      expect(parsePrUrl(url), url).toEqual({ owner: 'o', pr, repo: 'r' });
    }
  });

  it('matches the host case-insensitively (GitHub.com is a valid host)', () => {
    expect(parsePrUrl('https://GitHub.com/o/r/pull/8')).toEqual({
      owner: 'o',
      pr: 8,
      repo: 'r',
    });
  });

  it('trims surrounding whitespace', () => {
    expect(parsePrUrl('  https://github.com/o/r/pull/9  ')).toEqual({
      owner: 'o',
      pr: 9,
      repo: 'r',
    });
  });

  it('returns null for anything that is not a valid github PR URL', () => {
    for (const bad of [
      '133',
      'github.com/o/r/pull/1',
      'https://github.com/o/r/pull/abc',
      'https://github.com/o/r/pull/0',
      'https://github.com/o/r/pull/-1',
      'https://github.com/o/r/issues/1',
      'https://github.com/o/r/pull',
      'https://gitlab.com/o/r/pull/1',
      'https://github.com/o/pull/1',
      '',
    ]) {
      expect(parsePrUrl(bad), bad).toBeNull();
    }
  });
});

describe('hasExplicitSource — gates whether the CLI reads stdin', () => {
  it('false with no source flags (stdin may be read)', () => {
    expect(hasExplicitSource({})).toBe(false);
    expect(hasExplicitSource({ stdinPiped: true })).toBe(false);
  });

  it('true for each explicit source flag (stdin must NOT be read)', () => {
    expect(hasExplicitSource({ pr: '5' })).toBe(true);
    expect(hasExplicitSource({ diffFile: 'x' })).toBe(true);
    expect(hasExplicitSource({ staged: true })).toBe(true);
    expect(hasExplicitSource({ workingTree: true })).toBe(true);
  });
});
