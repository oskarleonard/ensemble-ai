import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  computePolicyHashAt,
  EVIDENCE_SEATS,
  evidenceShortfall,
  formatEvidenceShortfall,
  POLICY_VERSION_EVIDENCE,
  POLICY_VERSION_LEGACY,
  receiptPolicyVersion,
  resolvePolicyVersion,
} from './evidence';
import { computePolicyHash } from './receipt';

// THE VERSIONED-HASHER CONTRACT (gate-r3 pin 2). The whole no-re-review-wave guarantee rests on
// one property: the v1 PREIMAGE is frozen. If someone "improves" it, every receipt on disk
// silently stales and the #123-class fence starts demanding pointless re-reviews. So we pin the
// exact bytes here, independently of the implementation.
describe('versioned policy hasher — contract', () => {
  const coveragePolicy = { ceilingBytes: 400_000 };
  const reviewerPolicy = ['grok', 'codex'];

  it('v1 preimage is EXACTLY the frozen pre-evidence formula (byte-for-byte)', () => {
    // Reproduced literally, not imported — a test that calls the code it guards proves nothing.
    const frozenPreimage = JSON.stringify({
      coveragePolicy: { ceilingBytes: 400_000 },
      diffMode: 'pr',
      reviewerPolicy: ['codex', 'grok'], // sorted
    });
    const expected = `sha256:${crypto.createHash('sha256').update(frozenPreimage, 'utf8').digest('hex')}`;
    expect(computePolicyHashAt({ coveragePolicy, diffMode: 'pr', reviewerPolicy }, 1)).toBe(expected);
  });

  it('the legacy computePolicyHash entry point still hashes at v1', () => {
    expect(
      computePolicyHash({ coveragePolicy, diffMode: 'pr', reviewerPolicy: ['codex', 'grok'] })
    ).toBe(computePolicyHashAt({ coveragePolicy, diffMode: 'pr', reviewerPolicy }, POLICY_VERSION_LEGACY));
  });

  it('v1 IGNORES evidence inputs — an all-packet run keeps its legacy identity', () => {
    const bare = computePolicyHashAt({ coveragePolicy, diffMode: 'pr', reviewerPolicy }, 1);
    const withEvidence = computePolicyHashAt(
      {
        coveragePolicy,
        diffMode: 'pr',
        intendedEvidence: { codex: 'packet', grok: 'packet' },
        reviewerPolicy,
        sandboxProfiles: { grok: { id: 'ensemble-review', version: 1 } },
      },
      1
    );
    expect(withEvidence).toBe(bare);
  });

  it('v2 BINDS the intended evidence map, the gate seat, and the sandbox profile versions', () => {
    const base = {
      coveragePolicy,
      diffMode: 'pr' as const,
      intendedEvidence: { codex: 'worktree', gate: 'worktree' } as const,
      reviewerPolicy,
    };
    const v2 = computePolicyHashAt(base, POLICY_VERSION_EVIDENCE);
    expect(v2).not.toBe(computePolicyHashAt(base, POLICY_VERSION_LEGACY));
    // a weaker gate seat is a DIFFERENT policy
    expect(
      computePolicyHashAt({ ...base, intendedEvidence: { codex: 'worktree', gate: 'packet' } }, 2)
    ).not.toBe(v2);
    // a bumped sandbox profile version is a DIFFERENT policy
    expect(
      computePolicyHashAt({ ...base, sandboxProfiles: { codex: { id: 'x', version: 1 } } }, 2)
    ).not.toBe(
      computePolicyHashAt({ ...base, sandboxProfiles: { codex: { id: 'x', version: 2 } } }, 2)
    );
  });

  it('v2 is insertion-order independent (canonical map ordering)', () => {
    const a = computePolicyHashAt(
      { coveragePolicy, diffMode: 'pr', intendedEvidence: { codex: 'worktree', grok: 'packet' }, reviewerPolicy },
      2
    );
    const b = computePolicyHashAt(
      { coveragePolicy, diffMode: 'pr', intendedEvidence: { grok: 'packet', codex: 'worktree' }, reviewerPolicy },
      2
    );
    expect(a).toBe(b);
  });

  it('an UNKNOWN version throws rather than hashing under semantics it does not define', () => {
    expect(() => computePolicyHashAt({ coveragePolicy, diffMode: 'pr', reviewerPolicy }, 99)).toThrow(
      /unknown policyVersion 99/
    );
  });

  it('a receipt with no policyVersion reads as v1; version selection follows intent', () => {
    expect(receiptPolicyVersion(undefined)).toBe(POLICY_VERSION_LEGACY);
    expect(receiptPolicyVersion(2)).toBe(POLICY_VERSION_EVIDENCE);
    expect(receiptPolicyVersion(99)).toBe(POLICY_VERSION_LEGACY); // unknown → legacy, fail-safe
    expect(resolvePolicyVersion({ codex: 'packet', grok: 'packet' })).toBe(POLICY_VERSION_LEGACY);
    expect(resolvePolicyVersion({ codex: 'packet', grok: 'worktree' })).toBe(POLICY_VERSION_EVIDENCE);
  });
});

describe('realized-vs-intended evidence comparison', () => {
  it('an ABSENT realized class is `unknown` and is WEAKER than a WORKTREE request', () => {
    const gaps = evidenceShortfall({ codex: 'worktree' }, undefined);
    expect(gaps).toEqual([{ intended: 'worktree', realized: 'unknown', seat: 'codex' }]);
  });

  // gate-r3 pin 2: an absent realized map fails "only when the caller requests worktree evidence".
  // A legacy receipt provably HAD packet evidence — the packet is all that existed — so `unknown`
  // is packet-strength. Treating it as weaker than everything would make the engine reject its own
  // receipts: an all-packet run mints a v1 receipt with no realized map (buildDiffReceipt), which a
  // caller verifying with an explicit `{codex:'packet'}` intent would then call evidence-degraded.
  it('an ABSENT realized class satisfies a PACKET request — a legacy receipt is not degraded', () => {
    expect(evidenceShortfall({ codex: 'packet' }, undefined)).toEqual([]);
    expect(evidenceShortfall({ codex: 'packet', grok: 'packet' }, {})).toEqual([]);
  });

  it('a mixed intent reports ONLY the worktree seat against a legacy receipt', () => {
    const gaps = evidenceShortfall({ codex: 'packet', grok: 'worktree' }, undefined);
    expect(gaps).toEqual([{ intended: 'worktree', realized: 'unknown', seat: 'grok' }]);
  });

  it('packet realized under a worktree intent is a gap; the reverse is not', () => {
    expect(evidenceShortfall({ grok: 'worktree' }, { grok: 'packet' })).toHaveLength(1);
    // realized STRONGER than intended is never a shortfall
    expect(evidenceShortfall({ grok: 'packet' }, { grok: 'worktree' })).toEqual([]);
  });

  it('only seats the caller ASKS for are compared', () => {
    expect(evidenceShortfall({ codex: 'packet' }, { codex: 'packet', claude: 'packet' })).toEqual([]);
  });

  it('the GATE is compared like any other seat (pin 1)', () => {
    const gaps = evidenceShortfall({ gate: 'worktree' }, { gate: 'packet' });
    expect(gaps.map((g) => g.seat)).toEqual(['gate']);
  });

  it('the failure names the weaker seat AND points at the flag', () => {
    const msg = formatEvidenceShortfall(evidenceShortfall({ codex: 'worktree' }, { codex: 'packet' }));
    expect(msg).toContain('codex realized packet, intended worktree');
    expect(msg).toContain('--accept-degraded');
  });
});

// REGRESSION: `claude` is in BOTH REVIEWER_IDS (the registry) and HARNESS_SEATS (the CLI's
// additive producer). The naive [...REVIEWER_IDS, ...HARNESS_SEATS] listed it twice, so a
// degraded/unbound claude seat got iterated + named twice. EVIDENCE_SEATS must dedupe.
describe('EVIDENCE_SEATS — deduped across the reviewer/harness overlap', () => {
  it('lists every actor exactly once (claude is both a ReviewerId and a HARNESS_SEAT)', () => {
    expect([...EVIDENCE_SEATS]).toEqual(['codex', 'grok', 'claude', 'gate']);
    expect(new Set(EVIDENCE_SEATS).size).toBe(EVIDENCE_SEATS.length);
  });

  it('a degraded claude seat appears ONCE in the shortfall, not twice', () => {
    const gaps = evidenceShortfall({ claude: 'worktree' }, { claude: 'packet' });
    expect(gaps).toEqual([{ intended: 'worktree', realized: 'packet', seat: 'claude' }]);
    expect(formatEvidenceShortfall(gaps).match(/claude/g)).toHaveLength(1);
  });
});
