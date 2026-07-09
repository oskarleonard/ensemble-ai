import { describe, expect, it } from 'vitest';

import type { Coverage } from './diff';
import { computePolicyHashAt, type EvidenceMap } from './evidence';
import {
  buildDiffReceipt,
  type DiffReviewReceipt,
  isDiffReviewed,
  type ReceiptKey,
  validateReceiptShape,
} from './receipt';

const coverage: Coverage = {
  files: [{ included: true, kind: 'source', path: 'a.ts' }],
  includedFiles: 1,
  omittedFiles: 0,
  totalFiles: 1,
} as unknown as Coverage;

const reviewed = { runId: 'r1', terminalState: 'reviewed' as const };
const deps = (receipt: DiffReviewReceipt | null) => ({
  readReceipt: () => receipt,
  readReview: () => reviewed as never,
});

function receiptFor(overrides: Partial<DiffReviewReceipt>): DiffReviewReceipt {
  return {
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    completed: ['codex'],
    coverage: { includedFiles: 1, omitted: [], omittedFiles: 0, totalFiles: 1 },
    diffDigest: 'sha256:dd',
    diffMode: 'pr',
    headSha: 'h'.repeat(40),
    policyHash: 'sha256:p',
    repo: 'o/r',
    reviewerPolicy: ['codex'],
    runId: 'r1',
    vendors: ['openai'],
    ...overrides,
  };
}

const key: ReceiptKey = {
  baseSha: 'b'.repeat(40),
  diffDigest: 'sha256:dd',
  headSha: 'h'.repeat(40),
  policyHash: 'sha256:p',
  repo: 'o/r',
};

const live = { coverage, key, required: ['codex' as const] };

// gate-r3 pin 2: `receipt verify` MUST compare realized vs intended, and the LEGACY case must be
// pinned — schema-compatibility (can I read this receipt?) is SEPARATE from evidence-quality
// (is it as strong as what I'm asking for?).
describe('receipt verify — realized-vs-intended evidence', () => {
  it('a PACKET-mode caller is unaffected: a legacy receipt still verifies (v1 semantics intact)', () => {
    const state = isDiffReviewed(live, deps(receiptFor({})));
    expect(state.reviewed).toBe(true);
    expect(state.reason).toBe('reviewed');
  });

  it('a legacy receipt FAILS a worktree-evidence request — unknown = weaker, not "no receipt"', () => {
    const state = isDiffReviewed(
      { ...live, intendedEvidence: { codex: 'worktree' } },
      deps(receiptFor({}))
    );
    expect(state.reviewed).toBe(false);
    expect(state.reason).toBe('evidence-degraded');
    expect(state.evidenceGaps).toEqual([
      { intended: 'worktree', realized: 'unknown', seat: 'codex' },
    ]);
  });

  it('--accept-degraded lets the caller take the weaker evidence deliberately', () => {
    const state = isDiffReviewed(
      { ...live, acceptDegraded: true, intendedEvidence: { codex: 'worktree' } },
      deps(receiptFor({}))
    );
    expect(state.reviewed).toBe(true);
  });

  it('a realized-worktree receipt satisfies a worktree request', () => {
    const state = isDiffReviewed(
      { ...live, intendedEvidence: { codex: 'worktree' } },
      deps(receiptFor({ policyVersion: 2, realizedEvidence: { codex: 'worktree' } }))
    );
    expect(state.reviewed).toBe(true);
  });

  it('a run where one seat FELL BACK is never receipt-equivalent to a full-worktree run', () => {
    const state = isDiffReviewed(
      { ...live, intendedEvidence: { codex: 'worktree', gate: 'worktree' } },
      deps(
        receiptFor({
          policyVersion: 2,
          realizedEvidence: { codex: 'packet', gate: 'worktree' },
        })
      )
    );
    expect(state.reason).toBe('evidence-degraded');
    expect(state.evidenceGaps?.[0].seat).toBe('codex');
  });

  it('the LEGACY KEY is consulted when the v2 key misses, so the failure is degraded (not no-receipt)', () => {
    const legacyKey: ReceiptKey = { ...key, policyHash: 'sha256:legacy' };
    const v2Key: ReceiptKey = { ...key, policyHash: 'sha256:v2' };
    const stored = receiptFor({ policyHash: 'sha256:legacy' });
    const state = isDiffReviewed(
      { ...live, intendedEvidence: { codex: 'worktree' }, key: v2Key, legacyKey },
      {
        readReceipt: (k) => (k.policyHash === 'sha256:legacy' ? stored : null),
        readReview: () => reviewed as never,
      }
    );
    expect(state.reason).toBe('evidence-degraded');
  });

  it('evidence is checked only AFTER digest/policy/coverage — a stale receipt still reads `stale`', () => {
    const state = isDiffReviewed(
      { ...live, intendedEvidence: { codex: 'worktree' } },
      deps(receiptFor({ diffDigest: 'sha256:OTHER' }))
    );
    expect(state.reason).toBe('stale');
  });
});

describe('buildDiffReceipt — evidence identity', () => {
  const base = {
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    coverage,
    coveragePolicy: { ceilingBytes: 100 },
    diffDigest: 'sha256:dd',
    diffMode: 'pr' as const,
    diffTruncated: false,
    headSha: 'h'.repeat(40),
    repo: 'o/r',
    required: ['codex' as const],
    reviews: [
      { reviewer: { vendor: 'openai' }, reviewerId: 'codex', terminalState: 'reviewed' },
    ] as never,
    runId: 'r1',
  };

  it('an all-packet run mints a LEGACY receipt: no evidence fields, v1 hash', () => {
    const built = buildDiffReceipt({ ...base, intendedEvidence: { codex: 'packet' } });
    expect(built.ok).toBe(true);
    expect(built.receipt?.policyVersion).toBeUndefined();
    expect(built.receipt?.intendedEvidence).toBeUndefined();
    expect(built.receipt?.policyHash).toBe(
      computePolicyHashAt(
        { coveragePolicy: { ceilingBytes: 100 }, diffMode: 'pr', reviewerPolicy: ['codex'] },
        1
      )
    );
  });

  it('omitting evidence entirely is identical to an all-packet run (zero behavior change)', () => {
    expect(buildDiffReceipt(base).receipt?.policyHash).toBe(
      buildDiffReceipt({ ...base, intendedEvidence: { codex: 'packet' } }).receipt?.policyHash
    );
  });

  it('a worktree seat mints a v2 receipt carrying BOTH maps as distinct facts', () => {
    const intended: EvidenceMap = { codex: 'worktree', gate: 'worktree' };
    const realized: EvidenceMap = { codex: 'packet', gate: 'worktree' };
    const r = buildDiffReceipt({ ...base, intendedEvidence: intended, realizedEvidence: realized }).receipt;
    expect(r?.policyVersion).toBe(2);
    expect(r?.intendedEvidence).toEqual(intended);
    expect(r?.realizedEvidence).toEqual(realized);
  });
});

describe('validateReceiptShape — evidence fields', () => {
  it('accepts a receipt with no evidence fields (every receipt on disk today)', () => {
    expect(() => validateReceiptShape(receiptFor({}))).not.toThrow();
  });

  it('rejects a corrupt evidence map rather than reading it as "no gap"', () => {
    expect(() =>
      validateReceiptShape(receiptFor({ realizedEvidence: { codex: 'nonsense' } as never }))
    ).toThrow(/realizedEvidence/);
    expect(() =>
      validateReceiptShape(receiptFor({ intendedEvidence: { bogusSeat: 'packet' } as never }))
    ).toThrow(/intendedEvidence/);
  });

  it('rejects an unknown policyVersion and a malformed sandboxProfiles', () => {
    expect(() => validateReceiptShape(receiptFor({ policyVersion: 99 }))).toThrow(/policyVersion/);
    expect(() =>
      validateReceiptShape(receiptFor({ sandboxProfiles: { codex: { id: 'x' } } as never }))
    ).toThrow(/sandboxProfiles/);
  });
});
