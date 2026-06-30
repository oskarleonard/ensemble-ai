import { describe, expect, it } from 'vitest';

import {
  canonicalizeDiff,
  classifyFileKind,
  computeCoverage,
  diffDigest,
  parseDiffFiles,
} from './diff';

const SRC = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
-const a = 0;
+const a = 1;
 export { a };
`;

const LOCKFILE = `diff --git a/package-lock.json b/package-lock.json
index 333..444 100644
--- a/package-lock.json
+++ b/package-lock.json
@@ -1,1 +1,2 @@
+  "added": true
`;

const BINARY = `diff --git a/img.png b/img.png
index 555..666 100644
Binary files a/img.png and b/img.png differ
`;

describe('parseDiffFiles', () => {
  it('splits a multi-file diff into per-file sections with paths + line counts', () => {
    const files = parseDiffFiles(SRC + LOCKFILE + BINARY);
    expect(files.map((f) => f.path)).toEqual([
      'src/a.ts',
      'package-lock.json',
      'img.png',
    ]);
    const a = files[0];
    expect(a.added).toBe(1);
    expect(a.removed).toBe(1);
    expect(a.bytes).toBeGreaterThan(0);
  });

  it('detects a binary file section', () => {
    const [bin] = parseDiffFiles(BINARY);
    expect(bin.isBinary).toBe(true);
    expect(bin.kind).toBe('binary');
  });

  it('returns [] for an empty diff', () => {
    expect(parseDiffFiles('')).toEqual([]);
    expect(parseDiffFiles('   \n')).toEqual([]);
  });
});

describe('classifyFileKind', () => {
  it('classifies lockfiles / build output as generated', () => {
    expect(classifyFileKind('package-lock.json', false)).toBe('generated');
    expect(classifyFileKind('pnpm-lock.yaml', false)).toBe('generated');
    expect(classifyFileKind('dist/bundle.js', false)).toBe('generated');
    expect(classifyFileKind('app.min.js', false)).toBe('generated');
  });

  it('classifies ordinary code as source', () => {
    expect(classifyFileKind('src/a.ts', false)).toBe('source');
    expect(classifyFileKind('lib/util.py', false)).toBe('source');
  });

  it('classifies anything binary as binary, regardless of path', () => {
    expect(classifyFileKind('src/a.ts', true)).toBe('binary');
  });
});

describe('computeCoverage', () => {
  it('includes source, omits generated + binary — and NAMES every omission (no silent drop)', () => {
    const files = parseDiffFiles(SRC + LOCKFILE + BINARY);
    const { coverage, includedDiff } = computeCoverage(files);
    expect(coverage.totalFiles).toBe(3);
    expect(coverage.includedFiles).toBe(1);
    expect(coverage.omittedFiles).toBe(2);
    const omitted = coverage.files.filter((f) => !f.included);
    expect(omitted.map((f) => [f.path, f.omitReason]).sort()).toEqual([
      ['img.png', 'binary'],
      ['package-lock.json', 'generated'],
    ]);
    // the included diff is exactly the source section (the reviewer sees only it)
    expect(includedDiff).toContain('src/a.ts');
    expect(includedDiff).not.toContain('package-lock.json');
  });

  it('omits a source file as over-limit (NAMED) when the byte ceiling is exceeded', () => {
    const big = `diff --git a/src/big.ts b/src/big.ts
@@ -1,1 +1,1 @@
+${'x'.repeat(500)}
`;
    const files = parseDiffFiles(SRC + big);
    // ceiling fits the first source file but not both → second is over-limit
    const { coverage } = computeCoverage(files, 200);
    const over = coverage.files.find((f) => f.path === 'src/big.ts');
    expect(over?.included).toBe(false);
    expect(over?.omitReason).toBe('over-limit');
    expect(over?.kind).toBe('source'); // an omitted SOURCE file → disqualifies a receipt
  });

  it('always includes the first file even if it alone exceeds the ceiling (never drops everything)', () => {
    const { coverage } = computeCoverage(parseDiffFiles(SRC), 1);
    expect(coverage.includedFiles).toBe(1);
  });
});

describe('canonicalizeDiff + diffDigest', () => {
  it('is stable across CRLF and trailing-newline noise', () => {
    const lf = 'a\nb\n';
    const crlf = 'a\r\nb\r\n\n\n';
    expect(canonicalizeDiff(crlf)).toBe(canonicalizeDiff(lf));
    expect(diffDigest(crlf)).toBe(diffDigest(lf));
  });

  it('is a sha256:-prefixed digest, distinct for distinct content', () => {
    expect(diffDigest(SRC)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(diffDigest(SRC)).not.toBe(diffDigest(LOCKFILE));
  });
});
