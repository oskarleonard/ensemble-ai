import { describe, expect, it, vi } from 'vitest';

import { STAGE_MARKER, type StagedReviewPayload } from './stage-plan';
import { checkFreshness, classifyPending, type GhResult, type GhRunner, isCommitSha, parseReviewSummaries, stageReview } from './stage';

const TARGET = { owner: 'o', pr: 7, repo: 'r' };
const HEAD = 'a'.repeat(40);
const PAYLOAD: StagedReviewPayload = {
  body: `## 🔭 ensemble-ai — cross-vendor review\n${STAGE_MARKER}\n\nbody`,
  comments: [{ body: 'inline', line: 3, path: 'src/a.ts', side: 'RIGHT' }],
  commit_id: HEAD,
};

// A scriptable `gh`: each entry matches on a substring of the joined argv and returns its result.
function fakeGh(script: { match: string; result: GhResult }[]): { calls: string[][]; gh: GhRunner } {
  const calls: string[][] = [];
  const gh: GhRunner = (args) => {
    calls.push(args);
    const joined = args.join(' ');
    const hit = script.find((s) => joined.includes(s.match));
    return hit ? hit.result : { error: `unscripted gh call: ${joined}`, ok: false };
  };
  return { calls, gh };
}

const okHead = (sha = HEAD): { match: string; result: GhResult } => ({
  match: 'api repos/o/r/pulls/7 --jq .head.sha',
  result: { ok: true, text: `${sha}\n` },
});
const reviews = (json: unknown): { match: string; result: GhResult } => ({
  match: 'pulls/7/reviews --paginate',
  result: { ok: true, text: JSON.stringify(json) },
});
const created = (url = 'https://github.com/o/r/pull/7#pullrequestreview-1'): { match: string; result: GhResult } => ({
  match: '--method POST',
  result: { ok: true, text: JSON.stringify({ html_url: url, id: 1 }) },
});

// ── The freshness guard ───────────────────────────────────────────────────────────────

// ── The bound-head guard ──────────────────────────────────────────────────────────────

// `gh pr diff` carries no commit identity, so acquireDiff labels its headSha rather than inventing
// one. Staging such a review would compare that label against a real SHA and refuse with a
// fabricated "the head moved" story — and GitHub would reject the label as a `commit_id` anyway.
describe('bound-head guard — a review with no commit identity is never staged', () => {
  it('recognizes a SHA-1 and a SHA-256 head, and nothing else', () => {
    expect(isCommitSha('a'.repeat(40))).toBe(true);
    expect(isCommitSha('0123456789abcdef'.repeat(4))).toBe(true); // 64 hex
    expect(isCommitSha('gh pr diff (no local commit identity)')).toBe(false);
    expect(isCommitSha('A'.repeat(40))).toBe(false); // uppercase is not git's spelling
    expect(isCommitSha('a'.repeat(39))).toBe(false);
    expect(isCommitSha('')).toBe(false);
  });

  it('stageReview REFUSES an unbound head and makes NO gh call at all', () => {
    const { calls, gh } = fakeGh([okHead(), reviews([]), created()]);
    const res = stageReview(PAYLOAD, TARGET, { gh, reviewedHeadSha: 'gh pr diff (no local commit identity)' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('unbound-head');
      expect(res.error).toContain('not bound to a commit');
    }
    expect(calls).toEqual([]); // refused before any I/O
  });
});

describe('freshness guard — never post stale anchors', () => {
  it('passes when the reviewed head IS the live head', () => {
    expect(checkFreshness(HEAD, HEAD)).toEqual({ ok: true });
  });

  it('refuses when the PR head moved, naming both SHAs', () => {
    const res = checkFreshness('a'.repeat(40), 'b'.repeat(40));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('the PR head moved since this review');
      expect(res.error).toContain('aaaaaaaaaaaa');
      expect(res.error).toContain('bbbbbbbbbbbb');
    }
  });

  it('stageReview REFUSES a moved head and writes NOTHING', () => {
    const { calls, gh } = fakeGh([okHead('b'.repeat(40)), reviews([]), created()]);
    const res = stageReview(PAYLOAD, TARGET, { gh, reviewedHeadSha: HEAD });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('head-moved');
    // The head read is the ONLY call — no list, no delete, no create.
    expect(calls).toHaveLength(1);
    expect(calls.every((c) => !c.includes('POST') && !c.includes('DELETE'))).toBe(true);
  });
});

// ── Stale-pending detection ───────────────────────────────────────────────────────────

describe('stale-pending detection — one pending review per user per PR', () => {
  it('no pending review → none', () => {
    expect(classifyPending([{ id: 1, state: 'APPROVED' }, { id: 2, state: 'COMMENTED' }])).toEqual({ kind: 'none' });
  });

  it('a PENDING review carrying our marker is OURS', () => {
    expect(classifyPending([{ body: `x ${STAGE_MARKER} y`, id: 9, state: 'PENDING' }])).toEqual({ id: 9, kind: 'ours' });
  });

  it('a PENDING review WITHOUT our marker is the user\'s own unsubmitted work', () => {
    expect(classifyPending([{ body: 'half-written thoughts', id: 9, state: 'PENDING' }])).toEqual({ id: 9, kind: 'foreign' });
  });

  it('a PENDING review with a null body is foreign (fail closed — never claim it)', () => {
    expect(classifyPending([{ body: null, id: 9, state: 'PENDING' }])).toEqual({ id: 9, kind: 'foreign' });
  });

  it('stageReview FAILS LEGIBLY on a foreign pending review, and never deletes it', () => {
    const { calls, gh } = fakeGh([okHead(), reviews([{ body: 'mine', id: 9, state: 'PENDING' }]), created()]);
    const res = stageReview(PAYLOAD, TARGET, { gh, reviewedHeadSha: HEAD });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe('foreign-pending');
      expect(res.error).toContain('only one pending review per user per PR');
      expect(res.error).toContain('Submit or discard it on GitHub');
    }
    expect(calls.some((c) => c.includes('DELETE'))).toBe(false);
    expect(calls.some((c) => c.includes('POST'))).toBe(false);
  });

  it('parseReviewSummaries tolerates a non-array payload', () => {
    expect(parseReviewSummaries('{"message":"Not Found"}')).toEqual([]);
  });
});

// ── Staging + idempotency ─────────────────────────────────────────────────────────────

describe('staging a PENDING review', () => {
  it('creates ONE pending review: POST with the payload on stdin, `event` never sent', () => {
    const { calls, gh } = fakeGh([okHead(), reviews([]), created()]);
    const spy = vi.fn(gh);
    const res = stageReview(PAYLOAD, TARGET, { gh: spy, reviewedHeadSha: HEAD });
    expect(res).toEqual({ ok: true, replaced: false, url: 'https://github.com/o/r/pull/7#pullrequestreview-1' });
    const post = spy.mock.calls.find((c) => c[0].includes('POST'));
    expect(post?.[0]).toEqual(['api', '--method', 'POST', 'repos/o/r/pulls/7/reviews', '--input', '-']);
    const sent = JSON.parse(post?.[1] as string);
    expect(sent).toEqual(PAYLOAD);
    expect(sent.event).toBeUndefined();
    expect(calls.some((c) => c.includes('DELETE'))).toBe(false);
  });

  it('a re-run REPLACES our prior pending review (update-in-place, never duplicate)', () => {
    const { calls, gh } = fakeGh([
      okHead(),
      reviews([{ body: STAGE_MARKER, id: 42, state: 'PENDING' }]),
      { match: '--method DELETE', result: { ok: true, text: '' } },
      created(),
    ]);
    const res = stageReview(PAYLOAD, TARGET, { gh, reviewedHeadSha: HEAD });
    expect(res).toMatchObject({ ok: true, replaced: true });
    const del = calls.find((c) => c.includes('DELETE'));
    expect(del).toEqual(['api', '--method', 'DELETE', 'repos/o/r/pulls/7/reviews/42']);
    // Deleted BEFORE the create — so the PR never holds two ensemble-ai pending reviews.
    expect(calls.findIndex((c) => c.includes('DELETE'))).toBeLessThan(calls.findIndex((c) => c.includes('POST')));
  });

  it('a failed delete aborts — it never stacks a second pending review on the author', () => {
    const { calls, gh } = fakeGh([
      okHead(),
      reviews([{ body: STAGE_MARKER, id: 42, state: 'PENDING' }]),
      { match: '--method DELETE', result: { error: '403', ok: false } },
      created(),
    ]);
    const res = stageReview(PAYLOAD, TARGET, { gh, reviewedHeadSha: HEAD });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.kind).toBe('gh-failed');
    expect(calls.some((c) => c.includes('POST'))).toBe(false);
  });

  it('a gh failure is a typed result, never a throw', () => {
    const { gh } = fakeGh([{ match: 'api repos/o/r/pulls/7', result: { error: 'gh: not authenticated', ok: false } }]);
    const res = stageReview(PAYLOAD, TARGET, { gh, reviewedHeadSha: HEAD });
    expect(res).toMatchObject({ kind: 'gh-failed', ok: false });
    if (!res.ok) expect(res.error).toContain('not authenticated');
  });

  it('a THROWING runner is caught — staging never takes down the review', () => {
    const gh: GhRunner = () => {
      throw new Error('spawn ENOMEM');
    };
    const res = stageReview(PAYLOAD, TARGET, { gh, reviewedHeadSha: HEAD });
    expect(res).toMatchObject({ kind: 'gh-failed', ok: false });
  });

  it('an unparseable create response still reports success — the review WAS created', () => {
    const { gh } = fakeGh([okHead(), reviews([]), { match: '--method POST', result: { ok: true, text: 'not json' } }]);
    expect(stageReview(PAYLOAD, TARGET, { gh, reviewedHeadSha: HEAD })).toEqual({ ok: true, replaced: false, url: null });
  });

  it('an empty live head SHA fails closed (never assume freshness)', () => {
    const { gh } = fakeGh([{ match: '--jq .head.sha', result: { ok: true, text: '\n' } }]);
    expect(stageReview(PAYLOAD, TARGET, { gh, reviewedHeadSha: HEAD })).toMatchObject({ kind: 'unreadable', ok: false });
  });
});
