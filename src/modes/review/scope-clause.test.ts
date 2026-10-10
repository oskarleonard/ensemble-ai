import { describe, expect, it } from 'vitest';

import { renderCodeReviewSeatPrompt } from './code-review-seat';
import { renderHolisticPrompt } from './holistic';
import { materializedDiffClause } from './worktree';

// A seat handed ONE PART of a change must never be told it holds "exactly the diff": run
// 2026-10-10-18-51-44-9acc127a's lens was told a 70-file backend slice was the whole of a 411-file
// merge, and believed it. With a scope note the clause says "in parts" and points at the listing.

const DIFF = 'diff --git a/backend/a.go b/backend/a.go\n@@ -1,1 +1,1 @@\n+x\n';
const SCOPE = 'This change touches 2 file(s)…\npart 2 — web (hunks NOT below — read at head):\n  web/c.ts (+1/-1)';

describe('materializedDiffClause', () => {
  it('without a scope says the bytes are exactly the diff (unchanged)', () => {
    const s = materializedDiffClause({ baseSha: 'b'.repeat(40), diff: DIFF, headSha: 'h'.repeat(40) });
    expect(s).toContain('is exactly `git diff');
    expect(s).toContain(DIFF);
  });

  it('with a scope says the change is handed over in PARTS and embeds the listing before the diff', () => {
    const s = materializedDiffClause({ baseSha: 'b'.repeat(40), diff: DIFF, headSha: 'h'.repeat(40), scope: SCOPE });
    expect(s).not.toContain('is exactly `git diff');
    expect(s).toContain('handed over in PARTS');
    expect(s).toContain('rather than assuming they are\nunchanged');
    expect(s.indexOf(SCOPE)).toBeLessThan(s.indexOf('```diff'));
  });
});

describe('the scope reaches the fenced seats that embed the diff', () => {
  const base = { baseSha: 'b'.repeat(40), diff: DIFF, headSha: 'h'.repeat(40), worktree: '/tmp/wt' };

  it('the /code-review producer prompt', () => {
    expect(renderCodeReviewSeatPrompt(base)).toContain('is exactly `git diff');
    const scoped = renderCodeReviewSeatPrompt({ ...base, scope: SCOPE });
    expect(scoped).toContain('handed over in PARTS');
    expect(scoped).toContain('web/c.ts (+1/-1)');
  });

  it('the holistic lens prompt', () => {
    expect(renderHolisticPrompt(base)).toContain('is exactly `git diff');
    const scoped = renderHolisticPrompt({ ...base, scope: SCOPE });
    expect(scoped).toContain('handed over in PARTS');
    expect(scoped).toContain('web/c.ts (+1/-1)');
  });
});
