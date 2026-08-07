import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveClaudeBin } from '../brainstorm/claude';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';
import { escapesRoot, makeOwnerOnlyTempDir } from '../../core/artifacts';
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
  version: 1,
};

// Claude's `--effort` accepts these levels; anything else ('default' sentinel included)
// means "leave it to the CLI default", so the flag is omitted rather than passed invalid.
// Exported so the gate-seat resolver whitelist-checks a `--gate-effort` value against the
// SAME set (one source of truth for the review-side effort whitelist).
export const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// The tools REMOVED from every review/synthesis seat. Encoded as data so a unit test pins the exact
// deny-list (a silent drop here is the difference between a fence and a suggestion). `Bash` is the
// load-bearing entry: without it the seat cannot execute anything the untrusted tree asks it to,
// and `WebFetch`/`WebSearch` close the egress side. The write tools were the original belt.
//
// `MultiEdit` no longer exists in the CLI (it warns "matches no known tool" on stderr). It is kept
// deliberately: the deny-list is a fence, and a fence names the tool BEFORE it comes back.
export const CLAUDE_REVIEW_DENIED_TOOLS = [
  'Bash',
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

// Is `child` inside `parent`? Compared on resolved paths, with the trail's own `escapesRoot` as the
// separator-boundary rule, so the path-escape predicate cannot drift between here and the writer.
// An empty rel (child === parent) does not escape, which is what `readRoot === homeDir` must mean.
function isUnder(child: string, parent: string): boolean {
  return !escapesRoot(path.relative(path.resolve(parent), path.resolve(child)));
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
// of this file. Honors the voice config's model/effort so a CONFIGURED Claude model runs.
//
// `--disallowedTools` is variadic, so it goes LAST — nothing may follow it. `--add-dir` is variadic
// too, so it is always followed immediately by `--strict-mcp-config`.
//
// THROWS when the read root lives inside the home directory: the home deny would then also deny the
// worktree, and a seat that silently reviewed nothing is exactly the fail-open this fence exists to
// prevent. Callers turn the throw into a loud, failed seat.
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
  args.push('--disallowedTools', ...CLAUDE_REVIEW_DENIED_TOOLS, ...homeReadDenyRules(homeDir));
  return args;
}

// The seat's cwd: an engine-owned, owner-only, EMPTY directory. Never the worktree, never a shared
// temp root — a `CLAUDE.md` sitting in either would be loaded and obeyed as instructions.
export function makeNeutralSeatCwd(): string {
  return makeOwnerOnlyTempDir('ensemble-seat-cwd-');
}

// A reply that is an API-layer ERROR, not a review: the CLI prints the transport error
// ("API Error: 529 Overloaded", 429 rate limit, other 5xx) to stdout and exits within
// seconds, having consumed no tokens and produced no review. Observed verbatim on runs
// 2026-08-05-11-46-48 and 2026-08-05-13-09-19 (the raw reply was exactly the one 529
// line) — which the parser then honestly reported as "no parseable JSON block", masking
// the real cause. The predicate is deliberately narrow: SHORT replies only, so a real
// review that merely quotes an error string can never be classed as transient.
export function isTransientApiErrorReply(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 1500) return false;
  return /\bAPI Error:\s*(?:429|5\d\d)\b/i.test(trimmed) || /\boverloaded\b/i.test(trimmed);
}

// A reply that is the OPERATOR'S subscription usage limit, not a review: the CLI prints
// one short line ("You've hit your session limit · resets 5:10pm (Europe/Stockholm)")
// and exits. Observed verbatim on run 2026-08-07-14-53-49 (65 bytes), where it was
// mislabeled "no parseable JSON block". NOT retryable — a 5-hour window does not clear
// in 45 seconds — so it must be NAMED, never retried and never fed to the parser.
export function isUsageLimitReply(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 300) return false;
  return /\b(session|usage|weekly) limit\b/i.test(trimmed) && /\b(reset|hit|reached)\b/i.test(trimmed);
}

// Retryable transport statuses: rate limit + server-side (the CLI surfaces them on the
// result event's api_error_status when the stream completes with is_error).
export function isRetryableApiStatus(status: number | null): boolean {
  return status === 429 || (typeof status === 'number' && status >= 500 && status <= 599);
}

// Fast-fail retry schedule for transient API errors: a 529/429 returns in seconds, so a
// couple of spaced retries are nearly free next to the review they rescue. An attempt
// that ran longer than TRANSIENT_FAST_FAIL_MS did real work and is never retried — the
// retry exists for the seat that died on arrival, not to double-spend a long run.
export const TRANSIENT_RETRY_DELAYS_MS = [15_000, 45_000] as const;
export const TRANSIENT_FAST_FAIL_MS = 120_000;

// The LIVENESS bar: with stream-json a working seat emits an event every few seconds
// (thinking heartbeats included), so ten silent minutes means a wedged seat, not slow
// honest work. This is what actually reclaims wedges now; the absolute per-seat budgets
// are pure runaway backstops sized far past any observed honest run.
export const CLAUDE_INACTIVITY_TIMEOUT_MS = 600_000; // 10 min of total silence

// The stream's final `type:"result"` event, when one exists. `found:false` means the
// stream never completed (killed mid-run) or the reply was not stream-json at all —
// callers fall back to treating the raw output as plain text, which keeps the old
// text-mode contract working end-to-end.
export interface StreamResultEvent {
  apiErrorStatus: number | null;
  found: boolean;
  isError: boolean;
  text: string | null;
}

// PURE: pull the last `type:"result"` event out of a stream-json stdout. Defensive per
// line — non-JSON lines (a stray warning, a truncated tail) are skipped, never fatal.
export function extractStreamResult(stdout: string): StreamResultEvent {
  let found: StreamResultEvent = { apiErrorStatus: null, found: false, isError: false, text: null };
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const o = obj as Record<string, unknown>;
    if (o.type !== 'result') continue;
    found = {
      apiErrorStatus: typeof o.api_error_status === 'number' ? o.api_error_status : null,
      found: true,
      isError: o.is_error === true,
      text: typeof o.result === 'string' ? o.result : null,
    };
  }
  return found;
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
          failWhy: `operator usage limit reached — ${limitText.slice(0, 160)}`,
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
