import { describe, expect, it } from 'vitest';

import { evaluatePushFence, parsePushContext, type PrPushContext } from './push-fence';

const ctx = (over: Partial<PrPushContext> = {}): PrPushContext => ({
  headRefName: 'feature',
  headRepoOwner: 'oskarleonard',
  isCrossRepository: false,
  viewerCanPushBase: true,
  ...over,
});

describe('fix-tail push fence — refuse to push to a head ref the user does not own', () => {
  it('ALLOWS a same-repo PR where the user has push access', () => {
    expect(evaluatePushFence(ctx(), 'o/r')).toEqual({ allowed: true });
  });

  it('REFUSES a fork PR — a contributor\'s branch is theirs', () => {
    const v = evaluatePushFence(ctx({ headRepoOwner: 'contributor', isCrossRepository: true }), 'o/r');
    expect(v.allowed).toBe(false);
    if (!v.allowed) {
      expect(v.reason).toContain("contributor's fork");
      expect(v.reason).toContain('--stage');
    }
  });

  it('REFUSES a fork PR even when "allow edits by maintainers" would permit the push', () => {
    // The fence deliberately does not consult maintainerCanModify: rewriting a contributor's
    // branch is not a review action, however technically possible.
    const v = evaluatePushFence(ctx({ headRepoOwner: 'contributor', isCrossRepository: true }), 'o/r');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toContain('allow edits by maintainers');
  });

  it('REFUSES when the fork was deleted (no head owner)', () => {
    const v = evaluatePushFence(ctx({ headRepoOwner: null, isCrossRepository: true }), 'o/r');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toContain('a deleted fork');
  });

  it('REFUSES a same-repo PR when the user has no push access to the base', () => {
    const v = evaluatePushFence(ctx({ viewerCanPushBase: false }), 'o/r');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toContain('do not have push access to o/r');
  });

  it('names the stage tail as the alternative — a fence, never a dispatcher that reroutes for you', () => {
    const v = evaluatePushFence(ctx({ isCrossRepository: true }), 'o/r');
    expect(v.allowed).toBe(false);
    if (!v.allowed) expect(v.reason).toContain('ensemble-ai review --pr <url> --stage');
  });
});

describe('parsePushContext — fails CLOSED on every unreadable field', () => {
  it('reads gh pr view\'s shape', () => {
    expect(
      parsePushContext(
        { headRefName: 'feat', headRepositoryOwner: { login: 'oskarleonard' }, isCrossRepository: false },
        true
      )
    ).toEqual({ headRefName: 'feat', headRepoOwner: 'oskarleonard', isCrossRepository: false, viewerCanPushBase: true });
  });

  it('a MISSING isCrossRepository is treated as cross-repo (refuse), never as same-repo', () => {
    expect(parsePushContext({}, true).isCrossRepository).toBe(true);
  });

  it('a non-boolean push permission is NOT push access', () => {
    expect(parsePushContext({ isCrossRepository: false }, 'true').viewerCanPushBase).toBe(false);
    expect(parsePushContext({ isCrossRepository: false }, undefined).viewerCanPushBase).toBe(false);
  });

  it('a malformed owner object yields no owner (refuse)', () => {
    expect(parsePushContext({ headRepositoryOwner: 'oskarleonard' }, true).headRepoOwner).toBeNull();
    expect(parsePushContext(null, true).headRepoOwner).toBeNull();
  });

  it('a fully unreadable PR refuses', () => {
    expect(evaluatePushFence(parsePushContext(null, null), 'o/r').allowed).toBe(false);
  });
});
