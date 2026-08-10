import { runReviewerExec } from '../../core/spawn';
import { resolveClaudeBin } from '../brainstorm/claude';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';

import {
  CLAUDE_EFFORTS,
  CLAUDE_INACTIVITY_TIMEOUT_MS,
  extractStreamResult,
  isRetryableApiStatus,
  isTransientApiErrorReply,
  isUsageLimitReply,
  TRANSIENT_FAST_FAIL_MS,
  TRANSIENT_RETRY_DELAYS_MS,
  type ReviewerExec,
} from './claude';

// THE UNFENCED EXECUTION VOICE — the one Anthropic seat class that RUNS the PR's code, shared by
// the SETTLER (settler.ts — settles gate-tagged execution-decidable findings) and the PROBER
// (probe.ts — proactively probes a PR's behaviors). It is deliberately unfenced where the review
// seats are fenced: executing the experiment IS executing the PR's code, so the read-only
// capability fence cannot apply.
//
// That is an operator decision, not an oversight (2026-08-10): this pipeline reviews the
// operator's own and his team's PRs — the same trust as checking the branch out and running
// `make test` yourself — and app-pilot set the precedent (real local rails, injected env, no
// sandbox apparatus). What remains is accident-shaped, not attacker-shaped: the seat's cwd is the
// run's DISPOSABLE worktree, each caller's prompt forbids commit/push/deployed-env access, and the
// fan-out (Agent/Task) + web tools stay denied so one exec seat is one conversation running local
// commands. Do NOT point this at PRs from strangers.

// PURE: the claude CLI args for an execution seat. Verified empirically 2026-08-10 (headless
// probe): `--permission-mode bypassPermissions` executes Bash in `-p` mode with no interactive
// prompt. Same stream-json + liveness contract as the review seats. The deny-list keeps the
// fan-out channel (Agent/Task — one exec seat is ONE conversation; a subagent multiplies
// subscription burn) and the web tools (experiments are local; research is the reviewers' job)
// off. Bash/Read/Write/Edit stay: they are the whole point. No home-read deny and no neutral cwd —
// see the operator-decision block above. `--disallowedTools` is variadic, so it goes LAST.
export function buildClaudeExecArgs(prompt: string, config?: VoiceConfig): string[] {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--strict-mcp-config',
  ];
  if (config?.model && config.model !== 'default') args.push('--model', config.model);
  if (config && CLAUDE_EFFORTS.has(config.effort)) args.push('--effort', config.effort);
  args.push('--disallowedTools', 'Agent', 'Task', 'WebFetch', 'WebSearch');
  return args;
}

// Test seams, same pattern as ClaudeVoiceSeams (claude.ts).
export interface ExecVoiceSeams {
  exec?: ReviewerExec;
  fastFailMs?: number;
  inactivityTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Invoke an execution seat headless: cwd = THE WORKTREE (deliberately — the repo's own agent
// docs, Makefiles, and compose files are the experiment tooling), stream-json for the liveness
// watchdog, and the same transient-API retry + named-failure ladder as runClaudeReviewVoice — an
// error line must never reach a downstream parser and be re-masked as "no parseable block".
// `timeoutMs` is REQUIRED: each caller owns its runaway backstop (settler 45 min, prober 90 min).
export async function runClaudeExecVoice(
  prompt: string,
  config: VoiceConfig,
  opts: { onSpawn?: (kill: () => void) => void; timeoutMs: number; worktree: string },
  seams: ExecVoiceSeams = {}
): Promise<VoiceRunResult> {
  const exec = seams.exec ?? runReviewerExec;
  const retryDelaysMs = seams.retryDelaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  const fastFailMs = seams.fastFailMs ?? TRANSIENT_FAST_FAIL_MS;
  const inactivityTimeoutMs = seams.inactivityTimeoutMs ?? CLAUDE_INACTIVITY_TIMEOUT_MS;
  const args = buildClaudeExecArgs(prompt, config);
  let retried = 0;
  for (;;) {
    const startedAt = Date.now();
    const { raw, stderrTail, timedOut, timedOutReason } = await exec({
      args,
      bin: resolveClaudeBin(),
      capture: 'stdout',
      cwd: opts.worktree,
      inactivityTimeoutMs,
      onSpawn: opts.onSpawn,
      stderrLimit: 2000,
      timeoutMs: opts.timeoutMs,
    });
    const elapsedMs = Date.now() - startedAt;
    const stream = typeof raw === 'string' ? extractStreamResult(raw) : null;
    const text = stream?.found ? stream.text : raw;
    const transient =
      !timedOut &&
      typeof raw === 'string' &&
      elapsedMs < fastFailMs &&
      (stream?.found
        ? stream.isError &&
          (isRetryableApiStatus(stream.apiErrorStatus) || isTransientApiErrorReply(stream.text ?? ''))
        : isTransientApiErrorReply(raw));
    if (transient && retried < retryDelaysMs.length) {
      await sleep(retryDelaysMs[retried]);
      retried += 1;
      continue;
    }
    if (transient) {
      const errorLine = (stream?.found ? (stream.text ?? '') : (raw ?? '')).trim();
      return {
        failWhy: `persistent transient API error after ${retried + 1} attempts`,
        ok: false,
        raw: null,
        stderrTail: errorLine.slice(0, 300),
        timedOut: false,
      };
    }
    const limitText = typeof text === 'string' && isUsageLimitReply(text) ? text.trim() : null;
    if (!timedOut && limitText) {
      return {
        failWhy: `operator usage limit reached — ${limitText.slice(0, 160)}`,
        ok: false,
        raw: null,
        stderrTail: limitText.slice(0, 300),
        timedOut: false,
      };
    }
    if (!timedOut && stream?.found && stream.isError) {
      const status = stream.apiErrorStatus;
      return {
        failWhy: `exec seat returned an error result${status ? ` (API status ${status})` : ''}`,
        ok: false,
        raw: null,
        stderrTail: (stream.text ?? '').trim().slice(0, 300) || stderrTail,
        timedOut: false,
      };
    }
    if (timedOut && timedOutReason === 'inactivity') {
      return {
        failWhy: `stalled: no stream output for ${Math.round(inactivityTimeoutMs / 60_000)} min (wedged seat reclaimed)`,
        ok: false,
        raw: null,
        stderrTail,
        timedOut: true,
      };
    }
    const retryNote = retried > 0 ? `[retried ${retried}x on transient API error] ` : '';
    const reply = text && text.trim() ? text : null;
    return {
      ok: reply !== null && !timedOut,
      raw: reply,
      stderrTail: retryNote ? `${retryNote}${stderrTail ?? ''}` : stderrTail,
      timedOut,
    };
  }
}
