import { describe, expect, it } from 'vitest';

import { type GateFinding, reconcileGateVerdicts } from './gate';
import {
  derivePostable,
  parsePostableClass,
  parseSuggestion,
  SUGGESTION_LINE_CEILING,
} from './gate-postable';

const HUNK = ['function f(a) {', '  for (let i = 0; i <= a.length; i++) {', '    total += a[i];', '  }', '}'];

const base = {
  body: 'The loop condition `i <= a.length` reads one past the end of `a`.',
  fixStatus: 'keep' as const,
  hunkCode: HUNK,
  ops: [],
  rescoredSeverity: undefined,
  severity: 'high' as const,
  verdict: 'agree' as const,
};

// ── The gate-verified suggestion (spec §6's inline exception) ─────────────────────────

describe('deriveSuggestion — a one-click replacement the gate verified, or nothing', () => {
  it('accepts a replacement built only from tokens the body + hunk already contain', () => {
    const r = derivePostable({ ...base, suggestion: { replacement: '  for (let i = 0; i < a.length; i++) {' } });
    expect(r.postableSuggestion).toEqual({ replacement: '  for (let i = 0; i < a.length; i++) {' });
  });

  it('REJECTS a replacement that invents an identifier absent from the body and hunk', () => {
    // `sanitizeIndex` appears nowhere — a paraphrase with an apply button is the worst failure mode.
    const r = derivePostable({ ...base, suggestion: { replacement: '  for (const x of sanitizeIndex(a)) {' } });
    expect(r.postableSuggestion).toBeNull();
    expect(r.postableBody).toBe(base.body); // the finding still posts; only the apply button is dropped
  });

  it('REJECTS a replacement that invents a path or number', () => {
    expect(derivePostable({ ...base, suggestion: { replacement: 'require("../evil.js")' } }).postableSuggestion).toBeNull();
    expect(derivePostable({ ...base, suggestion: { replacement: 'i < 99999' } }).postableSuggestion).toBeNull();
  });

  it('offers NO suggestion on a `partial` — a narrowed claim no longer provably supports the fix', () => {
    const r = derivePostable({
      ...base,
      fixStatus: 'keep',
      ops: [{ op: 'strike', quote: ' reads one past the end of `a`' }],
      suggestion: { replacement: '  for (let i = 0; i < a.length; i++) {' },
      verdict: 'partial',
    });
    expect(r.postableStatus).toBe('postable');
    expect(r.postableSuggestion).toBeNull();
  });

  it('offers NO suggestion unless the gate VERIFIED the fix (fixStatus keep)', () => {
    for (const fixStatus of ['narrow', 'strike'] as const) {
      const r = derivePostable({ ...base, fixStatus, suggestion: { replacement: '  for (let i = 0; i < a.length; i++) {' } });
      expect(r.postableSuggestion).toBeNull();
    }
  });

  it('REJECTS a replacement past the hostile-input line ceiling', () => {
    const tall = Array.from({ length: SUGGESTION_LINE_CEILING + 1 }, () => 'a').join('\n');
    expect(derivePostable({ ...base, suggestion: { replacement: tall } }).postableSuggestion).toBeNull();
  });

  it('REJECTS an empty / whitespace-only replacement', () => {
    expect(derivePostable({ ...base, suggestion: { replacement: '   \n  ' } }).postableSuggestion).toBeNull();
  });

  it('no suggestion offered ⇒ null, and the postable body is untouched', () => {
    const r = derivePostable(base);
    expect(r.postableSuggestion).toBeNull();
    expect(r.postableBody).toBe(base.body);
  });
});

// ── Parsing the gate's raw reply ──────────────────────────────────────────────────────

describe('parsing the gate reply\'s placement fields', () => {
  it('parses the two known classes and rejects anything else', () => {
    expect(parsePostableClass('bug')).toBe('bug');
    expect(parsePostableClass('quality')).toBe('quality');
    expect(parsePostableClass('nit')).toBeUndefined();
    expect(parsePostableClass(3)).toBeUndefined();
  });

  it('parses a suggestion object and caps its length', () => {
    expect(parseSuggestion({ replacement: 'x' })).toEqual({ replacement: 'x' });
    expect(parseSuggestion({ replacement: 'a'.repeat(5000) })?.replacement).toHaveLength(800);
    expect(parseSuggestion({ replacement: '' })).toBeUndefined();
    expect(parseSuggestion('x')).toBeUndefined();
    expect(parseSuggestion(null)).toBeUndefined();
  });
});

// ── Placement class through reconcile ─────────────────────────────────────────────────

function finding(over: Partial<GateFinding> = {}): GateFinding {
  return {
    body: 'b',
    file: 'src/a.ts',
    findingId: 'codex#1',
    hunkCode: HUNK,
    hunkLabel: 'H1',
    line: 2,
    resolved: true,
    reviewer: 'codex',
    severity: 'high',
    title: 't',
    truncated: false,
    ...over,
  };
}

const envelope = (verdicts: unknown[]): Parameters<typeof reconcileGateVerdicts>[1] =>
  ({ agreements: [], bottomLine: '', disagreements: [], verdicts }) as Parameters<typeof reconcileGateVerdicts>[1];

describe('the gate assigns placement; the posting path never re-judges it', () => {
  it('an omitted class defaults to `bug` — a grounded finding is never silently demoted to the quiet tier', () => {
    const { records } = reconcileGateVerdicts([finding()], envelope([{ findingId: 'codex#1', reason: 'r', verdict: 'agree' }]));
    expect(records[0].postableClass).toBe('bug');
  });

  it('an explicit `quality` class survives reconcile', () => {
    const { records } = reconcileGateVerdicts(
      [finding()],
      envelope([{ class: 'quality', findingId: 'codex#1', reason: 'r', verdict: 'agree' }])
    );
    expect(records[0].postableClass).toBe('quality');
  });

  it('an unrecognized class falls back to `bug`, never to null', () => {
    const { records } = reconcileGateVerdicts(
      [finding()],
      envelope([{ class: 'nit', findingId: 'codex#1', reason: 'r', verdict: 'agree' }])
    );
    expect(records[0].postableClass).toBe('bug');
  });

  it('a NON-postable finding has NO placement (it would advertise a comment that never posts)', () => {
    const { records } = reconcileGateVerdicts([finding()], envelope([{ findingId: 'codex#1', reason: 'r', verdict: 'unverified' }]));
    expect(records[0].postableClass).toBeNull();
    expect(records[0].postableSuggestion).toBeNull();
  });

  it('an ESCALATED postable derivation has no placement either', () => {
    // agree + ops is a contradiction → escalated, not postable.
    const { records } = reconcileGateVerdicts(
      [finding()],
      envelope([{ findingId: 'codex#1', ops: [{ op: 'strike', quote: 'b' }], reason: 'r', verdict: 'agree' }])
    );
    expect(records[0].postableStatus).toBe('escalated');
    expect(records[0].postableClass).toBeNull();
  });

  it('the record carries `resolved`, so the posting path can refuse an out-of-diff anchor', () => {
    const { records } = reconcileGateVerdicts(
      [finding({ hunkCode: [], hunkLabel: null, resolved: false })],
      envelope([{ findingId: 'codex#1', reason: 'r', verdict: 'agree' }])
    );
    expect(records[0].resolved).toBe(false);
  });

  it('a suggestion survives reconcile end-to-end when the gate verified it', () => {
    const { records } = reconcileGateVerdicts(
      [finding({ body: 'The loop `i <= a.length` reads past the end.' })],
      envelope([
        {
          findingId: 'codex#1',
          fixStatus: 'keep',
          reason: 'r',
          suggestion: { replacement: '  for (let i = 0; i < a.length; i++) {' },
          verdict: 'agree',
        },
      ])
    );
    expect(records[0].postableSuggestion).toEqual({ replacement: '  for (let i = 0; i < a.length; i++) {' });
  });
});
