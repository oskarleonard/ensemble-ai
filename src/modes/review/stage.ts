import { isEnsembleStagedReview, type StagedReviewPayload } from './stage-plan';

// THE STAGED PENDING REVIEW (spec §6) — the review verb's one outward action on a FOREIGN PR.
//
// Everything lands as ONE **PENDING** review under the user's own account: the create-review call
// OMITS `event`, which GitHub treats as pending — author-private until the user reads, edits, and
// clicks Submit in GitHub's own UI. `event` is never sent, so this tool can never Approve or
// Request-Changes anywhere. Nothing appears under the user's name without their click, including
// "LGTM": a zero-bug run still stages a review carrying only the summary body.
//
// Three hardenings, all fail-CLOSED (post nothing rather than post something wrong):
//   1. FRESHNESS — the reviewed headSha must still be the PR's live head. A moved head means every
//      inline anchor points at code the author has already changed.
//   2. STALE PENDING — GitHub allows ONE pending review per user per PR. A pending review that is
//      not ours is a human's unsubmitted work: we refuse, legibly, and never touch it.
//   3. IDEMPOTENCY — a pending review that IS ours (it carries STAGE_MARKER) is REPLACED, so a
//      re-run updates in place instead of stacking duplicate comments on the author.
//
// All GitHub I/O goes through an injected runner, so every branch above is unit-tested without
// spawning `gh`.

export type GhResult = { error: string; ok: false } | { ok: true; text: string };

// The exec seam: `gh api <args>` with an optional JSON body on stdin.
export type GhRunner = (args: string[], input?: string) => GhResult;

export interface StageTarget {
  owner: string;
  pr: number;
  repo: string;
}

export interface StageSuccess {
  ok: true;
  // True when a prior ensemble-ai pending review was replaced (an idempotent re-run).
  replaced: boolean;
  url: string | null;
}

export interface StageFailure {
  error: string;
  // The machine-readable cause, so a consumer can branch without parsing prose.
  kind: 'foreign-pending' | 'gh-failed' | 'head-moved' | 'unbound-head' | 'unreadable';
  ok: false;
}

export type StageResult = StageFailure | StageSuccess;

function apiPath(t: StageTarget, suffix = ''): string {
  return `repos/${t.owner}/${t.repo}/pulls/${t.pr}${suffix}`;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

// ── 1. Freshness guard ────────────────────────────────────────────────────────────────

// Does `s` name a commit? A diff acquired via `gh pr diff` has no commit identity and carries a
// human-readable label instead of a SHA (see acquireDiff). Staging such a review would compare a
// label against a real head and refuse with a fabricated "the head moved" story — and its
// `commit_id` would be rejected by GitHub anyway. SHA-1 (40) or SHA-256 (64) hex.
export function isCommitSha(s: string): boolean {
  return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(s);
}

// PURE. The review is tied to `reviewedHeadSha`; every inline anchor and the ```suggestion``` line
// numbers are only meaningful at that commit. If the PR head moved, REFUSE — a stale anchor lands a
// confident comment on code the author already rewrote.
export function checkFreshness(
  reviewedHeadSha: string,
  liveHeadSha: string
): { error: string; ok: false } | { ok: true } {
  if (reviewedHeadSha === liveHeadSha) return { ok: true };
  return {
    error:
      `the PR head moved since this review: reviewed at ${reviewedHeadSha.slice(0, 12)}, ` +
      `live head is ${liveHeadSha.slice(0, 12)}. Refusing to stage a review whose line anchors ` +
      `point at code that has changed — re-run the review against the current head.`,
    ok: false,
  };
}

// ── 2. Stale-pending detection ────────────────────────────────────────────────────────

export interface ReviewSummary {
  body?: string | null;
  id?: number;
  state?: string;
}

export type PendingState =
  | { id: number; kind: 'foreign' }
  | { id: number; kind: 'ours' }
  | { kind: 'none' };

// PURE. GitHub returns the caller's OWN pending review in the reviews list (a pending review is
// invisible to everyone else), so a PENDING entry here is always the user's. It is `ours` only when
// it carries our marker; anything else is their unsubmitted work.
export function classifyPending(reviews: ReviewSummary[]): PendingState {
  for (const r of reviews) {
    if (r.state !== 'PENDING' || typeof r.id !== 'number') continue;
    return isEnsembleStagedReview(r.body) ? { id: r.id, kind: 'ours' } : { id: r.id, kind: 'foreign' };
  }
  return { kind: 'none' };
}

export function parseReviewSummaries(text: string): ReviewSummary[] {
  const parsed = parseJson(text);
  return Array.isArray(parsed) ? (parsed as ReviewSummary[]) : [];
}

// ── 3. Stage (create / replace) ───────────────────────────────────────────────────────

const FOREIGN_PENDING = (t: StageTarget): string =>
  `you already have an unsubmitted PENDING review on ${t.owner}/${t.repo}#${t.pr} that ensemble-ai did not create. ` +
  `GitHub allows only one pending review per user per PR. Submit or discard it on GitHub, then re-run — ` +
  `refusing to touch a review you wrote by hand.`;

// Create ONE pending review carrying the summary body + the inline comments. Replaces a prior
// ensemble-ai pending review first (idempotent re-run). Never throws: every failure is a typed
// StageFailure the caller renders as a loud warning.
export function stageReview(
  payload: StagedReviewPayload,
  target: StageTarget,
  deps: { gh: GhRunner; log?: (m: string) => void; reviewedHeadSha: string }
): StageResult {
  const log = deps.log ?? (() => {});
  const run = (args: string[], input?: string): GhResult => {
    try {
      return deps.gh(args, input);
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e), ok: false };
    }
  };

  // 0. BOUND HEAD — a review with no commit identity has nothing to anchor or compare. Refuse
  //    before any I/O, so the exported library API cannot stage one either.
  if (!isCommitSha(deps.reviewedHeadSha)) {
    return {
      error:
        `the review is not bound to a commit (its head is \`${deps.reviewedHeadSha.slice(0, 60)}\`, not a SHA), ` +
        `so its line anchors cannot be tied to a commit and its freshness cannot be checked. ` +
        `Acquire the diff bound to the PR's head SHA (the compare API) before staging.`,
      kind: 'unbound-head',
      ok: false,
    };
  }

  // 1. FRESHNESS — read the live head before writing anything.
  const head = run(['api', apiPath(target), '--jq', '.head.sha']);
  if (!head.ok) return { error: `could not read the PR head: ${head.error}`, kind: 'gh-failed', ok: false };
  const liveHead = head.text.trim();
  if (!liveHead) return { error: 'the PR head SHA came back empty', kind: 'unreadable', ok: false };
  const fresh = checkFreshness(deps.reviewedHeadSha, liveHead);
  if (!fresh.ok) return { error: fresh.error, kind: 'head-moved', ok: false };

  // 2. STALE PENDING — one per user per PR.
  const list = run(['api', apiPath(target, '/reviews'), '--paginate']);
  if (!list.ok) return { error: `could not list PR reviews: ${list.error}`, kind: 'gh-failed', ok: false };
  let pending: PendingState;
  try {
    pending = classifyPending(parseReviewSummaries(list.text));
  } catch (e) {
    return { error: `could not parse the PR review list: ${(e as Error).message}`, kind: 'unreadable', ok: false };
  }
  if (pending.kind === 'foreign') {
    return { error: FOREIGN_PENDING(target), kind: 'foreign-pending', ok: false };
  }

  // 3. IDEMPOTENCY — replace OUR prior pending review so a re-run updates in place. Deleting is
  //    safe by construction: a pending review is unsubmitted, invisible to the author, and this one
  //    carries our marker, so it is content we wrote on a previous run of this same command.
  //
  //    The replace CANNOT be atomic: GitHub allows one pending review per user per PR, so the old
  //    one must go before the new one can exist. If the CREATE below then fails, the prior staged
  //    review is gone and nothing replaced it — the failure names that explicitly, because the fix
  //    is simply to re-run (the content is regenerated deterministically from the same records).
  let replaced = false;
  if (pending.kind === 'ours') {
    const del = run(['api', '--method', 'DELETE', apiPath(target, `/reviews/${pending.id}`)]);
    if (!del.ok) {
      return { error: `could not replace the prior ensemble-ai pending review: ${del.error}`, kind: 'gh-failed', ok: false };
    }
    replaced = true;
    log(`· replaced the prior ensemble-ai pending review (#${pending.id}) — updating in place`);
  }

  // 4. CREATE — `event` omitted ⇒ PENDING.
  const created = run(
    ['api', '--method', 'POST', apiPath(target, '/reviews'), '--input', '-'],
    JSON.stringify(payload)
  );
  if (!created.ok) {
    return {
      error:
        `could not create the pending review: ${created.error}` +
        (replaced
          ? '. Your prior ensemble-ai pending review was already removed to make room for it (GitHub ' +
            'allows one pending review per user per PR, so a replacement cannot be atomic) — re-run to ' +
            'regenerate it. Nothing was submitted, and the author saw neither review.'
          : ''),
      kind: 'gh-failed',
      ok: false,
    };
  }
  let url: string | null = null;
  try {
    const obj = parseJson(created.text) as { html_url?: unknown };
    if (typeof obj.html_url === 'string') url = obj.html_url;
  } catch {
    /* the review was created; a URL we cannot parse is cosmetic */
  }
  return { ok: true, replaced, url };
}
