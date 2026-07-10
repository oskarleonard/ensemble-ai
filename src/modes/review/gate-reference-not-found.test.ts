import { describe, expect, it } from 'vitest';

import { DOWNGRADE_REASONS, type GateFinding, reconcileGateVerdicts } from './gate';

// gate-r3 pin 1: `reference-not-found` is a GATE-emitted cause, and the gate is an
// EVIDENCE-BEARING actor. A packet-fed gate sees a ±25-line window, so it structurally cannot
// distinguish "this reference does not exist at headSha" from `truncated`. The cause may
// therefore be honored ONLY when the gate's realized evidence is `worktree`.

const finding: GateFinding = {
  anchorSide: 'new',
  body: 'b',
  file: 'src/a.ts',
  findingId: 'codex#1',
  hunkCode: ['const somethingSubstantialHere = 1;'],
  hunkLabel: 'H1',
  line: 3,
  resolved: true,
  reviewer: 'codex',
  severity: 'high',
  title: 't',
  truncated: false,
};

const envelope = (cause?: string) => ({
  agreements: [],
  bottomLine: '',
  disagreements: [],
  verdicts: [
    {
      findingId: 'codex#1',
      reason: 'no such symbol at headSha',
      verdict: 'unverified',
      ...(cause ? { cause } : {}),
    },
  ],
});

describe('reference-not-found — additive, and gated on the gate`s own evidence', () => {
  it('is a member of the downgrade taxonomy, beside truncated/missing (additive)', () => {
    expect(DOWNGRADE_REASONS).toContain('reference-not-found');
    expect(DOWNGRADE_REASONS).toContain('truncated');
    expect(DOWNGRADE_REASONS).toContain('missing');
  });

  it('is EMITTED when the gate read the worktree', () => {
    const { records } = reconcileGateVerdicts([finding], envelope('reference-not-found'), {
      gateEvidence: 'worktree',
    });
    expect(records[0].effectiveVerdict).toBe('unverified');
    expect(records[0].downgradeReason).toBe('reference-not-found');
  });

  it('is DROPPED (with a warning) on a packet-fed gate — never asserted on weaker evidence', () => {
    const { records, warnings } = reconcileGateVerdicts([finding], envelope('reference-not-found'), {
      gateEvidence: 'packet',
    });
    expect(records[0].effectiveVerdict).toBe('unverified');
    expect(records[0].downgradeReason).toBeNull();
    expect(warnings.join(' ')).toMatch(/PACKET evidence — dropped/);
  });

  it('defaults to packet evidence, so every pre-worktree caller keeps today`s semantics', () => {
    const { records } = reconcileGateVerdicts([finding], envelope('reference-not-found'));
    expect(records[0].downgradeReason).toBeNull();
  });

  it('a truncated finding still downgrades as `truncated` — the causes never collide', () => {
    const { records } = reconcileGateVerdicts(
      [{ ...finding, truncated: true }],
      {
        agreements: [],
        bottomLine: '',
        disagreements: [],
        verdicts: [{ citation: 'x', findingId: 'codex#1', reason: 'r', verdict: 'false' }],
      },
      { gateEvidence: 'worktree' }
    );
    expect(records[0].downgradeReason).toBe('truncated');
  });

  it('an unverified WITHOUT the cause is untouched on worktree evidence', () => {
    const { records } = reconcileGateVerdicts([finding], envelope(), { gateEvidence: 'worktree' });
    expect(records[0].downgradeReason).toBeNull();
  });
});
