import type { ReviewerConfig, ReviewerId } from '../../core/types';
import {
  CODEX_SANDBOX_PROFILE,
  codexSandboxSupported,
  defaultCodexSandboxPaths,
  renderCodexSandboxProfile,
} from '../../reviewers/codex-sandbox';
import { GROK_SANDBOX_PROFILE, resolveReviewSandbox } from '../../reviewers/grok';

import { CLAUDE_CAPABILITY_FENCE } from './claude';
import type {
  EvidenceClass,
  EvidenceMap,
  EvidenceSeat,
  SandboxProfileMap,
  SandboxProfileRef,
} from './evidence';
import { UNTRUSTED_INSTRUCTIONS_CLAUSE } from './worktree';

// SEAT POLICY (spec §2) — "a seat gets the worktree IFF it runs under a deny-by-default
// (repo-rooted, secret-denied) sandbox. Fail closed per seat: no qualifying sandbox → that seat
// keeps the packet."
//
// This module answers, for one run, two separate questions the receipt keeps separate:
//
//   INTENT   — what the caller asked for. Passing the repo location IS the request for worktree
//              evidence, for EVERY seat that runs. Intent must NOT vary with whether a seat's
//              sandbox happens to be available on this machine: `policyHash` binds intent, and §8
//              requires "has this diff been reviewed at full quality?" to be askable BEFORE the
//              outcome is known. A seat that cannot get its sandbox degrades in the REALIZED map.
//   QUALIFY  — can this seat actually get its sandbox here, right now? A `false` here is a
//              fail-closed fallback to the packet, and it is LOUD (stderr + receipt + footer),
//              never silent (§2, §9 grok-f2).
//
// The sandbox profile identity a seat is bound to is the profile its POLICY names — the constant
// exported beside each adapter. Recording it for an intended-worktree seat that fell back is not a
// claim that the seat ran under it: `realizedEvidence` says `packet`, and the two maps are read
// together. It is what makes the receipt KEY stable across a full and a degraded run of the same
// policy, which is the property §8 asks for.

export interface SeatQualification {
  // The profile this seat's policy names. Present even when unqualified — it identifies the fence
  // the policy WOULD have applied, and it is what `sandboxProfiles` hashes into the v2 policyHash.
  profile: SandboxProfileRef;
  qualified: boolean;
  // Why this seat cannot have the worktree here. Null iff qualified. Rendered LOUDLY by callers.
  reason: string | null;
}

// codex: the ensemble-OWNED Seatbelt wrapper. Two ways it cannot apply, both fail-closed:
// the platform has no `sandbox-exec` (Seatbelt is macOS-only), or the profile refuses to build
// because an interpolated read root is `/` or contains `$HOME` (renderCodexSandboxProfile throws
// rather than emit a costume). We render it here — a pure, no-write dry run — so an unsafe root is
// discovered BEFORE the seat is spawned, not after a 12-minute review.
export function qualifyCodexSeat(
  worktree: string,
  deps: { supported?: boolean } = {}
): SeatQualification {
  const profile = CODEX_SANDBOX_PROFILE;
  const supported = deps.supported ?? codexSandboxSupported();
  if (!supported) {
    return {
      profile,
      qualified: false,
      reason: `codex: no qualifying sandbox on ${process.platform} — the \`${profile.id}\` wrapper is Seatbelt (macOS) only, and codex's own \`-s read-only\` restricts writes, not reads. The seat keeps the packet.`,
    };
  }
  try {
    renderCodexSandboxProfile(defaultCodexSandboxPaths(worktree));
  } catch (e) {
    return { profile, qualified: false, reason: `codex: ${(e as Error).message}` };
  }
  return { profile, qualified: true, reason: null };
}

// grok: `ensemble-review` (a `strict` deny-by-default read base + a kernel secret deny-list) is
// already the shape §2 requires; pointing it at the worktree root is config-only. But
// `resolveReviewSandbox` also admits bare `strict`, which lacks the secret deny-list — and the
// receipt would then attest `ensemble-review`, a profile the seat never ran under. Fail closed.
export function qualifyGrokSeat(configuredSandbox?: string): SeatQualification {
  const profile = GROK_SANDBOX_PROFILE;
  const resolved = resolveReviewSandbox(configuredSandbox);
  if (resolved !== profile.id) {
    return {
      profile,
      qualified: false,
      reason: `grok: resolved to the "${resolved}" sandbox, but worktree access is only qualified under "${profile.id}" (the profile whose id+version the receipt attests). The seat keeps the packet.`,
    };
  }
  return { profile, qualified: true, reason: null };
}

// claude + gate: fenced by CAPABILITY, not by the kernel (spec §2, corrected 2026-07-10). The old
// `claude-plan-mode-deny-writes` belt did NOT satisfy §2's deny-by-default predicate — plan mode
// still executes Bash, and the tree's CLAUDE.md was an instruction channel. What qualifies these
// seats now is CLAUDE_CAPABILITY_FENCE: no Bash, no network, no MCP, a neutral cwd, the worktree as
// the sole `--add-dir` read root, and `$HOME` denied to every read tool (see ./claude for the probe
// results behind each clause).
export function qualifyHarnessSeat(): SeatQualification {
  return { profile: CLAUDE_CAPABILITY_FENCE, qualified: true, reason: null };
}

// The per-reviewer qualifier, keyed by id. EXHAUSTIVE over ReviewerId, like REVIEW_ADAPTERS and
// RETRIES_ON_PACKET: TS errors if a new reviewer joins REVIEWER_IDS without an explicit ruling on
// how its sandbox qualifies. A default branch here would be fail-OPEN — the new seat would inherit
// some other vendor's qualifier, be handed the worktree, and attest evidence under a profile it
// never ran behind, which is the one thing the realized-evidence map exists to make impossible.
export const SEAT_QUALIFIERS: Record<
  ReviewerId,
  (args: { config: ReviewerConfig; worktree: string }) => SeatQualification
> = {
  codex: ({ worktree }) => qualifyCodexSeat(worktree),
  grok: ({ config }) => qualifyGrokSeat(config.sandbox),
};

export type SeatQualifications = Partial<Record<EvidenceSeat, SeatQualification>>;

// The INTENT map: every seat that runs is asked for worktree evidence. Independent of
// qualification, on purpose (see the header).
export function intendedEvidenceFor(seats: readonly EvidenceSeat[]): EvidenceMap {
  const map: EvidenceMap = {};
  for (const seat of seats) map[seat] = 'worktree';
  return map;
}

export function sandboxProfilesFor(quals: SeatQualifications): SandboxProfileMap {
  const map: SandboxProfileMap = {};
  for (const [seat, q] of Object.entries(quals) as [EvidenceSeat, SeatQualification][]) {
    map[seat] = q.profile;
  }
  return map;
}

// ── The seat prompt's worktree preamble ───────────────────────────────────────────────

// PURE: what a worktree-fed CODEX/GROK seat is told, appended to the pinned packet prompt. The
// packet stays the change under review (and the gate still grounds citations against the pinned
// reviewer-visible diff); the preamble adds what the packet structurally cannot carry — the whole
// project, on disk, at `headSha`. It is the seat's cwd, so its file tools reach it with no path.
//
// It carries the SAME untrusted-instruction clause as the three Anthropic prompts, and it is the
// seat class that needs it most: unlike the fenced Anthropic seats, codex runs with its internal
// sandbox off (`--dangerously-bypass-approvals-and-sandbox`) and therefore holds a live shell inside
// the untrusted tree, bounded only by a Seatbelt profile that grants outbound :443. The strip closes
// the FILE instruction channel (CLAUDE.md, AGENTS.md, …); nothing but this clause addresses
// directions embedded in an ordinary source file the seat reads.
//
// Encoded as data so a unit test pins the exact contract, like every other prompt in this engine.
export function worktreePromptSuffix(args: {
  baseSha: string | null;
  headSha: string;
  worktree: string;
}): string {
  const range = args.baseSha
    ? `\nThe change under review is exactly: git diff ${args.baseSha}...${args.headSha}`
    : '';
  return `

## Whole-project evidence — you are running inside the project

The full project at the PR head is checked out READ-ONLY at ${args.worktree} (detached at ${args.headSha}), and it is your working directory.${range}
Read any file there for whole-project context: a finding may cite an UNCHANGED file (a reinvented
utility, a convention the diff drifts from). You may not edit, stage, or push anything — the
worktree is a throwaway the review reaps, and this is someone else's pull request.

${UNTRUSTED_INSTRUCTIONS_CLAUSE}

Anchor every finding at file:line as it exists at ${args.headSha}.`;
}

// ── Loud surfacing (§2, §8, §9 grok-f2) ───────────────────────────────────────────────

// The one-line evidence statement for the posted review's footer + the receipt reader. A run where
// any seat fell back is NEVER rendered as a full-worktree run.
export function formatEvidenceFooter(realized: EvidenceMap): string {
  const seats = Object.entries(realized) as [EvidenceSeat, EvidenceClass][];
  if (seats.length === 0) return '';
  const parts = seats.map(([seat, cls]) => `${seat} ${cls}`);
  const degraded = seats.some(([, cls]) => cls === 'packet');
  return `evidence: ${parts.join(' · ')}${degraded ? ' (DEGRADED — a seat fell back to the diff-only packet)' : ''}`;
}
