// THE FIX-TAIL PUSH FENCE (spec §9, gate-r3 grok-f3 residue).
//
// One pipeline, two tails. The STAGE tail posts a pending review and never pushes; the FIX tail
// (`/ensemble-ai-review-fix`) fixes findings in the session and pushes to the PR's head ref. The
// stage tail may legitimately run on contributor PRs to repos Oskar HAS write access to
// (app-pilot, ensemble-ai) — so the two tails now meet on the same PRs, and the fix tail must
// refuse to push to a head ref the user does not own.
//
// IT IS A FENCE, NOT A DISPATCHER. Which tail runs is decided by which command the consumer
// invokes (`review --stage` vs the fix skill) — never by an engine predicate over the PR. This
// module only answers: "may the fix tail push here?" It never routes, never falls back to staging,
// and never pushes anything itself.
//
// Fails CLOSED: an unreadable field, a deleted fork, or a missing permission all REFUSE.

export interface PrPushContext {
  // The PR's head branch name (informational — named in the refusal so it is actionable).
  headRefName: string;
  // The head repo's owner login, or null when the fork was deleted.
  headRepoOwner: string | null;
  // GitHub's own answer to "is the head on a different repo than the base?" (a fork PR).
  isCrossRepository: boolean;
  // Does the authenticated user have push access to the BASE repo? For a same-repo PR the head
  // lives there too, so this is exactly "can I push to the head ref?".
  viewerCanPushBase: boolean;
}

export type PushFenceVerdict = { allowed: false; reason: string } | { allowed: true };

// PURE. `prSlug` is only used to make the refusal legible.
export function evaluatePushFence(ctx: PrPushContext, prSlug: string): PushFenceVerdict {
  if (ctx.isCrossRepository || !ctx.headRepoOwner) {
    const where = ctx.headRepoOwner
      ? `${ctx.headRepoOwner}'s fork (branch \`${ctx.headRefName}\`)`
      : 'a deleted fork';
    return {
      allowed: false,
      reason:
        `REFUSED — the head of ${prSlug} lives on ${where}, not on the base repo. The fix tail ` +
        `never pushes to a branch you do not own. Use \`ensemble-ai review --pr <url> --stage\` to ` +
        `stage a pending review instead. (GitHub's "allow edits by maintainers" can make such a push ` +
        `technically possible; this fence deliberately does not rely on it — rewriting a contributor's ` +
        `branch is not a review action.)`,
    };
  }
  if (!ctx.viewerCanPushBase) {
    return {
      allowed: false,
      reason:
        `REFUSED — you do not have push access to ${prSlug}, so the fix tail cannot push its fixes. ` +
        `Use \`ensemble-ai review --pr <url> --stage\` to stage a pending review instead.`,
    };
  }
  return { allowed: true };
}

// Parse `gh pr view --json headRefName,headRepositoryOwner,isCrossRepository` + the base repo's
// `permissions.push`. A missing/oddly-shaped field yields the fail-closed value (no owner, cross
// repo, no push), never an optimistic default.
export function parsePushContext(prJson: unknown, viewerCanPushBase: unknown): PrPushContext {
  const o = (prJson && typeof prJson === 'object' ? prJson : {}) as Record<string, unknown>;
  const owner = o.headRepositoryOwner;
  const login =
    owner && typeof owner === 'object' && typeof (owner as Record<string, unknown>).login === 'string'
      ? ((owner as Record<string, unknown>).login as string)
      : null;
  return {
    headRefName: typeof o.headRefName === 'string' ? o.headRefName : '(unknown)',
    headRepoOwner: login,
    isCrossRepository: o.isCrossRepository !== false, // anything but an explicit `false` fails closed
    viewerCanPushBase: viewerCanPushBase === true,
  };
}
