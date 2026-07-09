import { describe, expect, it } from 'vitest';

import { parseLsTree, readReadableSurface } from './evidence-manifest';
import type { GitRun } from './worktree';

// The readable surface is an AUDIT record: "what could this seat read, at exactly what content?"
// A parser that silently mangles a path degrades the audit without failing anything, so the
// NUL-separated contract is pinned here.

// Spelled with an explicit escape: a bare backslash-zero followed by a digit is an OCTAL
// escape, not a NUL — TypeScript rejects it outright.
const NUL = '\u0000';
const line = (sha: string, p: string) => `100644 blob ${sha}\t${p}`;
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

describe('parseLsTree — NUL-separated, so no path is ever C-quoted or split', () => {
  it('parses plain entries', () => {
    expect(parseLsTree(`${line(A, 'src/a.ts')}${NUL}${line(B, 'src/b.ts')}${NUL}`)).toEqual([
      { blobSha: A, path: 'src/a.ts' },
      { blobSha: B, path: 'src/b.ts' },
    ]);
  });

  // With `-z` git emits the RAW path. Without it these arrive C-quoted as `"ta\tb.ts"` and the
  // manifest would record the escaped literal, quotes and all, as though it were the real name.
  it('keeps a path containing a TAB verbatim — no quoting, no truncation at the tab', () => {
    expect(parseLsTree(`${line(A, 'ta\tb.ts')}${NUL}`)).toEqual([{ blobSha: A, path: 'ta\tb.ts' }]);
  });

  // The case a newline-separated parser DROPS outright: the row splits across two "lines" and
  // matches nothing, so the blob vanishes from a surface that claims to be complete.
  it('keeps a path containing a NEWLINE, rather than dropping the blob', () => {
    expect(parseLsTree(`${line(A, 'we\nird.ts')}${NUL}${line(B, 'ok.ts')}${NUL}`)).toEqual([
      { blobSha: A, path: 'we\nird.ts' },
      { blobSha: B, path: 'ok.ts' },
    ]);
  });

  it('keeps non-ASCII paths verbatim (core.quotePath would octal-escape them)', () => {
    expect(parseLsTree(`${line(A, 'src/résumé.ts')}${NUL}`)).toEqual([
      { blobSha: A, path: 'src/résumé.ts' },
    ]);
  });

  it('records symlinks and submodules like any other entry — content identity, not file type', () => {
    const text = `120000 blob ${A}\tlink${NUL}160000 commit ${B}\tvendor/sub${NUL}`;
    expect(parseLsTree(text)).toEqual([
      { blobSha: A, path: 'link' },
      { blobSha: B, path: 'vendor/sub' },
    ]);
  });

  it('ignores empty trailing segments and malformed rows', () => {
    expect(parseLsTree(`${line(A, 'a.ts')}${NUL}${NUL}garbage${NUL}`)).toEqual([
      { blobSha: A, path: 'a.ts' },
    ]);
  });
});

describe('readReadableSurface', () => {
  it('asks git for NUL-separated output (-z) — the whole point of the parser contract', () => {
    const calls: string[][] = [];
    const git: GitRun = (args) => {
      calls.push(args);
      return { ok: true, text: `${line(A, 'src/a.ts')}${NUL}` };
    };
    expect(readReadableSurface('/wt', 'deadbeef', { git })).toEqual([
      { blobSha: A, path: 'src/a.ts' },
    ]);
    expect(calls[0]).toEqual(['ls-tree', '-r', '-z', 'deadbeef']);
  });

  it('degrades to an empty surface when git fails — the manifest is advisory, never fatal', () => {
    const git: GitRun = () => ({ error: 'boom', ok: false });
    expect(readReadableSurface('/wt', 'deadbeef', { git })).toEqual([]);
  });
});
