import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveClaudeBin } from '../brainstorm/claude';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';
import { escapesRoot } from '../../core/artifacts';
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

// PURE: the claude CLI args for a review/synthesis voice. `-p <prompt>` (headless, single-shot,
// reply to STDOUT) + `--output-format text` (a plain reply; we parse the embedded ```json block
// ourselves, exactly like codex/grok — symmetry IS robustness) + the capability fence documented at
// the top of this file. Honors the voice config's model/effort so a CONFIGURED Claude model runs.
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
  const args = ['-p', prompt, '--output-format', 'text', '--permission-mode', 'plan'];
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-seat-cwd-'));
  fs.chmodSync(dir, 0o700);
  return dir;
}

// Invoke Claude headless over the review/synthesis prompt via the shared group-kill
// watchdog spawn, in stdout-capture mode. Returns the uniform {ok, raw, stderrTail,
// timedOut} so the orchestrator treats claude like every other voice.
export async function runClaudeReviewVoice(
  prompt: string,
  config: VoiceConfig,
  opts: RunReviewOpts = {}
): Promise<VoiceRunResult> {
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
    const { raw, stderrTail, timedOut } = await runReviewerExec({
      args,
      bin: resolveClaudeBin(),
      capture: 'stdout',
      cwd,
      onSpawn: opts.onSpawn,
      stderrLimit: 2000,
      timeoutMs,
    });
    return { ok: raw !== null && !timedOut, raw, stderrTail, timedOut };
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
