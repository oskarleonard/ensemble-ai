import { describe, expect, it } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { type GateVerdictRecord, annotateBaseDrift, carryBaseDrift, rewriteGateVerdictsTrail, writeGateVerdictsTrail } from './gate';
import type { GitRun } from './worktree';

// Base drift (trail v12): a label, never a verdict. The branch point is computed locally
// (`merge-base <tip> <head>`), because the host's base sha is the tip at the PR's last sync and
// reads "not moved" on exactly the incident shape (author pushed after a teammate's merge).

const HEAD = 'a'.repeat(40);
const TIP = 'b'.repeat(40);
const SYNC = 'c'.repeat(40);
const POINT = 'd'.repeat(40);

function rec(over: Partial<GateVerdictRecord>): GateVerdictRecord {
  return {
    anchorSide: null,
    downgradeReason: null,
    effectiveVerdict: 'unverified',
    file: 'src/untouched.ts',
    findingId: 'codex#1',
    line: 40,
    postableBody: null,
    postableClass: null,
    postableFix: null,
    postableStatus: 'not-postable',
    postableSuggestion: null,
    rawVerdict: 'unverified',
    reason: 'pre-existing: x',
    rescoredSeverity: null,
    resolved: false,
    reviewer: 'codex',
    scope: { dependsOn: null, kind: 'pre-existing' },
    severity: 'high',
    title: 't',
    tldr: null,
    ...over,
  };
}

// A scripted git: answers by the leading subcommand; `diff` answers per file.
function stubGit(movedFiles: Set<string>, opts: { failDiff?: boolean; failMergeBase?: boolean } = {}): { calls: string[][]; git: GitRun } {
  const calls: string[][] = [];
  const git: GitRun = (args) => {
    calls.push(args);
    if (args[0] === 'merge-base') return opts.failMergeBase ? { error: 'boom', ok: false } : { ok: true, text: `${POINT}\n` };
    if (args[0] === 'rev-list') return { ok: true, text: '7\n' };
    if (args[0] === 'diff') {
      if (opts.failDiff) return { error: 'bad object', ok: false };
      const file = args[args.length - 1];
      return { ok: true, text: movedFiles.has(file) ? `${file}\n` : '' };
    }
    return { error: `unexpected ${args.join(' ')}`, ok: false };
  };
  return { calls, git };
}

describe('annotateBaseDrift', () => {
  it('labels a pre-existing record whose file the base changed since the BRANCH POINT, and records the base block', () => {
    const { calls, git } = stubGit(new Set(['src/untouched.ts']));
    const { base, records } = annotateBaseDrift([rec({})], { ref: 'develop-fixture', sha: SYNC, tip: TIP }, HEAD, git, '/wt');
    expect(records[0].scope?.movedOnBase).toBe(true);
    expect(records[0].effectiveVerdict).toBe('unverified'); // label only
    expect(base).toEqual({ behindBy: 7, branchPoint: POINT, ref: 'develop-fixture', sha: SYNC, tip: TIP });
    // the diff is taken from the merge-base, not the host's base sha
    const diff = calls.find((c) => c[0] === 'diff')!;
    expect(diff).toEqual(['diff', '--name-only', POINT, TIP, '--', 'src/untouched.ts']);
    expect(calls.find((c) => c[0] === 'merge-base')).toEqual(['merge-base', TIP, HEAD]);
  });

  it('false when the base did not touch the file; null when the probe fails; one probe per file', () => {
    const quiet = stubGit(new Set());
    expect(annotateBaseDrift([rec({}), rec({ findingId: 'claude#1' })], { ref: 'b', sha: SYNC, tip: TIP }, HEAD, quiet.git, '/wt').records.map((r) => r.scope?.movedOnBase)).toEqual([false, false]);
    expect(quiet.calls.filter((c) => c[0] === 'diff')).toHaveLength(1);
    const failing = stubGit(new Set(), { failDiff: true });
    expect(annotateBaseDrift([rec({})], { ref: 'b', sha: SYNC, tip: TIP }, HEAD, failing.git, '/wt').records[0].scope?.movedOnBase).toBeNull();
  });

  it('no branch point (merge-base fails) ⇒ labels null, never a guess from the host base sha', () => {
    const { calls, git } = stubGit(new Set(['src/untouched.ts']), { failMergeBase: true });
    const { base, records } = annotateBaseDrift([rec({})], { ref: 'b', sha: SYNC, tip: TIP }, HEAD, git, '/wt');
    expect(base?.branchPoint).toBeNull();
    expect(records[0].scope?.movedOnBase).toBeNull();
    expect(calls.find((c) => c[0] === 'diff')).toBeUndefined();
  });

  it('probes run with literal pathspecs and the inert env (a reviewer cite is never pathspec magic)', () => {
    const seen: Record<string, string>[] = [];
    const git: GitRun = (args, opts) => {
      seen.push(opts?.env ?? {});
      if (args[0] === 'merge-base') return { ok: true, text: `${POINT}\n` };
      if (args[0] === 'rev-list') return { ok: true, text: '1\n' };
      return { ok: true, text: '' };
    };
    annotateBaseDrift([rec({ file: ':!src/other.ts' })], { ref: 'b', sha: SYNC, tip: TIP }, HEAD, git, '/wt');
    expect(seen.every((e) => e.GIT_LITERAL_PATHSPECS === '1' && e.GIT_NO_REPLACE_OBJECTS === '1')).toBe(true);
  });

  it('touches only pre-existing and blast-radius records; no tip ⇒ nothing', () => {
    const { git } = stubGit(new Set(['src/changed.ts', 'src/untouched.ts']));
    const rows = [
      rec({ file: 'src/changed.ts', findingId: 'a#1', scope: { dependsOn: null, kind: 'in-diff' } }),
      rec({ file: 'src/changed.ts', findingId: 'a#2', scope: { dependsOn: null, kind: 'in-file' } }),
      rec({ findingId: 'a#3', scope: { dependsOn: { file: 'src/changed.ts', line: 3 }, kind: 'blast-radius' }, effectiveVerdict: 'agree' }),
      rec({ findingId: 'a#4', scope: undefined }),
    ];
    const { records } = annotateBaseDrift(rows, { ref: 'b', sha: SYNC, tip: TIP }, HEAD, git, '/wt');
    expect(records.map((r) => r.scope?.movedOnBase)).toEqual([undefined, undefined, true, undefined]);
    expect(records[2].effectiveVerdict).toBe('agree');
    const off = annotateBaseDrift(rows, { ref: 'b', sha: SYNC, tip: null }, HEAD, git, '/wt');
    expect(off.base).toBeNull();
    expect(off.records).toBe(rows);
    expect(annotateBaseDrift(rows, undefined, HEAD, git, '/wt').base).toBeNull();
  });
});

describe('carryBaseDrift — a regate reuses review-time facts', () => {
  it('copies movedOnBase by findingId and the base block; nothing without a prior base', () => {
    const prior = {
      base: { behindBy: 3, branchPoint: POINT, ref: 'b', sha: SYNC, tip: TIP },
      verdicts: [{ findingId: 'codex#1', scope: { movedOnBase: true } }, { findingId: 'x#9', scope: { movedOnBase: false } }],
    };
    const { base, records } = carryBaseDrift([rec({}), rec({ findingId: 'claude#2' })], prior);
    expect(base).toEqual(prior.base);
    expect(records[0].scope?.movedOnBase).toBe(true);
    expect(records[1].scope).toEqual({ dependsOn: null, kind: 'pre-existing' }); // unknown id: untouched
    expect(carryBaseDrift([rec({})], null).base).toBeNull();
    // A prior trail that lost its base block (an older rewrite) still carries per-record labels.
    const noBase = carryBaseDrift([rec({})], { base: null, verdicts: [{ findingId: 'codex#1', scope: { movedOnBase: true } }] });
    expect(noBase.base).toBeNull();
    expect(noBase.records[0].scope?.movedOnBase).toBe(true);
  });
});


describe('rewriteGateVerdictsTrail — the settler rewrite keeps the base block', () => {
  it('a records-only rewrite still carries the base block the gate wrote', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-drift-'));
    const base = { behindBy: 2, branchPoint: POINT, ref: 'b', sha: SYNC, tip: TIP };
    expect(writeGateVerdictsTrail(dir, 'run-1', [rec({})], base)).toBe(true);
    expect(rewriteGateVerdictsTrail(dir, 'run-1', [rec({ findingId: 'codex#1', reason: 'settled' })])).toBe(true);
    const trail = JSON.parse(fs.readFileSync(path.join(dir, 'run-1', 'gate-verdicts.json'), 'utf8'));
    expect(trail.base).toEqual(base);
    expect(trail.verdicts[0].reason).toBe('settled');
    fs.rmSync(dir, { force: true, recursive: true });
  });
});
