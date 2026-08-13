import { describe, expect, it } from 'vitest';

import { assembleCodePacket } from './packet';
import { renderReviewPrompt } from './prompt';

const packet = assembleCodePacket({
  diff: 'diff --git a/x.ts b/x.ts\n+const a = 1;\n',
  objective: 'test objective',
  pr: 0,
  repo: 'acme/widget',
});

describe('renderReviewPrompt — code profile (default)', () => {
  it('uses the general code-review framing', () => {
    const p = renderReviewPrompt(packet);
    expect(p).toContain('adversarial code reviewer');
    expect(p).toContain('## Your task');
    expect(p).toContain('Find correctness bugs');
    // the strict findings contract is always present
    expect(p).toContain('## Output format — STRICT');
    // no security-only framing leaks into the code profile
    expect(p).not.toContain('SECURITY AUDIT');
  });

  it('asks for the twin-surface parity sweep (absences are findings)', () => {
    // Diff-only reviewers structurally miss what a mirrored surface LACKS (proven
    // on a real run: a portfolio alias of an account API shipped without the
    // detail endpoint and no reviewer flagged it) — so the ask must name the
    // sweep explicitly.
    const p = renderReviewPrompt(packet);
    expect(p).toContain('TWIN-SURFACE PARITY');
    expect(p).toContain('An absence is a finding');
  });
});

describe('renderReviewPrompt — security profile', () => {
  const p = renderReviewPrompt(packet, 'security');

  it('swaps in the adversarial security-auditor framing', () => {
    expect(p).toContain('adversarial SECURITY auditor');
    expect(p).toContain('## Your task — SECURITY AUDIT');
    expect(p).toContain('Think like an attacker');
  });

  it('lists the security classes and asks for a [class] title tag', () => {
    expect(p).toContain('[injection]');
    expect(p).toContain('[authz]');
    expect(p).toContain('[supply-chain]');
    expect(p).toContain('lead the "title" with the matching class tag');
  });

  it('keeps the SAME strict findings output contract + embedded diff', () => {
    expect(p).toContain('## Output format — STRICT');
    expect(p).toContain('const a = 1;');
  });
});

// A reviewer sees ONE diff, never the project's tracker — so "this change is out of scope" is a
// guess about a ticket it cannot read, dressed as a finding. The rule rides the SHARED findings
// contract, so every profile (and every vendor seat rendering from it) carries it.
describe('the findings contract forbids scope / sanction claims', () => {
  it('tells the reviewer to state the code-level consequence instead — in BOTH profiles', () => {
    for (const p of [renderReviewPrompt(packet), renderReviewPrompt(packet, 'security')]) {
      expect(p).toContain("see one diff, not the project's tracker");
      expect(p).toMatch(/never assert a change is out-of-scope or\s+unsanctioned/);
      expect(p).toMatch(/note the commit\s+boundary/);
    }
  });
});
