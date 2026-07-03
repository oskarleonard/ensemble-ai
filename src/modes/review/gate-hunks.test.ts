import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { reviewDir } from '../../core/artifacts';

import {
  GATE_PACKET_SCHEMA_VERSION,
  hunkCodeLines,
  hunkRangeKey,
  parseFileHunks,
  parsePacketHunks,
  persistGatePacket,
  readGatePacket,
  resolveFindingHunk,
  windowHunk,
} from './gate-hunks';

// A MIXED hunk: context + one deletion (old-side line 11) + two additions (new-side 11,12).
// The old-side deleted line and a new-side added line COLLIDE at number 11 — the case
// constraint #3 pins to a deterministic side-selection (new-side wins).
const MIXED = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,5 +10,6 @@ function foo() {
   const first = one();
-  const removedAtOldLineEleven = legacyPath();
+  const addedAtNewLineEleven = newPath();
+  const alsoAddedAtNewLineTwelve = anotherNewPath();
   const tail = two();
   return tail;
 }
`;

// A DELETION-ONLY hunk (newCount 0) — resolves on the OLD side.
const DELETION = `diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -20,3 +19,0 @@ ctx
-  const goneAtOldLineTwenty = removedThing();
-  const alsoGoneAtOldLineTwentyOne = removedTwo();
-  const thirdGoneAtOldLineTwentyTwo = removedThree();
`;

// A RENAMED file with a content change — the path resolves from `+++ b/<new path>`.
const RENAMED = `diff --git a/old/x.ts b/new/x.ts
similarity index 90%
rename from old/x.ts
rename to new/x.ts
--- a/old/x.ts
+++ b/new/x.ts
@@ -1,3 +1,3 @@
 const ctx = header();
-const oldRenamedContentLine = 1;
+const newRenamedContentLine = 2;
 const trailer = footer();
`;

describe('parseFileHunks + resolveFindingHunk — deterministic side-selection (constraint #3)', () => {
  it('a MIXED hunk resolves a cited line on the NEW side, never the colliding old-side deletion', () => {
    const hunks = parseFileHunks(MIXED);
    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ newCount: 6, newStart: 10, oldCount: 5, oldStart: 10 });
    // Line 11 is BOTH an old-side deleted line and a new-side added line. New-side wins.
    const r = resolveFindingHunk(hunks, 11);
    expect(r).not.toBeNull();
    expect(hunks[0].body[r!.bodyIndex]).toBe('+  const addedAtNewLineEleven = newPath();');
  });

  it('a DELETION-ONLY hunk resolves on the OLD side', () => {
    const hunks = parseFileHunks(DELETION);
    expect(hunks[0]).toMatchObject({ newCount: 0, oldCount: 3, oldStart: 20 });
    const r = resolveFindingHunk(hunks, 21);
    expect(r).not.toBeNull();
    expect(hunks[0].body[r!.bodyIndex]).toBe('-  const alsoGoneAtOldLineTwentyOne = removedTwo();');
  });

  it('a RENAMED file resolves by its NEW path + new-side line', () => {
    const map = parsePacketHunks(RENAMED);
    expect([...map.keys()]).toEqual(['new/x.ts']);
    const r = resolveFindingHunk(map.get('new/x.ts')!, 2);
    expect(r).not.toBeNull();
    expect(map.get('new/x.ts')![0].body[r!.bodyIndex]).toBe('+const newRenamedContentLine = 2;');
  });

  it('an out-of-range cite resolves to null (out-of-packet ⇒ the caller marks it unverified)', () => {
    expect(resolveFindingHunk(parseFileHunks(MIXED), 999)).toBeNull();
    expect(parsePacketHunks(MIXED).get('nope/missing.ts')).toBeUndefined();
  });

  it('a line in the DECLARED range but ABSENT from a malformed hunk body → null, not a forged index 0 (codex-f2)', () => {
    // The header claims 10 new-side lines; the body actually has ONE. Line 5 is "in range" per
    // the header yet not locatable → it must NOT be grounded on body index 0 (fail-closed), else
    // an unlocatable cite becomes a resolved + dismissible finding on unrelated first-line code.
    const malformed = { body: ['+  const only = realCode();'], header: '@@ -1,1 +1,10 @@', newCount: 10, newStart: 1, oldCount: 1, oldStart: 1 };
    expect(resolveFindingHunk([malformed], 5)).toBeNull();
    expect(resolveFindingHunk([malformed], 1)).toMatchObject({ bodyIndex: 0 }); // the present line still resolves
  });
});

describe('windowHunk — ±25-line bound → truncated flag', () => {
  it('a small hunk fits whole (not truncated)', () => {
    const hunks = parseFileHunks(MIXED);
    const w = windowHunk(hunks[0], 2);
    expect(w.truncated).toBe(false);
    expect(w.text).toContain('@@ -10,5 +10,6 @@');
    expect(w.text).toContain('const addedAtNewLineEleven');
  });

  it('a hunk larger than the ±window is truncated', () => {
    const body = Array.from({ length: 80 }, (_, i) => ` const line${i} = ${i};`);
    const bigHunk = { body, header: '@@ -1,80 +1,80 @@', newCount: 80, newStart: 1, oldCount: 80, oldStart: 1 };
    const w = windowHunk(bigHunk, 40, 25);
    expect(w.truncated).toBe(true);
    // exactly 2*25+1 body lines around the center, plus the header line
    expect(w.text.split('\n')).toHaveLength(1 + 51);
  });
});

describe('hunkCodeLines + hunkRangeKey', () => {
  it('strips +/-/space markers, normalizes whitespace, drops empties', () => {
    const lines = hunkCodeLines(parseFileHunks(MIXED)[0]);
    expect(lines).toContain('const addedAtNewLineEleven = newPath();');
    expect(lines).toContain('const removedAtOldLineEleven = legacyPath();');
    expect(lines.every((l) => !/^[ +-]/.test(l))).toBe(true);
  });

  it('keys a hunk by its new-side range (old-side for deletion-only)', () => {
    expect(hunkRangeKey('src/a.ts', parseFileHunks(MIXED)[0])).toBe('src/a.ts +10,6');
    expect(hunkRangeKey('src/b.ts', parseFileHunks(DELETION)[0])).toBe('src/b.ts -20,3');
  });
});

// ── Binding fix #1 (grok-f1/codex-f3) — truncation-marker-aware hunk parsing ────────────
// A pinned diff can carry the packet truncator's head+tail splice: `…[N chars truncated]…` between
// blank lines, with a PARTIAL line on each side of the cut. Neither the marker nor a partial
// fragment may become a citable line, and a hunk must never span the cut.
describe('parsePacketHunks — truncation-marker-aware (binding fix #1)', () => {
  // HEAD ends with a PARTIAL line (cut mid-token, no trailing newline).
  const HEAD_PART = `diff --git a/src/head.ts b/src/head.ts
--- a/src/head.ts
+++ b/src/head.ts
@@ -1,3 +1,4 @@
 export function head() {
+  const uniqueHeadGroundingLineHere = computeHeadValue(x);
   return h;
 }
+  const partialHeadLineCutMidTokenHere = veryLongExpr`;
  // TAIL resumes with a PARTIAL fragment, THEN a complete file section with its own header.
  const TAIL_PART = `partialTailFragmentBeforeItsFirstNewline
diff --git a/src/tail.ts b/src/tail.ts
--- a/src/tail.ts
+++ b/src/tail.ts
@@ -1,3 +1,4 @@
 export function tail() {
+  const uniqueTailGroundingLineHere = computeTailValue(y);
   return t;
 }
`;
  const TRUNCATED = `${HEAD_PART}\n\n…[9999 chars truncated]…\n\n${TAIL_PART}`;

  it('parses BOTH the head file and the post-marker tail file (with its own header)', () => {
    const map = parsePacketHunks(TRUNCATED);
    expect([...map.keys()].sort()).toEqual(['src/head.ts', 'src/tail.ts']);
    // the real, complete reviewer-visible lines resolve + are citable
    const headCode = hunkCodeLines(map.get('src/head.ts')![0]);
    const tailCode = hunkCodeLines(map.get('src/tail.ts')![0]);
    expect(headCode).toContain('const uniqueHeadGroundingLineHere = computeHeadValue(x);');
    expect(tailCode).toContain('const uniqueTailGroundingLineHere = computeTailValue(y);');
  });

  it('NEVER makes the marker or a partial boundary line citable (no bytes the reviewer did not see as code)', () => {
    const map = parsePacketHunks(TRUNCATED);
    const allCode = [...map.values()].flat().flatMap((h) => hunkCodeLines(h));
    // the truncation marker itself is not a code line
    expect(allCode.some((l) => /chars truncated/.test(l))).toBe(false);
    // the partial head line (cut mid-token) is dropped — not a complete line the reviewer saw
    expect(allCode.some((l) => l.includes('partialHeadLineCutMidTokenHere'))).toBe(false);
    // the partial tail fragment is dropped too
    expect(allCode.some((l) => l.includes('partialTailFragmentBeforeItsFirstNewline'))).toBe(false);
  });

  it('a NON-truncated (marker-free) diff parses normally — the common path is unchanged', () => {
    const clean = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,2 +1,3 @@
 const ctx = header();
+const soleUniqueGroundingLine = compute(v);
`;
    expect(hunkCodeLines(parsePacketHunks(clean).get('src/x.ts')![0])).toContain('const soleUniqueGroundingLine = compute(v);');
  });
});

describe('readGatePacket — pinned-packet identity is PROVEN (fail-closed)', () => {
  function tmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-gp-'));
  }

  it('round-trips a written packet when the head SHA matches', () => {
    const base = tmp();
    persistGatePacket(base, 'r1', { diff: MIXED, headSha: 'abc123' });
    const read = readGatePacket(base, 'r1', 'abc123');
    expect(read).toEqual({ diff: MIXED, ok: true });
  });

  it('reports missing / corrupt / sha-mismatch distinctly (all → packet-fail)', () => {
    const base = tmp();
    expect(readGatePacket(base, 'none', 'x')).toEqual({ ok: false, reason: 'missing' });

    persistGatePacket(base, 'r2', { diff: MIXED, headSha: 'sha-A' });
    expect(readGatePacket(base, 'r2', 'sha-B')).toEqual({ ok: false, reason: 'sha-mismatch' });

    // Corrupt JSON on disk
    fs.mkdirSync(reviewDir(base, 'r4'), { recursive: true });
    fs.writeFileSync(path.join(reviewDir(base, 'r4'), 'packet.gate.json'), '{ not json', 'utf8');
    expect(readGatePacket(base, 'r4', 'x')).toEqual({ ok: false, reason: 'corrupt' });

    // Wrong schemaVersion → corrupt (unrecognized shape, never guessed)
    fs.mkdirSync(reviewDir(base, 'r5'), { recursive: true });
    fs.writeFileSync(
      path.join(reviewDir(base, 'r5'), 'packet.gate.json'),
      JSON.stringify({ diff: MIXED, headSha: 'x', schemaVersion: GATE_PACKET_SCHEMA_VERSION + 99 })
    );
    expect(readGatePacket(base, 'r5', 'x')).toEqual({ ok: false, reason: 'corrupt' });

    // A stale v1 packet (which pinned the FULL pre-truncation diff) is now unrecognized → corrupt
    // (Phase 2 pins reviewer-visible bytes under v2), so a citation can't validate against bytes
    // the reviewer never saw. The schema version is bumped to 2 exactly for this semantic change.
    expect(GATE_PACKET_SCHEMA_VERSION).toBe(2);
    fs.mkdirSync(reviewDir(base, 'r6'), { recursive: true });
    fs.writeFileSync(
      path.join(reviewDir(base, 'r6'), 'packet.gate.json'),
      JSON.stringify({ diff: MIXED, headSha: 'x', schemaVersion: 1 })
    );
    expect(readGatePacket(base, 'r6', 'x')).toEqual({ ok: false, reason: 'corrupt' });
  });
});
