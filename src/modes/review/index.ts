import { writeTrailFile } from '../../core/artifacts';
import {
  type ConventionManifest,
  type ConventionReader,
  gatherConventions,
} from '../../core/conventions';
import type { EgressDenial } from '../../core/egress-proxy';
import {
  assembleCodePacket,
  PACKET_BUDGETS,
  reviewerVisibleDiff,
} from '../../core/packet';
import { renderReviewPrompt } from '../../core/prompt';
import { loadReviewers } from '../../core/reviewers';
import {
  CORE_REVIEWER_IDS,
  type ReviewerConfig,
  type ReviewerId,
  type StoredReview,
} from '../../core/types';
import { REVIEW_ADAPTERS } from '../../reviewers/registry';

import {
  acquireDiff,
  type AcquiredDiff,
  DEFAULT_COVERAGE_CEILING,
  type DiffMode,
} from './diff';
import {
  type DepSurfaceResult,
  scanDependencySurface,
} from './dep-surface';
import type {
  EvidenceMap,
  EvidenceSeat,
  SandboxProfileMap,
} from './evidence';
import { persistGatePacket } from './gate-hunks';
import { type ReviewProfile, SECURITY_OBJECTIVE } from './profile';
import {
  buildDiffReceipt,
  type DiffReviewReceipt,
  defaultReceiptStore,
} from './receipt';
import {
  intendedEvidenceFor,
  qualifyHarnessSeat,
  SEAT_QUALIFIERS,
  type SeatQualifications,
  sandboxProfilesFor,
  worktreePromptSuffix,
} from './seat-evidence';
import {
  type ReviewAdapter,
  RETRIES_ON_PACKET,
  runCoreSeat,
} from './seat-run';
import { scanDiffForSecrets, type SecretScanResult } from './secret-scan';

// The detached, read-only worktree of the PR head this run materialized (spec §1) — one per run,
// shared by every seat, owned and reaped by the CALLER. Its presence is the request for worktree
// evidence. `baseSha` is the range the seats are told the change spans; it is prompt context, never
// a receipt field (the receipt's own baseSha comes from the acquired diff).
export interface WorktreeEvidence {
  baseSha: string | null;
  dir: string;
  headSha: string;
}

// What the run intended, what it realized, and the fences it named — the receipt's evidence
// identity (spec §8), computed for the CORE seats this mode owns. The caller folds in the
// Anthropic seats (`claude`, `gate`) it owns.
export interface ReviewEvidence {
  // Every connection the run's per-vendor egress proxies REFUSED (codex-f3). Empty on a clean run.
  // Non-empty means a seat reached for a host outside its allowlist — surfaced on stderr as it
  // happened, written to `egress-denials.json`, and stated in the posted review's footer.
  egressDenials: EgressDenial[];
  // Every LOUD per-seat degradation: an unqualified sandbox, or a wrapper that provably broke.
  fallbacks: string[];
  intended: EvidenceMap;
  realized: EvidenceMap;
  sandboxProfiles: SandboxProfileMap;
}

export interface ReviewModeOptions {
  // The per-reviewer invocation adapters. Defaults to the real vendor CLIs (REVIEW_ADAPTERS);
  // injected in tests so the seat wiring (spawn cwd, sandbox qualification, realized evidence) is
  // exercised without spawning codex or grok.
  adapters?: Record<ReviewerId, ReviewAdapter>;
  agentsMd?: string;
  allowSensitive?: boolean;
  authorSummary?: string;
  base?: string;
  ceilingBytes?: number;
  // Cap (bytes) on the gathered conventions text (default in gatherConventions).
  conventionCapBytes?: number;
  // Explicit convention paths (`.ensemble-ai.json` / `--conventions`) — additive.
  conventionPaths?: string[];
  // The reader the conventions gatherer resolves the repo's md web through — fs for
  // local mode, gh for a `--pr <url>`. Absent OR noConventions → the packet keeps
  // opts.agentsMd (or nothing). One gatherer, injected I/O = no drift with the dashboard.
  conventionReader?: ConventionReader | null;
  cwd: string;
  // Mode label for a pre-supplied diffText (e.g. a `gh pr diff` capture → 'pr').
  diffMode?: DiffMode;
  diffText?: string;
  // Override the headSha for a pre-supplied diffText (a URL PR's resolved head SHA,
  // so the receipt is content-tied to the exact PR head). See AcquireDiffOpts.
  headShaOverride?: string;
  // Opt out of convention gathering entirely (`--no-conventions`).
  noConventions?: boolean;
  objective?: string;
  onProgress?: (msg: string) => void;
  out: string;
  // The review PROFILE: 'code' (default, general review) or 'security' (a
  // security-auditor framing + the local dependency-surface flag). A profile is a
  // thin variation — the engine, coverage, spawn, parse, and receipt are unchanged.
  profile?: ReviewProfile;
  receiptStore?: string;
  reviewers?: ReviewerId[];
  reviewersFile?: string;
  runId: string;
  // Override the reviewer sandbox profile (CLI `--sandbox`). The grok adapter
  // still pins it to a deny-by-default profile (a weaker value falls back), so
  // this can tighten but never weaken the boundary.
  sandbox?: string;
  // Review staged changes (`git diff --cached`) vs HEAD.
  staged?: boolean;
  workingTree?: boolean;
  // The Anthropic seats the CALLER will run after this mode returns (`claude`, `gate`). They are
  // part of the run's evidence INTENT — and therefore of `policyHash` — but this mode never spawns
  // them, so it records their intent and the caller records what they realized.
  peerSeats?: readonly EvidenceSeat[];
  // The materialized worktree (spec §1). Absent ⇒ every seat reviews the packet, the receipt hashes
  // under the legacy (v1) schema, and nothing about the packet path changes.
  worktree?: WorktreeEvidence;
}

export interface ReviewModeResult {
  acquired: AcquiredDiff;
  blocked: boolean;
  blockedReason?: string;
  // The gathered-conventions manifest (which convention files the reviewers saw,
  // which were truncated/omitted over the cap) — present when gathering ran.
  conventionManifest?: ConventionManifest;
  // The local dependency-surface scan — present ONLY for the 'security' profile
  // (manifest changes + risky imports drawn from the diff; no network).
  depSurface?: DepSurfaceResult;
  // The run's per-seat evidence identity for the CORE seats (intent, fact, and the sandbox profiles
  // that fenced them). Present on every non-blocked run; all-`packet` in packet mode.
  evidence?: ReviewEvidence;
  // The pinned REVIEWER-VISIBLE diff — the exact bytes every reviewer saw in the packet. The
  // Anthropic seats have no shell under the capability fence, so they cannot run `git diff`: the
  // engine hands them this. Same bytes as the persisted gate packet, so a seat, the gate, and the
  // trail can never disagree about what the change was. Absent only on a secret-scan block.
  pinnedDiff?: string;
  // The exact rendered prompt every core reviewer saw (byte-identical across reviewers) —
  // returned so the self-contained layer's cold Opus reviewer reviews the SAME pinned
  // packet, never a re-derived diff. Absent only on a secret-scan block (no packet built).
  prompt?: string;
  receipt?: DiffReviewReceipt;
  // The receipt the core (codex/grok) QUALIFIED but that is deliberately NOT yet written:
  // when the default-on Opus reviewer is expected, the caller writes the receipt only
  // AFTER that reviewer also completes (fail-loud parity with the exit gate), stamping the
  // peer reviewer in — so an incomplete 3-reviewer run can never leave a clean receipt.
  receiptCandidate?: DiffReviewReceipt;
  receiptError?: string;
  receiptPath?: string;
  // The resolved receipt store dir (where the caller writes receiptCandidate).
  receiptStore?: string;
  reviews: StoredReview[];
  secretScan: SecretScanResult;
}

// The default `code`-profile review objective. Exported so the `diff` plumbing
// command assembles the SAME packet the engine would send — one objective string,
// no drift between the preview and the real review.
export const DEFAULT_OBJECTIVE =
  'Adversarial cross-vendor review of a code diff — find correctness, security, and convention issues a same-vendor author might miss.';

// Which sandbox each CORE seat qualifies for against THIS run's worktree (spec §2). Computed once,
// before any seat spawns, so an unsafe read root or an unsupported platform is a legible pre-flight
// fact rather than a discovery made after a 12-minute review.
function qualifyCoreSeats(
  reviewers: readonly ReviewerId[],
  worktree: string,
  configs: Record<ReviewerId, ReviewerConfig>
): SeatQualifications {
  const quals: SeatQualifications = {};
  for (const id of reviewers) {
    quals[id] = SEAT_QUALIFIERS[id]({ config: configs[id], worktree });
  }
  return quals;
}

// The review MODE end-to-end: acquire the diff (+ identity + coverage + digest) →
// secret-scan the payload (fail-closed unless allowSensitive) → assemble the
// bounded packet → run each reviewer READ-ONLY under the watchdog → parse + write
// the per-reviewer trail → build + write the content-tied receipt when the review
// qualifies. Emits FACTS (findings + execution status + coverage + receipt) — never
// a gate verdict; the gate policy is the consumer's.
export async function runReviewMode(
  opts: ReviewModeOptions
): Promise<ReviewModeResult> {
  const log = opts.onProgress ?? (() => {});
  const ceilingBytes = opts.ceilingBytes ?? DEFAULT_COVERAGE_CEILING;
  const profile: ReviewProfile = opts.profile ?? 'code';
  const reviewers =
    opts.reviewers && opts.reviewers.length > 0
      ? opts.reviewers
      : [...CORE_REVIEWER_IDS];

  const sourceLabel = opts.diffText !== undefined
    ? (opts.diffMode ?? 'raw')
    : opts.staged
      ? 'staged'
      : opts.workingTree
        ? 'working-tree'
        : 'commit';
  log(`Acquiring diff (${sourceLabel} mode)…`);
  const acquired = acquireDiff({
    base: opts.base,
    ceilingBytes,
    cwd: opts.cwd,
    diffMode: opts.diffMode,
    diffText: opts.diffText,
    headShaOverride: opts.headShaOverride,
    staged: opts.staged,
    workingTree: opts.workingTree,
  });
  log(
    `Diff: ${acquired.coverage.totalFiles} file(s), ${acquired.coverage.includedFiles} covered, ${acquired.coverage.omittedFiles} omitted · digest ${acquired.canonicalDigest.slice(0, 19)}…`
  );

  // The security profile adds a LOCAL dependency-surface flag over the FULL parsed
  // diff (manifest changes + risky imports) — no network, computed once and surfaced
  // in every return path (including a secret-scan block) so the reader always sees it.
  const depSurface =
    profile === 'security' ? scanDependencySurface(acquired.files) : undefined;

  // Secret-scan the FULL canonical diff (the change identity), not just the
  // covered subset — the payload + the manifest must reflect the whole change.
  // (acquireDiff already parsed these files for coverage — reuse, don't re-parse.)
  const secretScan = scanDiffForSecrets(acquired.files, {
    allowSensitive: opts.allowSensitive,
  });
  if (secretScan.blocked) {
    const paths = [
      ...secretScan.sensitivePaths.map((p) => `${p.path} (${p.label})`),
      ...secretScan.inlineSecrets.map((s) => `${s.path} (${s.label})`),
    ];
    const reason = `diff carries sensitive content: ${paths.join(', ')} — pass --allow-sensitive to review anyway`;
    log(`BLOCKED — ${reason}`);
    return {
      acquired,
      blocked: true,
      blockedReason: reason,
      depSurface,
      reviews: [],
      secretScan,
    };
  }

  // Gather the repo's convention web (root + touched packages + the linked/swept md)
  // through the injected reader — the SAME pure gatherer the dashboard calls. Feeds
  // the packet's conventions slot; a NAMED-truncated set beats today's empty one.
  // Falls back to opts.agentsMd when gathering is off or yields nothing.
  let agentsMd = opts.agentsMd;
  let conventionManifest: ConventionManifest | undefined;
  if (!opts.noConventions && opts.conventionReader) {
    const changed = acquired.files
      .map((f) => f.path)
      .filter((p) => p && p !== 'unknown');
    const gathered = await gatherConventions(opts.conventionReader, changed, {
      capBytes: opts.conventionCapBytes,
      conventions: opts.conventionPaths,
    });
    if (gathered.text.trim()) agentsMd = gathered.text;
    conventionManifest = gathered.manifest;
    const inc = gathered.manifest.files.filter((f) => f.included).length;
    log(
      `Conventions: ${inc}/${gathered.manifest.files.length} file(s), ${gathered.manifest.totalBytes} bytes gathered`
    );
  }

  const packet = assembleCodePacket({
    agentsMd,
    authorSummary: opts.authorSummary,
    diff: acquired.diff,
    objective:
      opts.objective ??
      (profile === 'security' ? SECURITY_OBJECTIVE : DEFAULT_OBJECTIVE),
    pr: 0,
    repo: acquired.repoId ?? '',
  });
  const prompt = renderReviewPrompt(packet, profile);
  if (!packet.complete) {
    log('Packet incomplete (no usable diff) — persisting an empty review.');
  }

  // Materialize the PINNED gate packet ONCE per run: the exact REVIEWER-VISIBLE diff (the
  // packet's diff-section body — head+tail-truncated over PACKET_BUDGETS.diff, exactly what every
  // reviewer saw in the prompt) + the head SHA it was resolved at. Pinning the reviewer-visible
  // bytes (NOT the full pre-truncation acquired.diff) is the binding fix (grok-f1/codex-f3): a
  // citation into bytes the reviewers did NOT see can never validate a dismissal. The verified
  // gate's hunk-resolver + citation-validator read ONLY this artifact (never the working tree),
  // so a tree that mutates between the run and the gate can change no authority outcome.
  // Best-effort — a failure just means the gate later reads no packet and degrades
  // all-`unverified` (fail-closed).
  const pinnedDiff = reviewerVisibleDiff(packet).text;
  try {
    persistGatePacket(opts.out, opts.runId, {
      diff: pinnedDiff,
      headSha: acquired.headSha,
    });
  } catch {
    /* trail write is best-effort — the gate fails closed if the packet is absent */
  }

  log(`Running ${reviewers.length} reviewer(s): ${reviewers.join(', ')}…`);
  // Load the reviewers config ONCE per run (a file read + JSON parse), then index
  // it per reviewer — not once per reviewer inside the fan-out.
  const resolved = loadReviewers(opts.reviewersFile);
  const configs = Object.fromEntries(
    reviewers.map((id) => [
      id,
      { ...resolved[id], ...(opts.sandbox ? { sandbox: opts.sandbox } : {}) },
    ])
  ) as Record<ReviewerId, ReviewerConfig>;

  // WORKTREE EVIDENCE MODE (spec §1–§2). The worktree's presence is the request; qualification
  // decides, per seat, whether the request is granted. The worktree prompt is the pinned packet
  // prompt PLUS the whole-project preamble — a packet seat never sees it.
  const wt = opts.worktree;
  const quals = wt ? qualifyCoreSeats(reviewers, wt.dir, configs) : {};
  const worktreePrompt = wt
    ? prompt + worktreePromptSuffix({ baseSha: wt.baseSha, headSha: wt.headSha, worktree: wt.dir })
    : undefined;
  if (wt) {
    log(`Worktree evidence: ${wt.dir} (detached at ${wt.headSha.slice(0, 12)})`);
  }

  const adapters = opts.adapters ?? REVIEW_ADAPTERS;
  const seatRuns = await Promise.all(
    reviewers.map(async (id) => {
      const reviewer = configs[id];
      log(`  · ${id} (${reviewer.vendor} · ${reviewer.model})…`);
      const seat = await runCoreSeat({
        adapter: adapters[id],
        log,
        out: opts.out,
        packet,
        packetComplete: packet.complete,
        packetPrompt: prompt,
        qualification: quals[id],
        retryOnPacket: RETRIES_ON_PACKET[id],
        reviewer,
        runId: opts.runId,
        ...(wt ? { worktree: wt.dir, worktreePrompt } : {}),
      });
      log(
        `  · ${id}: ${seat.review.terminalState} — ${seat.review.findings.length} finding(s) · evidence ${seat.realized}`
      );
      return [id, seat] as const;
    })
  );
  const reviews = seatRuns.map(([, seat]) => seat.review);

  // The evidence identity (spec §8). INTENT covers every seat the caller asked for — including the
  // Anthropic seats it will run itself — because `policyHash` binds intent and must not vary with a
  // runtime fallback: "has this diff been reviewed at full quality?" has to be askable before the
  // outcome is known. FACT is what the core seats realized; the caller folds in its own.
  const intended = wt
    ? intendedEvidenceFor([...reviewers, ...(opts.peerSeats ?? [])])
    : {};
  const sandboxProfiles = wt
    ? sandboxProfilesFor({
        ...quals,
        ...Object.fromEntries((opts.peerSeats ?? []).map((s) => [s, qualifyHarnessSeat()])),
      })
    : {};
  const realized: EvidenceMap = {};
  const fallbacks: string[] = [];
  const egressDenials: EgressDenial[] = [];
  for (const [id, seat] of seatRuns) {
    realized[id] = seat.realized;
    if (seat.fallbackReason) fallbacks.push(seat.fallbackReason);
    egressDenials.push(...seat.egressDenials);
  }
  // THE DENIAL ARTIFACT (codex-f3 §6). Written whenever the fence refused anything, so the run's
  // trail carries the evidence a footer line can only summarize. Best-effort, like every other trail
  // write — the denial already reached stderr the instant it happened, and the footer restates it.
  if (egressDenials.length > 0) {
    log(`  · ⚠ egress fence: ${egressDenials.length} connection(s) DENIED`);
    try {
      writeTrailFile(opts.out, opts.runId, 'egress-denials.json', JSON.stringify(egressDenials, null, 2));
    } catch {
      /* trail write is best-effort — stderr + the footer already carry the denial */
    }
  }
  const evidence: ReviewEvidence = { egressDenials, fallbacks, intended, realized, sandboxProfiles };

  // Build the content-tied receipt — only when every required reviewer completed
  // AND coverage has no omitted source file (else no receipt; the reason is
  // reported, the gate stays the consumer's).
  const built = buildDiffReceipt({
    baseRef: acquired.baseRef,
    baseSha: acquired.baseSha,
    coverage: acquired.coverage,
    coveragePolicy: { ceilingBytes },
    diffDigest: acquired.canonicalDigest,
    diffMode: acquired.mode,
    // The covered diff is truncated in the packet when it exceeds the diff budget;
    // a truncated payload must not qualify a receipt (the reviewer saw head+tail).
    diffTruncated: acquired.diff.length > PACKET_BUDGETS.diff,
    headSha: acquired.headSha,
    // An all-packet run passes empty maps ⇒ a legacy (v1) receipt, byte-identical to what shipped
    // before evidence identity existed. Any worktree seat ⇒ v2. The realized map here covers the
    // CORE seats only; the caller stamps the Anthropic seats in before writing (realizedEvidence is
    // never hashed, so folding it in afterwards cannot move the receipt key).
    intendedEvidence: intended,
    realizedEvidence: realized,
    repo: acquired.repoId,
    required: reviewers,
    reviews,
    runId: opts.runId,
    sandboxProfiles,
  });
  if (built.ok && built.receipt) {
    // The core (codex/grok) QUALIFIES the receipt here, but writing is DEFERRED to the
    // caller: the default-on Opus reviewer + synthesis run AFTER this, and a receipt must
    // never be persisted before the full expected roster completed (else a failed/skipped
    // Opus leaves a clean 'reviewed' receipt for an incomplete run — the fail-open). The
    // caller writes receiptCandidate once the roster is verified complete.
    const store = opts.receiptStore ?? defaultReceiptStore();
    log('Receipt qualified by the core — deferred to the full-roster gate.');
    return { acquired, blocked: false, conventionManifest, depSurface, evidence, pinnedDiff, prompt, receiptCandidate: built.receipt, receiptStore: store, reviews, secretScan };
  }
  log(`No receipt — ${built.error}`);
  return { acquired, blocked: false, conventionManifest, depSurface, evidence, pinnedDiff, prompt, receiptError: built.error, reviews, secretScan };
}
