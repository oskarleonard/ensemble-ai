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
  section,
} from '../../core/packet';
import { renderReviewPrompt } from '../../core/prompt';
import { loadReviewers } from '../../core/reviewers';
import { scrubControl } from '../../core/sanitize';
import {
  CORE_REVIEWER_IDS,
  type ReviewerConfig,
  type ReviewerId,
  type StoredReview,
} from '../../core/types';
import { REVIEW_ADAPTERS } from '../../reviewers/registry';

import { type ChunkSeatRun, mergeChunkSeatRuns } from './chunk-merge';
import {
  CHUNKS_TRAIL_FILE,
  CHUNKS_TRAIL_SCHEMA_VERSION,
  type ChunksTrail,
  type ChunkTrailEntry,
  DEFAULT_MAX_CHUNKS,
  renderChangeScope,
  renderLensScope,
} from './chunks';
import { CI_EVIDENCE_BOTH_REASON, CI_EVIDENCE_TRAIL_FILE, resolveCiEvidence } from './ci-evidence';
import {
  acquireDiff,
  type AcquiredDiff,
  DEFAULT_COVERAGE_CEILING,
  type DiffMode,
  isTestPath,
  worktreeFirstLineReader,
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
  formatEgressDenialCounts,
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
import { resolveGitleaksExemptions } from './gitleaks-allowlist';
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
  // CI evidence for the PR head (modes/review/ci-evidence.ts) — the rendered text, or the reason a
  // fetch failed. Either one makes the packet render its CI section (loud when unavailable).
  // The two are MUTUALLY EXCLUSIVE: evidence, or the reason there is none — never both.
  ciEvidence?: string;
  ciEvidenceUnavailable?: string;
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
  // The author's STATED INTENT for this change — on the `--pr` path, the PR's title + body. It
  // fills the packet's `directive` slot (bounded by PACKET_BUDGETS.objective) so a reviewer can
  // read a deliberate change as deliberate instead of guessing at scope from the diff alone.
  // Absent ⇒ the section is simply not rendered (its absence is not notable, unlike the diff's).
  directive?: string;
  // Override the headSha for a pre-supplied diffText (a URL PR's resolved head SHA,
  // so the receipt is content-tied to the exact PR head). See AcquireDiffOpts.
  headShaOverride?: string;
  // Cap on review PARTS (chunks.ts): a change over the ceiling is reviewed in up to this many
  // packets, each whole. Default DEFAULT_MAX_CHUNKS; files past it are `over-limit`, named.
  maxChunks?: number;
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
  // Override the repo identity (a URL PR's repoIdFromSlug) — the subject repo of a
  // URL-PR review is not the cwd's repo. See AcquireDiffOpts.
  repoIdOverride?: string;
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
  // Called ONCE, the moment the packet is pinned and BEFORE any core seat spawns, with everything
  // the Anthropic producer and the lens need (they depend on the packet, never on the core seats'
  // replies). A caller uses it to START those stages so they overlap the cross-vendor fan-out
  // instead of following it. Not called on a secret-scan block (no packet is built).
  onPacketsReady?: (ready: PacketsReady) => void;
  // The materialized worktree (spec §1). Absent ⇒ every seat reviews the packet, the receipt hashes
  // under the legacy (v1) schema, and nothing about the packet path changes.
  worktree?: WorktreeEvidence;
}

export interface PacketsReady {
  headSha: string;
  lensHandoff?: { diff: string; scope: string };
  parts: ReviewPart[];
  pinnedDiff: string;
  prompt: string;
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
  // The LENS handoff for a review in parts: as much of the union diff as one packet holds (part 1
  // onward, whole parts only) plus the scope listing naming every other changed file. Absent on a
  // single-part review — the lens then gets `pinnedDiff`, which IS the whole change.
  lensHandoff?: { diff: string; scope: string };
  // The review PARTS (chunks.ts): the exact prompt, reviewer-visible diff and scope note each
  // packet carried, in part order. ONE entry on a single-packet review (then `prompt` and
  // `pinnedDiff` are that entry's). The Claude producer reviews these one by one, as the core did.
  parts?: ReviewPart[];
  // The pinned REVIEWER-VISIBLE diff — the exact bytes every reviewer saw in the packet. The
  // Anthropic seats have no shell under the capability fence, so they cannot run `git diff`: the
  // engine hands them this. Same bytes as the persisted gate packet, so a seat, the gate, and the
  // trail can never disagree about what the change was. On a review in parts it is the UNION of
  // every part's diff (what the gate pins). Absent only on a secret-scan block.
  pinnedDiff?: string;
  // The exact rendered prompt every core reviewer saw (byte-identical across reviewers) —
  // returned so the self-contained layer's cold Opus reviewer reviews the SAME pinned
  // packet, never a re-derived diff. On a review in parts: part 1's prompt (see `parts`).
  // Absent only on a secret-scan block (no packet built).
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

// One review PART as the seats were handed it (chunks.ts): the rendered packet prompt, the
// reviewer-visible diff (the packet's diff-section body) and the scope note — what the Claude
// producer needs to review the same part the core did.
export interface ReviewPart {
  diff: string;
  index: number;
  label: string;
  prompt: string;
  // Absent when the change fit one packet and nothing was omitted (no scope section was rendered).
  scope?: string;
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
  // undefined → the default core; an explicit list — INCLUDING an empty one — is the roster as
  // given. `[]` is the claude-only run (resolveReviewRoster): no core seat spawns, the packet,
  // coverage and evidence are built exactly as before for the Anthropic seats that follow, and
  // no content-tied receipt qualifies (buildDiffReceipt refuses an empty core).
  const reviewers = opts.reviewers ?? [...CORE_REVIEWER_IDS];

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
    maxChunks: opts.maxChunks ?? DEFAULT_MAX_CHUNKS,
    // With the tree on disk, a changed file is classed by its OWN first line too (a mid-file hunk
    // of an ORM client shows no `Code generated` header — the file does).
    ...(opts.worktree ? { readFirstLine: worktreeFirstLineReader(opts.worktree.dir) } : {}),
    repoIdOverride: opts.repoIdOverride,
    staged: opts.staged,
    workingTree: opts.workingTree,
  });
  const partCount = acquired.plan.chunks.length;
  log(
    `Diff: ${acquired.coverage.totalFiles} file(s), ${acquired.coverage.includedFiles} covered, ${acquired.coverage.omittedFiles} omitted${
      partCount > 1 ? ` · reviewed in ${partCount} parts (ceiling ${ceilingBytes.toLocaleString('en-US')} bytes)` : ''
    } · digest ${acquired.canonicalDigest.slice(0, 19)}…`
  );
  if (partCount > 1) {
    for (const c of acquired.plan.chunks) {
      log(`  · part ${c.index}/${partCount}: ${c.label} — ${c.paths.length} file(s), ${c.bytes.toLocaleString('en-US')} bytes`);
    }
    if (acquired.plan.overflow.length > 0) {
      log(
        `  · ⚠ ${acquired.plan.overflow.length} file(s) past the ${opts.maxChunks ?? DEFAULT_MAX_CHUNKS}-part limit are NOT reviewed (named in coverage as over-limit; raise --max-chunks)`
      );
    }
  }

  // The security profile adds a LOCAL dependency-surface flag over the FULL parsed
  // diff (manifest changes + risky imports) — no network, computed once and surfaced
  // in every return path (including a secret-scan block) so the reader always sees it.
  const depSurface =
    profile === 'security' ? scanDependencySurface(acquired.files) : undefined;

  // Secret-scan the FULL canonical diff (the change identity) so the manifest
  // reflects the whole change — but only a hit in a COVERED file can block: an
  // omitted file's bytes never reach a vendor (the packet carries acquired.diff,
  // the covered subset; the raw diff feeds the digest only).
  // (acquireDiff already parsed these files for coverage — reuse, don't re-parse.)
  //
  // Two passes, the second only when the first would block: a transmitted inline
  // hit is checked against the repo's gitleaks allowlist (read through the
  // conventions reader — fs locally, the PR's BASE on GitHub) and an exempted
  // path is re-scanned as allowlisted. No reader (--no-conventions, no clone) →
  // no exemption, and the block names that so the reader knows what to switch on.
  const coveredPaths = new Set(acquired.coverage.files.filter((f) => f.included).map((f) => f.path));
  let secretScan = scanDiffForSecrets(acquired.files, { allowSensitive: opts.allowSensitive, coveredPaths });
  let allowlistNote = '';
  if (secretScan.inlineSecrets.length > 0) {
    if (opts.conventionReader) {
      const hitPaths = [...new Set(secretScan.inlineSecrets.map((s) => s.path))];
      const ex = await resolveGitleaksExemptions(opts.conventionReader, hitPaths);
      for (const { configPath, pattern } of ex.invalid) {
        log(`gitleaks allowlist: ${configPath} — pattern not compilable here, skipped: ${pattern}`);
      }
      if (ex.exempt.size > 0) {
        secretScan = scanDiffForSecrets(acquired.files, {
          allowSensitive: opts.allowSensitive,
          allowlistedPaths: new Set(ex.exempt.keys()),
          coveredPaths,
        });
        for (const [p, cfg] of ex.exempt) log(`secret-scan: ${p} — allowlisted by ${cfg}; not blocking`);
      } else if (ex.configs.length > 0) {
        allowlistNote = ` (not exempted by ${ex.configs.join(', ')})`;
      }
    } else {
      allowlistNote = ' (no repo reader, so the gitleaks allowlist was not consulted)';
    }
  }
  if (secretScan.blocked) {
    const paths = [
      ...secretScan.sensitivePaths.map((p) => `${p.path} (${p.label})`),
      ...secretScan.inlineSecrets.map((s) => `${s.path} (${s.label})`),
    ];
    const reason = `diff carries sensitive content: ${paths.join(', ')}${allowlistNote} — pass --allow-sensitive to review anyway`;
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
  for (const s of secretScan.inlineSecretsOmitted) {
    log(`secret-scan: ${s.path} (${s.label}) — in an OMITTED file, not transmitted; not blocking`);
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

  // ONE both-fields rule, owned by ci-evidence.ts and applied at every seam (this engine, the
  // packet, the worktree producer). The drop is announced, not silent.
  const ci = resolveCiEvidence(opts.ciEvidence, opts.ciEvidenceUnavailable);
  const bothCiEvidence = ci.kind === 'unavailable' && ci.reason === CI_EVIDENCE_BOTH_REASON;
  if (bothCiEvidence) {
    log('CI evidence: caller supplied both text and an unavailable reason — treating as unavailable');
  }
  const ciEvidence = ci.kind === 'text' ? ci.text : undefined;
  const ciEvidenceUnavailable = ci.kind === 'unavailable' ? ci.reason : undefined;

  // ONE PACKET PER PART (chunks.ts). A change that fits the ceiling is one part and assembles
  // exactly the packet this engine always built. A larger change is several, each whole, each
  // carrying the scope note (this part's files, the other parts' files, the omitted files) ahead
  // of its diff. A scope note also rides a single part when files were left out past the part
  // limit — a seat is never left to infer an omission from a listing it was not given.
  const objective =
    opts.objective ?? (profile === 'security' ? SECURITY_OBJECTIVE : DEFAULT_OBJECTIVE);
  const scoped = partCount > 1 || acquired.plan.overflow.length > 0;
  const scopeInput = { coverage: acquired.coverage, plan: acquired.plan };
  // The scope note the FENCED prompts embed raw (the `/code-review` producer, the lens) is bounded
  // exactly as the packet section is, so a thousand-file change cannot put an unbounded listing in
  // front of every part's diff.
  const boundedScope = (text: string): string => section('scope', 'scope', text, PACKET_BUDGETS.scope).body;
  const packets = (partCount > 0 ? acquired.plan.chunks : [null]).map((chunk) =>
    assembleCodePacket({
      agentsBudget: conventionManifest?.capBytes,
      agentsMd,
      authorSummary: opts.authorSummary,
      ciEvidence,
      ciEvidenceUnavailable,
      diff: chunk ? chunk.diff : acquired.diff,
      // The covered diff was admitted under THIS ceiling; the packet's diff section follows it so
      // the coverage listing and the bytes the seats see cannot disagree.
      diffBudget: ceilingBytes,
      directive: opts.directive,
      objective,
      pr: 0,
      repo: acquired.repoId ?? '',
      ...(chunk && scoped ? { scope: renderChangeScope(scopeInput, chunk.index) } : {}),
    })
  );
  const packet = packets[0];
  // The rendered CI evidence joins the trail for humans + dashboards (best-effort, like every
  // trail write). The packet manifest already records the section for the seats.
  if (ciEvidence) {
    try {
      writeTrailFile(opts.out, opts.runId, CI_EVIDENCE_TRAIL_FILE, ciEvidence);
    } catch {
      /* trail write is best-effort */
    }
  }
  const prompts = packets.map((p) => renderReviewPrompt(p, profile));
  const prompt = prompts[0];
  if (!packet.complete) {
    log('Packet incomplete (no usable diff) — persisting an empty review.');
  }
  const parts: ReviewPart[] = packets.map((p, i) => {
    const chunk = acquired.plan.chunks[i];
    return {
      diff: reviewerVisibleDiff(p).text,
      index: chunk?.index ?? 1,
      label: chunk?.label ?? '(the change)',
      prompt: prompts[i],
      ...(chunk && scoped ? { scope: boundedScope(renderChangeScope(scopeInput, chunk.index)) } : {}),
    };
  });

  // Materialize the PINNED gate packet ONCE per run: the exact REVIEWER-VISIBLE diff (the
  // packet's diff-section body — head+tail-truncated over the diff budget, exactly what every
  // reviewer saw in the prompt; on a review in parts, the UNION of every part's body) + the head
  // SHA it was resolved at + EVERY path the change touches (included or omitted), so the holistic
  // gate can ask "is this a file the PR changes?" without conflating it with "did the packet carry
  // its hunks?". Pinning the reviewer-visible bytes (NOT the full pre-truncation acquired.diff) is
  // the binding fix (grok-f1/codex-f3): a citation into bytes the reviewers did NOT see can never
  // validate a dismissal. The verified gate's hunk-resolver + citation-validator read ONLY this
  // artifact (never the working tree), so a tree that mutates between the run and the gate can
  // change no authority outcome. Best-effort — a failure just means the gate later reads no packet
  // and degrades all-`unverified` (fail-closed).
  const pinnedDiff = parts.map((p) => p.diff).join('');
  try {
    persistGatePacket(opts.out, opts.runId, {
      changedFiles: acquired.coverage.files.map((f) => f.path).filter((p) => p && p !== 'unknown'),
      diff: pinnedDiff,
      headSha: acquired.headSha,
    });
  } catch {
    /* trail write is best-effort — the gate fails closed if the packet is absent */
  }
  // THE LENS HANDOFF on a review in parts: the lens reads the whole tree, but its prompt holds one
  // packet's worth of diff. It gets whole parts from part 1 up to the ceiling, and a listing that
  // names every other changed file as changed — never the sentence "this is exactly the diff"
  // over a slice (run 2026-10-10-18-51-44-9acc127a's lens was told that, and believed it).
  let lensHandoff: { diff: string; scope: string } | undefined;
  // Also on a ONE-part review that left files past the part limit: the lens must not be told
  // the diff is exactly the change when named files were never shipped.
  if (scoped && partCount > 0) {
    const shown: number[] = [];
    let bytes = 0;
    for (const p of parts) {
      const partBytes = Buffer.byteLength(p.diff, 'utf8');
      if (shown.length > 0 && bytes + partBytes > ceilingBytes) break;
      shown.push(p.index);
      bytes += partBytes;
    }
    lensHandoff = {
      diff: parts.filter((p) => shown.includes(p.index)).map((p) => p.diff).join(''),
      scope: boundedScope(renderLensScope(scopeInput, shown)),
    };
  }

  // Everything the Anthropic stages need is pinned now — hand it over before the fan-out so a
  // caller can run them alongside the core seats. A throwing hook is the caller's bug and must not
  // take the paid review down with it: reported, then the fan-out proceeds.
  if (opts.onPacketsReady) {
    try {
      opts.onPacketsReady({ headSha: acquired.headSha, ...(lensHandoff ? { lensHandoff } : {}), parts, pinnedDiff, prompt });
    } catch (e) {
      log(`onPacketsReady hook failed (${(e as Error).message}) — the Anthropic stages will run after the core instead`);
    }
  }

  log(
    reviewers.length > 0
      ? `Running ${reviewers.length} reviewer(s): ${reviewers.join(', ')}…`
      : 'Running 0 core reviewer(s) — claude-only: the Opus reviewer, the lens (when requested) and the gate are the reviewers of record; no cross-vendor receipt will qualify'
  );
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
  const worktreePrompts = wt
    ? prompts.map((p) => p + worktreePromptSuffix({ baseSha: wt.baseSha, headSha: wt.headSha, worktree: wt.dir }))
    : undefined;
  if (wt) {
    log(`Worktree evidence: ${wt.dir} (detached at ${wt.headSha.slice(0, 12)})`);
  }

  const adapters = opts.adapters ?? REVIEW_ADAPTERS;
  // Per-part seat facts for the chunk trail (what each seat did with each part).
  const partSeats = new Map<number, ChunkTrailEntry['seats']>();
  const seatRuns = await Promise.all(
    reviewers.map(async (id) => {
      const reviewer = configs[id];
      log(`  · ${id} (${reviewer.vendor} · ${reviewer.model})…`);
      const runPart = (k: number, suffix?: string) =>
        runCoreSeat({
          adapter: adapters[id],
          ...(suffix ? { artifactSuffix: suffix } : {}),
          log,
          out: opts.out,
          packet: packets[k],
          packetComplete: packets[k].complete,
          packetPrompt: prompts[k],
          qualification: quals[id],
          retryOnPacket: RETRIES_ON_PACKET[id],
          reviewer,
          runId: opts.runId,
          ...(wt && worktreePrompts ? { worktree: wt.dir, worktreePrompt: worktreePrompts[k] } : {}),
        });
      const record = (k: number, s: Awaited<ReturnType<typeof runCoreSeat>>): void => {
        const idx = acquired.plan.chunks[k]?.index ?? 1;
        const seats = partSeats.get(idx) ?? {};
        seats[id] = {
          ...(s.review.diagnostics ? { elapsedMs: s.review.diagnostics.elapsedMs } : {}),
          findings: s.review.findings.length,
          state: s.review.terminalState === 'reviewed' ? 'reviewed' : 'failed-reviewer',
          ...(s.review.terminalState === 'reviewed' ? {} : { why: scrubControl(s.review.summary).slice(0, 160) }),
        };
        partSeats.set(idx, seats);
      };
      let seat: Awaited<ReturnType<typeof runCoreSeat>>;
      if (packets.length <= 1) {
        seat = await runPart(0);
        record(0, seat);
      } else {
        // The parts run ONE AT A TIME per reviewer (reviewers still run side by side): a vendor
        // seat is one CLI session with one rate budget, and N parallel sessions of the same seat
        // would trip it for no wall-clock gain the cross-vendor fan-out does not already give.
        const partRuns: ChunkSeatRun[] = [];
        for (let k = 0; k < packets.length; k++) {
          const chunk = acquired.plan.chunks[k];
          log(`  · ${id}: part ${chunk.index}/${packets.length} — ${chunk.label}…`);
          const s = await runPart(k, `c${chunk.index}`);
          record(k, s);
          log(
            `  · ${id}: part ${chunk.index}/${packets.length} ${s.review.terminalState} — ${s.review.findings.length} finding(s)${
              s.review.terminalState === 'reviewed' ? '' : ` — ${scrubControl(s.review.summary).slice(0, 160)}`
            }`
          );
          partRuns.push({ index: chunk.index, label: chunk.label, seat: s });
        }
        seat = mergeChunkSeatRuns({
          out: opts.out,
          packet,
          prompt,
          reviewer,
          runId: opts.runId,
          runs: partRuns,
        });
      }
      // A failed seat names its cause on the outcome line: a consumer that reads only the log
      // tail (hugin distills a dead run's failure text from it) otherwise sees a state and no why.
      const cause =
        seat.review.terminalState === 'reviewed'
          ? ''
          // VENDOR text (persistAttempt embeds the seat's own stderr tail in a failure summary) on
          // its way to a terminal: scrubControl strips the C0/DEL bytes and collapses the
          // whitespace this line used to fold by hand.
          : ` — ${scrubControl(seat.review.summary).slice(0, 200)}`;
      log(
        `  · ${id}: ${seat.review.terminalState} — ${seat.review.findings.length} finding(s) · evidence ${seat.realized}${cause}`
      );
      // …and names the remedy on the spot: the trail this run already wrote is enough to re-run
      // JUST this seat, and the alternative a reader reaches for otherwise is re-billing everyone.
      // The hint has to carry the evidence class the run HAD. A reseat without `--repo` re-runs the
      // seat on the packet AND regates the whole run on packet grounding — so on a worktree run the
      // bare form steers the operator into the very downgrade the retry then warns about. This run
      // knows neither the operator's clone path nor the PR URL the reseat CLI parses, so both stay
      // ANGLE-BRACKET placeholders: a template to fill, never a line to paste blind.
      // …and it carries the two inputs that DECIDE the seat's config, when this run set them:
      // reseat resolves the reviewer from `--reviewers-file` and can override its profile with
      // `--sandbox`, so a hint that drops them retries a DIFFERENT seat (the default reviewers.json,
      // the default profile) and calls the result the same review. Unlike the clone path, this run
      // knows both values — so they are filled in, not placeholders.
      if (seat.review.terminalState !== 'reviewed') {
        log(
          `  · → retry just this seat: ensemble-ai reseat ${
            wt ? '<pr-url> --repo <path-to-your-clone> ' : ''
          }--seat ${id} --out '${opts.out}' --run-id ${opts.runId}${
            opts.sandbox ? ` --sandbox ${opts.sandbox}` : ''
          }${opts.reviewersFile ? ` --reviewers-file '${opts.reviewersFile}'` : ''}`
        );
        log(
          '  ·   (without --repo the retried seat AND the whole-run regate fall back to PACKET evidence)'
        );
      }
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
    log(`  · ⚠ egress fence: ${formatEgressDenialCounts(egressDenials)}`);
    try {
      writeTrailFile(opts.out, opts.runId, 'egress-denials.json', JSON.stringify(egressDenials, null, 2));
    } catch {
      /* trail write is best-effort — stderr + the footer already carry the denial */
    }
  }
  const evidence: ReviewEvidence = { egressDenials, fallbacks, intended, realized, sandboxProfiles };

  // THE CHUNK TRAIL (chunks.json): the parts as planned, what each core seat did with each, and
  // every file no seat saw — the record the coverage overview and the dashboard render. Written on
  // EVERY run (one part included) so a consumer has one shape to read. The caller folds the
  // Anthropic seats in after its layer runs. Best-effort, like every trail write.
  const chunksTrail: ChunksTrail = {
    ceilingBytes,
    chunks: acquired.plan.chunks.map((c, i) => ({
      bytes: c.bytes,
      files: c.files.map((f) => ({ added: f.added, path: f.path, removed: f.removed, test: isTestPath(f.path) })),
      index: c.index,
      label: c.label,
      promptChars: prompts[i]?.length ?? 0,
      seats: partSeats.get(c.index) ?? {},
    })),
    maxChunks: opts.maxChunks ?? DEFAULT_MAX_CHUNKS,
    omitted: acquired.coverage.files
      .filter((f) => !f.included)
      .map((f) => ({ kind: f.kind, path: f.path, reason: f.omitReason ?? 'omitted' })),
    schemaVersion: CHUNKS_TRAIL_SCHEMA_VERSION,
  };
  try {
    writeTrailFile(opts.out, opts.runId, CHUNKS_TRAIL_FILE, JSON.stringify(chunksTrail, null, 2));
  } catch {
    /* trail write is best-effort */
  }

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
    // A part's diff is truncated in its packet only when ONE file alone exceeds the ceiling (the
    // packet's diff budget follows the ceiling, and every part fits it); a truncated payload must
    // not qualify a receipt (the reviewer saw head+tail of that part).
    diffTruncated: packets.some((p) => reviewerVisibleDiff(p).truncated),
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
    return { acquired, blocked: false, conventionManifest, depSurface, evidence, ...(lensHandoff ? { lensHandoff } : {}), parts, pinnedDiff, prompt, receiptCandidate: built.receipt, receiptStore: store, reviews, secretScan };
  }
  log(`No receipt — ${built.error}`);
  return { acquired, blocked: false, conventionManifest, depSurface, evidence, ...(lensHandoff ? { lensHandoff } : {}), parts, pinnedDiff, prompt, receiptError: built.error, reviews, secretScan };
}
