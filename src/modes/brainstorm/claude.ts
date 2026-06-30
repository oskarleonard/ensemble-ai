import { resolveBin } from '../../core/bin';
import { runReviewerExec } from '../../core/spawn';
import {
  type CodexReviewResult,
  REVIEW_TIMEOUT_MS,
  type RunReviewOpts,
} from '../../reviewers/codex';

import type { VoiceConfig } from './types';

// The Claude (Anthropic) brainstorm voice — the third vendor beside Codex + Grok.
// Claude is a brainstorm-ONLY voice: in review it arbitrates the cross-vendor
// findings and must stay independent, but in brainstorm every voice just
// contributes ideas, so there is no independence concern.

export function resolveClaudeBin(): string {
  return resolveBin('claude', { envVar: 'CLAUDE_BIN' });
}

// PURE: the claude CLI args for a brainstorm voice. `-p <prompt>` (headless,
// single-shot, prints the reply to STDOUT) + `--output-format text` (a plain reply;
// we parse the embedded ```json block out of it ourselves, exactly like the codex /
// grok voices — symmetry IS robustness). Ideation needs no tools; the shared
// watchdog bounds a hang regardless. Encoded as DATA so a unit test pins it.
export function buildClaudeVoiceArgs(prompt: string): string[] {
  return ['-p', prompt, '--output-format', 'text'];
}

// Invoke Claude headless with the brainstorm prompt over the SAME group-aware
// watchdog spawn primitive the reviewers use (claude can fork subprocesses, so the
// group-kill is mandatory), in STDOUT-capture mode (claude prints its reply to
// stdout, no -o file — like grok). Returns the uniform {ok, raw, stderrTail,
// timedOut} so the orchestrator treats every voice identically. `_config` is unused
// today (claude -p takes no model/effort flag here) but kept for adapter symmetry.
export function runClaudeVoice(
  prompt: string,
  _config: VoiceConfig,
  opts: RunReviewOpts = {}
): Promise<CodexReviewResult> {
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
  return runReviewerExec({
    args: buildClaudeVoiceArgs(prompt),
    bin: resolveClaudeBin(),
    capture: 'stdout',
    onSpawn: opts.onSpawn,
    stderrLimit: 2000,
    timeoutMs,
  }).then(({ raw, stderrTail, timedOut }) => ({
    ok: raw !== null && !timedOut,
    raw,
    stderrTail,
    timedOut,
  }));
}
