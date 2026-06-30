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
