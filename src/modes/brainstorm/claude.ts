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

// Claude's `--effort` accepts these levels; the 'default' sentinel (or anything
// else) means "leave it to the CLI default", so the flag is omitted rather than
// passed as an invalid value.
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// The layered READ-ONLY policy every headless Claude voice (brainstorm + consult
// ideation/synthesis) runs under. It is report-only — it must never touch the tree.
// This is REAL enforcement, not a claim:
//   `--tools ""`          — the hard constraint: DISABLES every built-in tool, so there
//                           is literally no Edit/Write/Bash/NotebookEdit to invoke even
//                           if a crafted diff or topic tries to prompt-inject one
//                           (verified: with `--tools ""` a "write this file" prompt
//                           produces no file — the tool does not exist to call).
//   `--disallowed-tools`  — belt-and-suspenders: an explicit deny of the mutating tools,
//                           so the read-only intent survives even if a future edit widens
//                           `--tools`.
//   `--permission-mode default` — never `bypassPermissions`/`--dangerously-skip-…`, so no
//                           ambient config can silently grant a tool back.
// This gives Claude the same read-only guarantee codex (`-s read-only`) and grok (OS
// sandbox) carry. Encoded as DATA so a unit test pins it.
const CLAUDE_READONLY_ARGS = [
  '--tools',
  '',
  '--disallowed-tools',
  'Bash',
  'Edit',
  'Write',
  'NotebookEdit',
  '--permission-mode',
  'default',
];

// PURE: the claude CLI args for a headless voice. `-p <prompt>` (headless, single-shot,
// prints the reply to STDOUT) + `--output-format text` (a plain reply; we parse the
// embedded ```json block out of it ourselves, exactly like the codex / grok voices —
// symmetry IS robustness) + the layered read-only policy above. Honors the voice
// config's model/effort so a CONFIGURED Claude model actually runs (not merely printed
// in progress). Encoded as DATA so a unit test pins it.
export function buildClaudeVoiceArgs(prompt: string, config?: VoiceConfig): string[] {
  const args = ['-p', prompt, '--output-format', 'text', ...CLAUDE_READONLY_ARGS];
  if (config?.model && config.model !== 'default') args.push('--model', config.model);
  if (config && CLAUDE_EFFORTS.has(config.effort)) args.push('--effort', config.effort);
  return args;
}

// Invoke Claude headless with the brainstorm prompt over the SAME group-aware
// watchdog spawn primitive the reviewers use (claude can fork subprocesses, so the
// group-kill is mandatory), in STDOUT-capture mode (claude prints its reply to
// stdout, no -o file — like grok). Returns the uniform {ok, raw, stderrTail,
// timedOut} so the orchestrator treats every voice identically. Passes `config`
// through so the roster's model/effort override is applied (see buildClaudeVoiceArgs).
export function runClaudeVoice(
  prompt: string,
  config: VoiceConfig,
  opts: RunReviewOpts = {}
): Promise<CodexReviewResult> {
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
  return runReviewerExec({
    args: buildClaudeVoiceArgs(prompt, config),
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
