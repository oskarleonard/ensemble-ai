import { describe, expect, it } from 'vitest';

import type { AcquiredDiff, Coverage } from '../modes/review/diff';

import { buildPacketPreview, renderPacketPreview } from './diff-preview';

// A source diff comfortably over DIFF_USEFUL_FLOOR (200 chars) so the packet reads
// as `complete` (a shorter diff is a legitimately "blind"/incomplete packet).
const DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 0000000..1111111 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,6 @@',
  ' const a = 1;',
  '+const b = 2;',
  '+const c = 3;',
  '+const d = 4;',
  '+// a small change with enough body to clear the usefulness floor',
  '+export const total = a + b + c + d;',
  ' export const base = a;',
  '',
].join('\n');

function coverage(): Coverage {
  return {
    files: [
      { added: 1, bytes: DIFF.length, included: true, kind: 'source', path: 'src/a.ts', removed: 0 },
      { added: 0, bytes: 40, included: false, kind: 'generated', omitReason: 'generated', path: 'package-lock.json', removed: 0 },
    ],
    includedBytes: DIFF.length,
    includedFiles: 1,
    omittedFiles: 1,
    totalBytes: DIFF.length + 40,
    totalFiles: 2,
  };
}

function acquired(over: Partial<AcquiredDiff> = {}): AcquiredDiff {
  return {
    baseRef: 'origin/main',
    baseSha: 'aaa',
    canonicalDigest: 'sha256:deadbeef',
    coverage: coverage(),
    diff: DIFF,
    files: [],
    headSha: 'bbb',
    mode: 'commit',
    rawDiff: DIFF,
    repoId: 'https://example/repo',
    ...over,
  };
}

describe('buildPacketPreview — assembles the packet, spawns nothing', () => {
  it('assembles a complete code packet embedding the diff (no reviewer invoked)', () => {
    const { packet, prompt } = buildPacketPreview(acquired(), 'code');
    expect(packet.complete).toBe(true);
    // the diff is embedded verbatim in the prompt the reviewer would receive
    expect(prompt).toContain('const b = 2;');
    // the general-review ask, not the security ask
    expect(prompt).toContain('adversarial code reviewer');
  });

  it('the security profile swaps ONLY the framing (security-audit objective)', () => {
    const { prompt } = buildPacketPreview(acquired(), 'security');
    expect(prompt).toContain('SECURITY AUDIT');
    expect(prompt).toContain('adversarial SECURITY auditor');
  });

  it('an empty diff yields an incomplete packet (blind review)', () => {
    const { packet } = buildPacketPreview(
      acquired({ diff: '', coverage: { ...coverage(), includedBytes: 0, includedFiles: 0 } }),
      'code'
    );
    expect(packet.complete).toBe(false);
  });
});

describe('renderPacketPreview', () => {
  it('shows the identity, coverage, the section manifest, and the cost preview', () => {
    const preview = buildPacketPreview(acquired(), 'code');
    const out = renderPacketPreview(acquired(), preview, {
      full: false,
      profile: 'code',
      reviewers: ['codex', 'grok'],
    });
    expect(out).toContain('sha256:deadbeef');
    expect(out).toContain('2 total · 1 reviewed · 1 omitted');
    expect(out).toContain('omitted: package-lock.json (generated/generated)');
    expect(out).toContain('The diff under review'); // a manifest section title
    expect(out).toContain('× 2 reviewer(s) [codex, grok]');
    // default view does NOT dump the whole prompt
    expect(out).toContain('pass --full');
    expect(out).not.toContain('## Objective');
  });

  it('--full appends the entire rendered prompt', () => {
    const preview = buildPacketPreview(acquired(), 'code');
    const out = renderPacketPreview(acquired(), preview, {
      full: true,
      profile: 'code',
      reviewers: ['codex'],
    });
    expect(out).toContain('rendered prompt');
    expect(out).toContain('const b = 2;');
  });
});
