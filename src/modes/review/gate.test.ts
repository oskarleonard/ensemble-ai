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
  gateAuthorityActive,
  gateDispositionSummary,
  type GateFinding,
  type GateRunner,
  honoredHighDismissals,
  parseGateEnvelope,
  prepareGateFindings,
  reconcileGateVerdicts,
  renderGateVerdicts,
  renderHighGate,
  resolveHighGate,
  runGate,
  SHADOW_GATE_SCHEMA_VERSION,
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
    anchorSide: 'new', body: 'b', file: 'src/x.ts', findingId: 'codex#1', hunkCode: [ANCHOR],
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

  it('an over-cap reason is clipped to REASON_CAP with a trailing ellipsis (not cut mid-word blind)', () => {
    const long = 'word '.repeat(300).trim(); // ~1499 chars, well over the 700 cap
    const p = parseGateEnvelope(envelope([{ findingId: 'codex#1', reason: long, verdict: 'agree' }]));
    if ('failure' in p) throw new Error('expected a parsed envelope');
    const { reason } = p.verdicts[0];
    expect(reason.length).toBe(700);
    expect(reason.endsWith('…')).toBe(true);
    expect(reason.endsWith(' …')).toBe(false); // trailing space trimmed before the ellipsis
  });

  it('a reason at/under the cap is passed through untouched (no ellipsis)', () => {
    const p = parseGateEnvelope(envelope([{ findingId: 'codex#1', reason: 'short reason.', verdict: 'agree' }]));
    if ('failure' in p) throw new Error('expected a parsed envelope');
    expect(p.verdicts[0].reason).toBe('short reason.');
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

// ── Postable text (A+): agree posts verbatim, partial narrows via ops, else not-postable ──
describe('reconcileGateVerdicts — postable text (A+)', () => {
  const body = 'The pool leaks a connection because release() is never called, and it always crashes.';

  it('agree ⇒ postableBody is the reviewer body VERBATIM', () => {
    const r = reconcileGateVerdicts(
      [gf({ body, findingId: 'codex#1' })],
      parseGateEnvelope(envelope([{ findingId: 'codex#1', reason: 'ok', verdict: 'agree' }]))
    ).records[0];
    expect(r).toMatchObject({ effectiveVerdict: 'agree', postableBody: body, postableStatus: 'postable' });
  });

  it('partial ⇒ postableBody is the body narrowed by the ops', () => {
    const r = reconcileGateVerdicts(
      [gf({ body, findingId: 'codex#1' })],
      parseGateEnvelope(
        envelope([{ findingId: 'codex#1', ops: [{ op: 'strike', quote: ', and it always crashes' }], reason: 'overstated', rescoredSeverity: 'medium', verdict: 'partial' }])
      )
    ).records[0];
    expect(r.postableStatus).toBe('postable');
    expect(r.postableBody).toBe('The pool leaks a connection because release() is never called.');
    expect(r.rescoredSeverity).toBe('medium');
  });

  it('a partial the gate could not narrow (no ops) ⇒ escalated, never posts', () => {
    const r = reconcileGateVerdicts(
      [gf({ body, findingId: 'codex#1' })],
      parseGateEnvelope(envelope([{ findingId: 'codex#1', reason: 'overstated', verdict: 'partial' }]))
    ).records[0];
    expect(r).toMatchObject({ effectiveVerdict: 'partial', postableBody: null, postableStatus: 'escalated' });
  });

  it('a partial carries its verified kernel (trail v10) — advisory, posting unchanged', () => {
    const r = reconcileGateVerdicts(
      [gf({ body, findingId: 'codex#1' })],
      parseGateEnvelope(
        envelope([
          {
            findingId: 'codex#1',
            kernel: { effort: 'quick-win', fix: 'call release() in a finally block' },
            ops: [{ op: 'strike', quote: ', and it always crashes' }],
            reason: 'overstated',
            verdict: 'partial',
          },
        ])
      )
    ).records[0];
    expect(r.verifiedKernel).toEqual({ effort: 'quick-win', fix: 'call release() in a finally block' });
    expect(r.postableStatus).toBe('postable');
    expect(r.postableBody).toBe('The pool leaks a connection because release() is never called.');
  });

  it('a kernel on an agree is dropped — nothing was narrowed away for it to preserve', () => {
    const r = reconcileGateVerdicts(
      [gf({ body, findingId: 'codex#1' })],
      parseGateEnvelope(
        envelope([
          {
            findingId: 'codex#1',
            kernel: { effort: 'quick-win', fix: 'call release() in a finally block' },
            reason: 'ok',
            verdict: 'agree',
          },
        ])
      )
    ).records[0];
    expect(r.effectiveVerdict).toBe('agree');
    expect(r.verifiedKernel).toBeUndefined();
  });

  it('a malformed kernel parses to absent without touching the verdict', () => {
    const r = reconcileGateVerdicts(
      [gf({ body, findingId: 'codex#1' })],
      parseGateEnvelope(
        envelope([
          {
            findingId: 'codex#1',
            kernel: { effort: 'someday', fix: 'x'.repeat(400) },
            ops: [{ op: 'strike', quote: ', and it always crashes' }],
            reason: 'overstated',
            verdict: 'partial',
          },
        ])
      )
    ).records[0];
    expect(r.effectiveVerdict).toBe('partial');
    expect(r.verifiedKernel).toBeUndefined();
  });

  it('false / unverified ⇒ not-postable (null body)', () => {
    const [f, u] = reconcileGateVerdicts(
      [gf({ body, findingId: 'codex#1' }), gf({ body, findingId: 'grok#1' })],
      parseGateEnvelope(
        envelope([
          { citation: ANCHOR, findingId: 'codex#1', reason: 'refuted', verdict: 'false' },
          { findingId: 'grok#1', reason: 'ungrounded', verdict: 'unverified' },
        ])
      )
    ).records;
    expect(f).toMatchObject({ effectiveVerdict: 'false', postableBody: null, postableStatus: 'not-postable' });
    expect(u).toMatchObject({ effectiveVerdict: 'unverified', postableBody: null, postableStatus: 'not-postable' });
  });

  it('the durable trail schema is bumped to v10 (verifiedKernel; premise was v9, duplicateOf/duplicates v8, verifyRequested v7, settlement v6, postable/placement/anchorSide/tldr v2–v5)', () => {
    expect(GATE_TRAIL_SCHEMA_VERSION).toBe(10);
  });

  describe('duplicateOf → threaded duplicate echoes (trail v8)', () => {
    // Two reviewers, one defect: grok#1 confirmed with the benign framing shown, codex#4
    // unverified (hunk unavailable) but carrying the sentence that names the dangerous
    // direction. The proven failure mode is that dedup-by-prose sheds codex#4's framing;
    // the pointer must thread it onto the primary instead.
    const twoFindings = [
      gf({ findingId: 'grok#1', reviewer: 'grok', body: 'destination guard rejects portfolio destinations' }),
      gf({
        findingId: 'codex#4',
        reviewer: 'codex',
        body: 'portfolio-to-account transfers PASS this guard',
        resolved: false,
      }),
    ];

    it('threads the duplicate claim onto the primary and marks the duplicate', () => {
      const { records, warnings } = reconcileGateVerdicts(twoFindings, {
        agreements: [],
        bottomLine: '',
        disagreements: [],
        verdicts: [
          { findingId: 'grok#1', reason: 'grounded', verdict: 'agree' },
          { findingId: 'codex#4', duplicateOf: 'grok#1', reason: 'same defect as grok#1; adds the passing direction', verdict: 'unverified' },
        ],
      });
      expect(warnings).toEqual([]);
      const primary = records.find((r) => r.findingId === 'grok#1')!;
      const dup = records.find((r) => r.findingId === 'codex#4')!;
      expect(dup.duplicateOf).toBe('grok#1');
      expect(dup.effectiveVerdict).toBe('unverified');
      expect(primary.duplicates).toHaveLength(1);
      expect(primary.duplicates![0]).toMatchObject({
        findingId: 'codex#4',
        reviewer: 'codex',
        claim: 'portfolio-to-account transfers PASS this guard',
      });
      // The threaded claim never touches what posts: the primary's postable body is verbatim.
      expect(primary.postableBody).toBe('destination guard rejects portfolio destinations');
    });

    it('drops the pointer with a warning on a confirmed verdict or an unknown/self id', () => {
      const { records, warnings } = reconcileGateVerdicts(twoFindings, {
        agreements: [],
        bottomLine: '',
        disagreements: [],
        verdicts: [
          { duplicateOf: 'codex#4', findingId: 'grok#1', reason: 'grounded', verdict: 'agree' },
          { duplicateOf: 'nosuch#9', findingId: 'codex#4', reason: 'same defect', verdict: 'unverified' },
        ],
      });
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toContain('only an unverified verdict may defer');
      expect(warnings[1]).toContain('not a different, known findingId');
      for (const r of records) {
        expect(r.duplicateOf).toBeUndefined();
        expect(r.duplicates).toBeUndefined();
      }
    });
  });

  it('verify:"run" rides ONLY a confirmed verdict onto the record (a hedge on unverified is dropped)', () => {
    const { records } = reconcileGateVerdicts(
      [gf({ findingId: 'codex#1' }), gf({ findingId: 'codex#2' })],
      {
        agreements: [],
        bottomLine: '',
        disagreements: [],
        verdicts: [
          { findingId: 'codex#1', reason: 'real', verdict: 'agree', verify: 'run' },
          { findingId: 'codex#2', reason: 'execution-decidable: run it', verdict: 'unverified', verify: 'run' },
        ],
      }
    );
    expect(records.find((r) => r.findingId === 'codex#1')?.verifyRequested).toBe(true);
    expect(records.find((r) => r.findingId === 'codex#2')?.verifyRequested).toBeUndefined();
  });
});

// ── The gate-generated TLDR (trail v5) ─────────────────────────────────────────────────
//
// A LABELED, ADDITIVE plain-English summary produced by the SAME seat that grounded the finding,
// so it ships inside the verified trail. Three properties carry the whole feature: a CONFIRMED
// verdict carries it, an unconfirmed one never does, and a model that simply forgets it must not
// cost the verdict (the finding is the product; the summary is a convenience on top of it).
describe('reconcileGateVerdicts — the gate-generated TLDR (trail v5)', () => {
  const TLDR =
    "If accounts are still loading the balance check silently skips, so you can press Next with an amount over your balance. Let's gate Next on accounts being fully loaded.";
  const body = 'The pool leaks a connection because release() is never called, and it always crashes.';

  it('an agree carries the gate TLDR onto the record', () => {
    const r = reconcileGateVerdicts(
      [gf()],
      parseGateEnvelope(envelope([{ findingId: 'codex#1', reason: 'ok', tldr: TLDR, verdict: 'agree' }]))
    ).records[0];
    expect(r.tldr).toBe(TLDR);
  });

  it('a partial carries one too — it summarizes the NARROWED claim', () => {
    const r = reconcileGateVerdicts(
      [gf({ body })],
      parseGateEnvelope(
        envelope([
          { findingId: 'codex#1', ops: [{ op: 'strike', quote: ', and it always crashes' }], reason: 'overstated', tldr: TLDR, verdict: 'partial' },
        ])
      )
    ).records[0];
    expect(r).toMatchObject({ effectiveVerdict: 'partial', postableStatus: 'postable', tldr: TLDR });
  });

  it('an over-long TLDR is CAPPED at 280 chars (marked), never allowed through whole', () => {
    const r = reconcileGateVerdicts(
      [gf()],
      parseGateEnvelope(envelope([{ findingId: 'codex#1', reason: 'ok', tldr: 'x'.repeat(400), verdict: 'agree' }]))
    ).records[0];
    expect(r.tldr).toHaveLength(280);
    expect(r.tldr?.endsWith('…')).toBe(true);
  });

  it('a MISSING tldr is null — it NEVER costs the verdict (an old-shape reply still posts)', () => {
    const r = reconcileGateVerdicts(
      [gf({ body })],
      parseGateEnvelope(envelope([{ findingId: 'codex#1', reason: 'ok', verdict: 'agree' }]))
    ).records[0];
    expect(r.tldr).toBeNull();
    expect(r).toMatchObject({ effectiveVerdict: 'agree', postableBody: body, postableStatus: 'postable' });
  });

  it('a `false` gets NO tldr even when the model sent one (nothing confirmed to summarize)', () => {
    const r = reconcileGateVerdicts(
      [gf()],
      parseGateEnvelope(envelope([{ citation: ANCHOR, findingId: 'codex#1', reason: 'refuted', tldr: TLDR, verdict: 'false' }]))
    ).records[0];
    expect(r).toMatchObject({ effectiveVerdict: 'false', tldr: null });
  });

  it('a HOST-DOWNGRADED verdict gets none either — the summary follows the EFFECTIVE verdict', () => {
    // A truncated finding's `false` is forced to unverified(truncated); its TLDR must not survive
    // the downgrade, or a dismissed claim would still hand a host a confident one-liner to post.
    const r = reconcileGateVerdicts(
      [gf({ truncated: true })],
      parseGateEnvelope(envelope([{ citation: ANCHOR, findingId: 'codex#1', reason: 'refuted', tldr: TLDR, verdict: 'false' }]))
    ).records[0];
    expect(r).toMatchObject({ downgradeReason: 'truncated', effectiveVerdict: 'unverified', tldr: null });
  });

  it('a WHOLE-envelope failure leaves every record without one', () => {
    const r = reconcileGateVerdicts([gf()], { failure: 'gate-failed' }).records[0];
    expect(r.tldr).toBeNull();
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
    expect(findings[0]).toMatchObject({ anchorSide: null, hunkLabel: null, resolved: false });
  });

  // WHICH line space a cite resolved in decides whether it may be anchored as a RIGHT comment on a
  // staged review. resolveFindingHunk falls back to OLD-side numbers for a deletion-only hunk, and
  // posting one of those on the RIGHT is a 422 that fails the whole review.
  it('a cite into a NORMAL hunk anchors on the NEW side', () => {
    const { findings } = prepareGateFindings([review('codex', [f({ evidence: { file: 'src/x.ts', line: 3 } })])], parsePacketHunks(DIFF));
    expect(findings[0]).toMatchObject({ anchorSide: 'new', resolved: true });
  });

  it('a cite into a DELETION-ONLY hunk resolves, but on the OLD side', () => {
    const DELETION = `diff --git a/src/d.ts b/src/d.ts
--- a/src/d.ts
+++ b/src/d.ts
@@ -20,3 +19,0 @@ ctx
-  const goneAtOldLineTwenty = releaseTheLock();
-  const alsoGoneAtOldLineTwentyOne = removedTwo();
-  const thirdGoneAtOldLineTwentyTwo = removedThree();
`;
    const { findings } = prepareGateFindings(
      [review('codex', [f({ evidence: { file: 'src/d.ts', line: 21 } })])],
      parsePacketHunks(DELETION)
    );
    expect(findings[0]).toMatchObject({ anchorSide: 'old', line: 21, resolved: true });
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

  // A gate that never returned is not a weak gate. Telling the operator to raise the model sends
  // them to tune a seat that never got to reason (the run that prompted this split was already
  // opus@max). And the three envelope failures do not share a recovery — a regate re-reads the
  // SAME persisted packet, so recommending it after a packet-fail sends the operator to repeat a
  // failure verbatim.
  it('gives each whole-envelope failure its own recovery, and never the model hint', () => {
    const expected = {
      'gate-failed': /never returned usable output.*regate/s,
      'packet-fail': /fails the same way; re-run the REVIEW/s,
      'unknown-schema': /schema this engine does not recognize/s,
    } as const;
    for (const [failure, pattern] of Object.entries(expected)) {
      const records = reconcileGateVerdicts([gf()], { failure: failure as 'gate-failed' }).records;
      const text = renderGateVerdicts(records, { scrub, trailWritten: true }).join('\n');
      expect(text, failure).toMatch(pattern);
      expect(text, failure).not.toContain('stronger gate model');
    }
    // the one that must NOT send the operator to re-run the gate
    const packetFail = renderGateVerdicts(
      reconcileGateVerdicts([gf()], { failure: 'packet-fail' }).records,
      { scrub, trailWritten: true }
    ).join('\n');
    expect(packetFail).not.toMatch(/re-run it \(`regate`\)/);
  });

  it('keeps the "teeth did not engage" model hint when the gate RAN and grounded nothing', () => {
    // per-finding downgrade (`missing`), not a whole-envelope failure: the seat replied, it just
    // returned no verdict for this finding — that IS the capability-floor signal.
    const parsed = parseGateEnvelope(envelope([]));
    if ('failure' in parsed) throw new Error('fixture envelope must parse');
    const records = reconcileGateVerdicts([gf()], parsed).records;
    const text = renderGateVerdicts(records, { scrub, trailWritten: true }).join('\n');
    expect(text).toContain('gate teeth did not engage');
    expect(text).not.toContain('the gate never returned verdicts');
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

  // The runner names WHY a seat came back empty (persistent transient API error, operator usage
  // limit, an error result, a wedged seat reclaimed by the watchdog). Until 2026-08-19 the gate
  // collapsed all of them to "gate produced no output", which is how a real dead run (MONEY-618's
  // review) left no way to tell a retryable 529 from a wedged seat.
  it('carries the runner failWhy + stderr tail into the log and the synthesis error', async () => {
    const { base, runId } = seed();
    const logged: string[] = [];
    const res = await runGate({
      baseDir: base,
      config: CFG,
      expectedHeadSha: HEAD,
      log: (m) => logged.push(m),
      reviews,
      run: async (): Promise<VoiceRunResult> => ({
        failWhy: 'persistent transient API error after 3 attempts',
        ok: false,
        raw: null,
        stderrTail: 'API Error: 529 overloaded_error',
        timedOut: false,
      }),
      runId,
    });
    const line = logged.join('\n');
    expect(line).toContain('persistent transient API error after 3 attempts');
    expect(line).toContain('529 overloaded_error');
    expect(res.synthesis.error).toContain('persistent transient API error after 3 attempts');
    expect(res.synthesis.error).toContain('529 overloaded_error');
    // still fail-closed: the named cause changes the DIAGNOSIS, never the verdicts
    expect(res.verdicts.every((v) => v.effectiveVerdict === 'unverified')).toBe(true);
  });

  // Losing the gate costs the WHOLE run (every finding drops to unverified); a second gate costs
  // one seat. The 2026-08-19 lisk-backend#738 gate returned nothing after 13 min and a regate over
  // the byte-identical packet landed 4 agree / 2 partial / 0 unverified — the failure was transient.
  it('re-spawns ONCE when the seat returns empty, and the retry\'s verdicts stand', async () => {
    const { base, runId } = seed();
    const logged: string[] = [];
    let calls = 0;
    const res = await runGate({
      baseDir: base, config: CFG, expectedHeadSha: HEAD, log: (m) => logged.push(m), reviews, runId,
      run: async (): Promise<VoiceRunResult> => {
        calls += 1;
        return calls === 1
          ? { ok: false, raw: null, stderrTail: '', timedOut: false }
          : okRun(goodEnvelope);
      },
    });
    expect(calls).toBe(2);
    expect(logged.join('\n')).toContain('re-spawning once');
    expect(res.verdicts.every((v) => v.downgradeReason === 'gate-failed')).toBe(false);
    expect(verdictCounts(res.verdicts).unverified).toBeLessThan(res.verdicts.length);
  });

  it('does NOT re-spawn what a retry cannot fix: usage limit, timeout, spawn throw', async () => {
    const cases: [string, () => Promise<VoiceRunResult>][] = [
      // the window is closed until its reset time — a retry burns wall clock for nothing
      ['usage limit', async () => ({ failWhy: 'operator usage limit reached — resets 5pm', ok: false, raw: null, stderrTail: '', timedOut: false })],
      // it was working and too slow; a re-spawn just spends the budget twice
      ['timeout', async () => ({ ok: false, raw: null, stderrTail: '', timedOut: true })],
    ];
    for (const [label, run] of cases) {
      const { base, runId } = seed();
      let calls = 0;
      const res = await runGate({
        baseDir: base, config: CFG, expectedHeadSha: HEAD, reviews, runId,
        run: async (...a: Parameters<typeof run>) => { calls += 1; return run(...a); },
      });
      expect(calls, label).toBe(1);
      expect(res.verdicts.every((v) => v.effectiveVerdict === 'unverified'), label).toBe(true);
    }
    // a spawn that THREW never produced a seat — a different fault, and gateSpawned stays false
    const { base, runId } = seed();
    let throws = 0;
    const res = await runGate({
      baseDir: base, config: CFG, expectedHeadSha: HEAD, reviews, runId,
      run: async () => { throws += 1; throw new Error('boom'); },
    });
    expect(throws).toBe(1);
    expect(res.gateSpawned).toBe(false);
  });

  // The retry can REPLACE a named cause with a vaguer one: a bare empty reply after a named 529
  // would erase the 529 — the exact information loss this whole change exists to stop.
  it('keeps BOTH causes when the retry fails differently from the first attempt', async () => {
    const { base, runId } = seed();
    let calls = 0;
    const res = await runGate({
      baseDir: base, config: CFG, expectedHeadSha: HEAD, reviews, runId,
      run: async (): Promise<VoiceRunResult> => {
        calls += 1;
        return calls === 1
          ? { failWhy: 'reviewer returned an error result (API status 529)', ok: false, raw: null, stderrTail: '', timedOut: false }
          : { ok: false, raw: null, stderrTail: '', timedOut: false }; // vaguer: no failWhy at all
      },
    });
    expect(res.synthesis.error).toContain('API status 529');
    expect(res.synthesis.error).toContain('gate produced no output');
  });

  it('falls back exactly as before when BOTH attempts come back empty', async () => {
    const { base, runId } = seed();
    let calls = 0;
    const res = await runGate({
      baseDir: base, config: CFG, expectedHeadSha: HEAD, reviews, runId,
      run: async (): Promise<VoiceRunResult> => {
        calls += 1;
        return { failWhy: 'reviewer returned an error result (API status 529)', ok: false, raw: null, stderrTail: '', timedOut: false };
      },
    });
    expect(calls).toBe(2);
    expect(res.synthesis.degraded).toBe(true);
    expect(res.verdicts.every((v) => v.effectiveVerdict === 'unverified' && v.downgradeReason === 'gate-failed')).toBe(true);
    expect(res.synthesis.error).toContain('API status 529');
  });

  // The reply is the only record of how the gate reasoned about each finding. probe-gate has
  // persisted its transcript since it shipped; the review gate persisted nothing, so a run whose
  // verdicts looked wrong could not be re-read.
  it('persists the gate transcript — on a clean run AND on an unparseable envelope', async () => {
    for (const [reply, label] of [
      [goodEnvelope, 'clean'],
      ['not json', 'unparseable'],
    ] as const) {
      const { base, runId } = seed();
      await runGate({ baseDir: base, config: CFG, expectedHeadSha: HEAD, reviews, run: async () => okRun(reply), runId });
      const raw = path.join(reviewDir(base, runId), 'gate.raw.md');
      expect(fs.existsSync(raw), label).toBe(true);
      expect(fs.readFileSync(raw, 'utf8'), label).toContain(label === 'clean' ? 'codex#1' : 'not json');
    }
  });

  // `gateSpawned` is what the run's REALIZED evidence for the `gate` seat is derived from. A gate
  // that never spawned read NOTHING, so a receipt must not attest it read the worktree; one that
  // spawned and returned garbage DID have the tree open, and says so honestly.
  it('gateSpawned is false ONLY when the seat never ran (no healthy reviewer / spawn threw)', async () => {
    const good = async (): Promise<VoiceRunResult> => okRun(goodEnvelope);
    const threw = async (): Promise<VoiceRunResult> => { throw new Error('boom'); };
    const timedOut = async (): Promise<VoiceRunResult> => ({ ok: false, raw: null, stderrTail: '', timedOut: true });
    const garbage = async (): Promise<VoiceRunResult> => okRun('not json');
    const noHealthy = [{ ...review('codex', [f({ title: 'x' })]), ok: false }];

    const cases: [string, () => Promise<VoiceRunResult>, typeof reviews, boolean][] = [
      ['a clean run', good, reviews, true],
      ['spawn threw — never reached the worktree', threw, reviews, false],
      ['no healthy reviewer — the seat is never spawned', good, noHealthy, false],
      // Ran, but produced nothing usable: it still had the worktree open as its cwd.
      ['timed out after spawning', timedOut, reviews, true],
      ['unparseable envelope', garbage, reviews, true],
    ];
    for (const [label, run, rs, expected] of cases) {
      const { base, runId } = seed();
      const res = await runGate({ baseDir: base, config: CFG, expectedHeadSha: HEAD, reviews: rs, run, runId });
      expect(res.gateSpawned, label).toBe(expected);
    }
  });

  // ── The SHADOW gate (audit-only, champion/challenger) ──────────────────────────────
  describe('shadow gate', () => {
    const SHADOW_CFG: VoiceConfig = { cmd: 'codex', effort: 'xhigh', id: 'codex', model: 'gpt-5.6-sol', vendor: 'openai' };
    const shadowArtifact = (base: string, runId: string) =>
      JSON.parse(fs.readFileSync(path.join(reviewDir(base, runId), 'shadow-gate-codex-verdicts.json'), 'utf8'));

    it('judges the IDENTICAL prompt, writes both artifacts, and records the comparison', async () => {
      const { base, runId } = seed();
      const prompts: { primary?: string; shadow?: string } = {};
      const res = await runGate({
        baseDir: base, config: CFG, expectedHeadSha: HEAD, reviews,
        run: async (p) => { prompts.primary = p; return okRun(goodEnvelope); },
        runId,
        shadow: { config: SHADOW_CFG, run: async (p) => { prompts.shadow = p; return okRun(goodEnvelope); } },
      });
      // property 3: same input — byte-identical prompt, judge vs judge
      expect(prompts.shadow).toBe(prompts.primary);
      // property 1: the primary result is the authority, unchanged in shape
      expect(res.verdicts.map((v) => v.findingId).sort()).toEqual(['claude#1', 'codex#1', 'codex#2', 'grok#1']);
      expect(fs.readFileSync(path.join(reviewDir(base, runId), 'shadow-gate-codex.raw.md'), 'utf8')).toBe(goodEnvelope);
      const art = shadowArtifact(base, runId);
      expect(art).toMatchObject({
        authoritative: false,
        ok: true,
        schemaVersion: SHADOW_GATE_SCHEMA_VERSION,
        seat: { effort: 'xhigh', id: 'codex', model: 'gpt-5.6-sol' },
      });
      // identical envelope through the identical reconcile ⇒ full agreement
      expect(art.comparison).toEqual({ compared: 4, disagreements: [], matched: 4 });
      expect(art.verdicts).toHaveLength(4);
    });

    it('records a per-finding disagreement when the judges differ', async () => {
      const { base, runId } = seed();
      // the shadow judges codex#2 partial where the primary said agree
      const shadowEnvelope = envelope([
        { citation: ANCHOR, findingId: 'codex#1', reason: 'refuted', verdict: 'false' },
        { findingId: 'codex#2', reason: 'overstated', verdict: 'partial' },
        { findingId: 'grok#1', reason: 'overstated', verdict: 'partial' },
        { findingId: 'claude#1', reason: 'cannot ground', verdict: 'unverified' },
      ]);
      const res = await runGate({
        baseDir: base, config: CFG, expectedHeadSha: HEAD, reviews,
        run: async () => okRun(goodEnvelope), runId,
        shadow: { config: SHADOW_CFG, run: async () => okRun(shadowEnvelope) },
      });
      expect(res.verdicts.find((v) => v.findingId === 'codex#2')?.effectiveVerdict).toBe('agree');
      const art = shadowArtifact(base, runId);
      expect(art.comparison.compared).toBe(4);
      expect(art.comparison.matched).toBe(3);
      expect(art.comparison.disagreements).toEqual([
        { findingId: 'codex#2', primary: 'agree', shadow: 'partial' },
      ]);
    });

    it('is FAIL-SOFT: a shadow throw / timeout / junk leaves the run identical and stubs the artifact (property 2)', async () => {
      const shadowRuns: [string, GateRunner][] = [
        ['throw', async () => { throw new Error('boom'); }],
        ['timeout', async () => ({ ok: false, raw: null, stderrTail: '', timedOut: true })],
        ['junk', async () => okRun('not json')],
      ];
      for (const [label, shadowRun] of shadowRuns) {
        const { base, runId } = seed();
        const logged: string[] = [];
        const res = await runGate({
          baseDir: base, config: CFG, expectedHeadSha: HEAD, log: (m) => logged.push(m), reviews,
          run: async () => okRun(goodEnvelope), runId,
          shadow: { config: SHADOW_CFG, run: shadowRun },
        });
        // the primary is byte-identical to a run with no shadow
        expect(res.gateTrailWritten, label).toBe(true);
        expect(res.verdicts.map((v) => v.findingId).sort(), label).toEqual(['claude#1', 'codex#1', 'codex#2', 'grok#1']);
        const art = shadowArtifact(base, runId);
        expect(art.ok, label).toBe(false);
        expect(art.authoritative, label).toBe(false);
        expect(art.verdicts, label).toEqual([]);
        expect(logged.join('\n'), label).toContain('audit-only, run unaffected');
      }
    });

    it('records verdicts but NO comparison when the primary gate failed (host-forced unverified is not a judgment)', async () => {
      const { base, runId } = seed();
      const logged: string[] = [];
      const res = await runGate({
        baseDir: base, config: CFG, expectedHeadSha: HEAD, log: (m) => logged.push(m), reviews,
        run: async () => okRun('not json'), runId,
        shadow: { config: SHADOW_CFG, run: async () => okRun(goodEnvelope) },
      });
      expect(res.verdicts.every((v) => v.effectiveVerdict === 'unverified')).toBe(true);
      const art = shadowArtifact(base, runId);
      expect(art.ok).toBe(true);
      expect(art.verdicts).toHaveLength(4); // the challenger's judgment still lands
      expect(art.comparison).toBeNull(); // …but never a "disagreement" against host-forced verdicts
      expect(art.comparisonSkipped).toContain('no usable envelope');
      expect(logged.join('\n')).toContain('verdicts recorded, no comparison');
    });

    it('SKIPS the shadow spawn on packet-fail (nothing can be grounded for either judge), stub artifact lands', async () => {
      // no packet seeded ⇒ packet-fail
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-rg-'));
      let shadowSpawns = 0;
      const logged: string[] = [];
      await runGate({
        baseDir: base, config: CFG, expectedHeadSha: HEAD, log: (m) => logged.push(m), reviews,
        run: async () => okRun(goodEnvelope), runId: 'r',
        shadow: { config: SHADOW_CFG, run: async () => { shadowSpawns += 1; return okRun(goodEnvelope); } },
      });
      expect(shadowSpawns).toBe(0);
      const art = shadowArtifact(base, 'r');
      expect(art.ok).toBe(false);
      expect(art.why).toContain('pinned packet unusable');
      expect(logged.join('\n')).toContain('skipped (nothing can be grounded');
    });

    it('no shadow configured ⇒ no shadow artifacts, no shadow log line', async () => {
      const { base, runId } = seed();
      const logged: string[] = [];
      await runGate({ baseDir: base, config: CFG, expectedHeadSha: HEAD, log: (m) => logged.push(m), reviews, run: async () => okRun(goodEnvelope), runId });
      expect(fs.existsSync(path.join(reviewDir(base, runId), 'shadow-gate-codex-verdicts.json'))).toBe(false);
      expect(logged.join('\n')).not.toContain('shadow gate');
    });
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

// ── DC4 — provenance-scoped authority + dismiss-only exit gate ─────────────────────────
describe('gateAuthorityActive — provenance-scoped default + flag overrides (DC4)', () => {
  it('LOCAL provenance ⇒ authority ON by default', () => {
    expect(gateAuthorityActive({ gateDismissals: false, localProvenance: true, strictHigh: false })).toBe(true);
  });
  it('FOREIGN provenance ⇒ STRICT by default; --gate-dismissals opts it IN', () => {
    expect(gateAuthorityActive({ gateDismissals: false, localProvenance: false, strictHigh: false })).toBe(false);
    expect(gateAuthorityActive({ gateDismissals: true, localProvenance: false, strictHigh: false })).toBe(true);
  });
  it('--strict-high forces STRICT anywhere — beats local provenance AND --gate-dismissals', () => {
    expect(gateAuthorityActive({ gateDismissals: true, localProvenance: true, strictHigh: true })).toBe(false);
  });
});

describe('resolveHighGate — dismiss-only; host-forced downgrades always gate (DC4 · DC11 · DC12)', () => {
  const validatedFalse = (id: string, over: Partial<GateFinding> = {}) =>
    reconcileGateVerdicts(
      [gf({ findingId: id, ...over })],
      parseGateEnvelope(envelope([{ citation: ANCHOR, findingId: id, reason: 'refuted', verdict: 'false' }]))
    ).records;

  it('active authority + validated-false HIGH + trail written ⇒ dismissed, none gates', () => {
    expect(resolveHighGate(validatedFalse('codex#1'), true, true)).toEqual({ dismissedHighIds: ['codex#1'], gatingHighIds: [] });
  });
  it('STRICT authority ⇒ EVERY HIGH gates, even a validated-false one', () => {
    expect(resolveHighGate(validatedFalse('codex#1'), true, false)).toEqual({ dismissedHighIds: [], gatingHighIds: ['codex#1'] });
  });
  it('a trail-write failure ⇒ NOT dismissed even under active authority (DC11)', () => {
    expect(resolveHighGate(validatedFalse('codex#1'), false, true)).toEqual({ dismissedHighIds: [], gatingHighIds: ['codex#1'] });
  });
  it('a TRUNCATED HIGH (host-forced unverified) gates even with a valid citation (DC12)', () => {
    expect(resolveHighGate(validatedFalse('codex#1', { truncated: true }), true, true)).toEqual({ dismissedHighIds: [], gatingHighIds: ['codex#1'] });
  });
  it('invalid-citation + packet-fail HIGHs gate under active authority (host-forced downgrade honored)', () => {
    const badCite = reconcileGateVerdicts([gf()], parseGateEnvelope(envelope([{ citation: 'nowhere near the hunk', findingId: 'codex#1', reason: 'r', verdict: 'false' }]))).records;
    expect(resolveHighGate(badCite, true, true).gatingHighIds).toEqual(['codex#1']);
    const packetFail = reconcileGateVerdicts([gf()], { failure: 'packet-fail' }).records;
    expect(resolveHighGate(packetFail, true, true).gatingHighIds).toEqual(['codex#1']);
  });
  it('MED/LOW findings are NEVER in the HIGH gate', () => {
    const recs = reconcileGateVerdicts([gf({ findingId: 'grok#1', severity: 'medium' })], parseGateEnvelope(envelope([{ findingId: 'grok#1', reason: 'r', verdict: 'agree' }]))).records;
    expect(resolveHighGate(recs, true, false)).toEqual({ dismissedHighIds: [], gatingHighIds: [] });
  });
  it('mixed — a dismissed HIGH alongside an agree HIGH ⇒ the agree HIGH still gates', () => {
    const recs = reconcileGateVerdicts(
      [gf({ findingId: 'codex#1' }), gf({ findingId: 'grok#1' })],
      parseGateEnvelope(envelope([
        { citation: ANCHOR, findingId: 'codex#1', reason: 'refuted', verdict: 'false' },
        { findingId: 'grok#1', reason: 'real', verdict: 'agree' },
      ]))
    ).records;
    expect(resolveHighGate(recs, true, true)).toEqual({ dismissedHighIds: ['codex#1'], gatingHighIds: ['grok#1'] });
  });
});

describe('renderHighGate — loud dismissed HIGH + advisory-strict surfacing (DC4)', () => {
  const validatedFalse = reconcileGateVerdicts(
    [gf({ findingId: 'codex#1' })],
    parseGateEnvelope(envelope([{ citation: ANCHOR, findingId: 'codex#1', reason: 'refuted by the cited line', verdict: 'false' }]))
  ).records;

  it('renders a dismissed HIGH LOUDLY as `HIGH (dismissed by gate — reason)`', () => {
    const d = resolveHighGate(validatedFalse, true, true);
    const text = renderHighGate(validatedFalse, d, { authorityActive: true, authorityLabel: 'ON (local provenance — dismiss-only)', scrub }).join('\n');
    expect(text).toMatch(/HIGH \(dismissed by gate — refuted by the cited line\) · codex#1/);
    expect(text).toContain('every HIGH dismissed by the gate');
  });
  it('under STRICT, an advisory gate-false HIGH is surfaced (not dismissed) and still gates', () => {
    const d = resolveHighGate(validatedFalse, true, false);
    const text = renderHighGate(validatedFalse, d, { authorityActive: false, authorityLabel: 'STRICT (--strict-high — every HIGH gates)', scrub }).join('\n');
    expect(text).toMatch(/advisory — authority STRICT/);
    expect(text).toMatch(/1 HIGH\(s\) gate → exit 4: codex#1/);
    expect(text).not.toMatch(/dismissed by gate/);
  });
  it('returns [] when there are no HIGH findings (nothing authority-relevant to say)', () => {
    const med = reconcileGateVerdicts([gf({ findingId: 'grok#1', severity: 'medium' })], parseGateEnvelope(envelope([{ findingId: 'grok#1', reason: 'r', verdict: 'agree' }]))).records;
    expect(renderHighGate(med, resolveHighGate(med, true, true), { authorityActive: true, authorityLabel: 'x', scrub })).toEqual([]);
  });
});

// ── DC7 — the receipt disposition summary payload ──────────────────────────────────────
describe('gateDispositionSummary — receipt disposition payload (DC7)', () => {
  it('carries verdict counts + honored dismissed HIGH ids + the trail-written marker', () => {
    const recs = reconcileGateVerdicts(
      [gf({ findingId: 'codex#1' }), gf({ findingId: 'grok#1', severity: 'medium' })],
      parseGateEnvelope(envelope([
        { citation: ANCHOR, findingId: 'codex#1', reason: 'r', verdict: 'false' },
        { findingId: 'grok#1', reason: 'r', verdict: 'agree' },
      ]))
    ).records;
    const summary = gateDispositionSummary(recs, resolveHighGate(recs, true, true).dismissedHighIds, true);
    expect(summary).toEqual({
      dismissedHighIds: ['codex#1'],
      trailWritten: true,
      verdictCounts: { agree: 1, false: 1, partial: 0, unverified: 0 },
    });
  });
});

// ── Premise provenance — the external-testimony flag (trail v9) ─────────────────────────
describe('premise provenance — external-testimony (trail v9)', () => {
  it('parses only the literal value; unrecognized premise classes parse to absent', () => {
    const p = parseGateEnvelope(envelope([
      { findingId: 'codex#1', premise: 'external-testimony', reason: 'r', verdict: 'partial' },
      { findingId: 'grok#1', premise: 'vibes', reason: 'r', verdict: 'partial' },
    ]));
    if ('failure' in p) throw new Error('unexpected parse failure');
    expect(p.verdicts[0].premise).toBe('external-testimony');
    expect(p.verdicts[1].premise).toBeUndefined();
  });

  it('fail-closes an "agree" carrying the flag: unverified(external-testimony), never postable', () => {
    const { records } = reconcileGateVerdicts([gf()], parseGateEnvelope(envelope([
      { findingId: 'codex#1', premise: 'external-testimony', reason: 'rests on a repo comment about the backend', verdict: 'agree' },
    ])));
    expect(records[0]).toMatchObject({
      downgradeReason: 'external-testimony',
      effectiveVerdict: 'unverified',
      postableStatus: 'not-postable',
      premise: 'external-testimony',
      rawVerdict: 'agree',
      tldr: null,
    });
  });

  it('carries the flag on partial/unverified without altering the verdict', () => {
    const { records } = reconcileGateVerdicts(
      [gf({ findingId: 'codex#1' }), gf({ findingId: 'grok#1', reviewer: 'grok' })],
      parseGateEnvelope(envelope([
        { findingId: 'codex#1', premise: 'external-testimony', reason: 'r', verdict: 'partial' },
        { findingId: 'grok#1', premise: 'external-testimony', reason: 'r', verdict: 'unverified' },
      ]))
    );
    const byId = Object.fromEntries(records.map((r) => [r.findingId, r]));
    expect(byId['codex#1']).toMatchObject({ downgradeReason: null, effectiveVerdict: 'partial', premise: 'external-testimony' });
    expect(byId['grok#1']).toMatchObject({ downgradeReason: null, effectiveVerdict: 'unverified', premise: 'external-testimony' });
  });

  it('a validated "false" ignores the flag — the dismissal stands and the record carries no premise', () => {
    const { records } = reconcileGateVerdicts([gf()], parseGateEnvelope(envelope([
      { citation: ANCHOR, findingId: 'codex#1', premise: 'external-testimony', reason: 'r', verdict: 'false' },
    ])));
    expect(records[0].effectiveVerdict).toBe('false');
    expect(records[0].premise).toBeUndefined();
  });
});

// A file diff whose single hunk is ~45KB after ±25 windowing (long lines) — used to exercise
// the byte-budget truncation path deterministically. 40 added lines starting at new line 1;
// citing line 20 keeps the whole hunk in-window (not per-finding truncated) yet large.
function BIG_FILE(name: string, marker: string): string {
  const lines = Array.from({ length: 40 }, (_, i) => `+  const ${marker}${i} = ${'x'.repeat(1100)};`);
  return `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -1,0 +1,40 @@\n${lines.join('\n')}\n`;
}
