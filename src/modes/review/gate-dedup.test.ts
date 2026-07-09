import { describe, expect, it } from 'vitest';

import { clusterPostable } from './gate-dedup';
import type { GateVerdictRecord } from './gate';

function rec(over: Partial<GateVerdictRecord> & { findingId: string }): GateVerdictRecord {
  return {
    downgradeReason: null,
    effectiveVerdict: 'agree',
    file: 'src/a.ts',
    line: 10,
    postableBody: 'body',
    postableFix: 'keep',
    postableStatus: 'postable',
    rawVerdict: 'agree',
    reason: 'r',
    rescoredSeverity: null,
    reviewer: over.findingId.split('#')[0],
    severity: 'medium',
    title: 't',
    ...over,
  };
}

const NET = 'isNetworkError treats any TypeError as a connectivity failure, masking real errors';

describe('clusterPostable — dedup by selection', () => {
  it('merges same-file same-line findings with high text overlap into one primary', () => {
    const out = clusterPostable([
      rec({ findingId: 'codex#1', line: 19, postableBody: NET }),
      rec({ findingId: 'grok#1', line: 19, postableBody: NET }),
      rec({ findingId: 'claude#1', line: 19, postableBody: NET }),
    ]);
    const primaries = out.filter((r) => r.cluster?.primary);
    expect(primaries).toHaveLength(1);
    expect(primaries[0].cluster).toMatchObject({ corroboration: 3 });
    expect(primaries[0].cluster?.corroborators).toHaveLength(2);
    // every member shares one clusterId
    expect(new Set(out.map((r) => r.cluster?.clusterId)).size).toBe(1);
  });

  it('does NOT merge distinct issues in the same file at far-apart lines', () => {
    const out = clusterPostable([
      rec({ findingId: 'codex#1', line: 19, postableBody: NET }),
      rec({ findingId: 'codex#2', line: 200, postableBody: 'a totally different bug about unbounded cache growth' }),
    ]);
    expect(out.filter((r) => r.cluster?.primary)).toHaveLength(2); // two singletons
    expect(out.every((r) => r.cluster?.corroboration === 1)).toBe(true);
  });

  it('does NOT merge proximate-but-unrelated findings (low text overlap)', () => {
    const out = clusterPostable([
      rec({ findingId: 'codex#1', line: 19, postableBody: NET }),
      rec({ findingId: 'grok#1', line: 20, postableBody: 'the retry counter is never reset after a success path' }),
    ]);
    expect(out.filter((r) => r.cluster?.primary)).toHaveLength(2);
  });

  it('elects an agree over a partial as the cluster primary', () => {
    const out = clusterPostable([
      rec({ effectiveVerdict: 'partial', findingId: 'codex#1', line: 19, postableBody: NET }),
      rec({ effectiveVerdict: 'agree', findingId: 'grok#1', line: 19, postableBody: NET }),
    ]);
    const primary = out.find((r) => r.cluster?.primary);
    expect(primary?.findingId).toBe('grok#1'); // the agree wins even though codex sorts first
  });

  it('leaves non-postable records untouched (no cluster field)', () => {
    const out = clusterPostable([
      rec({ effectiveVerdict: 'unverified', findingId: 'codex#1', postableBody: null, postableStatus: 'not-postable' }),
    ]);
    expect(out[0].cluster).toBeUndefined();
  });

  it('is deterministic — same input yields the same primary', () => {
    const input = [
      rec({ findingId: 'grok#1', line: 19, postableBody: NET }),
      rec({ findingId: 'codex#1', line: 19, postableBody: NET }),
    ];
    const a = clusterPostable(input).find((r) => r.cluster?.primary)?.findingId;
    const b = clusterPostable(input).find((r) => r.cluster?.primary)?.findingId;
    expect(a).toBe(b);
  });
});
