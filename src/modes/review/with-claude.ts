// The `--with-claude` layer: add a COLD headless `claude -p` reviewer to the
// codex+grok core, then a separate `claude -p` SYNTHESIS pass — so the bare CLI
// stands alone from a plain terminal with no Claude session. Off by default (the
// SKILL path, where the invoking session's Claude IS the ensemble's Claude, is the
// default UX). Registry-driven; `--reviewers` subsets the roster; every voice
// failure degrades gracefully. REVIEW-ONLY, and enforced not merely asserted: both
// the cold reviewer and the synthesizer spawn through runClaudeVoice, which applies
// the layered read-only policy (`--tools ""` disables every tool + an explicit
// `--disallowed-tools` deny of Bash/Edit/Write/NotebookEdit + `--permission-mode
// default` — see buildClaudeVoiceArgs), so this voice provably cannot read/write/
// execute. This layer itself writes only the (fenced) trail.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseFindings } from '../../core/findings';
import { REVIEWER_IDS, type ReviewerId, type StoredReview } from '../../core/types';
import { runClaudeVoice } from '../brainstorm/claude';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';
import type { RunReviewOpts } from '../../reviewers/codex';

import {
  fallbackReviewSynthesis,
  parseReviewSynthesis,
  reconcileSynthesis,
  renderReviewSynthesisPrompt,
  type ReviewSynthesis,
  type VoiceReview,
} from './synthesis';

// ── Roster resolution (registry-driven; `--reviewers` subsets) ────────────────

export type RosterResolution =
  | { claude: boolean; core: ReviewerId[] }
  | { error: string };

// Split an explicit `--reviewers` list into the cross-vendor CORE (codex/grok, which
// mint the content-tied receipt) and whether the CLAUDE voice runs. The known-id set
// widens to include `claude` ONLY under `--with-claude`, so `--reviewers claude`
// without the flag fails closed (claude is not a core reviewer). Absent `--reviewers`
// → the full roster (core = codex+grok, claude = withClaude). Fails closed on a typo.
export function resolveReviewRoster(
  requested: string[] | undefined,
  withClaude: boolean
): RosterResolution {
  const known = withClaude ? [...REVIEWER_IDS, 'claude'] : [...REVIEWER_IDS];
  if (requested === undefined) {
    return { claude: withClaude, core: [...REVIEWER_IDS] };
  }
  const ids = [...new Set(requested.map((s) => s.trim()).filter(Boolean))];
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length > 0) {
    const hint =
      !withClaude && unknown.includes('claude')
        ? ' (claude is only available with --with-claude)'
        : '';
    return {
      error: `unknown reviewer id(s): ${unknown.join(', ')} (known: ${known.join(', ')})${hint}`,
    };
  }
  const core = ids.filter((id): id is ReviewerId =>
    (REVIEWER_IDS as readonly string[]).includes(id)
  );
  const claude = ids.includes('claude');
  // The CLI core stays codex+grok (they mint the content-tied receipt); claude is an
  // ADDITIVE voice, never a standalone reviewer. Require ≥1 cross-vendor core.
  if (core.length === 0) {
    return {
      error:
        'select at least one cross-vendor reviewer (codex/grok) — claude is additive (--with-claude), not standalone',
    };
  }
  return { claude, core };
}

// ── Voice-review adaptation ───────────────────────────────────────────────────

// Reduce a persisted core review (codex/grok) to what the synthesizer needs.
export function storedToVoiceReview(r: StoredReview): VoiceReview {
  return {
    findings: r.findings,
    ok: r.terminalState === 'reviewed',
    summary: r.summary,
    voiceId: r.reviewerId ?? r.reviewer.vendor,
  };
}

type ClaudeRunner = (
  prompt: string,
  config: VoiceConfig,
  opts?: RunReviewOpts
) => Promise<VoiceRunResult>;

// ── The synthesis pass ────────────────────────────────────────────────────────

// Run the Claude SYNTHESIS over every voice's findings. Injectable runner (real =
// runClaudeVoice; tests inject outputs). Any failure/unparseable reply degrades to
// the deterministic fallback (clearly flagged), never throwing.
export async function synthesizeReviews(
  reviews: VoiceReview[],
  run: ClaudeRunner,
  config: VoiceConfig,
  opts: { log?: (m: string) => void; timeoutMs?: number } = {}
): Promise<ReviewSynthesis> {
  const log = opts.log ?? (() => {});
  const healthy = reviews.filter((r) => r.ok);
  if (healthy.length === 0) return fallbackReviewSynthesis(reviews);

  const prompt = renderReviewSynthesisPrompt(reviews);
  log('Synthesizing with claude — dedupe · agree/disagree · sanity-check…');
  let res: VoiceRunResult;
  try {
    res = await run(prompt, config, { timeoutMs: opts.timeoutMs });
  } catch (e) {
    log(`  · synthesis failed (${(e as Error).message}) — deterministic fallback`);
    return { ...fallbackReviewSynthesis(reviews), error: (e as Error).message };
  }
  if (!res.raw || res.timedOut) {
    log('  · synthesis produced no usable output — deterministic fallback');
    return {
      ...fallbackReviewSynthesis(reviews),
      error: res.timedOut ? 'synthesis timed out' : 'synthesis produced no output',
    };
  }
  const parsed = parseReviewSynthesis(res.raw);
  if (parsed.parseError) {
    log(`  · synthesis not parseable (${parsed.parseError}) — deterministic fallback`);
    return { ...fallbackReviewSynthesis(reviews), error: parsed.parseError, raw: res.raw };
  }
  // Validate the synthesizer's claims against the ACTUAL per-voice reviews so it can't
  // fabricate confident agreement (invented consensus / phantom voices).
  const { synthesis, demoted } = reconcileSynthesis(
    {
      agreements: parsed.agreements,
      bottomLine: parsed.bottomLine,
      by: 'claude',
      degraded: false,
      disagreements: parsed.disagreements,
      ok: true,
      raw: res.raw,
      sanityChecks: parsed.sanityChecks,
      summary: parsed.summary,
    },
    reviews
  );
  if (demoted > 0) {
    log(
      `  · synthesis: ${demoted} unverifiable "agreement(s)" demoted to look-closer (not corroborated by ≥2 real voices)`
    );
  }
  log(
    `  · synthesis: ${synthesis.agreements.length} agreement(s), ${synthesis.disagreements.length} disagreement(s), ${synthesis.sanityChecks.length} sanity-check(s)`
  );
  return synthesis;
}

// ── The whole layer: claude reviewer + synthesis ──────────────────────────────

export interface ClaudeLayerOptions {
  claudeConfig: VoiceConfig;
  // The codex+grok reviews already produced by runReviewMode (the receipt-bearing core).
  coreReviews: StoredReview[];
  // Whether the CLAUDE voice runs as a third reviewer (roster.claude).
  includeClaudeReviewer: boolean;
  log?: (m: string) => void;
  // The exact packet prompt the core reviewers saw — the claude reviewer sees it too.
  reviewPrompt: string;
  // Injectable claude runner (default: the real headless `claude -p` voice).
  run?: ClaudeRunner;
  synthConfig?: VoiceConfig;
  timeoutMs?: number;
}

export interface ClaudeLayerResult {
  // The cold claude review (null when claude is not in the roster).
  claudeReview: VoiceReview | null;
  synthesis: ReviewSynthesis;
}

// Run the cold claude reviewer (when in the roster) over the SAME prompt, then
// synthesize over every voice. A claude reviewer failure degrades to an ok:false
// voice (the synthesis still runs over codex+grok); an unavailable synthesizer
// degrades to the deterministic fallback.
export async function runClaudeReviewLayer(
  opts: ClaudeLayerOptions
): Promise<ClaudeLayerResult> {
  const log = opts.log ?? (() => {});
  const run: ClaudeRunner = opts.run ?? runClaudeVoice;
  const voiceReviews = opts.coreReviews.map(storedToVoiceReview);

  let claudeReview: VoiceReview | null = null;
  if (opts.includeClaudeReviewer) {
    log('  · claude (anthropic) reviewing the diff (cold)…');
    claudeReview = await runClaudeReviewer(opts.reviewPrompt, opts.claudeConfig, run, opts.timeoutMs, log);
    voiceReviews.push(claudeReview);
  }

  const synthesis = await synthesizeReviews(
    voiceReviews,
    run,
    opts.synthConfig ?? opts.claudeConfig,
    { log, timeoutMs: opts.timeoutMs }
  );
  return { claudeReview, synthesis };
}

async function runClaudeReviewer(
  reviewPrompt: string,
  config: VoiceConfig,
  run: ClaudeRunner,
  timeoutMs: number | undefined,
  log: (m: string) => void
): Promise<VoiceReview> {
  let res: VoiceRunResult;
  try {
    res = await run(reviewPrompt, config, { timeoutMs });
  } catch (e) {
    log(`  · claude: failed to run — ${(e as Error).message}`);
    return { findings: [], ok: false, summary: `claude did not run: ${(e as Error).message}`, voiceId: 'claude' };
  }
  if (!res.raw || res.timedOut) {
    const why = res.timedOut ? 'timed out' : 'produced no output';
    log(`  · claude: ${why}`);
    return { findings: [], ok: false, summary: `claude ${why}`, voiceId: 'claude' };
  }
  const parsed = parseFindings(res.raw);
  if (parsed.parseError) {
    log(`  · claude: ${parsed.parseError}`);
    return { findings: [], ok: false, summary: parsed.summary || parsed.parseError, voiceId: 'claude' };
  }
  log(`  · claude: reviewed — ${parsed.findings.length} finding(s)`);
  return { findings: parsed.findings, ok: true, summary: parsed.summary, voiceId: 'claude' };
}

// ── Trail boundary guard (brain separation for `_work` repos) ─────────────────

// Resolve a path through symlinks WITHOUT requiring it to exist yet (the trail out-dir
// is created later): realpath the nearest existing ancestor, then re-append the missing
// tail. A pure `path.resolve` is a STRING op that a symlink can defeat — e.g. a `_work`
// out dir symlinked into ~/brain would resolve to a non-brain string and slip the guard.
// Mirrors Part A's convention-boundary symlink fix.
function realpathBestEffort(p: string): string {
  let cur = path.resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p); // hit the root without resolving
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// True iff a path lies under a `_work` fence — the employer-side repo bucket. The
// review of such a repo must never write its trail into the personal brain. Realpath
// first so a symlinked repo path can't hide the `_work` segment.
export function isUnderWorkPath(p: string): boolean {
  return realpathBestEffort(p)
    .split(path.sep)
    .some((seg) => seg === '_work' || seg.startsWith('_work-'));
}

// PURE-ish: would writing the trail to `outDir` for a review of `cwd` cross the brain
// boundary? True iff the repo is a `_work` repo AND the out dir resolves under one of
// the personal-brain roots. Both sides are realpath'd (not string-resolved) so a
// symlinked out dir can't slip the fence. (Injectable roots keep this unit-testable.)
export function trailBoundaryViolation(
  cwd: string,
  outDir: string,
  brainRoots: string[]
): boolean {
  if (!isUnderWorkPath(cwd)) return false;
  const out = realpathBestEffort(outDir);
  // Realpath BOTH sides through the same resolver so any symlink transform (e.g. macOS
  // `/home` autofs) applies identically to out and the roots — a string-only compare
  // would spuriously miss/hit once one side is resolved.
  return brainRoots.some((root) => {
    const r = realpathBestEffort(root);
    return out === r || out.startsWith(r + path.sep);
  });
}

// The personal-brain roots to fence a `_work` trail out of (~/brain + its real target).
export function resolveBrainRoots(): string[] {
  const roots = new Set<string>();
  const candidates = [
    path.join(os.homedir(), 'brain'),
    path.join(os.homedir(), 'programming', 'projects', '_personal', 'my-brain'),
  ];
  for (const c of candidates) {
    try {
      roots.add(fs.realpathSync(c));
    } catch {
      // not present on this machine — skip
    }
    roots.add(path.resolve(c));
  }
  return [...roots];
}

// Enforce the boundary: for a `_work` repo, force the trail to a local temp dir when
// the requested out dir would land in the brain. Returns the safe out dir + whether it
// was overridden (so the CLI can warn).
export function enforceTrailBoundary(
  cwd: string,
  outDir: string,
  runId: string,
  brainRoots: string[] = resolveBrainRoots()
): { out: string; overridden: boolean } {
  if (trailBoundaryViolation(cwd, outDir, brainRoots)) {
    return { out: path.join(os.tmpdir(), 'ensemble-ai', runId), overridden: true };
  }
  return { out: outDir, overridden: false };
}

// ── Rendering (for the CLI summary) ───────────────────────────────────────────

// Strip control chars + collapse whitespace — voice output is untrusted (a crafted
// diff could induce ANSI escapes). Local copy so the module is self-contained.
function scrub(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// The claude-layer block for stdout: the cold claude review's findings, then the
// synthesis (AGREE / DISAGREE / sanity-checks / bottom line). Grouped + scannable,
// mirroring printSummary/printConsult.
export function renderClaudeLayer(result: ClaudeLayerResult): string[] {
  const out: string[] = [];
  const cr = result.claudeReview;
  if (cr) {
    out.push('');
    out.push(`  ── claude [anthropic] — ${cr.ok ? 'reviewed' : 'failed'} (cold, --with-claude) ──`);
    if (!cr.ok) {
      out.push(`     ${scrub(cr.summary).slice(0, 200)}`);
    } else if (cr.findings.length === 0) {
      out.push('     no findings');
    } else {
      for (const f of cr.findings) {
        const where = f.evidence.file
          ? `${f.evidence.file}${f.evidence.line ? `:${f.evidence.line}` : ''}`
          : '(uncited)';
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
  if (s.sanityChecks.length > 0) {
    out.push('     sanity-checks');
    for (const c of s.sanityChecks) {
      out.push(`        [${c.verdict}] ${scrub(c.finding).slice(0, 200)}${c.note ? ` — ${scrub(c.note).slice(0, 200)}` : ''}`);
    }
  }
  if (s.bottomLine) {
    out.push('     → bottom line');
    out.push(`        ${scrub(s.bottomLine).slice(0, 500)}`);
  }
  return out;
}
