import {
  CLAUDE_EFFORTS,
  CLAUDE_INACTIVITY_TIMEOUT_MS,
  extractStreamResult,
  isRetryableApiStatus,
  isTransientApiErrorReply,
  isUsageLimitReply,
  streamActivityTail,
  TRANSIENT_FAST_FAIL_MS,
  TRANSIENT_RETRY_DELAYS_MS,
  USAGE_LIMIT_FAIL_PREFIX,
} from '../../core/claude-stream';
import fs from 'node:fs';
import os from 'node:os';

import { isUnder, makeOwnerOnlyTempDir } from '../../core/artifacts';
import { resolveBin } from '../../core/bin';
import { CLAUDE_REVIEW_DENIED_TOOLS, homeReadDenyRules } from '../../core/claude-fence';
import { runReviewerExec } from '../../core/spawn';
import { ADVISOR_OFF, parseSeatAdvisor } from '../../core/types';
import {
  type CodexReviewResult,
  REVIEW_TIMEOUT_MS,
  type RunReviewOpts,
} from '../../reviewers/codex';

import type { VoiceConfig } from './types';

// The Claude VOICE for brainstorm / consult — a headless `claude -p` over the round's prompt.
// Not a review seat: it reads no worktree, so it needs no capability fence; the only tools it
// may hold are the web pair (`web: true`), pre-approved for the headless spawn.
//
// LIVENESS (2026-10-09). The voice used to run `--output-format text`, which prints nothing
// until the reply is complete — so the spawn layer had no signal that the seat was alive, and
// a single ABSOLUTE timeout was the only thing that could end it. Run 2026-10-08-19-32-31
// (hugin) lost both opus@max seats that way: 14 and 13 minutes into honest web research,
// killed by a 900 s cap, with "timed out" as the whole explanation. The voice now runs the
// SAME stream contract as every other headless Anthropic seat (core/claude-stream.ts):
// `--output-format stream-json --verbose` emits one event per line while the seat works, the
// INACTIVITY watchdog reclaims a seat only after CLAUDE_INACTIVITY_TIMEOUT_MS of total silence,
// and the absolute `timeoutMs` is a runaway backstop the caller sizes in hours — a seat that is
// working is never the thing the cap kills. Every failure is NAMED (failWhy) and carries which
// watchdog fired (timedOutReason) plus what the seat was doing last (stream tail).

export function resolveClaudeBin(): string {
  return resolveBin('claude', { envVar: 'CLAUDE_BIN' });
}

export function claudeAdvisorArgs(config?: { advisor?: unknown; id: string }): string[] {
  const advisor = parseSeatAdvisor(config?.advisor, config?.id ?? 'claude');
  if (advisor === undefined || advisor === ADVISOR_OFF) return [];
  return ['--settings', JSON.stringify({ advisorModel: advisor })];
}

export function claudeAdvisorEnv(config?: { advisor?: unknown; id: string }): Record<string, string> {
  const advisor = parseSeatAdvisor(config?.advisor, config?.id ?? 'claude');
  return advisor === ADVISOR_OFF ? { CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' } : {};
}

export const CLAUDE_WEB_TOOLS = 'WebSearch,WebFetch';
export const CLAUDE_WEB_MAX_TURNS = 25;
// Behind an evidence root the voice READS (Read/Grep/Glob are turns), so the cap is wider.
export const CLAUDE_EVIDENCE_MAX_TURNS = 60;

export interface ClaudeVoiceFence {
  // Injectable for tests. Defaults to the real home directory.
  homeDir?: string;
  // The one directory the voice may read: the evidence root, granted via `--add-dir`.
  evidenceRoot?: string;
}

// PURE: the claude CLI args for a voice that reads an EVIDENCE ROOT (hugin spec doc-review-evidence
// §3) — the review seat's capability fence (modes/review/claude.ts, every clause a probe result)
// with ONE difference: `WebSearch` stays when the voice has `web` (vendor-side search is a named
// residual channel; `WebFetch` — a local fetch of an arbitrary URL, the exfiltration channel — is
// denied like every other write/exec/egress tool). Neutral cwd + `--add-dir <root>` so a planted
// CLAUDE.md in the root is never loaded as instructions; `--strict-mcp-config` loads zero MCP
// servers (the work profile's connectors stay out); the home-read deny keeps vendor auth and every
// other repo out of the voice's reach. THROWS when the root lives inside the home directory.
// `--disallowedTools` is variadic, so it goes LAST; `--add-dir` is variadic too, so it is followed
// immediately by `--strict-mcp-config`.
export function buildClaudeEvidenceArgs(prompt: string, config: VoiceConfig | undefined, fence: ClaudeVoiceFence): string[] {
  const root = fence.evidenceRoot;
  if (!root) throw new Error('buildClaudeEvidenceArgs: an evidence root is required');
  const home = fence.homeDir ?? os.homedir();
  if (root === home || isUnder(root, home))
    throw new Error(
      `refusing to fence a claude voice whose evidence root (${root}) is inside the home directory — the home-read deny would also deny the root. Seal the evidence outside $HOME.`
    );
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan'];
  if (config?.web === true) args.push('--allowedTools', 'WebSearch');
  args.push('--max-turns', String(CLAUDE_EVIDENCE_MAX_TURNS));
  if (config?.model && config.model !== 'default') args.push('--model', config.model);
  if (config && CLAUDE_EFFORTS.has(config.effort)) args.push('--effort', config.effort);
  args.push(...claudeAdvisorArgs(config));
  args.push('--add-dir', root, '--strict-mcp-config');
  const denied = CLAUDE_REVIEW_DENIED_TOOLS.filter((t) => !(config?.web === true && t === 'WebSearch'));
  args.push('--disallowedTools', ...denied, ...homeReadDenyRules(home));
  return args;
}

// PURE: the claude CLI args for the voice. `-p <prompt>` (headless, single-shot) +
// `--output-format stream-json --verbose` (the liveness signal — see the header). With `web`
// the two web tools are the ONLY tools and are pre-approved (`--allowedTools` is load-bearing: a
// `-p` spawn silently denies a permission-gated tool) under a turn cap; without it `--tools ''`
// keeps the voice provably tool-less. Honors the config's model / effort / advisor.
export function buildClaudeVoiceArgs(prompt: string, config?: VoiceConfig): string[] {
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (config?.web === true)
    args.push('--tools', CLAUDE_WEB_TOOLS, '--allowedTools', CLAUDE_WEB_TOOLS, '--max-turns', String(CLAUDE_WEB_MAX_TURNS));
  else args.push('--tools', '');
  if (config?.model && config.model !== 'default') args.push('--model', config.model);
  if (config && CLAUDE_EFFORTS.has(config.effort)) args.push('--effort', config.effort);
  args.push(...claudeAdvisorArgs(config));
  return args;
}

// Test seams: the exec primitive, the binary, the waits and the liveness bar. Production
// callers pass nothing.
export interface BrainstormClaudeSeams {
  bin?: string;
  exec?: typeof runReviewerExec;
  fastFailMs?: number;
  inactivityTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runClaudeVoice(
  prompt: string,
  config: VoiceConfig,
  opts: RunReviewOpts = {},
  seams: BrainstormClaudeSeams = {}
): Promise<CodexReviewResult> {
  const exec = seams.exec ?? runReviewerExec;
  const retryDelaysMs = seams.retryDelaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  const fastFailMs = seams.fastFailMs ?? TRANSIENT_FAST_FAIL_MS;
  const inactivityTimeoutMs = seams.inactivityTimeoutMs ?? CLAUDE_INACTIVITY_TIMEOUT_MS;
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
  // Behind an evidence root: the fenced argv (built BEFORE the neutral cwd exists, so an
  // unfenceable root throws without leaking a dir) and a neutral, owner-only, EMPTY cwd the voice
  // never owns — reaped here. Without one: the tool-less / web-only voice in a throwaway cwd.
  const args = opts.evidenceRoot ? buildClaudeEvidenceArgs(prompt, config, { evidenceRoot: opts.evidenceRoot }) : buildClaudeVoiceArgs(prompt, config);
  const neutralCwd = opts.evidenceRoot ? makeOwnerOnlyTempDir('ensemble-voice-cwd-') : undefined;
  const env = claudeAdvisorEnv(config);
  let retried = 0;
  try {
  for (;;) {
    const startedAt = Date.now();
    const { raw, stderrTail, timedOut, timedOutReason } = await exec({
      args,
      bin: seams.bin ?? resolveClaudeBin(),
      capture: 'stdout',
      ...(neutralCwd ? { cwd: neutralCwd } : {}),
      env,
      inactivityTimeoutMs,
      onSpawn: opts.onSpawn,
      stderrLimit: 2000,
      timeoutMs,
    });
    const elapsedMs = Date.now() - startedAt;
    const stream = typeof raw === 'string' ? extractStreamResult(raw) : null;
    // The reply is the result event's text; a stream that never completed (killed) or a reply
    // that was not stream-json at all falls back to the raw stdout, as before.
    const text = stream?.found ? stream.text : raw;
    const activity = streamActivityTail(raw);
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
        failWhy: `${USAGE_LIMIT_FAIL_PREFIX} — ${limitText.slice(0, 160)}`,
        ok: false,
        raw: null,
        stderrTail: limitText.slice(0, 300),
        timedOut: false,
      };
    }
    if (!timedOut && stream?.found && stream.isError) {
      const status = stream.apiErrorStatus;
      return {
        failWhy: `the voice returned an error result${status ? ` (API status ${status})` : ''}`,
        ok: false,
        raw: null,
        stderrTail: (stream.text ?? '').trim().slice(0, 300) || stderrTail,
        timedOut: false,
      };
    }
    if (timedOut) {
      const bar = timedOutReason === 'inactivity' ? inactivityTimeoutMs : timeoutMs;
      const span = bar >= 60_000 ? `${Math.round(bar / 60_000)} min` : `${Math.round(bar / 1000)} s`;
      const failWhy =
        timedOutReason === 'inactivity'
          ? `stalled: no stream output for ${span} (wedged seat reclaimed)`
          : `still working when the ${span} backstop cut it — give it budget`;
      return {
        failWhy,
        ok: false,
        raw: null,
        stderrTail,
        ...(activity ? { stream: activity } : {}),
        timedOut: true,
        ...(timedOutReason ? { timedOutReason } : {}),
      };
    }
    const retryNote = retried > 0 ? `[retried ${retried}x on transient API error] ` : '';
    const reply = text && text.trim() ? text : null;
    return {
      ok: reply !== null,
      raw: reply,
      stderrTail: retryNote ? `${retryNote}${stderrTail ?? ''}` : stderrTail,
      ...(reply === null && activity ? { stream: activity } : {}),
      timedOut: false,
    };
  }
  } finally {
    if (neutralCwd) fs.rmSync(neutralCwd, { force: true, recursive: true });
  }
}
