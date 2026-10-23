import { persistReview } from '../../core/artifacts';
import { type ParsedReview, parseFindings } from '../../core/findings';
import type { assembleCodePacket } from '../../core/packet';
import type {
  ReviewerConfig,
  ReviewerId,
  SeatDiagnostics,
  StoredReview,
  TerminalState,
} from '../../core/types';
import type { EgressDenial } from '../../core/egress-proxy';
import { CODEX_RETRY_NOTE_RE, type CodexReviewResult, type RunReviewOpts } from '../../reviewers/codex';

import type { EvidenceClass } from './evidence';
import type { SeatQualification } from './seat-evidence';
import { conventionsReadOf, parseSeatUsage } from './seat-usage';
import { readConventionsLayout } from '../../core/conventions';

// ONE CORE SEAT (codex / grok), run with the evidence its policy qualified it for, and its trail
// artifact persisted. This is where INTENT becomes FACT: the returned `realized` class is what the
// receipt records, and it is derived from what actually ran — never from what was asked for.

export type ReviewAdapter = (
  prompt: string,
  config: ReviewerConfig,
  opts?: RunReviewOpts
) => Promise<CodexReviewResult>;

export interface SeatRunResult {
  // Connections this seat's egress proxy REFUSED (codex-f3). Empty unless the seat ran fenced in
  // the worktree and reached for a host outside its vendor allowlist. LOUD by contract.
  egressDenials: readonly EgressDenial[];
  // Why this seat did not get the worktree it was asked for (unqualified sandbox, or a wrapper
  // that provably broke). Null when nothing degraded. LOUD by contract — the caller prints it,
  // the receipt records the weaker realized class, and the posted footer states it.
  fallbackReason: string | null;
  realized: EvidenceClass;
  review: StoredReview;
}

export interface RunCoreSeatArgs {
  adapter: ReviewAdapter;
  // The review PART's artifact suffix (`c2`), when this seat run is one part of several — its
  // files land beside the reviewer's merged set (core/artifacts PersistReviewInput). Absent ⇒
  // the canonical files, as before.
  artifactSuffix?: string;
  // The conventions were handed over as a file in the worktree this run (modes/review
  // CONVENTIONS_IN_TREE_*), at this absolute path: record how far this seat read into it.
  conventionsFile?: string;
  log: (m: string) => void;
  out: string;
  packet: ReturnType<typeof assembleCodePacket>;
  packetComplete: boolean;
  // The pinned packet prompt — what every seat sees, worktree or not.
  packetPrompt: string;
  // The seat's sandbox qualification for THIS run's worktree. Absent ⇒ packet-mode run.
  qualification?: SeatQualification;
  reviewer: ReviewerConfig;
  // True when a proven-breakage worktree run must be RE-RUN on the packet (the codex wrapper's
  // viability check — see runCoreSeat). False for a seat whose sandbox is already proven.
  retryOnPacket: boolean;
  runId: string;
  // The detached read-only worktree of the PR head. Absent ⇒ packet-mode run.
  worktree?: string;
  // The packet prompt + the worktree preamble. Only ever sent to a seat that HAS the worktree —
  // telling a packet seat "the project is checked out at /tmp/…" would be a lie.
  worktreePrompt?: string;
}

// Wall-clock of one adapter attempt, persisted with the seat's artifact: the trail's answer to
// "how long did it actually run" — which a timeout summary alone cannot give.
export interface SeatTiming {
  endedAt: number;
  startedAt: number;
}

// Invoke the adapter once, isolating a per-seat failure (a CLI binary that can't be resolved
// throws) into a recorded failure rather than a rejected fan-out.
async function adapterOnce(
  adapter: ReviewAdapter,
  prompt: string,
  reviewer: ReviewerConfig,
  opts: RunReviewOpts
): Promise<{ result: CodexReviewResult; timing: SeatTiming }> {
  const startedAt = Date.now();
  try {
    const result = await adapter(prompt, reviewer, opts);
    return { result, timing: { endedAt: Date.now(), startedAt } };
  } catch (e) {
    return {
      result: { ok: false, raw: null, stderrTail: (e as Error).message, timedOut: false },
      timing: { endedAt: Date.now(), startedAt },
    };
  }
}

// A timeout summary names WHICH watchdog fired and how long the seat ran: the absolute backstop
// means it was still producing when cut (give it budget), the liveness one means it went silent
// (it wedged). Run 2026-08-26-10-45-52 left only "timed out" behind, and the difference had to be
// reconstructed from artifact mtimes. The adapter's own wording wins when it has one.
function timedOutSummary(result: CodexReviewResult, timing: SeatTiming): string {
  if (result.failWhy) return result.failWhy;
  const minutes = Math.round((timing.endedAt - timing.startedAt) / 60_000);
  const watchdog =
    result.timedOutReason === 'inactivity'
      ? // Elapsed is NOT the silence: a seat can work for 30 min and then go quiet for 15. Only the
        // adapter knows its own silence budget, so it states the figure in `failWhy` (returned
        // above); this generic wording is the fallback for a seat that named none.
        'the liveness watchdog cut it on a silent seat'
      : `the absolute backstop cut it after ${minutes} min`;
  return `The reviewer timed out before completing (${watchdog}) — its output is incomplete and not trusted.`;
}

// The seat's run FACTS for the trail, written for every attempt. The stderr tail is the noise
// channel bounded by the adapter (2000 chars) — kept here rather than dropped, because on a
// timeout it is the only text the seat left behind. Pre-flight warnings ride their own field, so
// the summaries below (which quote the head of stderrTail) never show a warning in the seat's place.
export function seatDiagnostics(
  result: CodexReviewResult,
  timing: SeatTiming,
  // `conventionsFile`: this run handed the conventions over as a file at this path, so how far
  // the seat read into it is a fact worth recording. Absent (inline) ⇒ the field is never written.
  opts: { conventionsFile?: string } = {}
): SeatDiagnostics {
  const usage = parseSeatUsage(result.stream);
  const conventions = opts.conventionsFile ? conventionsReadOf(result.stream, readConventionsLayout(opts.conventionsFile)) : undefined;
  return {
    elapsedMs: timing.endedAt - timing.startedAt,
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    ...(conventions ? { conventions } : {}),
    endedAt: new Date(timing.endedAt).toISOString(),
    ...(result.failWhy ? { failWhy: result.failWhy } : {}),
    ...(result.preflightWarnings?.length ? { preflightWarnings: [...result.preflightWarnings] } : {}),
    startedAt: new Date(timing.startedAt).toISOString(),
    stderrTail: result.stderrTail.trim().slice(-2000),
    ...(result.timedOutReason ? { timedOutReason: result.timedOutReason } : {}),
  };
}

// Parse + persist one attempt's reply as this seat's trail artifact. A watchdog timeout or a parse
// failure marks the reviewer failed-reviewer: a cut-off review is not trusted even if it partly
// parsed. A re-run (the packet fallback) overwrites the failed attempt's artifacts, so the trail
// always describes the review that actually counted.
function persistAttempt(
  args: RunCoreSeatArgs,
  prompt: string,
  result: CodexReviewResult,
  timing: SeatTiming
): StoredReview {
  const parsed = result.raw ? parseFindings(result.raw) : null;
  const terminalState = attemptTerminalState(result, parsed);
  // A REVIEWED seat keeps its own summary — even an empty one: a valid review without a summary is
  // not a parse failure. A FAILED seat says why, through the one derivation (attemptFailureWhy) —
  // under a sandbox wrapper that is the difference between "the model had nothing to say" and
  // "the profile killed the process".
  const summary = result.timedOut
    ? timedOutSummary(result, timing)
    : terminalState === 'reviewed'
      ? (parsed?.summary ?? '')
      : `The ${args.reviewer.id} reviewer produced no parseable findings: ${attemptFailureWhy(result)}`;
  return persistReview(args.out, {
    ...(args.artifactSuffix ? { artifactSuffix: args.artifactSuffix } : {}),
    diagnostics: seatDiagnostics(result, timing, { conventionsFile: args.conventionsFile }),
    findings: parsed?.findings ?? [],
    packet: args.packet,
    prompt,
    raw: result.raw,
    reviewer: args.reviewer,
    runId: args.runId,
    ...(result.stream ? { stream: result.stream } : {}),
    summary,
    terminalState,
  });
}

export async function runCoreSeat(args: RunCoreSeatArgs): Promise<SeatRunResult> {
  const { log, reviewer } = args;
  if (!args.packetComplete) {
    // No usable diff → the reviewer is NOT run, and this is recorded as a NON-completion (never
    // 'reviewed'). buildDiffReceipt and isDiffReviewed both key "did this reviewer complete?" off
    // terminalState === 'reviewed'; marking a skipped reviewer 'reviewed' would qualify a receipt
    // for a change no reviewer ever saw (fail-OPEN). 'failed-reviewer' keeps a blind/empty packet
    // fail-closed.
    return {
      egressDenials: [],
      fallbackReason: null,
      realized: 'packet',
      review: persistReview(args.out, {
        ...(args.artifactSuffix ? { artifactSuffix: args.artifactSuffix } : {}),
        findings: [],
        packet: args.packet,
        prompt: args.packetPrompt,
        raw: null,
        reviewer,
        runId: args.runId,
        summary: `Did not review with ${reviewer.id} — the diff could not be assembled (incomplete packet), so no trustworthy review ran. Surfaced for review.`,
        terminalState: 'failed-reviewer',
      }),
    };
  }

  // PACKET MODE — either no worktree exists, or this seat's sandbox does not qualify for one.
  // An unqualified seat carries its reason forward: the fallback is loud, never silent (§2).
  const wt = args.worktree;
  if (!wt || !args.qualification?.qualified || !args.worktreePrompt) {
    const unqualified = wt ? (args.qualification?.reason ?? null) : null;
    if (unqualified) log(`  · ⚠ ${unqualified}`);
    const { result, timing } = await adapterOnce(args.adapter, args.packetPrompt, reviewer, {});
    return {
      // A packet seat runs unfenced by design — it has no worktree, so no proxy and no denials.
      egressDenials: [],
      fallbackReason: unqualified,
      realized: 'packet',
      review: persistAttempt(args, args.packetPrompt, result, timing),
    };
  }

  // WORKTREE MODE — the seat runs in the tree, under the profile its qualification named.
  const { result: first, timing: firstTiming } = await adapterOnce(
    args.adapter,
    args.worktreePrompt,
    reviewer,
    { worktree: wt }
  );
  const review = persistAttempt(args, args.worktreePrompt, first, firstTiming);
  const egressDenials = first.egressDenials ?? [];
  if (review.terminalState === 'reviewed') {
    return { egressDenials, fallbackReason: null, realized: 'worktree', review };
  }
  // A TIMEOUT is not a sandbox-viability signal — the seat ran under its profile and simply did not
  // finish. Re-running it on the packet would spend a second full review budget to learn nothing,
  // so the failed seat stands (and, having completed no review, it cannot qualify a receipt).
  // Neither is an API-NAMED death (run 2026-10-14-11-08-56-90dbf6a6): a 429 the adapter already
  // retried, or the operator's usage limit, says nothing about the sandbox — the packet re-run met
  // the same 429 five seconds later. The seat stands failed with the real cause on it; the
  // dashboard's reseat heals it once the limit clears.
  if (isSettledApiFailure(first))
    log(`  · ⚠ ${reviewer.id}: ${first.failWhy ?? first.failKind} — not a sandbox failure, so no packet re-run; the seat stands failed`);
  if (!packetRetryAfterWorktree(first, args.retryOnPacket)) {
    return { egressDenials, fallbackReason: null, realized: 'worktree', review };
  }
  // PROVEN BREAKAGE (§9 grok-f2, spec §2's codex branch): the wrapper's viability check IS this
  // real review run, and it produced nothing usable. Fall back to the packet, LOUDLY — this seat
  // now runs BELOW the ratified acceptance bar (packet < the manual whole-repo baseline), which is
  // Oskar's ratification call to accept, never a silent downgrade.
  const why = attemptFailureWhy(first);
  const reason = `${reviewer.id}: the worktree seat produced no usable review under its \`${args.qualification.profile.id}\` sandbox (${why}) — FELL BACK to the diff-only packet. This seat reviewed less than it would have in-project.`;
  log(`  · ⚠ ${reason}`);
  const { result: second, timing: secondTiming } = await adapterOnce(
    args.adapter,
    args.packetPrompt,
    reviewer,
    {}
  );
  return {
    // The FAILED worktree attempt's denials still count: a seat that reached for a forbidden host
    // and then fell back must not launder that away with a clean packet re-run.
    egressDenials,
    fallbackReason: reason,
    realized: 'packet',
    review: persistAttempt(args, args.packetPrompt, second, secondTiming),
  };
}

// codex `exec --json` writes only this banner to stderr — the reply and any death ride the -o file
// and the `--json` stream (see codexStreamFailure) — so as a CAUSE it says nothing.
export const CODEX_STDIN_BANNER = 'Reading additional input from stdin...';

// WHY a failed attempt produced no usable review — the ONE derivation the packet-fallback reason
// (runCoreSeat), the failed seat's summary (persistAttempt) and a consumer composing its own seats
// (the Munin dashboard) all read: a non-blank failWhy; else the stderr tail without codex's stdin
// banner and its retry note (context, never a cause); else the reply itself named — 'the reply did
// not parse as a review' when one came back, 'no output' when none did. Capped at 300.
export function attemptFailureWhy(
  first: Pick<CodexReviewResult, 'failWhy' | 'raw' | 'stderrTail'>
): string {
  const named = first.failWhy?.trim();
  if (named) return named.slice(0, 300);
  const tail = first.stderrTail
    .split('\n')
    .filter((line) => line.trim() !== CODEX_STDIN_BANNER && !CODEX_RETRY_NOTE_RE.test(line.trim()))
    .join('\n')
    .trim();
  if (tail) return tail.slice(0, 300);
  return first.raw ? 'the reply did not parse as a review' : 'no output';
}

// After a failed WORKTREE attempt: a failure the adapter already SETTLED — an API-named death (a
// 429 / 5xx / overloaded: retried in place while it arrives inside the fast-fail window, named the
// same when it arrives later, unretried) or the operator's usage limit. Neither says anything about
// the sandbox, so no packet re-run can cure it. Read off the typed fact
// (`failKind`), which codex's toCodexResult and the Claude runners set alike: from the death
// itself, never from whether the attempt was fast enough to retry. grok's adapter sets no failKind
// yet, so a grok death never reads as settled (moot for the CLI — RETRIES_ON_PACKET.grok is false).
export function isSettledApiFailure(first: Pick<CodexReviewResult, 'failKind'>): boolean {
  return first.failKind === 'transient-api' || first.failKind === 'usage-limit';
}

// ONE attempt's terminal state: a review only when its reply parsed and the seat did not time out
// (a cut-off review is not trusted even if it partly parsed). `ok` is NOT this — codex returns ok
// with a reply that does not parse — so the retry rule below asks this, never `ok`.
function attemptTerminalState(
  result: Pick<CodexReviewResult, 'raw' | 'timedOut'>,
  parsed: ParsedReview | null = result.raw ? parseFindings(result.raw) : null
): TerminalState {
  return parsed && !parsed.parseError && !result.timedOut ? 'reviewed' : 'failed-reviewer';
}

// THE one rule for "a worktree attempt re-runs on the diff-only packet" — runCoreSeat's own
// decision, whole, exported so a consumer that composes its own seats (the Munin dashboard) applies
// the same one: only after a FAILED attempt (the terminal state persistAttempt records), never
// after a timeout (a second full budget to learn nothing), never after a settled API failure, and
// only for a seat whose sandbox is the unproven mechanism (RETRIES_ON_PACKET).
export function packetRetryAfterWorktree(
  first: Pick<CodexReviewResult, 'failKind' | 'raw' | 'timedOut'>,
  retryOnPacket: boolean
): boolean {
  return (
    retryOnPacket &&
    attemptTerminalState(first) === 'failed-reviewer' &&
    !first.timedOut &&
    !isSettledApiFailure(first)
  );
}

// Only the codex seat re-runs on the packet after a failed worktree attempt: its wrapper is the
// unproven mechanism this phase introduces (spec Open questions — "fail closed to packet per seat
// only on PROVEN breakage"), and a real review under it is the proof the spec asks for. grok's
// `ensemble-review` profile is already proven in production, so a grok failure there is a reviewer
// failure, not a sandbox-viability signal — retrying would double a 12-minute review for no
// evidence gain.
// claude: like grok, its fence (the capability fence) is a proven mechanism, not the
// unproven wrapper this retry exists to prove — a claude failure is a reviewer failure.
// Frozen: the engine's own runs read this table, so a consumer that imports it reads the policy and
// can never rewrite it for the process.
export const RETRIES_ON_PACKET: Readonly<Record<ReviewerId, boolean>> = Object.freeze({
  claude: false,
  codex: true,
  grok: false,
});
