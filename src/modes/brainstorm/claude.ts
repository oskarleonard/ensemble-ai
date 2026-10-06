import { resolveBin } from '../../core/bin';
import { runReviewerExec } from '../../core/spawn';
import { ADVISOR_OFF, parseSeatAdvisor } from '../../core/types';
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

// PURE: the advisor half of EVERY `claude` invocation this engine builds (review seat,
// brainstorm/consult voice, execution seat) — one owner, so the three can never spell it
// differently. Absent → no flag (the seat inherits the operator's settings). A model id →
// `--settings {"advisorModel":"<id>"}`. "off" → no flag either: no `--settings` value disables
// the advisor (measured 2026-10-04 — see core/types), so "off" is the env kill switch
// claudeAdvisorEnv returns. Built with JSON.stringify, never concatenation. This is the SPAWN
// BACKSTOP: the CLI already refused an invalid value at its up-front seat resolution, but a
// programmatic consumer (e.g. a dashboard setting ReviewerConfig.advisor) hands a runner a config
// no resolver saw — so the value goes through parseSeatAdvisor again, and an invalid one THROWS
// here rather than reaching the CLI.
export function claudeAdvisorArgs(config?: { advisor?: unknown; id: string }): string[] {
  const advisor = parseSeatAdvisor(config?.advisor, config?.id ?? 'claude');
  if (advisor === undefined || advisor === ADVISOR_OFF) return [];
  return ['--settings', JSON.stringify({ advisorModel: advisor })];
}

// PURE: the env half of the advisor, merged over the parent env at every `claude` spawn. "off" →
// CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1, the CLI's own kill switch and the one per-run off that holds
// on any base model, whatever the operator's advisorModel (measured 2026-10-04). A model id or
// absent → {}. Same parseSeatAdvisor backstop as claudeAdvisorArgs: an invalid value THROWS.
export function claudeAdvisorEnv(config?: { advisor?: unknown; id: string }): Record<string, string> {
  const advisor = parseSeatAdvisor(config?.advisor, config?.id ?? 'claude');
  return advisor === ADVISOR_OFF ? { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' } : {};
}

// Claude's `--effort` accepts these levels; the 'default' sentinel (or anything
// else) means "leave it to the CLI default", so the flag is omitted rather than
// passed as an invalid value.
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// PURE: the claude CLI args for a brainstorm voice. `-p <prompt>` (headless,
// single-shot, prints the reply to STDOUT) + `--output-format text` (a plain reply;
// we parse the embedded ```json block out of it ourselves, exactly like the codex /
// grok voices — symmetry IS robustness). `--tools ""` DISABLES every tool: ideation
// needs none, and a tool-less voice is provably READ-ONLY — it cannot read, write, or
// execute anything even if the topic or file context tries to prompt-inject it, giving
// Claude the same read-only guarantee codex (`-s read-only`) and grok (OS sandbox)
// carry. Honors the voice config's model/effort/advisor so a CONFIGURED Claude model
// actually runs (not merely printed in progress). Encoded as DATA so a unit test pins it.
// The web research tool set and its turn cap (`web: true` on the voice). `--tools` makes the two
// tools AVAILABLE and `--allowedTools` PRE-APPROVES them: a headless `-p` spawn silently denies a
// permission-gated tool (measured 2026-10-06 — with `--tools` alone the voice reported "the
// WebFetch permission was denied"). `--max-turns` bounds the research loop so a voice cannot
// browse for an hour on a vendor window. WebSearch runs vendor-side; WebFetch is the local CLI
// fetching an arbitrary URL — the exfiltration channel the review fence exists to close — which
// is why this stays a per-voice opt-in and the review reviewer never gets it.
export const CLAUDE_WEB_TOOLS = 'WebSearch,WebFetch';
export const CLAUDE_WEB_MAX_TURNS = 25;

export function buildClaudeVoiceArgs(prompt: string, config?: VoiceConfig): string[] {
  const args = ['-p', prompt, '--output-format', 'text'];
  if (config?.web === true)
    args.push('--tools', CLAUDE_WEB_TOOLS, '--allowedTools', CLAUDE_WEB_TOOLS, '--max-turns', String(CLAUDE_WEB_MAX_TURNS));
  else args.push('--tools', '');
  if (config?.model && config.model !== 'default') args.push('--model', config.model);
  if (config && CLAUDE_EFFORTS.has(config.effort)) args.push('--effort', config.effort);
  args.push(...claudeAdvisorArgs(config));
  return args;
}

// Invoke Claude headless with the brainstorm prompt over the SAME group-aware
// watchdog spawn primitive the reviewers use (claude can fork subprocesses, so the
// group-kill is mandatory), in STDOUT-capture mode (claude prints its reply to
// stdout, no -o file — like grok). Returns the uniform {ok, raw, stderrTail,
// timedOut} so the orchestrator treats every voice identically. Passes `config`
// through so the roster's model/effort override is applied (see buildClaudeVoiceArgs),
// and its advisor "off" reaches the child's env (claudeAdvisorEnv).
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
    env: claudeAdvisorEnv(config),
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
