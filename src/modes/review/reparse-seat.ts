import fs from 'node:fs';
import path from 'node:path';

import { reviewDir, writeTrailFile } from '../../core/artifacts';
import { parseFindings } from '../../core/findings';
import { scrubControl } from '../../core/sanitize';
import type { ReviewFinding, SeatDiagnostics } from '../../core/types';
import type { ResolvedVoiceConfig } from '../brainstorm/types';

import { CHUNKS_TRAIL_FILE, type ChunksTrail } from './chunks';
import { EVIDENCE_MANIFEST_FILE } from './evidence-manifest';
import { readConventionPathsFromTrail, type RegateOptions, type RegateResult, runRegate } from './regate';
import { acquireReseatLock, foldSynthesis } from './reseat';
import { persistSeatReview, renderReviewMarkdown } from './self-contained';
import type { VoiceReview } from './synthesis';
import { readTrailJson } from './trail-io';

// REPARSE — heal a seat whose reply is ON DISK but was recorded as failed because the parser of the
// day could not read it. The zero-cost half of `reseat`: nothing is spawned, nothing is re-billed;
// the persisted `<seat>-review.raw.md` is re-read with THIS engine's parser, the seat's trail
// artifacts are rewritten as a healthy review, and the gate re-runs over the union exactly as a
// reseat would. Born from the stray-brace runs (2026-09-25 … 2026-10-15): a complete review, five
// findings, `"line":54}}},{` — "no parseable JSON block", seat dropped, run red, nothing posted.
//
// Only the Anthropic producer seat today. It has no pinned prompt on disk (persistSeatReview writes
// no prompt.claude.md), so a true RE-RUN of it is not possible from the trail — which is why
// `reseat --seat claude` is this path and only this path: a reply that still does not parse is
// refused, not re-spawned.

export const REPARSE_SEATS = ['claude'] as const;
export type ReparseSeat = (typeof REPARSE_SEATS)[number];

export function isReparseSeat(v: string): v is ReparseSeat {
  return (REPARSE_SEATS as readonly string[]).includes(v);
}

export interface ReparseReady {
  // The seat's persisted review.<seat>.json, verbatim — its advisor and diagnostics are kept.
  existing: Record<string, unknown>;
  findings: ReviewFinding[];
  raw: string;
  summary: string;
}

export type ReparseGate = { refusal: string } | ReparseReady;

// Every refusal BEFORE anything is touched, in the words the CLI prints. Nothing is billed on this
// path either way; what a refusal protects is the trail — a healthy seat, a cut-off reply, or a
// reply this engine cannot read must never be rewritten as "reviewed".
export function checkReparse(baseDir: string, runId: string, seat: ReparseSeat): ReparseGate {
  const existing = readTrailJson<Record<string, unknown>>(baseDir, runId, `review.${seat}.json`);
  if (!existing || typeof existing !== 'object' || typeof existing.voiceId !== 'string') {
    return {
      refusal: `run ${runId} has no review.${seat}.json under ${baseDir} — the ${seat} seat never persisted a review here; re-fire the review`,
    };
  }
  if (existing.ok === true) {
    return {
      refusal: `seat ${seat} completed in run ${runId} — nothing to heal (re-running a healthy seat is a new review)`,
    };
  }
  // A cut-off reply is not trusted even when what survived happens to parse — the same rule the
  // core seats apply at persist time (seat-run.ts persistAttempt).
  const diag = existing.diagnostics as { timedOutReason?: unknown } | undefined;
  if (diag && typeof diag === 'object' && typeof diag.timedOutReason === 'string') {
    return {
      refusal: `seat ${seat} was cut off on run ${runId} (${diag.timedOutReason}) — its reply is not a complete review and will not be re-read; re-fire the review`,
    };
  }
  const dir = reviewDir(baseDir, runId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  const partRe = new RegExp(`^${seat}-review\\.c\\d+\\.raw\\.md$`);
  const parts = names.filter((n) => partRe.test(n));
  if (parts.length > 0) {
    return {
      refusal: `seat ${seat} reviewed run ${runId} in ${parts.length} parts — re-reading a multi-part reply is not supported yet; re-fire the review`,
    };
  }
  const rawPath = path.join(dir, `${seat}-review.raw.md`);
  if (!fs.existsSync(rawPath)) {
    return {
      refusal: `seat ${seat} left no reply on run ${runId} (no ${seat}-review.raw.md) — nothing to re-read; re-fire the review`,
    };
  }
  const raw = fs.readFileSync(rawPath, 'utf8');
  const parsed = parseFindings(raw);
  if (parsed.parseError) {
    return {
      refusal: `seat ${seat}'s persisted reply on run ${runId} still does not parse under this engine (${parsed.parseError}) — a re-run of this seat is not supported yet; re-fire the review`,
    };
  }
  return { existing, findings: parsed.findings, raw, summary: parsed.summary };
}

export function reparseRefusal(baseDir: string, runId: string, seat: ReparseSeat): string | null {
  const pre = checkReparse(baseDir, runId, seat);
  return 'refusal' in pre ? pre.refusal : null;
}

export interface ReparseSeatOptions {
  baseDir: string;
  conventionPaths?: string[];
  gateConfig: ResolvedVoiceConfig;
  // Injected for tests — the gate seat spawn runRegate uses.
  gateRun?: RegateOptions['run'];
  log?: (m: string) => void;
  premise?: boolean;
  // Injected for tests — the regate over the union. The default is the real one.
  regate?: typeof runRegate;
  runId: string;
  seat: ReparseSeat;
  // The PR head re-materialized by the CLI — the regate is evidence-bearing when present.
  worktree?: string;
}

export interface ReparseSeatResult {
  gate: RegateResult;
  // true ⇔ the regate produced a usable envelope (the seat itself always heals on this path).
  ok: boolean;
  review: VoiceReview;
  // Did the `reseats[]` provenance stamp reach claude-synthesis.json? Best-effort like reseat's,
  // and just as much not a detail to swallow: it is the only durable record that the seat's
  // findings were re-read after the fact rather than parsed at run time.
  stampWritten: boolean;
}

export async function runReparseSeat(opts: ReparseSeatOptions): Promise<ReparseSeatResult> {
  const pre = checkReparse(opts.baseDir, opts.runId, opts.seat);
  if ('refusal' in pre) throw new Error(pre.refusal);
  // Same per-run lock as a reseat: both rewrite the same trail files and regate the same union.
  const release = acquireReseatLock(opts.baseDir, opts.runId);
  try {
    return await reparseUnderLock(opts, pre);
  } finally {
    release();
  }
}

async function reparseUnderLock(opts: ReparseSeatOptions, pre: ReparseReady): Promise<ReparseSeatResult> {
  const log = opts.log ?? (() => {});
  const { baseDir, runId, seat } = opts;
  const { existing, findings } = pre;
  const previousSummary = typeof existing.summary === 'string' ? existing.summary : '';
  const summary =
    pre.summary || `Re-read from the persisted reply: ${findings.length} finding(s) (the reply carried no summary)`;
  const healed: VoiceReview = {
    ...(typeof existing.advisor === 'string' ? { advisor: existing.advisor } : {}),
    ...(existing.diagnostics && typeof existing.diagnostics === 'object'
      ? { diagnostics: existing.diagnostics as SeatDiagnostics }
      : {}),
    findings,
    ok: true,
    summary,
    voiceId: seat,
  };
  log(
    scrubControl(
      `reseat: re-reading ${seat}'s persisted reply on run ${runId} — previously failed (${previousSummary.slice(0, 120)}); now ${findings.length} finding(s), nothing re-billed`
    )
  );
  // The reply itself is NOT rewritten (raw: null) — it is the evidence this heal was read from.
  persistSeatReview(baseDir, runId, seat, healed, null);
  try {
    writeTrailFile(baseDir, runId, `review.${seat}.md`, renderReviewMarkdown(healed));
  } catch (e) {
    log(`reseat: review.${seat}.md could not be written (${(e as Error).message})`);
  }
  // The chunk trail records this seat as failed with the parser's words — make it say what stands.
  try {
    const trail = readTrailJson<ChunksTrail>(baseDir, runId, CHUNKS_TRAIL_FILE);
    if (trail && Array.isArray(trail.chunks)) {
      let touched = false;
      for (const c of trail.chunks) {
        const rec = c.seats?.[seat];
        if (!rec) continue;
        const { why: _why, ...rest } = rec as typeof rec & { why?: string };
        void _why;
        c.seats[seat] = { ...rest, findings: findings.length, state: 'reviewed' };
        touched = true;
      }
      if (touched) writeTrailFile(baseDir, runId, CHUNKS_TRAIL_FILE, JSON.stringify(trail, null, 2));
    }
  } catch (e) {
    log(`reseat: ${CHUNKS_TRAIL_FILE} could not be updated (${(e as Error).message})`);
  }
  // What this seat actually read is unchanged — the manifest already says it; the stamp repeats it.
  const realized = ((): string => {
    const m = readTrailJson<{ realizedEvidence?: Record<string, string> }>(baseDir, runId, EVIDENCE_MANIFEST_FILE);
    return m?.realizedEvidence?.[seat] ?? 'packet';
  })();
  const stampWritten = foldSynthesis(
    baseDir,
    runId,
    (synth) => ({
      ...synth,
      // The synthesis trail keeps the seat's own record beside the stamp (regate's fold never
      // clobbers it, so the failed copy would otherwise stay there forever).
      [`${seat}Review`]: healed,
      reseats: [
        ...((synth.reseats as unknown[] | undefined) ?? []),
        {
          at: new Date().toISOString(),
          baseSha: null,
          evidenceDowngraded: false,
          fallbackReason: null,
          outcome: 'reviewed',
          previous: { ok: false, summary: previousSummary },
          realized,
          // The one field that tells this heal from a re-run: the reply was never re-spawned.
          reparsed: true,
          seat,
          summary: healed.summary.slice(0, 600),
        },
      ],
    }),
    log
  );
  log(`reseat: ${seat} reviewed — ${findings.length} finding(s) · evidence ${realized} · regating the union…`);
  const gate = await (opts.regate ?? runRegate)({
    baseDir,
    conventionPaths: opts.conventionPaths ?? readConventionPathsFromTrail(baseDir, runId),
    gateConfig: opts.gateConfig,
    log,
    ...(opts.premise ? { premise: true } : {}),
    ...(opts.gateRun ? { run: opts.gateRun } : {}),
    runId,
    ...(opts.worktree ? { worktree: opts.worktree } : {}),
  });
  return { gate, ok: gate.ok, review: healed, stampWritten };
}
