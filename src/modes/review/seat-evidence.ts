import type { EgressDenial } from '../../core/egress-proxy';
import type { ReviewerConfig, ReviewerId } from '../../core/types';
import {
  CODEX_SANDBOX_PROFILE,
  codexSandboxSupported,
  defaultCodexSandboxPaths,
  QUALIFY_PROBE_PORT,
  renderCodexSandboxProfile,
} from '../../reviewers/codex-sandbox';
import {
  GROK_CLI_SANDBOX,
  GROK_SANDBOX_PROFILE,
  resolveReviewSandbox,
} from '../../reviewers/grok';

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
    // A DRY RUN over the read roots. The real proxy port is bound at spawn (it is ephemeral, per
    // run), so qualification renders against QUALIFY_PROBE_PORT — the port never affects whether the
    // read roots are safe, which is the only question this check answers.
    renderCodexSandboxProfile(defaultCodexSandboxPaths(worktree, QUALIFY_PROBE_PORT));
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
  // Compared against the CLI sandbox NAME, not the receipt's profile id: since codex-f3 the id also
  // names the egress fence (`+proxy-env-noshell`), which grok's own sandbox schema cannot express.
  if (resolved !== GROK_CLI_SANDBOX) {
    return {
      profile,
      qualified: false,
      reason: `grok: resolved to the "${resolved}" sandbox, but worktree access is only qualified under "${GROK_CLI_SANDBOX}" (the profile whose id+version the receipt attests). The seat keeps the packet.`,
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
  // The Anthropic registry seat qualifies exactly like the CLI's claude layer:
  // the capability fence (tools removed, strict MCP, neutral cwd, $HOME
  // read-denied) is CLI-flag-based — no kernel wrapper, no platform dependency.
  claude: () => qualifyHarnessSeat(),
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
//
// EGRESS DENIALS RIDE THE FOOTER (codex-f3, §6). A seat that tried to reach a host outside its
// vendor allowlist is the exact event this fence exists to catch, and burying it in a run artifact
// nobody opens would make the fence silent. Hosts are DEDUPED and NAMED — a retry storm against one
// host is one fact, not forty.
export function formatEvidenceFooter(
  realized: EvidenceMap,
  egressDenials: readonly EgressDenial[] = []
): string {
  const seats = Object.entries(realized) as [EvidenceSeat, EvidenceClass][];
  if (seats.length === 0) return '';
  const parts = seats.map(([seat, cls]) => `${seat} ${cls}`);
  const degraded = seats.some(([, cls]) => cls === 'packet');
  const line = `evidence: ${parts.join(' · ')}${degraded ? ' (DEGRADED — a seat fell back to the diff-only packet)' : ''}`;
  return egressDenials.length === 0 ? line : `${line}\n${formatEgressDenials(egressDenials)}`;
}

// PURE: the denial line. Exported so the artifact writer and the footer say the same thing.
export function formatEgressDenials(denials: readonly EgressDenial[]): string {
  const hosts = [...new Set(denials.map((d) => d.host))].sort();
  return `egress fence: ${denials.length} connection(s) DENIED to ${hosts.length} host(s) outside the vendor allowlist — ${hosts.join(', ')}. A seat reached for a host it is not permitted to reach; review the run's egress-denials.json.`;
}

// PURE: the live run-log rollup — per-host:port counts, biggest first. The per-connection
// prints used to BE this rollup (~400 identical lines on one retry storm, run
// 2026-07-23-15-36-50); now seatDenialPrinter emits one line per distinct host and this line
// carries the counts. Hosts past the cap are counted, never silently dropped —
// egress-denials.json still holds every connection.
export function formatEgressDenialCounts(
  denials: readonly EgressDenial[],
  maxHosts = 6
): string {
  const counts = new Map<string, number>();
  for (const d of denials) {
    const key = `${d.host}:${d.port}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const ordered = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
  const shown = ordered.slice(0, maxHosts).map(([host, n]) => `${host} ×${n}`);
  const hidden = ordered.length - shown.length;
  return `${denials.length} connection(s) DENIED — ${shown.join(' · ')}${
    hidden > 0 ? ` · +${hidden} more host(s) (see egress-denials.json)` : ''
  }`;
}
