import { persistReview } from '../../core/artifacts';
import { parseFindings } from '../../core/findings';
import type { assembleCodePacket } from '../../core/packet';
import type {
  ReviewerConfig,
  ReviewerId,
  StoredReview,
  TerminalState,
} from '../../core/types';
import type { CodexReviewResult, RunReviewOpts } from '../../reviewers/codex';

import type { EvidenceClass } from './evidence';
import type { SeatQualification } from './seat-evidence';

// ONE CORE SEAT (codex / grok), run with the evidence its policy qualified it for, and its trail
// artifact persisted. This is where INTENT becomes FACT: the returned `realized` class is what the
// receipt records, and it is derived from what actually ran — never from what was asked for.

export type ReviewAdapter = (
  prompt: string,
  config: ReviewerConfig,
  opts?: RunReviewOpts
) => Promise<CodexReviewResult>;

export interface SeatRunResult {
  // Why this seat did not get the worktree it was asked for (unqualified sandbox, or a wrapper
  // that provably broke). Null when nothing degraded. LOUD by contract — the caller prints it,
  // the receipt records the weaker realized class, and the posted footer states it.
  fallbackReason: string | null;
  realized: EvidenceClass;
  review: StoredReview;
}

export interface RunCoreSeatArgs {
  adapter: ReviewAdapter;
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

// Invoke the adapter once, isolating a per-seat failure (a CLI binary that can't be resolved
// throws) into a recorded failure rather than a rejected fan-out.
async function adapterOnce(
  adapter: ReviewAdapter,
  prompt: string,
  reviewer: ReviewerConfig,
  opts: RunReviewOpts
): Promise<CodexReviewResult> {
  try {
    return await adapter(prompt, reviewer, opts);
  } catch (e) {
    return { ok: false, raw: null, stderrTail: (e as Error).message, timedOut: false };
  }
}

// Parse + persist one attempt's reply as this seat's trail artifact. A watchdog timeout or a parse
// failure marks the reviewer failed-reviewer: a cut-off review is not trusted even if it partly
// parsed. A re-run (the packet fallback) overwrites the failed attempt's artifacts, so the trail
// always describes the review that actually counted.
function persistAttempt(
  args: RunCoreSeatArgs,
  prompt: string,
  result: CodexReviewResult
): StoredReview {
  const parsed = result.raw ? parseFindings(result.raw) : null;
  const terminalState: TerminalState =
    parsed && !parsed.parseError && !result.timedOut ? 'reviewed' : 'failed-reviewer';
  // A seat that produced NOTHING says why (its stderr tail) — under a sandbox wrapper that is the
  // difference between "the model had nothing to say" and "the profile killed the process".
  const summary = result.timedOut
    ? 'The reviewer timed out before completing — its output is incomplete and not trusted.'
    : parsed?.summary ||
      `The ${args.reviewer.id} reviewer produced no parseable findings: ${result.stderrTail.trim().slice(0, 300) || 'no output'}`;
  return persistReview(args.out, {
    findings: parsed?.findings ?? [],
    packet: args.packet,
    prompt,
    raw: result.raw,
    reviewer: args.reviewer,
    runId: args.runId,
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
      fallbackReason: null,
      realized: 'packet',
      review: persistReview(args.out, {
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
    const result = await adapterOnce(args.adapter, args.packetPrompt, reviewer, {});
    return {
      fallbackReason: unqualified,
      realized: 'packet',
      review: persistAttempt(args, args.packetPrompt, result),
    };
  }

  // WORKTREE MODE — the seat runs in the tree, under the profile its qualification named.
  const first = await adapterOnce(args.adapter, args.worktreePrompt, reviewer, { worktree: wt });
  const review = persistAttempt(args, args.worktreePrompt, first);
  if (review.terminalState === 'reviewed') {
    return { fallbackReason: null, realized: 'worktree', review };
  }
  // A TIMEOUT is not a sandbox-viability signal — the seat ran under its profile and simply did not
  // finish. Re-running it on the packet would spend a second full review budget to learn nothing,
  // so the failed seat stands (and, having completed no review, it cannot qualify a receipt).
  if (first.timedOut || !args.retryOnPacket) {
    return { fallbackReason: null, realized: 'worktree', review };
  }
  // PROVEN BREAKAGE (§9 grok-f2, spec §2's codex branch): the wrapper's viability check IS this
  // real review run, and it produced nothing usable. Fall back to the packet, LOUDLY — this seat
  // now runs BELOW the ratified acceptance bar (packet < the manual whole-repo baseline), which is
  // Oskar's ratification call to accept, never a silent downgrade.
  const why = first.stderrTail.trim().slice(0, 300) || 'no output';
  const reason = `${reviewer.id}: the worktree seat produced no usable review under its \`${args.qualification.profile.id}\` sandbox (${why}) — FELL BACK to the diff-only packet. This seat reviewed less than it would have in-project.`;
  log(`  · ⚠ ${reason}`);
  const second = await adapterOnce(args.adapter, args.packetPrompt, reviewer, {});
  return {
    fallbackReason: reason,
    realized: 'packet',
    review: persistAttempt(args, args.packetPrompt, second),
  };
}

// Only the codex seat re-runs on the packet after a failed worktree attempt: its wrapper is the
// unproven mechanism this phase introduces (spec Open questions — "fail closed to packet per seat
// only on PROVEN breakage"), and a real review under it is the proof the spec asks for. grok's
// `ensemble-review` profile is already proven in production, so a grok failure there is a reviewer
// failure, not a sandbox-viability signal — retrying would double a 12-minute review for no
// evidence gain.
export const RETRIES_ON_PACKET: Record<ReviewerId, boolean> = { codex: true, grok: false };
