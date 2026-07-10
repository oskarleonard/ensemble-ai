import os from 'node:os';
import path from 'node:path';

import { resolveCodexBin, runReviewerExec } from '../core/spawn';
import type { ReviewerConfig } from '../core/types';

import {
  buildCodexWorktreeArgs,
  codexSandboxSupported,
  defaultCodexSandboxPaths,
  wrapWithSandbox,
  writeCodexSandboxProfile,
} from './codex-sandbox';

// A code review at xhigh reasoning is far slower than a chat turn — give the
// reviewer real time, but ALWAYS under a watchdog. The lived 40-min 0%-CPU wedge
// on open stdin proved the timeout is mandatory, not optional.
export const REVIEW_TIMEOUT_MS = 720_000; // 12 min

export interface CodexReviewResult {
  ok: boolean;
  raw: string | null; // the reviewer's full reply (read from the -o file)
  stderrTail: string;
  timedOut: boolean;
}

// PURE: the exact codex CLI args for a review. Encodes every lived lesson as
// DATA so a unit test pins it: `-s read-only` (the reviewer can NEVER mutate the
// work) · `-m <model>` + `-c model_reasoning_effort=<effort>` (the CONFIGURED
// strong model, not the account default — a review wants the best) ·
// `--skip-git-repo-check` (we run from tmpdir; the diff is IN the prompt, not
// the cwd) · `-o <file>` (codex's reply comes from there — stdout is empty and
// the exit code lies) · `--ephemeral` + `--color never`. stdin is closed at the
// spawn (stdio), not via an arg — see runCodexReview.
export function buildCodexReviewArgs(
  config: ReviewerConfig,
  outFile: string,
  prompt: string
): string[] {
  return [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color',
    'never',
    '-s',
    'read-only',
    '-m',
    config.model,
    '-c',
    `model_reasoning_effort="${config.effort}"`,
    '-o',
    outFile,
    prompt,
  ];
}

export interface RunReviewOpts {
  // Receives the kill handle so a caller (a future cancel) can abort the child.
  onSpawn?: (kill: () => void) => void;
  timeoutMs?: number;
  // WORKTREE EVIDENCE (§2): the detached, read-only worktree of the PR head this seat runs in.
  // BORROWED, never owned — one worktree is materialized per run and shared by every seat, so a
  // seat must never reap it. Absent ⇒ the packet path (a throwaway cwd). It lives on the SHARED
  // opts so seats extend through the one adapter contract (REVIEW_ADAPTERS), never a per-reviewer
  // intersection type. Only grok honors it today; codex needs its external wrapper first.
  worktree?: string;
}

function reviewOutFile(): string {
  return path.join(
    os.tmpdir(),
    `codex-review-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
  );
}

// WORKTREE EVIDENCE (§2) — codex under the ensemble-OWNED external Seatbelt wrapper: its INTERNAL
// sandbox is off (nested Seatbelt does not compose) and the EXTERNAL profile is the boundary, with
// the worktree as cwd so codex's file tools reach the project.
//
// FAIL CLOSED, never silently: an unsupported platform or a profile that refuses to build (an
// unsafe read root — see renderCodexSandboxProfile) RESOLVES to `ok:false` with a named reason,
// which the orchestrator turns into a LOUD per-seat packet fallback. It never resolves `ok:true`
// while reviewing anything other than the worktree — a receipt recording `worktree` evidence codex
// never had is precisely the silent downgrade the realized-evidence map exists to make impossible.
//
// The VIABILITY CHECK (§9 grok-f2) is this call itself: it exercises the real subprocess/pty
// spawn with the real review prompt under the real profile, not a `--version` smoke. If codex
// cannot function inside the wrapper, this run produces no reply and the caller falls back.
function runCodexWorktreeReview(
  prompt: string,
  config: ReviewerConfig,
  worktree: string,
  opts: RunReviewOpts
): Promise<CodexReviewResult> {
  if (!codexSandboxSupported()) {
    return Promise.resolve({
      ok: false,
      raw: null,
      stderrTail: `ensemble-ai: the codex seat cannot take the worktree on ${process.platform} — its sandbox-exec wrapper is macOS-only, and codex's own \`-s read-only\` restricts writes, not reads.`,
      timedOut: false,
    });
  }
  let profile: ReturnType<typeof writeCodexSandboxProfile>;
  try {
    profile = writeCodexSandboxProfile(defaultCodexSandboxPaths(worktree));
  } catch (e) {
    return Promise.resolve({
      ok: false,
      raw: null,
      stderrTail: `ensemble-ai: ${(e as Error).message}`,
      timedOut: false,
    });
  }
  const outFile = reviewOutFile();
  const wrapped = wrapWithSandbox(
    profile.file,
    resolveCodexBin(),
    buildCodexWorktreeArgs(config, outFile, prompt)
  );
  // The profile file outlives the spawn only as long as sandbox-exec reads it; the owner-only temp
  // dir is ours to reap. `finally` on the promise (not the caller) because the dir name is random —
  // a leaked one is unfindable. A synchronous throw from runReviewerExec is caught too.
  try {
    return runReviewerExec({
      args: wrapped.args,
      bin: wrapped.bin,
      // The seat BORROWS the worktree (one per run, shared by every seat). It never reaps it.
      cwd: worktree,
      onSpawn: opts.onSpawn,
      outFile,
      stderrLimit: 2000,
      timeoutMs: opts.timeoutMs ?? REVIEW_TIMEOUT_MS,
    })
      .then(({ raw, stderrTail, timedOut }) => ({ ok: raw !== null, raw, stderrTail, timedOut }))
      .finally(profile.cleanup);
  } catch (e) {
    profile.cleanup();
    throw e;
  }
}

// Invoke the reviewer (Codex) READ-ONLY with the embedded packet prompt, over the
// shared runReviewerExec spawn contract (group-aware watchdog, settle-on-`exit`,
// an absolute backstop — so a wedged rmcp grandchild can never hang the request;
// lived: the 40-min 0%-CPU wedge). Parameterized for a review: the configured
// strong model/effort and a long (12-min) timeout. The reply is read from the -o
// file. On Codex's separate quota, never a shared pool.
export function runCodexReview(
  prompt: string,
  config: ReviewerConfig,
  opts: RunReviewOpts = {}
): Promise<CodexReviewResult> {
  if (opts.worktree) return runCodexWorktreeReview(prompt, config, opts.worktree, opts);
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
  const outFile = reviewOutFile();
  return runReviewerExec({
    bin: resolveCodexBin(),
    args: buildCodexReviewArgs(config, outFile, prompt),
    outFile,
    timeoutMs,
    stderrLimit: 2000,
    onSpawn: opts.onSpawn,
  }).then(({ raw, stderrTail, timedOut }) => ({
    ok: raw !== null,
    raw,
    stderrTail,
    timedOut,
  }));
}
