// The SELF-CONTAINED review layer: after the cross-vendor CORE (codex+grok) reviews the
// pinned packet, add a THIRD blind peer reviewer — a COLD headless `claude -p` (Opus) —
// on the SAME packet, then a separate `claude -p` GATE pass that reads all three
// reviewers' persisted trail files and emits AGREE(confident)/DISAGREE(look-closer) · a
// grounded per-finding verdict (agree/partial/false/unverified) · bottom-line. DEFAULT-ON
// (opt out with `--no-claude`), so the
// bare `ensemble-ai review <pr|branch|url>` runs from ANY terminal with no Claude session.
//
// REVIEW-ONLY: this layer never edits code. Its ONLY writes are to the (fenced, 0600)
// trail dir — the per-reviewer review files + the synthesis json — via the hardened
// writeTrailFile. The Opus reviewer/synthesizer spawn is best-effort read-only (see
// ./claude), accepted by design (the user runs it on their own diffs).

import { readReviewsForRun, writeTrailFile } from '../../core/artifacts';
import { evidenceRef, parseFindings } from '../../core/findings';
import { scrubControl as scrub } from '../../core/sanitize';
import type { ReviewFinding, StoredReview } from '../../core/types';
import { REVIEWER_IDS, type ReviewerId } from '../../core/types';
import type { RunReviewOpts } from '../../reviewers/codex';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';

import { runClaudeReviewVoice } from './claude';
import { renderCodeReviewSeatPrompt } from './code-review-seat';
import {
  type GateVerdictRecord,
  renderGateVerdicts,
  runGate,
} from './gate';
import {
  HOLISTIC_SEAT_ID,
  type HolisticPlan,
  resolveHolisticPlan,
  runHolisticLens,
} from './holistic';
import { worktreeReader } from './holistic-gate';
import { type ReviewSynthesis, type VoiceReview } from './synthesis';
import { reviewJsonFromTrail } from './trail-io';

// ── Roster resolution (registry-driven; `--reviewers` subsets, `--no-claude` opts out) ──

export type RosterResolution =
  | { claude: boolean; core: ReviewerId[] }
  | { error: string };

// Resolve which reviewers run. The Opus (claude) reviewer + synthesis are DEFAULT-ON;
// `--no-claude` forces them off. `--reviewers` subsets the roster — `claude` IS a valid id
// (it is default-on now), and the cross-vendor CORE (codex/grok) mints the content-tied
// receipt, so at least one core reviewer is required. Fails CLOSED on an unknown id (a typo
// must never silently narrow the policy).
export function resolveReviewRoster(
  requested: string[] | undefined,
  noClaude: boolean
): RosterResolution {
  const known = [...REVIEWER_IDS, 'claude'];
  if (requested === undefined) {
    return { claude: !noClaude, core: [...REVIEWER_IDS] };
  }
  const ids = [...new Set(requested.map((s) => s.trim()).filter(Boolean))];
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    return {
      error: `unknown reviewer id(s): ${unknown.join(', ')} (known: ${known.join(', ')})`,
    };
  }
  const core = ids.filter((id): id is ReviewerId =>
    (REVIEWER_IDS as readonly string[]).includes(id)
  );
  // codex/grok mint the content-tied receipt; claude is an ADDITIVE peer reviewer, never a
  // standalone one. Require ≥1 cross-vendor core.
  if (core.length === 0) {
    return {
      error:
        'select at least one cross-vendor reviewer (codex/grok) — claude is additive, not standalone',
    };
  }
  return { claude: ids.includes('claude') && !noClaude, core };
}

// ── Voice-review adaptation + trail persistence ─────────────────────────────────────

// Reduce a persisted core review (codex/grok) to what the synthesizer needs.
export function storedToVoiceReview(r: StoredReview): VoiceReview {
  return {
    findings: r.findings,
    ok: r.terminalState === 'reviewed',
    summary: r.summary,
    voiceId: r.reviewerId ?? r.reviewer.vendor,
  };
}

// Render ONE reviewer's review as human-readable markdown for the trail (`review.<id>.md`).
// Untrusted text (a crafted diff could induce it) is left as-is inside a fenced doc — the
// terminal renderer scrubs; the file is an artifact, not printed raw.
export function renderReviewMarkdown(v: VoiceReview): string {
  const lines: string[] = [`# review — ${v.voiceId}`, ''];
  lines.push(v.ok ? '_status: reviewed_' : '_status: failed_', '');
  lines.push('## summary', '', v.summary || '(none)', '');
  lines.push('## findings', '');
  if (v.findings.length === 0) {
    lines.push('(no findings)');
  } else {
    for (const f of v.findings) {
      const where = evidenceRef(f.evidence.file, f.evidence.line);
      lines.push(`### [${f.severity}/${f.confidence}] ${f.title}`);
      lines.push(`- where: ${where}`);
      lines.push(`- ${f.body}`, '');
    }
  }
  return `${lines.join('\n')}\n`;
}

// Persist ONE Anthropic seat's review to the trail with parity to codex/grok's persistReview
// artifacts — findings.<id>.json + <id>-review.raw.md + review.<id>.json (a VoiceReview so it
// round-trips) — so the gate can READ every reviewer from disk. Neither `claude` nor the holistic
// lens is a core ReviewerId (they mint no receipt), so this is a dedicated writer rather than
// persistReview.
export function persistSeatReview(
  baseDir: string,
  runId: string,
  seatId: string,
  review: VoiceReview,
  raw: string | null
): void {
  writeTrailFile(baseDir, runId, `findings.${seatId}.json`, JSON.stringify(review.findings, null, 2));
  if (raw !== null) writeTrailFile(baseDir, runId, `${seatId}-review.raw.md`, raw);
  writeTrailFile(baseDir, runId, `review.${seatId}.json`, JSON.stringify(review, null, 2));
}

// Load every reviewer's review BACK from the trail files (codex/grok via readReviewsForRun,
// claude via review.claude.json) → the VoiceReview set the synthesis operates over. This is
// what makes "the synthesis reads the three review files" literally true (not an in-memory
// hand-off). Missing files simply drop out.
export function loadVoiceReviewsFromTrail(
  baseDir: string,
  runId: string
): VoiceReview[] {
  const out = readReviewsForRun(baseDir, runId).map(storedToVoiceReview);
  const claude = reviewJsonFromTrail(baseDir, runId, 'review.claude.json');
  if (claude) out.push(claude);
  // The lens is LAST so its findingIds sort after the reviewers' in the gate prompt. Absent
  // whenever the lens did not run (the default) — no file, no voice, no findings.
  const holistic = reviewJsonFromTrail(baseDir, runId, `review.${HOLISTIC_SEAT_ID}.json`);
  if (holistic) out.push(holistic);
  return out;
}

type ClaudeRunner = (
  prompt: string,
  config: VoiceConfig,
  opts?: RunReviewOpts
) => Promise<VoiceRunResult>;

// ── The cold Opus reviewer ──────────────────────────────────────────────────────────

async function runClaudeReviewer(
  reviewPrompt: string,
  config: VoiceConfig,
  run: ClaudeRunner,
  timeoutMs: number | undefined,
  log: (m: string) => void,
  // The worktree, when this run has one — the spawn cwd is what makes this a worktree seat (its
  // file/git tools reach the project there). Absent ⇒ the throwaway tmpdir, as before.
  worktree?: string
): Promise<{ review: VoiceReview; raw: string | null }> {
  let res: VoiceRunResult;
  try {
    res = await run(reviewPrompt, config, { timeoutMs, ...(worktree ? { worktree } : {}) });
  } catch (e) {
    log(`  · claude: failed to run — ${(e as Error).message}`);
    return {
      raw: null,
      review: { findings: [], ok: false, summary: `claude did not run: ${(e as Error).message}`, voiceId: 'claude' },
    };
  }
  if (!res.raw || res.timedOut) {
    const why = res.timedOut ? 'timed out' : 'produced no output';
    log(`  · claude: ${why}`);
    return { raw: res.raw ?? null, review: { findings: [], ok: false, summary: `claude ${why}`, voiceId: 'claude' } };
  }
  const parsed = parseFindings(res.raw);
  if (parsed.parseError) {
    // A parse failure is the reviewer FAILING, never a clean review — surface it as such.
    // Lead the summary with the parse error so a voice that emitted an unparseable reply
    // (or a bare prose reply that yielded a summary but no findings array) is reported
    // failed, not dressed up with the model's own summary text that would mask the failure.
    log(`  · claude: ${parsed.parseError}`);
    const detail = parsed.summary ? `; model said: ${parsed.summary}` : '';
    return {
      raw: res.raw,
      review: { findings: [], ok: false, summary: `output not parseable (${parsed.parseError})${detail}`, voiceId: 'claude' },
    };
  }
  log(`  · claude: reviewed — ${parsed.findings.length} finding(s)`);
  return { raw: res.raw, review: { findings: parsed.findings, ok: true, summary: parsed.summary, voiceId: 'claude' } };
}

// ── The whole layer: Opus reviewer + per-reviewer files + the gate ────────────────────

export interface ClaudeLayerOptions {
  baseDir: string;
  // The base SHA the PR diverged from. With a worktree it turns the `claude` seat into THE ONE
  // CLAUDE PRODUCER (spec §3): the built-in `/code-review` methodology over the whole project,
  // told the exact range under review. Absent ⇒ the seat reviews the pinned packet prompt (it
  // still reads the tree, it is just not told the range).
  baseSha?: string | null;
  claudeConfig: VoiceConfig;
  // The run's gathered conventions files (repo-relative). The ONLY docs a holistic finding may
  // cite to lift its MED severity cap — and the gate re-reads the citation out of the tree anyway.
  conventionPaths?: readonly string[];
  // THE HOLISTIC LENS (spec §4) — DEFAULT OFF. Omit it and nothing changes: no seat is spawned, no
  // finding enters the gate, no clause enters the gate prompt, the records are the same objects.
  // Its PRESENCE is the request; present without `worktree` is a LOUD skip (holisticSkipped),
  // never a packet-evidence run.
  holistic?: { baseSha: string | null; config: VoiceConfig };
  // The GATE (synthesis) seat — its own model/effort, independent of the `claude` REVIEWER above
  // ("reviewer = Opus @ high, gate = Fable @ max"). Always a `claude -p` spawn (only model/effort
  // differ). Omitted ⇒ inherits `claudeConfig` (the pre-Phase-3 behavior — one seat for both).
  gateConfig?: VoiceConfig;
  // The codex+grok reviews already produced + persisted by runReviewMode (the core).
  coreReviews: StoredReview[];
  // The head SHA the reviewers saw — the gate reads the pinned packet keyed by it, and a
  // mismatch fails the packet closed (all verdicts unverified).
  expectedHeadSha: string;
  // Whether the Opus voice runs as a third reviewer (roster.claude).
  includeClaudeReviewer: boolean;
  log?: (m: string) => void;
  // The exact packet prompt the core reviewers saw — the Opus reviewer sees it too.
  reviewPrompt: string;
  runId: string;
  // Injectable claude runner (default: the real headless `claude -p` voice).
  run?: ClaudeRunner;
  timeoutMs?: number;
  // The detached read-only worktree of the PR head, when this run HAS worktree evidence. Its
  // presence makes the GATE worktree-fed (spec §5: "the gate reads the same worktree") and is the
  // precondition for the lens. Absent ⇒ every seat and the gate stay on the packet, as before.
  worktree?: string;
}

export interface ClaudeLayerResult {
  // The cold Opus review (null when claude is not in the roster).
  claudeReview: VoiceReview | null;
  // Whether the durable gate-verdicts.json trail wrote — dismissals are honored (Phase 2)
  // ONLY when true (a trail-write failure means the audit trail was lost → not honored).
  gateTrailWritten: boolean;
  // The host-reconciled grounded verdict for every finding across all three reviewers.
  gateVerdicts: GateVerdictRecord[];
  // The holistic lens's review — null when the lens was off (the default) or skipped. OPTIONAL:
  // this interface is a consumer contract (the dashboard renders it), and the lens is additive.
  holisticReview?: VoiceReview | null;
  // Why the lens did NOT run, when it was requested. Null/absent ⇒ it ran, or was never requested.
  holisticSkipped?: string | null;
  // The model that ACTUALLY ran the claude voice (e.g. `opus`, `sonnet`) — rendered in the
  // stdout block so the output never hardcodes "opus" when a different Claude model is
  // configured. `opus` is the design default (when the voice config leaves the model unset).
  modelLabel: string;
  synthesis: ReviewSynthesis;
}

// The Claude model label for output: the configured model when one is explicitly set, else
// `opus` (the CLI's default for this voice, by design). So a `--model sonnet` run prints
// `sonnet`, never a hardcoded `opus`.
export function claudeModelLabel(config: VoiceConfig): string {
  return config.model && config.model !== 'default' ? config.model : 'opus';
}

// Run the cold Opus reviewer (when in the roster) over the SAME prompt + persist it, write
// every reviewer's rendered review.<id>.md, then synthesize over the reviews LOADED from the
// trail files. An Opus reviewer failure degrades to an ok:false voice (synthesis still runs
// over codex+grok); an unavailable synthesizer degrades to the deterministic fallback.
export async function runClaudeReviewLayer(
  opts: ClaudeLayerOptions
): Promise<ClaudeLayerResult> {
  const log = opts.log ?? (() => {});
  const run: ClaudeRunner = opts.run ?? runClaudeReviewVoice;
  const modelLabel = claudeModelLabel(opts.claudeConfig);

  // THE ONE CLAUDE PRODUCER (spec §3). With worktree evidence the seat runs the built-in
  // `/code-review` methodology over the whole project at `headSha`; without it, the cold peer
  // reviewer on the pinned packet, exactly as before. The spawn cwd — not a flag — is what grants
  // the whole-project read, so a worktree with no resolved base SHA still reads the tree.
  const producerPrompt =
    opts.worktree && opts.baseSha
      ? renderCodeReviewSeatPrompt({
          baseSha: opts.baseSha,
          headSha: opts.expectedHeadSha,
          worktree: opts.worktree,
        })
      : opts.reviewPrompt;

  let claudeReview: VoiceReview | null = null;
  if (opts.includeClaudeReviewer) {
    log(
      opts.worktree
        ? `  · claude (anthropic/${modelLabel}) reviewing the whole project at the PR head (/code-review)…`
        : `  · claude (anthropic/${modelLabel}) reviewing the diff (cold)…`
    );
    const { review, raw } = await runClaudeReviewer(
      producerPrompt,
      opts.claudeConfig,
      run,
      opts.timeoutMs,
      log,
      opts.worktree
    );
    claudeReview = review;
    // The trail persist must SUCCEED for the claude voice to count as a complete reviewer:
    // if it fails, the review never reaches the trail (so the disk-read synthesis below
    // silently drops it) and its findings are unverifiable after the run. A completed-but-
    // unpersisted review must NOT be reported as a full pass — mark it ok:false so the exit
    // gate treats claude as an INCOMPLETE reviewer (fail-loud), matching a failed core
    // reviewer, instead of exit 0 as if 3 reviewers reviewed. It never crashes the review.
    try {
      persistSeatReview(opts.baseDir, opts.runId, 'claude', review, raw);
    } catch (e) {
      const why = (e as Error).message;
      log(`  · claude: trail persist FAILED (${why}) — reviewer counted INCOMPLETE`);
      claudeReview = {
        ...review,
        ok: false,
        summary: `claude reviewed but FAILED to persist to the trail (${why}) — not a complete reviewer`,
      };
    }
  }

  // Write each reviewer's rendered review.<id>.md (durable, human-readable trail artifact).
  // Each write is best-effort — one reviewer's FS error must not take down the others or
  // the synthesis.
  const coreVoices = opts.coreReviews.map(storedToVoiceReview);
  for (const v of coreVoices) {
    try {
      writeTrailFile(opts.baseDir, opts.runId, `review.${v.voiceId}.md`, renderReviewMarkdown(v));
    } catch (e) {
      log(`  · trail write review.${v.voiceId}.md failed (${(e as Error).message}) — continuing`);
    }
  }
  if (claudeReview) {
    try {
      writeTrailFile(opts.baseDir, opts.runId, 'review.claude.md', renderReviewMarkdown(claudeReview));
    } catch (e) {
      log(`  · trail write review.claude.md failed (${(e as Error).message}) — continuing`);
    }
  }

  // THE HOLISTIC LENS. Off by default; when requested it runs ONLY with worktree evidence, and a
  // requested-but-unavailable lens says so out loud rather than degrading to a packet-evidence
  // architecture claim. Its persist is the same fail-loud contract as the claude reviewer's: a
  // review the trail did not take is not a review, because the gate reads voices off disk.
  const holistic = opts.holistic;
  const plan: HolisticPlan = resolveHolisticPlan({
    baseSha: holistic?.baseSha,
    requested: Boolean(holistic),
    worktree: opts.worktree,
  });
  let holisticReview: VoiceReview | null = null;
  if (!plan.run) {
    if (plan.skipReason) log(`  · ${plan.skipReason}`);
  } else if (holistic) {
    log(`  · holistic lens (anthropic/${holistic.config.model} @ ${holistic.config.effort}) reading the whole project…`);
    const { raw, review } = await runHolisticLens({
      baseSha: plan.baseSha,
      config: holistic.config,
      headSha: opts.expectedHeadSha,
      log,
      run,
      timeoutMs: opts.timeoutMs,
      worktree: plan.worktree,
    });
    holisticReview = review;
    try {
      persistSeatReview(opts.baseDir, opts.runId, HOLISTIC_SEAT_ID, review, raw);
    } catch (e) {
      const why = (e as Error).message;
      log(`  · holistic: trail persist FAILED (${why}) — the lens's findings are dropped from this run`);
      holisticReview = { ...review, findings: [], ok: false, summary: `the holistic lens ran but FAILED to persist to the trail (${why})` };
    }
    // The rendered markdown is a human-readable artifact, NOT the gate's input — the gate reads
    // review.<id>.json. Its write is best-effort, exactly like review.claude.md above: folding it
    // into the persist above would report "findings dropped" while review.holistic.json — already
    // on disk — still fed those findings to the gate.
    try {
      writeTrailFile(opts.baseDir, opts.runId, `review.${HOLISTIC_SEAT_ID}.md`, renderReviewMarkdown(review));
    } catch (e) {
      log(`  · trail write review.${HOLISTIC_SEAT_ID}.md failed (${(e as Error).message}) — continuing`);
    }
  }

  // Run the GATE over the reviews READ BACK from the trail files (the literal "reads the
  // three review files") — grounding each finding against the pinned packet hunks, tagging
  // agree/partial/false/unverified, and writing the durable gate-verdicts.json trail. The
  // gate is FAIL-CLOSED (any spawn/packet/parse failure → deterministic fallback + all
  // verdicts unverified) and NEVER trips exit 1 — it is the synthesis stage, not a reviewer.
  const voiceReviews = loadVoiceReviewsFromTrail(opts.baseDir, opts.runId);
  const gate = await runGate({
    baseDir: opts.baseDir,
    // The GATE spawns its OWN configured seat (model/effort), NOT necessarily the reviewer's —
    // defaulting to claudeConfig keeps the one-seat behavior when no `gate` entry is configured.
    config: opts.gateConfig ?? opts.claudeConfig,
    expectedHeadSha: opts.expectedHeadSha,
    // With a worktree the gate is an evidence-bearing actor over the PR head: it may emit
    // `reference-not-found`, and it can verify a holistic finding's two sites. Without one, both
    // halves stay off — the pre-worktree behavior, unchanged.
    ...(opts.worktree
      ? {
          gateEvidence: 'worktree' as const,
          holistic: {
            conventionPaths: opts.conventionPaths,
            readAtHead: worktreeReader(opts.worktree),
          },
        }
      : {}),
    log,
    reviews: voiceReviews,
    run,
    runId: opts.runId,
    timeoutMs: opts.timeoutMs,
    // The gate reads the same worktree the seats did (spec §5) — its own spawn cwd.
    ...(opts.worktree ? { worktree: opts.worktree } : {}),
  });
  return {
    claudeReview,
    gateTrailWritten: gate.gateTrailWritten,
    gateVerdicts: gate.verdicts,
    holisticReview,
    holisticSkipped: plan.run ? null : plan.skipReason,
    modelLabel,
    synthesis: gate.synthesis,
  };
}

// ── HIGH-gate contribution ────────────────────────────────────────────────────────────

// The Opus voice is a full reviewer, so its HIGH findings count toward the SAME exit gate
// as codex/grok — a claude-only HIGH must not slip through as exit 0. Only a COMPLETED (ok)
// claude review counts.
export function claudeLayerHasHigh(layer: ClaudeLayerResult | null): boolean {
  const cr = layer?.claudeReview;
  return Boolean(cr?.ok && cr.findings.some((f: ReviewFinding) => f.severity === 'high'));
}

// ── Rendering (for the CLI summary) ───────────────────────────────────────────────────

// The claude-layer block for stdout: the cold Opus review's findings, then the synthesis
// (AGREE / DISAGREE / bottom line) and the grounded per-finding verdict tags. Grouped + scannable.
export function renderClaudeLayer(result: ClaudeLayerResult): string[] {
  const out: string[] = [];
  const cr = result.claudeReview;
  if (cr) {
    out.push('');
    out.push(`  ── claude [anthropic/${result.modelLabel}] — ${cr.ok ? 'reviewed' : 'failed'} (cold peer reviewer) ──`);
    if (!cr.ok) {
      out.push(`     ${scrub(cr.summary).slice(0, 200)}`);
    } else if (cr.findings.length === 0) {
      out.push('     no findings');
    } else {
      for (const f of cr.findings) {
        const where = evidenceRef(f.evidence.file, f.evidence.line);
        out.push(`     [${f.severity}] ${scrub(where)}  ${scrub(f.title)}`);
      }
    }
  }

  // The lens gets its OWN block, named as one seat. It is never folded into the reviewers' list,
  // because a reader must never mistake a single whole-tree opinion for cross-vendor corroboration.
  const hr = result.holisticReview;
  if (hr) {
    out.push('');
    out.push(`  ── holistic lens — ${hr.ok ? 'reviewed the whole project' : 'failed'} (ONE seat · suggestions · never corroborated) ──`);
    if (!hr.ok) {
      out.push(`     ${scrub(hr.summary).slice(0, 200)}`);
    } else if (hr.findings.length === 0) {
      out.push('     no findings — which is NOT an architecture certification (the lens finds valuable things when it looks; whole-repo search varies run to run)');
    } else {
      for (const f of hr.findings) {
        out.push(`     [${f.severity}] ${scrub(evidenceRef(f.evidence.file, f.evidence.line))}  ${scrub(f.title)}`);
      }
    }
  } else if (result.holisticSkipped) {
    out.push('');
    out.push(`  ── holistic lens — SKIPPED ──`);
    out.push(`     ${scrub(result.holisticSkipped)}`);
  }

  const s = result.synthesis;
  out.push('');
  out.push(
    `  Claude synthesis${s.by ? ` (by ${s.by})` : ''}${s.degraded ? ' — DEGRADED (deterministic fallback, NOT cross-confirmed)' : ''}`
  );
  if (s.summary) out.push(`     ${scrub(s.summary).slice(0, 400)}`);
  if (s.agreements.length > 0) {
    out.push('     ✓ AGREE (confident)');
    for (const a of s.agreements) {
      out.push(`        • ${scrub(a.point).slice(0, 300)}${a.voices.length ? `  [${a.voices.map(scrub).join(', ')}]` : ''}`);
    }
  }
  if (s.disagreements.length > 0) {
    out.push('     ⚠ DISAGREE (look closer)');
    for (const d of s.disagreements) {
      out.push(`        • ${scrub(d.point).slice(0, 300)}`);
      for (const p of d.positions) out.push(`            − ${scrub(p).slice(0, 240)}`);
    }
  }
  if (s.bottomLine) {
    out.push('     → bottom line');
    out.push(`        ${scrub(s.bottomLine).slice(0, 500)}`);
  }
  // The grounded per-finding verdict TAGS + the gate summary line + the trail marker — the
  // gate's teeth, rendered inline (Phase 1: informational; exit is unchanged).
  out.push(...renderGateVerdicts(result.gateVerdicts, { scrub, trailWritten: result.gateTrailWritten }));
  return out;
}
