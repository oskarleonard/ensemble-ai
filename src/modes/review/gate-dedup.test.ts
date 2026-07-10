import { describe, expect, it } from 'vitest';

import { clusterPostable } from './gate-dedup';
import type { GateVerdictRecord } from './gate';

function rec(over: Partial<GateVerdictRecord> & { findingId: string }): GateVerdictRecord {
  return {
    anchorSide: 'new',
    downgradeReason: null,
    effectiveVerdict: 'agree',
    file: 'src/a.ts',
    line: 10,
    postableBody: 'body',
    postableClass: 'bug',
    postableFix: 'keep',
    postableStatus: 'postable',
    postableSuggestion: null,
    rawVerdict: 'agree',
    reason: 'r',
    rescoredSeverity: null,
    resolved: true,
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

  it('merges three DIFFERENTLY-worded takes on one defect via overlap coefficient (real lisk-web#690 shape)', () => {
    // Same localStorage-PII defect, three reviewers, proximate lines, low Jaccard but high
    // overlap-coefficient — the exact case where a Jaccard threshold under-merged.
    const out = clusterPostable([
      rec({ findingId: 'codex#1', line: 117, title: 'KYB PII is persisted in localStorage', postableBody: 'The new draft hook serializes the full draft, including businessDetails and personsData, into localStorage. KYB associated-person/business data is sensitive and localStorage is readable by any same-origin script, persists across browser restarts, and is difficult to protect after an XSS or shared-device exposure. Prefer a server-side encrypted draft, or at minimum explicitly whitelist non-sensitive fields and avoid storing associated-person PII client-side.' }),
      rec({ findingId: 'grok#2', line: 117, title: 'Partial KYB submissions (including associated persons) stored in plaintext localStorage', postableBody: "patchDraft writes the full businessDetails and personsData objects (plus step) to keys of the form 'kyb-draft:<workspaceSlug>' with no encryption, user id scoping, or access control. clearAllKybDrafts runs only in the !hasNextSession branch of handleSignOut; the multi-session switch test explicitly asserts that the prior workspace's draft remains. Any code running on the origin or anyone with access to the browser profile can read the data after the user closes the tab or switches accounts. Suggested fix: do not persist regulated/compliance data client-side, scope to the authenticated user, prefer sessionStorage, or at minimum clear on any sign-out and add a storage event listener." }),
      rec({ findingId: 'claude#2', line: 120, title: 'Sensitive KYB PII persisted to localStorage without encryption or expiry-on-close', postableBody: '`patchDraft` serializes the entire draft (`businessDetails`, `businessActivity`, `personsData`) to `localStorage` on every change. KYB drafts contain business-identity PII and associated-persons personal data. localStorage is unencrypted, origin-persistent (survives tab/browser close), and reachable by any script on the origin — so a single XSS turns into exfiltration of identity-verification data, and the data lingers on shared machines. For a KYB/identity flow this is a data-protection concern worth an explicit decision: prefer sessionStorage, encrypt at rest, exclude the most sensitive person fields (tax IDs / DOB) from what is persisted, or scope persistence to non-PII progress only.' }),
    ]);
    const primaries = out.filter((r) => r.cluster?.primary);
    expect(primaries).toHaveLength(1); // all three collapse into one comment
    expect(primaries[0].cluster).toMatchObject({ corroboration: 3 });
  });

  it('merges the same defect cited at DIFFERENT lines of one function (10 lines apart)', () => {
    // Real lisk-web#690 shape: two reviewers flag the same localStorage-PII write in one hook
    // but cite lines 112 vs 122 — beyond a tight line window, caught by the function-span window.
    const pii = (extra: string): string =>
      `Serializes the full KYB draft (businessDetails, personsData) to localStorage with no encryption; readable by any same-origin script and persists across sessions. ${extra}`;
    const out = clusterPostable([
      rec({ findingId: 'codex#1', line: 112, title: 'KYB PII is persisted in plaintext localStorage', postableBody: pii('Prefer a server-side encrypted draft.') }),
      rec({ findingId: 'claude#1', line: 122, title: 'Sensitive KYB PII persisted to plaintext localStorage', postableBody: pii('Prefer sessionStorage or exclude the sensitive person fields.') }),
      // a DIFFERENT defect in the same file stays separate (low text overlap)
      rec({ findingId: 'codex#2', line: 69, title: 'Draft resume can skip required prior data', postableBody: 'resolveResumeStep maps a saved step to a later stage without checking earlier steps were completed, so a resumed draft can land past required data.' }),
    ]);
    expect(out.filter((r) => r.cluster?.primary)).toHaveLength(2); // the two PII findings merge; the resume bug stays
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
