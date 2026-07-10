import type { ReviewerConfig } from '../core/types';
import { runClaudeReviewVoice } from '../modes/review/claude';

import type { CodexReviewResult, RunReviewOpts } from './codex';

// The registry adapter for the Anthropic peer (spec 2026-07-09 §3's ONE Claude
// producer as a first-class registry seat). A thin shim over the SAME
// capability-fenced voice the CLI's claude layer runs (modes/review/claude.ts:
// Bash/net/write tools removed, --strict-mcp-config, neutral cwd, $HOME
// read-denied, worktree granted read-only via --add-dir, history packet honored)
// — one claude runner, no drift. VoiceConfig and ReviewerConfig are structurally
// identical and share the 'claude' id, so the config passes straight through.
//
// Same uniform result shape as codex/grok ({ok, raw, stderrTail, timedOut});
// `raw` is stdout, ready for parseFindings. No egressDenials field: this seat has
// no proxy because it has no network tools at all — the fence is capability
// removal, not an allowlist.
export function runClaudeReview(
  prompt: string,
  config: ReviewerConfig,
  opts: RunReviewOpts = {}
): Promise<CodexReviewResult> {
  return runClaudeReviewVoice(prompt, config, opts);
}
