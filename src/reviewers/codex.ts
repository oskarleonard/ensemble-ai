import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeOwnerOnlyTempDir } from '../core/artifacts';
import type { HistoryPacketFile } from '../modes/review/history-packet';
import { type EgressDenial, type EgressProxy, proxyEnv } from '../core/egress-proxy';
import { resolveCodexBin, runReviewerExec } from '../core/spawn';
import type { ReviewerConfig } from '../core/types';

import {
  buildCodexWorktreeArgs,
  codexSandboxSupported,
  defaultCodexSandboxPaths,
  SANDBOX_WRITABLE_TMP,
  wrapWithSandbox,
  writeCodexSandboxProfile,
} from './codex-sandbox';
import { egressStartFailure, startSeatEgressProxy } from './egress-seat';

// A code review at xhigh reasoning is far slower than a chat turn — give the
// reviewer real time, but ALWAYS under a watchdog. The lived 40-min 0%-CPU wedge
// on open stdin proved the timeout is mandatory, not optional.
export const REVIEW_TIMEOUT_MS = 720_000; // 12 min

export interface CodexReviewResult {
  // Every connection the run's egress proxy REFUSED (codex-f3). Absent on a packet-mode run, which
  // has no proxy. Empty on a clean worktree run. Non-empty means this seat tried to reach a host
  // outside its vendor allowlist — which, under a prompt-injectable shell, is the signal the fence
  // exists to catch. LOUD by contract: stderr at denial time, the run artifact, the posted footer.
  egressDenials?: readonly EgressDenial[];
  ok: boolean;
  raw: string | null; // the reviewer's full reply (read from the -o file)
  stderrTail: string;
  timedOut: boolean;
}

// PURE: the exact codex CLI args for a PACKET-mode review. Encodes every lived lesson as
// DATA so a unit test pins it: `-s read-only` (the reviewer can NEVER mutate the
// work) · `-m <model>` + `-c model_reasoning_effort=<effort>` (the CONFIGURED
// strong model, not the account default — a review wants the best) ·
// `--skip-git-repo-check` (we run from tmpdir; the diff is IN the prompt, not
// the cwd) · `-o <file>` (codex's reply comes from there — stdout is empty and
// the exit code lies) · `--ephemeral` + `--color never`. stdin is closed at the
// spawn (stdio), not via an arg — see runCodexReview.
//
// PACKET FENCE (packet-f1, 2026-07-10) — a packet seat has no worktree, so it has neither the
// kernel sandbox nor the egress proxy the worktree path fences with. Two flags close the two holes
// that left, both proved live:
//
//   `--ignore-user-config` — load NONE of the operator's ~/.codex/config.toml, above all its
//     `[mcp_servers]`. A review reads its prompt; it needs no MCP. An operator MCP server is an
//     operator-CREDENTIALED egress channel a prompt-injectable review has no business reaching:
//     verified 2026-07-10 through a logging proxy, the un-fenced packet seat CONNECTed to the
//     operator's `mcp.supabase.com` during a trivial exec; with this flag the same run reaches only
//     `chatgpt.com`. The seat still authenticates (the flag drops config.toml but auth still uses
//     $CODEX_HOME/auth.json) and still runs the CONFIGURED model/effort, which arrive via `-m`/`-c`
//     — an override layer, NOT the ignored file — so nothing a review needs is lost. The one
//     tradeoff, stated: an operator who defines a CUSTOM `model_providers` in config.toml and points
//     the reviewer model at it loses it here; a review seat is meant to use the standard vendor
//     provider. This is the WORKTREE path's `mcp.supabase.com` egress-deny expressed at the source
//     for the packet path — that path stays byte-identical (its proxy + kernel sandbox already deny
//     the same host); across both modes the seat never reaches an operator MCP server.
//
//   `otel.{exporter,metrics_exporter,trace_exporter}="none"` + `otel.log_user_prompt=false` — pin
//     every OpenTelemetry exporter OFF and never ship the prompt to a telemetry backend. The metrics
//     exporter DEFAULTS to `statsig`, so `--ignore-user-config` alone does not disable telemetry — it
//     resets to that default; the explicit `-c` overrides are what force it off, and they layer on
//     top of `--ignore-user-config`. `log_user_prompt=false` matters to the threat model: the
//     untrusted diff rides IN the prompt, so this guarantees it is never emitted to a telemetry
//     backend even if one is configured later. "none" is a documented value for each key (codex
//     config reference); the 2026-07-10 probe OBSERVED no telemetry host being contacted, so this is
//     fail-safe hardening, not the closing of an observed leak — documented honestly as such.
export function buildCodexReviewArgs(
  config: ReviewerConfig,
  outFile: string,
  prompt: string
): string[] {
  return [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    // Load none of the operator's ~/.codex/config.toml — above all its [mcp_servers]. Auth still
    // uses $CODEX_HOME; the model/effort below arrive via -m/-c (an override layer), not that file.
    '--ignore-user-config',
    // Every OpenTelemetry exporter OFF (metrics defaults to `statsig`, so ignoring the file is not
    // enough), and never ship the prompt — which carries the untrusted diff — to a telemetry backend.
    '-c',
    'otel.exporter="none"',
    '-c',
    'otel.metrics_exporter="none"',
    '-c',
    'otel.trace_exporter="none"',
    '-c',
    'otel.log_user_prompt=false',
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
  // THE HISTORY PACKET (modes/review/history-packet.ts): `git log` + `git blame` for the changed
  // files, computed by the engine and written into the seat's own cwd as read-only DATA. Honored by
  // the FENCED ANTHROPIC seats only — the capability fence removed their Bash, so this is the only
  // way they can see history. codex and grok ignore it: they hold a shell inside their OS-fenced
  // worktree cwd and run git themselves. It lives on the SHARED opts for the same reason `worktree`
  // does — one adapter contract, never a per-reviewer intersection type.
  historyPacket?: readonly HistoryPacketFile[];
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

// The WORKTREE seat's `-o` reply file, and why it is not `reviewOutFile()`.
//
// A worktree codex seat runs inside the `ensemble-review-codex` Seatbelt profile, whose ONLY
// writable roots are `~/.codex`, `/private/tmp`, and `/dev`. The per-user `$TMPDIR` that
// `os.tmpdir()` returns realpaths under `/private/var/folders/…`, which the profile grants
// file-READ (via the `/private/var` system root) and never file-WRITE. So a reply file placed
// there is unwritable BY THE SEAT: codex completes the whole review, then dies on
// `Failed to write last message file …: Operation not permitted (os error 1)` — verified against
// codex-cli 0.143.0 under this exact profile. `runReviewerExec` then reads no reply, the seat is
// scored `failed-reviewer`, and RETRIES_ON_PACKET re-runs it on the packet. Every worktree codex
// run would burn a full review and discard it.
//
// SANDBOX_WRITABLE_TMP is the one writable root the profile already grants, so the reply lands in
// an owner-only (0700) mkdtemp there — the same posture writeCodexSandboxProfile uses for the
// profile itself. The constant is owned by the profile module, so this path and the SBPL write rule
// cannot drift apart. No profile RULE changes, so `CODEX_SANDBOX_PROFILE.version` — and every
// receipt whose policyHash binds it — is untouched.
function worktreeReplyFile(): { cleanup: () => void; file: string } {
  const dir = makeOwnerOnlyTempDir('ensemble-codex-', SANDBOX_WRITABLE_TMP);
  return {
    cleanup: () => {
      try {
        fs.rmSync(dir, { force: true, recursive: true });
      } catch {
        /* best-effort, like every other reap in this engine */
      }
    },
    file: path.join(dir, 'reply.md'),
  };
}

function refuseWorktree(message: string): Promise<CodexReviewResult> {
  return Promise.resolve({ ok: false, raw: null, stderrTail: message, timedOut: false });
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
async function runCodexWorktreeReview(
  prompt: string,
  config: ReviewerConfig,
  worktree: string,
  opts: RunReviewOpts
): Promise<CodexReviewResult> {
  if (!codexSandboxSupported()) {
    return refuseWorktree(
      `ensemble-ai: the codex seat cannot take the worktree on ${process.platform} — its sandbox-exec wrapper is macOS-only, and codex's own \`-s read-only\` restricts writes, not reads.`
    );
  }
  // Resolve the binary BEFORE anything acquires a temp dir or a socket: resolveCodexBin THROWS when
  // codex is not installed, and a throw after writeCodexSandboxProfile would strand its owner-only
  // dir — mkdtemp names are random, so a leaked one is unfindable and nothing can ever clean it up.
  let bin: string;
  try {
    bin = resolveCodexBin();
  } catch (e) {
    return refuseWorktree(`ensemble-ai: ${(e as Error).message}`);
  }
  // THE FENCE (codex-f3). It binds BEFORE the profile is rendered, because the profile's only
  // egress rule is this proxy's port. A proxy that cannot start means NO qualifying fence, and a
  // seat with no fence does not run in the worktree — it refuses, LOUDLY, and the caller falls back
  // to the packet (§7). It never spawns a bypassed codex with unrestricted :443.
  let proxy: EgressProxy;
  try {
    proxy = await startSeatEgressProxy('codex');
  } catch (e) {
    return refuseWorktree(egressStartFailure('codex', e));
  }
  let profile: ReturnType<typeof writeCodexSandboxProfile> | undefined;
  let reply: ReturnType<typeof worktreeReplyFile>;
  try {
    profile = writeCodexSandboxProfile(defaultCodexSandboxPaths(worktree, proxy.port));
    reply = worktreeReplyFile();
  } catch (e) {
    profile?.cleanup();
    proxy.close();
    return refuseWorktree(`ensemble-ai: ${(e as Error).message}`);
  }
  const wrapped = wrapWithSandbox(
    profile.file,
    bin,
    buildCodexWorktreeArgs(config, reply.file, prompt)
  );
  // Both temp dirs (the profile sandbox-exec reads, and the reply the SEAT writes) and the proxy
  // socket are ours to reap. `finally` on the promise (not the caller) because the dir names are
  // random — a leaked one is unfindable. A synchronous throw from runReviewerExec is caught too.
  const cleanup = (): void => {
    profile.cleanup();
    reply.cleanup();
    proxy.close();
  };
  try {
    return await runReviewerExec({
      args: wrapped.args,
      bin: wrapped.bin,
      // The seat BORROWS the worktree (one per run, shared by every seat). It never reaps it.
      cwd: worktree,
      // The seat's ONLY route off the machine. Its Seatbelt profile denies every other outbound.
      env: proxyEnv(proxy.url),
      onSpawn: opts.onSpawn,
      outFile: reply.file,
      stderrLimit: 2000,
      timeoutMs: opts.timeoutMs ?? REVIEW_TIMEOUT_MS,
    })
      .then(({ raw, stderrTail, timedOut }) => ({
        // Snapshot the denials before cleanup: they are what the artifact and the footer report.
        egressDenials: [...proxy.denials],
        ok: raw !== null,
        raw,
        stderrTail,
        timedOut,
      }))
      .finally(cleanup);
  } catch (e) {
    cleanup();
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
