import { describe, expect, it } from 'vitest';

import { DOWNGRADE_REASONS, type GateFinding, findingScope, reconcileGateVerdicts } from './gate';
import { parsePacketHunks } from './gate-hunks';

// SCOPE (trail v11): "true at the head" is not "caused by this PR". A worktree-fed gate may confirm
// a finding that cites code outside the diff, but the host then requires a RESOLVING `dependsOn`
// pointer into the pinned hunks; none ⇒ pre-existing ⇒ the agree/partial fails closed to
// unverified and never posts. Born from a live run where a HIGH about an untouched file, already
// fixed on the base branch, led a foreign PR's review.

const DIFF = `diff --git a/src/changed.ts b/src/changed.ts
--- a/src/changed.ts
+++ b/src/changed.ts
@@ -1,4 +1,5 @@
 export function x() {
   const a = compute();
+  const veryUniqueGroundingLineHere = a.value.length;
   return a;
 }
`;
const hunks = parsePacketHunks(DIFF);
const changedFiles = new Set(['src/changed.ts', 'src/omitted-over-ceiling.ts']);

const inDiff: GateFinding = {
  anchorSide: 'new',
  body: 'b',
  file: 'src/changed.ts',
  findingId: 'codex#1',
  hunkCode: ['const veryUniqueGroundingLineHere = a.value.length;'],
  hunkLabel: 'H1',
  line: 3,
  resolved: true,
  reviewer: 'codex',
  severity: 'high',
  title: 't',
  truncated: false,
};
// A cite into a file this PR never touched — the hunk is unavailable, like the incident's.
const outOfDiff: GateFinding = {
  ...inDiff,
  anchorSide: null,
  file: 'src/untouched.ts',
  findingId: 'codex#2',
  hunkCode: [],
  hunkLabel: null,
  line: 40,
  resolved: false,
};

const envelope = (verdict: string, extra: Record<string, unknown> = {}, findingId = 'codex#2') => ({
  agreements: [],
  bottomLine: '',
  disagreements: [],
  verdicts: [{ findingId, reason: 'grounded in the tree', verdict, ...extra }],
});
const worktree = { changedFiles, gateEvidence: 'worktree' as const, packetHunks: hunks };

describe('findingScope — pure, decided from host-owned facts', () => {
  it('a resolved cite is in-diff regardless of evidence or pointer', () => {
    expect(findingScope(inDiff, undefined, 'packet', hunks, changedFiles).kind).toBe('in-diff');
    expect(findingScope(inDiff, 'none', 'worktree', hunks, changedFiles).kind).toBe('in-diff');
  });

  it('packet evidence or no pinned hunks ⇒ unknown (a packet gate cannot walk the tree)', () => {
    expect(findingScope(outOfDiff, undefined, 'packet', hunks, changedFiles).kind).toBe('unknown');
    expect(findingScope(outOfDiff, undefined, 'worktree', undefined, changedFiles).kind).toBe('unknown');
  });

  it('a cite into a file this PR CHANGES — off-hunk, file-level, or coverage-omitted — ⇒ in-file (never demoted)', () => {
    // Off every pinned hunk of a changed file (the common shape: a reviewer cites a few lines away).
    const offHunk = { ...outOfDiff, file: 'src/changed.ts', line: 40 };
    expect(findingScope(offHunk, undefined, 'worktree', hunks, changedFiles).kind).toBe('in-file');
    // File-level cite (line null) on a changed file.
    const fileLevel = { ...outOfDiff, file: 'src/changed.ts', line: null };
    expect(findingScope(fileLevel, 'none', 'worktree', hunks, changedFiles).kind).toBe('in-file');
    // Changed file whose hunks the packet splice dropped.
    const omitted = { ...outOfDiff, file: 'src/omitted-over-ceiling.ts' };
    expect(findingScope(omitted, undefined, 'worktree', hunks, changedFiles).kind).toBe('in-file');
  });

  it('a dependsOn that lands on an unchanged CONTEXT line of a hunk is not a dependency ⇒ pre-existing', () => {
    // Line 2 of src/changed.ts is `  const a = compute();` — context, not + or -.
    expect(findingScope(outOfDiff, { file: 'src/changed.ts', line: 2 }, 'worktree', hunks, changedFiles).kind).toBe('pre-existing');
  });

  it('a dependsOn that RESOLVES to a pinned hunk ⇒ blast-radius, with the resolved pointer', () => {
    const s = findingScope(outOfDiff, { file: 'src/changed.ts', line: 3 }, 'worktree', hunks, changedFiles);
    expect(s).toEqual({ dependsOn: { file: 'src/changed.ts', line: 3 }, kind: 'blast-radius' });
  });

  it('"none", absent, or a pointer that resolves to no hunk ⇒ pre-existing (fail-closed)', () => {
    expect(findingScope(outOfDiff, 'none', 'worktree', hunks, changedFiles).kind).toBe('pre-existing');
    expect(findingScope(outOfDiff, undefined, 'worktree', hunks, changedFiles).kind).toBe('pre-existing');
    expect(findingScope(outOfDiff, { file: 'src/changed.ts', line: 900 }, 'worktree', hunks, changedFiles).kind).toBe('pre-existing');
    expect(findingScope(outOfDiff, { file: 'src/elsewhere.ts', line: 1 }, 'worktree', hunks, changedFiles).kind).toBe('pre-existing');
  });
});

describe('reconcile — an out-of-diff agree/partial without a resolving dependency never posts', () => {
  it('pre-existing is a member of the downgrade taxonomy (additive)', () => {
    expect(DOWNGRADE_REASONS).toContain('pre-existing');
  });

  it('agree on an out-of-diff cite with no dependsOn ⇒ unverified(pre-existing), not postable, scope recorded', () => {
    const { records } = reconcileGateVerdicts([outOfDiff], envelope('agree'), worktree);
    const r = records[0];
    expect(r.effectiveVerdict).toBe('unverified');
    expect(r.downgradeReason).toBe('pre-existing');
    expect(r.rawVerdict).toBe('agree');
    expect(r.reason.startsWith('pre-existing:')).toBe(true);
    expect(r.reason).toContain('grounded in the tree');
    expect(r.postableStatus).toBe('not-postable');
    expect(r.postableBody).toBeNull();
    expect(r.tldr).toBeNull();
    expect(r.scope).toEqual({ dependsOn: null, kind: 'pre-existing' });
  });

  it('partial with "dependsOn": "none" is demoted the same way', () => {
    const { records } = reconcileGateVerdicts([outOfDiff], envelope('partial', { dependsOn: 'none', ops: [] }), worktree);
    expect(records[0].effectiveVerdict).toBe('unverified');
    expect(records[0].downgradeReason).toBe('pre-existing');
  });

  it('a resolving dependsOn keeps the agree standing — blast radius is this PR`s defect', () => {
    const { records, warnings } = reconcileGateVerdicts(
      [outOfDiff],
      envelope('agree', { dependsOn: { file: 'src/changed.ts', line: 3 }, tldr: 'plain words' }),
      worktree
    );
    expect(records[0].effectiveVerdict).toBe('agree');
    expect(records[0].downgradeReason).toBeNull();
    expect(records[0].postableStatus).toBe('postable');
    expect(records[0].scope).toEqual({ dependsOn: { file: 'src/changed.ts', line: 3 }, kind: 'blast-radius' });
    expect(warnings).toEqual([]);
  });

  it('a dependsOn that resolves to no hunk demotes WITH a warning naming the dead pointer', () => {
    const { records, warnings } = reconcileGateVerdicts(
      [outOfDiff],
      envelope('agree', { dependsOn: { file: 'src/changed.ts', line: 900 } }),
      worktree
    );
    expect(records[0].downgradeReason).toBe('pre-existing');
    expect(warnings.join(' ')).toMatch(/dependsOn.*src\/changed\.ts:900.*resolves to no hunk/);
  });

  it('on PACKET evidence nothing is demoted — the pre-v11 behavior, scope unknown', () => {
    const { records } = reconcileGateVerdicts([outOfDiff], envelope('agree'), { gateEvidence: 'packet', packetHunks: hunks, changedFiles });
    expect(records[0].effectiveVerdict).toBe('agree');
    expect(records[0].downgradeReason).toBeNull();
    expect(records[0].scope).toEqual({ dependsOn: null, kind: 'unknown' });
  });

  it('with no scope facts supplied (older callers) nothing is demoted either', () => {
    const { records } = reconcileGateVerdicts([outOfDiff], envelope('agree'), { gateEvidence: 'worktree' });
    expect(records[0].effectiveVerdict).toBe('agree');
    expect(records[0].scope).toEqual({ dependsOn: null, kind: 'unknown' });
  });

  it('an agree on an off-hunk cite in a CHANGED file is untouched (in-file), with or without dependsOn', () => {
    const offHunk = { ...outOfDiff, file: 'src/changed.ts', line: 40 };
    const { records } = reconcileGateVerdicts([offHunk], envelope('agree', { dependsOn: 'none' }), worktree);
    expect(records[0].effectiveVerdict).toBe('agree');
    expect(records[0].downgradeReason).toBeNull();
    expect(records[0].scope).toEqual({ dependsOn: null, kind: 'in-file' });
  });

  it('an in-diff agree carries scope in-diff and is untouched', () => {
    const { records } = reconcileGateVerdicts([inDiff], envelope('agree', {}, 'codex#1'), worktree);
    expect(records[0].effectiveVerdict).toBe('agree');
    expect(records[0].scope).toEqual({ dependsOn: null, kind: 'in-diff' });
  });

  it('an unverified out-of-diff verdict keeps its own verdict; scope rides as data', () => {
    const { records } = reconcileGateVerdicts([outOfDiff], envelope('unverified', { dependsOn: 'none' }), worktree);
    expect(records[0].effectiveVerdict).toBe('unverified');
    expect(records[0].downgradeReason).toBeNull();
    expect(records[0].scope?.kind).toBe('pre-existing');
  });

  it('a holistic-lens record is exempt (its own policy owns the in-diff requirement)', () => {
    const lens = { ...outOfDiff, findingId: 'holistic#1', reviewer: 'holistic' };
    const { records } = reconcileGateVerdicts([lens], envelope('unverified', {}, 'holistic#1'), worktree);
    expect(records[0].scope).toBeUndefined();
  });
});
