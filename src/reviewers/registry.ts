import type { ReviewerConfig, ReviewerId } from '../core/types';

import { type CodexReviewResult, type RunReviewOpts, runCodexReview } from './codex';
import { runGrokReview } from './grok';

// The per-reviewer invocation adapters, keyed by id. EXHAUSTIVE over ReviewerId —
// TS errors if a new reviewer joins REVIEWER_IDS without registering its adapter
// here, so a reviewer can never silently fall back to the wrong vendor. Both
// adapters return the uniform {ok, raw, stderrTail, timedOut} where `raw` is ready
// for parseFindings (codex: the -o file; grok: the `.text` of its JSON envelope).
// A third reviewer = one more entry here + its own thin adapter.
export const REVIEW_ADAPTERS: Record<
  ReviewerId,
  (
    prompt: string,
    config: ReviewerConfig,
    opts?: RunReviewOpts
  ) => Promise<CodexReviewResult>
> = {
  codex: runCodexReview,
  grok: runGrokReview,
};
