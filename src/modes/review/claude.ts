import { resolveClaudeBin } from '../brainstorm/claude';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';
import { runReviewerExec } from '../../core/spawn';
import { type RunReviewOpts, REVIEW_TIMEOUT_MS } from '../../reviewers/codex';

// The COLD headless `claude -p` used as a review VOICE (a peer reviewer) and as the
// SYNTHESIZER. It reuses the SAME group-aware, watchdog'd spawn primitive the codex/grok
// reviewers use (claude forks node subprocesses, so the group-kill is mandatory) in
// STDOUT-capture mode (claude prints its reply to stdout — no `-o` file, like grok).
//
// Read-only posture — BEST-EFFORT, NOT OS-enforced (unlike codex `-s read-only` or grok's
// kernel sandbox). The review spawn asks the CLI to stay read-only via `--permission-mode
// plan` (a plan-only session that does not apply edits) + an explicit `--disallowedTools`
// deny of every write tool (Write/Edit/MultiEdit/NotebookEdit). A determined prompt-
// injection could still, in principle, coax a read/exec the deny-list didn't name — so this
// is a defense-in-depth belt, documented as best-effort. It is ACCEPTED BY DESIGN: the user
// runs ensemble-ai on their OWN diffs, and this matches the dashboard's own full-tool worker
// posture. (The spawn's cwd is a throwaway tmpdir — see runReviewerExec — so even a read
// tool has nothing of the repo to reach; the diff under review is embedded in the prompt.)

// Claude's `--effort` accepts these levels; anything else ('default' sentinel included)
// means "leave it to the CLI default", so the flag is omitted rather than passed invalid.
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// The write tools denied for a review/synthesis voice. Encoded as data so a unit test
// pins the exact deny-list (a silent drop here is the difference between best-effort and
// no protection).
export const CLAUDE_REVIEW_DENIED_TOOLS = [
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
] as const;

// PURE: the claude CLI args for a review/synthesis voice. `-p <prompt>` (headless,
// single-shot, reply to STDOUT) + `--output-format text` (a plain reply; we parse the
// embedded ```json block ourselves, exactly like codex/grok — symmetry IS robustness) +
// the best-effort read-only belt (`--permission-mode plan` + a write-tool deny-list).
// Honors the voice config's model/effort so a CONFIGURED Claude model actually runs.
// Encoded as DATA so a unit test pins it.
export function buildClaudeReviewArgs(
  prompt: string,
  config?: VoiceConfig
): string[] {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'text',
    '--permission-mode',
    'plan',
    '--disallowedTools',
    ...CLAUDE_REVIEW_DENIED_TOOLS,
  ];
  if (config?.model && config.model !== 'default')
    args.push('--model', config.model);
  if (config && CLAUDE_EFFORTS.has(config.effort))
    args.push('--effort', config.effort);
  return args;
}

// Invoke Claude headless over the review/synthesis prompt via the shared group-kill
// watchdog spawn, in stdout-capture mode. Returns the uniform {ok, raw, stderrTail,
// timedOut} so the orchestrator treats claude like every other voice.
export function runClaudeReviewVoice(
  prompt: string,
  config: VoiceConfig,
  opts: RunReviewOpts = {}
): Promise<VoiceRunResult> {
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
  return runReviewerExec({
    args: buildClaudeReviewArgs(prompt, config),
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
