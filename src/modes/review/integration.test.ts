import { describe, expect, it } from 'vitest';

import { renderIntegrationPrompt } from './integration';

describe('renderIntegrationPrompt — the seams reviewer', () => {
  const base = { baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40), scope: 'part 1 — backend\n  a.go (+1/-0)', skeleton: '### a.go — part 1\n+ 3: func A()', worktree: '/tmp/wt' };
  it('carries the listing, the skeleton, the five classes, and the two-site rule', () => {
    const p = renderIntegrationPrompt(base);
    expect(p).toContain('INTEGRATION seat');
    expect(p).toContain('## The change, part by part\n\npart 1 — backend');
    expect(p).toContain('## The whole change as a skeleton\n\n### a.go');
    for (const cls of ['CONTRACT DRIFT', 'HALF-DONE CHANGES', 'GUARDS AND INVARIANTS', 'BEHAVIOR CHANGED WITH NO TEST', 'REGRESSION RISK OUTSIDE THE DIFF']) expect(p).toContain(cls);
    expect(p).toContain('MUST name at least two sites');
    expect(p).toContain('Never report style');
    expect(p).toContain('/tmp/wt');
    expect(p).not.toContain('Repo conventions — read the file');
  });
  it('points at the conventions file when the run handed one over', () => {
    expect(renderIntegrationPrompt({ ...base, conventionsPath: '/tmp/wt/.ensemble-conventions/CONVENTIONS.md' })).toContain('/tmp/wt/.ensemble-conventions/CONVENTIONS.md');
  });
});
