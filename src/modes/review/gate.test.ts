import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { reviewDir } from '../../core/artifacts';
import type { ReviewFinding } from '../../core/types';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';

import {
  GATE_TRAIL_SCHEMA_VERSION,
  type GateFinding,
  honoredHighDismissals,
  parseGateEnvelope,
  prepareGateFindings,
  reconcileGateVerdicts,
  renderGateVerdicts,
  runGate,
  validateCitation,
  verdictCounts,
  writeGateVerdictsTrail,
} from './gate';
import { parsePacketHunks, persistGatePacket } from './gate-hunks';
import type { VoiceReview } from './synthesis';

const CFG: VoiceConfig = { cmd: 'claude', effort: 'default', id: 'claude', model: 'default', vendor: 'anthropic' };
const HEAD = 'HEADSHA';
const okRun = (raw: string): VoiceRunResult => ({ ok: true, raw, stderrTail: '', timedOut: false });
const scrub = (s: string): string => s;

// A diff whose new-side line 3 is a UNIQUE, ≥16-non-ws-char code line — a clean anchor.
const DIFF = `diff --git a/src/x.ts b/src/x.ts
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,4 +1,5 @@
 export function x() {
   const a = compute();
+  const veryUniqueGroundingLineHere = a.value.length;
   return a;
 }
`;
const ANCHOR = 'const veryUniqueGroundingLineHere = a.value.length;';

function f(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return { body: 'b', confidence: 'high', evidence: { file: 'src/x.ts', line: 3 }, id: 'f1', severity: 'high', title: 't', ...over };
}
function review(voiceId: string, findings: ReviewFinding[]): VoiceReview {
  return { findings, ok: true, summary: `${voiceId} read`, voiceId };
}
function gf(over: Partial<GateFinding> = {}): GateFinding {
  return {
    body: 'b', file: 'src/x.ts', findingId: 'codex#1', hunkCode: [ANCHOR],
    hunkLabel: 'H1', line: 3, resolved: true, reviewer: 'codex', severity: 'high',
    title: 't', truncated: false, ...over,
  };
}
function envelope(verdicts: unknown[], over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    synthesis: { agreements: [], bottomLine: 'bl', disagreements: [] },
    verdicts,
    ...over,
  });
}

// ── DC2 — grounded citation validation + minimum-anchor negatives ──────────────────────
describe('validateCitation — own-hunk substring + deterministic minimum anchor (DC2)', () => {
  const codeLines = [
    'function n() {',
    'return x;',
    'const dup = repeatedBoilerplateLineHere();',
    'const dup = repeatedBoilerplateLineHere();',
    'const okLongUniqueAnchorLine = compute(value);',
    '}',
  ];

  it('accepts a citation quoting a unique ≥16-non-ws line (whitespace-normalized)', () => {
    expect(validateCitation('here → const okLongUniqueAnchorLine = compute(value);', codeLines).valid).toBe(true);
    // extra whitespace in the quote still matches (normalized)
    expect(validateCitation('const   okLongUniqueAnchorLine =    compute(value);', codeLines).valid).toBe(true);
  });

  it('REJECTS a `}`-only line and a <16-non-ws fragment (fail predicate a)', () => {
    expect(validateCitation('the code is just }', codeLines).valid).toBe(false);
    expect(validateCitation('return x;', codeLines).valid).toBe(false); // 8 non-ws chars
    expect(validateCitation('function n() {', codeLines).valid).toBe(false); // 12 non-ws chars
  });

  it('REJECTS a repeated idiom line (fail predicate b — not unique-in-hunk)', () => {
    expect(validateCitation('const dup = repeatedBoilerplateLineHere();', codeLines).valid).toBe(false);
  });

  it('REJECTS an empty citation and a citation not in the hunk at all', () => {
    expect(validateCitation('', codeLines).valid).toBe(false);
    expect(validateCitation('a line that is nowhere in this hunk whatsoever', codeLines).valid).toBe(false);
  });
});

// ── DC10 — envelope parse + host-owned reconciliation per-entry policy ─────────────────
describe('parseGateEnvelope — schemaVersion fail-closed + unparseable (DC10 · constraint #2)', () => {
  it('parses a well-formed envelope', () => {
    const p = parseGateEnvelope(envelope([{ findingId: 'codex#1', reason: 'r', verdict: 'agree' }]));
    expect('failure' in p).toBe(false);
    if (!('failure' in p)) {
      expect(p.bottomLine).toBe('bl');
      expect(p.verdicts).toEqual([{ citation: undefined, findingId: 'codex#1', reason: 'r', verdict: 'agree' }]);
    }
  });

  it('a MISSING or UNSUPPORTED schemaVersion ⇒ unknown-schema (whole envelope fails closed)', () => {
    expect(parseGateEnvelope(JSON.stringify({ synthesis: {}, verdicts: [] }))).toEqual({ failure: 'unknown-schema' });
    expect(parseGateEnvelope(envelope([], { schemaVersion: 99 }))).toEqual({ failure: 'unknown-schema' });
  });

  it('a fully-unparseable reply ⇒ gate-failed', () => {
    expect(parseGateEnvelope('no json at all here')).toEqual({ failure: 'gate-failed' });
  });
});

describe('reconcileGateVerdicts — host-owned per-entry policy (DC10)', () => {
  it('applies missing / duplicate / unknown-id / bad-enum / agree deterministically; severity untouched', () => {
    const findings = [gf({ findingId: 'codex#1' }), gf({ findingId: 'grok#1' }), gf({ findingId: 'codex#2' }), gf({ findingId: 'grok#2' })];
    const parsed = parseGateEnvelope(
      envelope([
        { findingId: 'codex#1', reason: 'ok', verdict: 'agree' },
        { findingId: 'grok#1', reason: 'a', verdict: 'false' },
        { findingId: 'grok#1', reason: 'b', verdict: 'agree' }, // duplicate → all discarded
        { findingId: 'grok#2', reason: 'x', verdict: 'maybe' }, // bad enum
        { findingId: 'zzz#9', reason: 'x', verdict: 'agree' }, // unknown id → ignored+warned
        // codex#2 has NO entry → missing
      ])
    );
    const { records, warnings } = reconcileGateVerdicts(findings, parsed);
    const byId = Object.fromEntries(records.map((r) => [r.findingId, r]));
    expect(byId['codex#1']).toMatchObject({ downgradeReason: null, effectiveVerdict: 'agree', rawVerdict: 'agree' });
    expect(byId['grok#1']).toMatchObject({ downgradeReason: 'duplicate', effectiveVerdict: 'unverified', rawVerdict: null });
    expect(byId['codex#2']).toMatchObject({ downgradeReason: 'missing', effectiveVerdict: 'unverified' });
    expect(byId['grok#2']).toMatchObject({ downgradeReason: 'bad-enum', effectiveVerdict: 'unverified', rawVerdict: 'maybe' });
    // the host owns severity — nothing the gate echoed altered it
    expect(records.every((r) => r.severity === 'high')).toBe(true);
    expect(warnings.some((w) => w.includes('zzz#9'))).toBe(true);
  });

  it('only a WHOLE-envelope failure ⇒ every finding unverified with that machine reason', () => {
    const findings = [gf({ findingId: 'codex#1' }), gf({ findingId: 'grok#1' })];
    for (const failure of ['gate-failed', 'unknown-schema', 'packet-fail'] as const) {
      const { records } = reconcileGateVerdicts(findings, { failure });
      expect(records.every((r) => r.effectiveVerdict === 'unverified' && r.downgradeReason === failure)).toBe(true);
    }
  });

  it('a `false` verdict — valid citation honored, invalid/missing/out-of-packet downgraded (DC2)', () => {
    const good = reconcileGateVerdicts(
      [gf({ findingId: 'codex#1' })],
      parseGateEnvelope(envelope([{ citation: ANCHOR, findingId: 'codex#1', reason: 'refuted', verdict: 'false' }]))
    ).records[0];
    expect(good).toMatchObject({ downgradeReason: null, effectiveVerdict: 'false' });

    // no citation
    expect(
      reconcileGateVerdicts([gf()], parseGateEnvelope(envelope([{ findingId: 'codex#1', reason: 'r', verdict: 'false' }]))).records[0]
    ).toMatchObject({ downgradeReason: 'invalid-citation', effectiveVerdict: 'unverified', rawVerdict: 'false' });

    // non-matching citation
    expect(
      reconcileGateVerdicts([gf()], parseGateEnvelope(envelope([{ citation: 'not in the hunk', findingId: 'codex#1', reason: 'r', verdict: 'false' }]))).records[0]
    ).toMatchObject({ downgradeReason: 'invalid-citation', effectiveVerdict: 'unverified' });

    // out-of-packet (finding never resolved to a hunk) → no dismissal
    expect(
      reconcileGateVerdicts([gf({ hunkCode: [], resolved: false })], parseGateEnvelope(envelope([{ citation: ANCHOR, findingId: 'codex#1', reason: 'r', verdict: 'false' }]))).records[0]
    ).toMatchObject({ downgradeReason: 'invalid-citation', effectiveVerdict: 'unverified' });
  });
});

// ── DC12 — truncation ineligibility (host-forced, regardless of citation) ──────────────
describe('reconcileGateVerdicts — truncated finding is dismissal-INELIGIBLE (DC12)', () => {
  it('forces a truncated finding\'s `false` (even with a valid citation) to unverified(truncated)', () => {
    const rec = reconcileGateVerdicts(
      [gf({ truncated: true })],
      parseGateEnvelope(envelope([{ citation: ANCHOR, findingId: 'codex#1', reason: 'refuted', verdict: 'false' }]))
    ).records[0];
    expect(rec).toMatchObject({ downgradeReason: 'truncated', effectiveVerdict: 'unverified', rawVerdict: 'false' });
  });
});

// ── DC1 — prepare findings: HIGH-first ordering, dedup, windowing + byte-budget truncation
describe('prepareGateFindings — deterministic budgeting (DC1)', () => {
  it('orders injection labels HIGH-first (severity → reviewer → index)', () => {
    const DIFF2 = `diff --git a/src/y.ts b/src/y.ts
--- a/src/y.ts
+++ b/src/y.ts
@@ -1,3 +1,4 @@
 export function y() {
+  const anotherUniqueGroundingLineY = q.data.size;
   return q;
 }
`;
    const hunks = parsePacketHunks(DIFF + DIFF2);
    const reviews = [
      review('codex', [f({ severity: 'low', evidence: { file: 'src/x.ts', line: 3 } })]),
      review('grok', [f({ severity: 'high', evidence: { file: 'src/y.ts', line: 2 } })]),
    ];
    const { findings } = prepareGateFindings(reviews, hunks);
    const byId = Object.fromEntries(findings.map((r) => [r.findingId, r]));
    // grok's HIGH gets H1 (allocated first), codex's LOW gets H2
    expect(byId['grok#1'].hunkLabel).toBe('H1');
    expect(byId['codex#1'].hunkLabel).toBe('H2');
  });

  it('dedups identical (file, hunk-range) injections — charged once, shared label', () => {
    const hunks = parsePacketHunks(DIFF);
    const reviews = [review('codex', [f(), f({ id: 'f2' })])]; // both cite src/x.ts:3
    const { findings, injections } = prepareGateFindings(reviews, hunks);
    expect(injections).toHaveLength(1);
    expect(findings.map((r) => r.hunkLabel)).toEqual(['H1', 'H1']);
  });

  it('NAMES an over-byte-budget hunk as truncated (dismissal-ineligible), never silently drops it', () => {
    // Two ~45KB windowed hunks; the byte budget (40,960) admits the first, truncates the second.
    const hunks = parsePacketHunks(BIG_FILE('src/a.ts', 'aa') + BIG_FILE('src/b.ts', 'bb'));
    const reviews = [
      review('codex', [
        f({ evidence: { file: 'src/a.ts', line: 20 } }),
        f({ id: 'f2', evidence: { file: 'src/b.ts', line: 20 } }),
      ]),
    ];
    const { findings, injections } = prepareGateFindings(reviews, hunks);
    expect(injections).toHaveLength(1); // only the first fit the budget
    expect(findings[0]).toMatchObject({ hunkLabel: 'H1', truncated: false });
    expect(findings[1]).toMatchObject({ hunkLabel: null, truncated: true }); // budget-dropped
  });

  it('an out-of-diff cite yields no hunk (resolved=false)', () => {
    const { findings } = prepareGateFindings(
      [review('codex', [f({ evidence: { file: 'nope.ts', line: 1 } })])],
      parsePacketHunks(DIFF)
    );
    expect(findings[0]).toMatchObject({ hunkLabel: null, resolved: false });
  });
});

// ── DC11 — trail durability gates dismissal-honoring ──────────────────────────────────
describe('honoredHighDismissals + writeGateVerdictsTrail (DC11)', () => {
  it('a validated-false HIGH is honored ONLY after the trail durably writes', () => {
    const records = reconcileGateVerdicts(
      [gf({ findingId: 'codex#1' })],
      parseGateEnvelope(envelope([{ citation: ANCHOR, findingId: 'codex#1', reason: 'r', verdict: 'false' }]))
    ).records;
    expect(records[0].effectiveVerdict).toBe('false');
    expect(honoredHighDismissals(records, true)).toEqual(['codex#1']);
    expect(honoredHighDismissals(records, false)).toEqual([]); // trail write failed → NOT honored
  });

  it('writeGateVerdictsTrail returns false on a write failure (read-only dir)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-gt-'));
    fs.mkdirSync(reviewDir(base, 'r'), { recursive: true });
    fs.chmodSync(reviewDir(base, 'r'), 0o500);
    try {
      expect(writeGateVerdictsTrail(base, 'r', [])).toBe(false);
    } finally {
      fs.chmodSync(reviewDir(base, 'r'), 0o700);
    }
  });
});

// ── Rendering ─────────────────────────────────────────────────────────────────────────
describe('renderGateVerdicts — tags, counts, teeth notice, trail marker', () => {
  it('prints every finding tag + the summary counts line', () => {
    const records = reconcileGateVerdicts(
      [gf({ findingId: 'codex#1' }), gf({ findingId: 'grok#1', severity: 'medium' })],
      parseGateEnvelope(envelope([
        { citation: ANCHOR, findingId: 'codex#1', reason: 'refuted', verdict: 'false' },
        { findingId: 'grok#1', reason: 'real', verdict: 'agree' },
      ]))
    ).records;
    const text = renderGateVerdicts(records, { scrub, trailWritten: true }).join('\n');
    expect(text).toMatch(/\[false\] codex#1/);
    expect(text).toMatch(/\[agree\] grok#1/);
    expect(text).toContain('gate — 1 agree · 0 partial · 1 false (dismissed) · 0 unverified');
    expect(verdictCounts(records)).toEqual({ agree: 1, false: 1, partial: 0, unverified: 0 });
  });

  it('emits the "teeth did not engage" notice when findings exist but zero verdicts landed', () => {
    const records = reconcileGateVerdicts([gf()], { failure: 'gate-failed' }).records;
    const text = renderGateVerdicts(records, { scrub, trailWritten: true }).join('\n');
    expect(text).toContain('gate teeth did not engage');
  });

  it('renders a LOUD trail-failed marker (dismissals not honored)', () => {
    const records = reconcileGateVerdicts([gf()], { failure: 'gate-failed' }).records;
    const text = renderGateVerdicts(records, { scrub, trailWritten: false }).join('\n');
    expect(text).toMatch(/gate trail: FAILED/);
  });
});

// ── DC5 / DC3 / DC12 — runGate end-to-end (fail-closed, trail shape, packet-fail) ──────
describe('runGate — end-to-end (DC3 · DC5 · DC12)', () => {
  function seed(diff = DIFF, headSha = HEAD): { base: string; runId: string } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-rg-'));
    const runId = 'r';
    persistGatePacket(base, runId, { diff, headSha });
    return { base, runId };
  }
  const reviews = [
    review('codex', [f({ title: 'codex a' }), f({ id: 'f2', title: 'codex b' })]),
    review('grok', [f({ title: 'grok a' })]),
    review('claude', [f({ title: 'claude a' })]),
  ];
  const goodEnvelope = envelope([
    { citation: ANCHOR, findingId: 'codex#1', reason: 'refuted', verdict: 'false' },
    { findingId: 'codex#2', reason: 'real', verdict: 'agree' },
    { findingId: 'grok#1', reason: 'overstated', verdict: 'partial' },
    { findingId: 'claude#1', reason: 'cannot ground', verdict: 'unverified' },
  ]);

  it('writes gate-verdicts.json with ONE entry per finding across all three reviewers + stable ids (DC3)', async () => {
    const { base, runId } = seed();
    const res = await runGate({ baseDir: base, config: CFG, expectedHeadSha: HEAD, reviews, run: async () => okRun(goodEnvelope), runId });
    expect(res.gateTrailWritten).toBe(true);
    expect(res.verdicts.map((v) => v.findingId).sort()).toEqual(['claude#1', 'codex#1', 'codex#2', 'grok#1']);
    const trail = JSON.parse(fs.readFileSync(path.join(reviewDir(base, runId), 'gate-verdicts.json'), 'utf8'));
    expect(trail.schemaVersion).toBe(GATE_TRAIL_SCHEMA_VERSION);
    expect(trail.verdicts).toHaveLength(4);
    // the validated-false HIGH is honored (trail written); its raw + effective are BOTH recorded
    const codex1 = trail.verdicts.find((v: { findingId: string }) => v.findingId === 'codex#1');
    expect(codex1).toMatchObject({ effectiveVerdict: 'false', rawVerdict: 'false' });
    expect(honoredHighDismissals(res.verdicts, res.gateTrailWritten)).toEqual(['codex#1']);
  });

  it('FAIL-CLOSED: a spawn throw / timeout / unparseable ⇒ fallback synthesis + all unverified, never throws (DC5)', async () => {
    for (const run of [
      async () => { throw new Error('boom'); },
      async (): Promise<VoiceRunResult> => ({ ok: false, raw: null, stderrTail: '', timedOut: true }),
      async () => okRun('not json'),
    ]) {
      const { base, runId } = seed();
      const res = await runGate({ baseDir: base, config: CFG, expectedHeadSha: HEAD, reviews, run, runId });
      expect(res.synthesis.degraded).toBe(true);
      expect(res.verdicts.every((v) => v.effectiveVerdict === 'unverified' && v.downgradeReason === 'gate-failed')).toBe(true);
      expect(res.gateTrailWritten).toBe(true); // the unverified trail STILL writes (audit)
    }
  });

  it('a missing / sha-mismatched packet at gate time ⇒ all verdicts unverified(packet-fail), prose kept (DC12)', async () => {
    // No packet seeded → packet-fail; the gate still returns a good envelope for PROSE.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-rg-'));
    const res = await runGate({ baseDir: base, config: CFG, expectedHeadSha: HEAD, reviews, run: async () => okRun(goodEnvelope), runId: 'r' });
    expect(res.verdicts.every((v) => v.effectiveVerdict === 'unverified' && v.downgradeReason === 'packet-fail')).toBe(true);
    expect(res.synthesis.degraded).toBe(false); // prose survived even though grounding was killed

    // sha-mismatch is also packet-fail
    const s = seed(DIFF, 'a-different-sha');
    const res2 = await runGate({ baseDir: s.base, config: CFG, expectedHeadSha: HEAD, reviews, run: async () => okRun(goodEnvelope), runId: s.runId });
    expect(res2.verdicts.every((v) => v.downgradeReason === 'packet-fail')).toBe(true);
  });

  it('validation reads ONLY the pinned packet — a citation not in the packet is NOT honored (DC2)', async () => {
    const { base, runId } = seed();
    const env = envelope([{ citation: 'a line only in the working tree, never in the packet', findingId: 'codex#1', reason: 'r', verdict: 'false' }]);
    const res = await runGate({ baseDir: base, config: CFG, expectedHeadSha: HEAD, reviews: [review('codex', [f()])], run: async () => okRun(env), runId });
    expect(res.verdicts[0]).toMatchObject({ downgradeReason: 'invalid-citation', effectiveVerdict: 'unverified' });
  });

  it('EXCLUDES a failed (ok:false) reviewer\'s findings from the verdict set — untrusted, like the exit gate', async () => {
    const { base, runId } = seed();
    // grok TIMED OUT but partly parsed → ok:false yet still carries a finding; the gate must
    // not tag it (parity with cli.ts hasHighFinding, which counts only terminalState reviewed).
    const mixed: VoiceReview[] = [
      review('codex', [f({ title: 'codex a' })]),
      { findings: [f({ title: 'grok cut-off HIGH', severity: 'high' })], ok: false, summary: 'grok timed out', voiceId: 'grok' },
    ];
    const env = envelope([{ findingId: 'codex#1', reason: 'real', verdict: 'agree' }]);
    const res = await runGate({ baseDir: base, config: CFG, expectedHeadSha: HEAD, reviews: mixed, run: async () => okRun(env), runId });
    expect(res.verdicts.map((v) => v.findingId)).toEqual(['codex#1']);
    expect(res.verdicts.some((v) => v.reviewer === 'grok')).toBe(false);
  });

  it('does NOT spawn the gate model when no reviewer is healthy (fallback + empty verdicts)', async () => {
    const { base, runId } = seed();
    let spawned = false;
    const res = await runGate({
      baseDir: base, config: CFG, expectedHeadSha: HEAD,
      reviews: [{ findings: [f()], ok: false, summary: 'failed', voiceId: 'codex' }],
      run: async () => { spawned = true; return okRun(goodEnvelope); },
      runId,
    });
    expect(spawned).toBe(false);
    expect(res.synthesis.degraded).toBe(true); // deterministic fallback, no model call
    expect(res.verdicts).toEqual([]); // no healthy findings to verdict
  });
});

// A file diff whose single hunk is ~45KB after ±25 windowing (long lines) — used to exercise
// the byte-budget truncation path deterministically. 40 added lines starting at new line 1;
// citing line 20 keeps the whole hunk in-window (not per-finding truncated) yet large.
function BIG_FILE(name: string, marker: string): string {
  const lines = Array.from({ length: 40 }, (_, i) => `+  const ${marker}${i} = ${'x'.repeat(1100)};`);
  return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,0 +1,40 @@\n${lines.join('\n')}\n`;
}
