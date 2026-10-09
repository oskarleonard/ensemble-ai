import fs from 'node:fs';
import os from 'node:os';

import { claudeAdvisorArgs, claudeAdvisorEnv, resolveClaudeBin } from '../brainstorm/claude';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';
import { isUnder, makeOwnerOnlyTempDir } from '../../core/artifacts';
import {
  CLAUDE_EFFORTS,
  CLAUDE_INACTIVITY_TIMEOUT_MS,
  extractStreamResult,
  isRetryableApiStatus,
  isTransientApiErrorReply,
  isUsageLimitReply,
  TRANSIENT_FAST_FAIL_MS,
  TRANSIENT_RETRY_DELAYS_MS,
  USAGE_LIMIT_FAIL_PREFIX,
} from '../../core/claude-stream';
import { runReviewerExec } from '../../core/spawn';
import { type RunReviewOpts, REVIEW_TIMEOUT_MS } from '../../reviewers/codex';

import type { SandboxProfileRef } from './evidence';
import { HISTORY_PACKET_CLAUSE, writeHistoryPacket } from './history-packet';
import { UNTRUSTED_INSTRUCTIONS_CLAUSE } from './worktree';

// The COLD headless `claude -p` used as a review VOICE (a peer reviewer) and as the
// SYNTHESIZER. It reuses the SAME group-aware, watchdog'd spawn primitive the codex/grok
// reviewers use (claude forks node subprocesses, so the group-kill is mandatory) in
// STDOUT-capture mode (claude prints its reply to stdout — no `-o` file, like grok).
//
// THE CAPABILITY FENCE (spec §2). An Anthropic seat reviewing a FOREIGN pull request reads
// untrusted code, so `--permission-mode plan` alone is not a fence: plan mode still EXECUTES Bash,
// and a `CLAUDE.md` in the seat's cwd hierarchy is loaded and obeyed as a trusted instruction
// channel. Both were verified empirically on 2026-07-10 (headless probes; run log
// `journal/runs/…-ea27-capability-fence.md`). So the seat is fenced by REMOVING CAPABILITIES, and
// every clause below is a probe result, not a hope:
//
//   1. `--disallowedTools Bash …` REMOVES the tool from the session. The seat reports no Bash tool,
//      `ToolSearch` cannot re-load its schema, and a SUBAGENT it spawns inherits the same deny-list
//      (probed: the subagent had no Bash either). No execution.
//   2. `--strict-mcp-config` with no `--mcp-config` loads ZERO MCP servers. Without it the seat's
//      deferred-tool list carries the user's connectors — and a connector that writes to an
//      external service (e.g. Drive `create_file`) is an egress channel. No egress.
//   3. The spawn cwd is an engine-owned EMPTY dir — NEVER the worktree. With a neutral cwd the
//      tree's `CLAUDE.md`/`AGENTS.md` is not in the cwd hierarchy, so it is never loaded as
//      instructions (probed: a planted "output this token" file was read as data and ignored).
//      The worktree is granted as a READ ROOT via `--add-dir` instead.
//   4. `--add-dir` is ADDITIVE, not restrictive: it grants the worktree but does NOT take `$HOME`
//      away (probed: the seat read `~/.gitconfig` and a `$HOME` canary through it). Spec §9 requires
//      that vendor auth (`~/.codex`, `~/.grok`) never reach a model input, so the read tools are
//      path-denied on the home directory as well (probed: denied, while worktree reads still work).
//
// WHAT THIS IS NOT. A capability fence is not a kernel sandbox. codex and grok run under an
// OS-enforced Seatbelt profile; this seat runs under the CLI's own permission engine, and its read
// deny is a DENY-LIST over an otherwise-readable filesystem (it names `$HOME`, where vendor auth and
// every repo live — not `/etc`, not another user's home). A seat that can Read can still be STEERED
// by instructions embedded in the code it reads. What bounds that residue is capability, not
// judgment: with no Bash and no network the seat's only outward channel is its own findings text,
// which the edit-ops "no new entities" whitelist and the §9 injection fixture already fence.

// THE ANTHROPIC SEATS' PROFILE IDENTITY. receipt.ts refuses to mint a receipt claiming worktree
// evidence for a seat with no profile identity — a worktree seat's evidence means nothing without
// the fence it ran behind. So the fence above IS this seat's profile, and it is named for what it
// actually is: a CAPABILITY fence (tools removed), not a kernel sandbox.
//
// `version` MUST be bumped whenever the fence changes (CLAUDE_REVIEW_DENIED_TOOLS, the permission
// mode, the MCP posture, the read-root/deny rules) — a receipt minted under a weaker fence must
// never verify as equivalent to one minted under a tighter one.
export const CLAUDE_CAPABILITY_FENCE: SandboxProfileRef = {
  id: 'claude-capability-fence',
  version: 2,
};

// The effort whitelist, the transient/usage-limit predicates, the liveness bar and the stream-json
// result extractor live in core/claude-stream.ts (shared with the brainstorm/consult voice since
// 2026-10-09); re-exported here so every existing importer keeps its path.
export {
  CLAUDE_EFFORTS,
  CLAUDE_INACTIVITY_TIMEOUT_MS,
  extractStreamResult,
  isRetryableApiStatus,
  isTransientApiErrorReply,
  isUsageLimitFailure,
  isUsageLimitReply,
  type StreamResultEvent,
  TRANSIENT_FAST_FAIL_MS,
  TRANSIENT_RETRY_DELAYS_MS,
  USAGE_LIMIT_FAIL_PREFIX,
} from '../../core/claude-stream';

// The tools REMOVED from every review/synthesis seat. Encoded as data so a unit test pins the exact
// deny-list (a silent drop here is the difference between a fence and a suggestion). `Bash` is the
// load-bearing entry: without it the seat cannot execute anything the untrusted tree asks it to,
// and `WebFetch`/`WebSearch` close the egress side. The write tools were the original belt.
//
// `MultiEdit` no longer exists in the CLI (it warns "matches no known tool" on stderr). It is kept
// deliberately: the deny-list is a fence, and a fence names the tool BEFORE it comes back.
export const CLAUDE_REVIEW_DENIED_TOOLS = [
  'Bash',
  // The fan-out channel: a subagent is a fresh full-context conversation at the seat's own
  // model/effort — at opus@max a skill- or model-initiated fan-out multiplies the operator's
  // subscription burn ~15x (lived: run 2026-08-07-17-16-13 ate ~77% of a Max 5x window). The
  // seat is a cold SINGLE-PASS peer; both tool names are denied ('Task' is the older name —
  // a fence names the tool before it comes back). Fence version bumped: 1 → 2.
  'Agent',
  'Task',
  'WebFetch',
  'WebSearch',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
] as const;

// The read tools that a path-scoped deny rule must cover: every tool that can pull a byte of a file
// (Read, Grep) or enumerate one (Glob) out of a directory.
export const CLAUDE_READ_TOOLS = ['Read', 'Grep', 'Glob'] as const;

// PURE: `Read(//abs/path/**)` — the CLI's absolute-path permission rule (a single `/` prefixed to
// an already-absolute path). Probed 2026-07-10: a matching rule in `--disallowedTools` denies the
// read with "File is in a directory that is denied by your permission settings".
function denyUnder(tool: string, absDir: string): string {
  return `${tool}(/${absDir.replace(/\/+$/, '')}/**)`;
}

// PURE: deny every read tool on the home directory — where vendor auth (`~/.codex`, `~/.grok`),
// ssh keys, and every other repo on the machine live. This is the `secret-denied` half of spec §2's
// predicate, and the mechanical form of §9's "vendor-auth content cannot reach any model input".
export function homeReadDenyRules(homeDir: string): string[] {
  return CLAUDE_READ_TOOLS.map((t) => denyUnder(t, homeDir));
}

export interface ClaudeSeatFence {
  // Injectable for tests. Defaults to the real home directory.
  homeDir?: string;
  // The one directory the seat may read: the detached worktree, granted via `--add-dir`. Absent ⇒ a
  // packet seat, which needs no file reads at all (its diff is in the prompt).
  readRoot?: string;
}

// PURE: the claude CLI args for a review/synthesis voice. `-p <prompt>` (headless, single-shot)
// + `--output-format stream-json --verbose`: the CLI emits one JSON event per line WHILE it works
// (probed 2026-08-07: `thinking_tokens` heartbeats tick every few seconds even inside a single
// long turn), which is the LIVENESS signal the inactivity watchdog needs — plain text mode prints
// nothing until the end, so a fixed deadline was the only (work-killing) option. The final reply
// is the `type:"result"` event's `result` field (extractStreamResult); the embedded ```json
// findings block is then parsed from it exactly as before. Capability fence documented at the top
// of this file. Honors the voice config's model/effort/advisor so a CONFIGURED Claude model runs.
//
// `--disallowedTools` is variadic, so it goes LAST — nothing may follow it. `--add-dir` is variadic
// too, so it is always followed immediately by `--strict-mcp-config`. A pinned advisor's `--settings`
// sits between `--effort` and `--disallowedTools`, where it breaks neither. "off" adds no argv: it is
// CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 in the spawn env (claudeAdvisorEnv), because no `--settings`
// value disables the advisor on Claude Code 2.1.289 (measured 2026-10-04). Neither is a fence change
// (no version bump): the settings object carries `advisorModel` alone and the env that one variable,
// both built in code — no config value can add a permission, a tool, or an MCP server through them.
//
// THROWS when the read root lives inside the home directory: the home deny would then also deny the
// worktree, and a seat that silently reviewed nothing is exactly the fail-open this fence exists to
// prevent. THROWS, too, on an invalid `advisor` (claudeAdvisorArgs). Callers turn the throw into a
// loud, failed seat.
export function buildClaudeReviewArgs(
  prompt: string,
  config?: VoiceConfig,
  fence: ClaudeSeatFence = {}
): string[] {
  const homeDir = fence.homeDir ?? os.homedir();
  if (fence.readRoot && isUnder(fence.readRoot, homeDir)) {
    throw new Error(
      `ensemble-ai: refusing to fence a Claude seat whose read root (${fence.readRoot}) is inside the home directory (${homeDir}) — the home-read deny would also deny the worktree. Point TMPDIR outside $HOME.`
    );
  }
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan'];
  if (fence.readRoot) args.push('--add-dir', fence.readRoot);
  args.push('--strict-mcp-config');
  if (config?.model && config.model !== 'default')
    args.push('--model', config.model);
  if (config && CLAUDE_EFFORTS.has(config.effort))
    args.push('--effort', config.effort);
  args.push(...claudeAdvisorArgs(config));
  args.push('--disallowedTools', ...CLAUDE_REVIEW_DENIED_TOOLS, ...homeReadDenyRules(homeDir));
  return args;
}

// The seat's cwd: an engine-owned, owner-only, EMPTY directory. Never the worktree, never a shared
// temp root — a `CLAUDE.md` sitting in either would be loaded and obeyed as instructions.
export function makeNeutralSeatCwd(): string {
  return makeOwnerOnlyTempDir('ensemble-seat-cwd-');
}

// The exec seam runClaudeReviewVoice drives — injectable so the retry loop is testable
// without spawning anything (same injection pattern as ClaudeRunner in self-contained).
export type ReviewerExec = typeof runReviewerExec;

// Test seams for the retry loop: the exec and the waits. Production callers pass nothing.
export interface ClaudeVoiceSeams {
  exec?: ReviewerExec;
  fastFailMs?: number;
  inactivityTimeoutMs?: number;
  retryDelaysMs?: readonly number[];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Invoke Claude headless over the review/synthesis prompt via the shared group-kill
// watchdog spawn, in stdout-capture mode. Returns the uniform {ok, raw, stderrTail,
// timedOut} so the orchestrator treats claude like every other voice.
//
// TRANSIENT-ERROR RETRY: an attempt whose reply is an API-layer error (529 overloaded,
// 429, 5xx) AND that fast-failed (under TRANSIENT_FAST_FAIL_MS) is retried after a
// short wait, up to TRANSIENT_RETRY_DELAYS_MS.length extra attempts. Anything else —
// a timeout, a long attempt, a real reply — is returned as-is. The retry is surfaced
// on stderrTail so the trail records that the seat needed it.
export async function runClaudeReviewVoice(
  prompt: string,
  config: VoiceConfig,
  opts: RunReviewOpts = {},
  seams: ClaudeVoiceSeams = {}
): Promise<VoiceRunResult> {
  const exec = seams.exec ?? runReviewerExec;
  const retryDelaysMs = seams.retryDelaysMs ?? TRANSIENT_RETRY_DELAYS_MS;
  const fastFailMs = seams.fastFailMs ?? TRANSIENT_FAST_FAIL_MS;
  const inactivityTimeoutMs = seams.inactivityTimeoutMs ?? CLAUDE_INACTIVITY_TIMEOUT_MS;
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
  // Built BEFORE the neutral cwd exists, so an unfenceable read root throws without leaking a dir.
  const args = buildClaudeReviewArgs(
    prompt,
    config,
    opts.worktree ? { readRoot: opts.worktree } : {}
  );
  const env = claudeAdvisorEnv(config);
  // WORKTREE EVIDENCE (§2): the worktree is the seat's READ ROOT (`--add-dir`), never its cwd. The
  // seat never owns the worktree; the run reaps it. The neutral cwd is ours, and we reap it here.
  const cwd = makeNeutralSeatCwd();
  try {
    // THE HISTORY PACKET (./history-packet): the `git log`/`git blame` this seat cannot run,
    // materialized as read-only data in the one directory it can reach without a read root. It goes
    // HERE, not into the worktree, so the checkout keeps containing exactly what the PR author
    // wrote — and it is reaped with the cwd below, on every path including a throwing spawn. Writing
    // it must never cost a review: an unwritable packet (a full temp disk) leaves the seat exactly
    // where it stood before this existed — reviewing without history — which is a degraded review,
    // never a failed one.
    if (opts.historyPacket?.length) {
      try {
        writeHistoryPacket(cwd, opts.historyPacket);
      } catch {
        /* best-effort — the seat reviews without history rather than not at all */
      }
    }
    let retried = 0;
    for (;;) {
      const startedAt = Date.now();
      const { raw, stderrTail, timedOut, timedOutReason } = await exec({
        args,
        bin: resolveClaudeBin(),
        capture: 'stdout',
        cwd,
        env,
        inactivityTimeoutMs,
        onSpawn: opts.onSpawn,
        stderrLimit: 2000,
        timeoutMs,
      });
      const elapsedMs = Date.now() - startedAt;
      // The reply is a stream: the real text lives in the final result event. A raw
      // with no result event (killed mid-run, or a plain-text reply from an older
      // CLI) falls back to being treated as the text itself — the old contract.
      const stream = typeof raw === 'string' ? extractStreamResult(raw) : null;
      const text = stream?.found ? stream.text : raw;
      const transient =
        !timedOut &&
        typeof raw === 'string' &&
        elapsedMs < fastFailMs &&
        (stream?.found
          ? stream.isError &&
            (isRetryableApiStatus(stream.apiErrorStatus) ||
              isTransientApiErrorReply(stream.text ?? ''))
          : isTransientApiErrorReply(raw));
      if (transient && retried < retryDelaysMs.length) {
        await sleep(retryDelaysMs[retried]);
        retried += 1;
        continue;
      }
      if (transient) {
        // Retries exhausted and the seat never produced a review — only API-error
        // replies. Report the REAL cause instead of letting the findings parser
        // downstream mislabel it "no parseable JSON" (which is what masked the
        // 2026-08-05 529s). raw is withheld so no caller mistakes the error line
        // for a reply; the error itself is preserved on stderrTail for the trail.
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
        // The operator's own subscription window is exhausted. Fail loud and named —
        // the reply carries the reset time, which is exactly what the operator needs.
        return {
          failWhy: `${USAGE_LIMIT_FAIL_PREFIX} — ${limitText.slice(0, 160)}`,
          ok: false,
          raw: null,
          stderrTail: limitText.slice(0, 300),
          timedOut: false,
        };
      }
      if (!timedOut && stream?.found && stream.isError) {
        // A completed stream whose result is an ERROR that retry did not (or may
        // not) cover — auth failure, permanent 4xx, an exhausted transient. Name
        // it; handing the error text to the findings parser would re-mask it as
        // "no parseable JSON" downstream.
        const status = stream.apiErrorStatus;
        return {
          failWhy: `reviewer returned an error result${status ? ` (API status ${status})` : ''}`,
          ok: false,
          raw: null,
          stderrTail: (stream.text ?? '').trim().slice(0, 300) || stderrTail,
          timedOut: false,
        };
      }
      if (timedOut && timedOutReason === 'inactivity') {
        // The liveness watchdog fired: the seat went SILENT (wedged), it was not
        // slow — say so, because "timed out" invites raising budgets that were
        // never the problem.
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
  } finally {
    try {
      fs.rmSync(cwd, { force: true, recursive: true });
    } catch {
      /* best-effort — an empty dir in the OS temp root */
    }
  }
}

// ── The Anthropic seats' worktree preamble ────────────────────────────────────────────

// PURE: what a worktree-fed ANTHROPIC seat is told. It differs from the codex/grok preamble
// (`worktreePromptSuffix`) on two facts that the capability fence made true: the tree is NOT the
// seat's cwd (so paths must be absolute), and there is NO shell (so `git diff` is not available and
// the change is handed over already materialized).
//
// `history` is set when the engine wrote a history packet into this seat's cwd (./history-packet) —
// the `git log`/`git blame` the fence took away, given back as data. Omitted when no packet was
// built (a shallow clone), because a prompt must never name evidence that is not there.
//
// Encoded as data so a unit test pins the exact contract, like every other prompt in this engine.
export function claudeWorktreePromptSuffix(args: {
  headSha: string;
  history?: boolean;
  worktree: string;
}): string {
  const history = args.history ? `\n\n${HISTORY_PACKET_CLAUSE}` : '';
  return `

## Whole-project evidence — the project is readable, but it is NOT your working directory

The full project at the PR head is checked out READ-ONLY at ${args.worktree} (detached at ${args.headSha}).
It is NOT your working directory: reach every file by ABSOLUTE path under that directory, with Read,
Grep, and Glob. You have NO shell and NO network — do not try to run \`git\`, \`npm\`, or any command.
The change under review is the diff already given to you above; it is fully materialized.

Read any file in that directory for whole-project context: a finding may cite an UNCHANGED file (a
reinvented utility, a convention the diff drifts from). Anchor every finding at file:line as it
exists at ${args.headSha}.

${UNTRUSTED_INSTRUCTIONS_CLAUSE}${history}`;
}
