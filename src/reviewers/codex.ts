import os from 'node:os';
import path from 'node:path';

import { resolveCodexBin, runReviewerExec } from '../core/spawn';
import type { ReviewerConfig } from '../core/types';

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
  // FAIL CLOSED, never silently. `worktree` lives on the shared opts, but this seat cannot yet
  // honor it: codex needs its external sandbox-exec wrapper (codex-sandbox.ts) wired in first,
  // and codex's own `-s read-only` restricts writes, not reads. Accepting-and-ignoring the option
  // would let a caller believe codex saw the worktree while it reviewed from the packet — and a
  // receipt could then record `worktree` evidence codex never had. That silent downgrade is the
  // precise failure the realized-evidence map exists to make impossible, so refuse it.
  //
  // RESOLVE, never reject: every reviewer path settles to a CodexReviewResult, and the
  // orchestrator turns `ok: false` into a clean failed-seat entry (which cannot qualify a
  // receipt). Throwing here would instead surface as an unhandled rejection in any adapter caller
  // that does not catch — a crash where the contract asks for a recorded failure.
  if (opts.worktree) {
    return Promise.resolve({
      ok: false,
      raw: null,
      stderrTail:
        'ensemble-ai: the codex seat cannot run against a worktree yet (its sandbox-exec wrapper is not wired). Refusing rather than reviewing the packet while reporting worktree evidence.',
      timedOut: false,
    });
  }
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
  const outFile = path.join(
    os.tmpdir(),
    `codex-review-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
  );
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
