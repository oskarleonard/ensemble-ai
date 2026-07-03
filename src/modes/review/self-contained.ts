// The SELF-CONTAINED review layer: after the cross-vendor CORE (codex+grok) reviews the
// pinned packet, add a THIRD blind peer reviewer — a COLD headless `claude -p` (Opus) —
// on the SAME packet, then a separate `claude -p` SYNTHESIS pass that reads all three
// reviewers' persisted trail files and emits AGREE(confident)/DISAGREE(look-closer) ·
// per-finding sanity-check · bottom-line. DEFAULT-ON (opt out with `--no-claude`), so the
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
import {
  type GateVerdictRecord,
  renderGateVerdicts,
  runGate,
} from './gate';
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

// Persist the cold Opus review to the trail with parity to codex/grok's persistReview
// artifacts — findings.claude.json + claude-review.raw.md + review.claude.json (a
// VoiceReview so it round-trips) — so the synthesizer can READ all three reviewers from
// disk. `claude` is not a core ReviewerId (it mints no receipt), so this is a dedicated
// writer rather than persistReview.
export function persistClaudeReview(
  baseDir: string,
  runId: string,
  review: VoiceReview,
  raw: string | null
): void {
  writeTrailFile(baseDir, runId, 'findings.claude.json', JSON.stringify(review.findings, null, 2));
  if (raw !== null) writeTrailFile(baseDir, runId, 'claude-review.raw.md', raw);
  writeTrailFile(baseDir, runId, 'review.claude.json', JSON.stringify(review, null, 2));
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
  log: (m: string) => void
): Promise<{ review: VoiceReview; raw: string | null }> {
  let res: VoiceRunResult;
  try {
    res = await run(reviewPrompt, config, { timeoutMs });
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
  claudeConfig: VoiceConfig;
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
}

export interface ClaudeLayerResult {
  // The cold Opus review (null when claude is not in the roster).
  claudeReview: VoiceReview | null;
  // Whether the durable gate-verdicts.json trail wrote — dismissals are honored (Phase 2)
  // ONLY when true (a trail-write failure means the audit trail was lost → not honored).
  gateTrailWritten: boolean;
  // The host-reconciled grounded verdict for every finding across all three reviewers.
  gateVerdicts: GateVerdictRecord[];
  // The model that ACTUALLY ran the claude voice (e.g. `opus`, `sonnet`) — rendered in the
  // stdout block so the output never hardcodes "opus" when a different Claude model is
  // configured. `opus` is the design default (when the voice config leaves the model unset).
  modelLabel: string;
  synthesis: ReviewSynthesis;
}

// The Claude model label for output: the configured model when one is explicitly set, else
// `opus` (the CLI's default for this voice, by design). So a `--model sonnet` run prints
// `sonnet`, never a hardcoded `opus`.
function claudeModelLabel(config: VoiceConfig): string {
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

  let claudeReview: VoiceReview | null = null;
  if (opts.includeClaudeReviewer) {
    log(`  · claude (anthropic/${modelLabel}) reviewing the diff (cold)…`);
    const { review, raw } = await runClaudeReviewer(
      opts.reviewPrompt,
      opts.claudeConfig,
      run,
      opts.timeoutMs,
      log
    );
    claudeReview = review;
    // The trail persist must SUCCEED for the claude voice to count as a complete reviewer:
    // if it fails, the review never reaches the trail (so the disk-read synthesis below
    // silently drops it) and its findings are unverifiable after the run. A completed-but-
    // unpersisted review must NOT be reported as a full pass — mark it ok:false so the exit
    // gate treats claude as an INCOMPLETE reviewer (fail-loud), matching a failed core
    // reviewer, instead of exit 0 as if 3 reviewers reviewed. It never crashes the review.
    try {
      persistClaudeReview(opts.baseDir, opts.runId, review, raw);
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

  // Run the GATE over the reviews READ BACK from the trail files (the literal "reads the
  // three review files") — grounding each finding against the pinned packet hunks, tagging
  // agree/partial/false/unverified, and writing the durable gate-verdicts.json trail. The
  // gate is FAIL-CLOSED (any spawn/packet/parse failure → deterministic fallback + all
  // verdicts unverified) and NEVER trips exit 1 — it is the synthesis stage, not a reviewer.
  const voiceReviews = loadVoiceReviewsFromTrail(opts.baseDir, opts.runId);
  const gate = await runGate({
    baseDir: opts.baseDir,
    config: opts.claudeConfig,
    expectedHeadSha: opts.expectedHeadSha,
    log,
    reviews: voiceReviews,
    run,
    runId: opts.runId,
    timeoutMs: opts.timeoutMs,
  });
  return {
    claudeReview,
    gateTrailWritten: gate.gateTrailWritten,
    gateVerdicts: gate.verdicts,
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
// (AGREE / DISAGREE / sanity-checks / bottom line). Grouped + scannable.
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
