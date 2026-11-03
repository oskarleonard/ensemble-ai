import fs from 'node:fs';
import path from 'node:path';

import { escapesRoot, reviewDir, writeTrailFile } from '../../core/artifacts';
import type { ResolvedVoiceConfig } from '../brainstorm/types';

import { runClaudeReviewVoice } from './claude';
import { type GateBaseTrail, type GateVerdictRecord, runGate, writeGateVerdictsTrail } from './gate';
import { readGatePacketHeadSha } from './gate-hunks';
import { worktreeReader, conventionsAwareReader } from './holistic-gate';
import { readTrailJson } from './trail-io';
import {
  GATE_WORKTREE_TIMEOUT_MS,
  loadVoiceReviewsFromTrail,
} from './self-contained';
import type { ReviewSynthesis } from './synthesis';

// ── REGATE: re-run ONLY the synthesis gate over a run's persisted trail ─────────────────
//
// A gate that dies (timeout, quota) fail-closes every verdict to `unverified` while the
// EXPENSIVE seats' work — codex, grok, the cold producer, the holistic lens — sits complete
// on disk. Re-firing the whole review to heal that one seat re-bills every vendor and
// re-spends the better part of an hour (born from run 2026-07-24-00-36-03: 21 findings
// reviewed clean, gate killed at its watchdog, every verdict fail-closed). The gate already
// reads everything it needs FROM THE TRAIL (the reviews via loadVoiceReviewsFromTrail, the
// pinned packet via readGatePacket), so a regate is: rehydrate, re-spawn the ONE seat,
// rewrite gate-verdicts.json + fold the outcome into claude-synthesis.json. A consumer's
// run page heals IN PLACE because it renders those trail files.
//
// REVIEW-ONLY like the layer itself: the only writes are trail files in the run's own dir.
// The regate NEVER re-reviews — reviewer files are read, never touched.

export interface RegateOptions {
  baseDir: string;
  // Best-effort: the run's gathered convention paths (holistic citation-lifting only).
  conventionPaths?: string[];
  gateConfig: ResolvedVoiceConfig;
  log?: (m: string) => void;
  // The opt-in PREMISE PASS (spec §4, --premise) — off by default, same as the initial pipeline.
  // On ⇒ a regate whose findings cluster re-earns the advisory `simplify` synthesis line; off ⇒ the
  // gate prompt + synthesis are byte-identical to a plain regate. Threaded so a --premise run whose
  // gate died can be HEALED with the same behavior it was launched with (codex#f1 · claude#f1).
  premise?: boolean;
  // The PR's own title + body, re-fetched by the CLI from the PR URL: the gate judges with the same
  // stated intent the review's gate had (a product finding's "does this PR claim it" rests on it).
  // Absent ⇒ no stated-intent clause, the pre-parity regate.
  directive?: string;
  // Re-gate ONE seat's findings only (`--only-seat product`): the gate runs over that seat's
  // persisted review alone, and its records REPLACE that seat's in the prior gate-verdicts.json —
  // every other seat's verdict (posted ones included) and the base block stay as they were, and the
  // synthesis prose is kept (a one-seat gate's bottom line describes one seat). Born of the hand-run
  // of 2026-10-22: a scratch trail holding only the product review, its records spliced back in.
  onlySeat?: string;
  // Injected for tests; the default is the real capability-fenced claude spawn.
  run?: typeof runClaudeReviewVoice;
  runId: string;
  timeoutMs?: number;
  // The PR head re-materialized by the CLI wrapper (openWorktree). Absent ⇒ the gate
  // grounds against the pinned packet only (reference-not-found + holistic verification
  // OFF — the pre-worktree gate, still able to agree/partial/false against the hunks).
  worktree?: string;
}

export interface RegateResult {
  headSha: string;
  // The gate produced a usable envelope — false means it failed AGAIN (verdicts remain
  // fail-closed unverified; the caller exits non-zero so a wrapper can say so).
  ok: boolean;
  reviews: number;
  synthesis: ReviewSynthesis;
  verdicts: GateVerdictRecord[];
}

// Read the run's conventions.json manifest back as the included paths. Best-effort by
// design (absent/corrupt ⇒ undefined): the paths only lift a holistic finding's severity
// cap when it cites one — a regate without them still gates every finding.
export function readConventionPathsFromTrail(
  baseDir: string,
  runId: string
): string[] | undefined {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(reviewDir(baseDir, runId), 'conventions.json'), 'utf8')
    ) as { files?: Array<{ included?: boolean; path?: string }> };
    const paths = (raw.files ?? [])
      .filter((f) => f.included === true && typeof f.path === 'string')
      .map((f) => f.path as string);
    return paths.length > 0 ? paths : undefined;
  } catch {
    return undefined;
  }
}

// The conventions file the REVIEW wrote, from the trail's manifest (`inTree.file`), but only when
// it lies inside the worktree THIS regate materialized — a regate's worktree is a fresh checkout,
// so the review-time path (a reaped temp dir) is normally gone and the answer is null. Null means
// the gate verifies gathered-doc citations from the tree only; it never means "read whatever the
// PR left at that path" (Munin, #145 review).
export function readConventionsFileFromTrail(baseDir: string, runId: string, worktree: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(reviewDir(baseDir, runId), 'conventions.json'), 'utf8')) as { inTree?: { file?: unknown } };
    const file = raw.inTree?.file;
    if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
    const rel = path.relative(path.resolve(worktree), path.resolve(file));
    if (rel === '' || escapesRoot(rel)) return null;
    return file;
  } catch {
    return null;
  }
}

export async function runRegate(opts: RegateOptions): Promise<RegateResult> {
  const log = opts.log ?? (() => {});
  const headSha = readGatePacketHeadSha(opts.baseDir, opts.runId);
  if (!headSha) {
    throw new Error(
      `run ${opts.runId} has no usable packet.gate.json under ${opts.baseDir} — nothing to ground a regate against`
    );
  }
  let reviews = loadVoiceReviewsFromTrail(opts.baseDir, opts.runId);
  if (reviews.length === 0) {
    throw new Error(
      `run ${opts.runId} has no persisted reviews in its trail — nothing to regate`
    );
  }
  if (opts.onlySeat) {
    const only = reviews.filter((r) => r.voiceId === opts.onlySeat);
    if (only.length === 0) {
      throw new Error(
        `run ${opts.runId} has no persisted review for seat "${opts.onlySeat}" (it holds ${reviews.map((r) => r.voiceId).join(', ')}) — nothing to regate`
      );
    }
    reviews = only;
  }
  log(
    `regate: ${reviews.length} persisted reviewer voice(s) rehydrated${opts.onlySeat ? ` (seat ${opts.onlySeat} only — every other seat's verdict is kept)` : ''} · head ${headSha.slice(0, 12)} · ${
      opts.worktree ? 'worktree evidence' : 'packet evidence'
    }`
  );

  // Base drift (trail v12): a regate carries the REVIEW-TIME facts forward (the head is unchanged,
  // the base is not) — read before runGate overwrites the trail.
  // Read before runGate overwrites the trail: the drift block for every regate, and the OTHER
  // seats' records when only one seat is re-gated.
  const priorDrift = readTrailJson<{ base?: GateBaseTrail | null; verdicts?: GateVerdictRecord[] }>(opts.baseDir, opts.runId, 'gate-verdicts.json');
  const conventionsFile = opts.worktree ? readConventionsFileFromTrail(opts.baseDir, opts.runId, opts.worktree) : null;
  if (opts.worktree && !conventionsFile) log('regate: no engine-written conventions file in this worktree — gathered-doc citations verify from the tree only');
  const gate = await runGate({
    baseDir: opts.baseDir,
    config: opts.gateConfig,
    ...(opts.directive ? { directive: opts.directive } : {}),
    expectedHeadSha: headSha,
    ...(priorDrift?.base ? { priorDrift } : {}),
    ...(opts.worktree
      ? {
          gateEvidence: 'worktree' as const,
          holistic: {
            conventionPaths: opts.conventionPaths,
            readAtHead: conventionsAwareReader(worktreeReader(opts.worktree), conventionsFile, opts.conventionPaths ?? [], opts.worktree),
          },
        }
      : {}),
    log,
    // Re-earn the advisory premise `simplify` line when the healed run asked for it (--premise);
    // off ⇒ byte-identical to a plain regate.
    ...(opts.premise ? { premise: true } : {}),
    reviews,
    run: opts.run ?? runClaudeReviewVoice,
    runId: opts.runId,
    // Same watchdog policy as the layer: the worktree gate carries the heavy-pass budget.
    timeoutMs: opts.timeoutMs ?? (opts.worktree ? GATE_WORKTREE_TIMEOUT_MS : undefined),
    ...(opts.worktree ? { worktree: opts.worktree } : {}),
  });

  // One seat only: splice its fresh records into the prior trail at the place that seat's records
  // held, and write THAT as the trail of record (runGate wrote the one-seat records alone).
  let verdicts = gate.verdicts;
  if (opts.onlySeat) {
    const prefix = `${opts.onlySeat}#`;
    const prior = priorDrift?.verdicts ?? [];
    const at = prior.findIndex((v) => v.findingId.startsWith(prefix));
    const kept = prior.filter((v) => !v.findingId.startsWith(prefix));
    const insertAt = at < 0 ? kept.length : at;
    verdicts = [...kept.slice(0, insertAt), ...gate.verdicts, ...kept.slice(insertAt)];
    if (!writeGateVerdictsTrail(opts.baseDir, opts.runId, verdicts, priorDrift?.base ?? null))
      log(`regate: gate-verdicts.json could not be rewritten with the other seats' records — it holds seat ${opts.onlySeat}'s alone`);
    else log(`regate: seat ${opts.onlySeat} — ${gate.verdicts.length} record(s) re-gated, ${kept.length} other kept`);
  }

  // Fold the new gate outcome into claude-synthesis.json IN PLACE — merge, never clobber:
  // the claudeReview/holistic fields in there are the durable record of seats this regate
  // deliberately did not run. `regatedAt` marks the synthesis as healed-after-the-fact.
  try {
    const p = path.join(reviewDir(opts.baseDir, opts.runId), 'claude-synthesis.json');
    const existing = fs.existsSync(p)
      ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>)
      : {};
    writeTrailFile(
      opts.baseDir,
      opts.runId,
      'claude-synthesis.json',
      JSON.stringify(
        {
          ...existing,
          gateSpawned: gate.gateSpawned,
          gateTrailWritten: gate.gateTrailWritten,
          gateVerdicts: verdicts,
          regatedAt: new Date().toISOString(),
          // One seat: the run's synthesis prose stays (it was written over every seat); the
          // one-seat gate's own prose would describe one seat as if it were the run.
          ...(opts.onlySeat ? { regatedSeat: opts.onlySeat } : {}),
          synthesis: opts.onlySeat && existing.synthesis ? existing.synthesis : gate.synthesis,
        },
        null,
        2
      )
    );
  } catch (e) {
    // Trail merge is best-effort — gate-verdicts.json (the consumer-facing truth) was
    // already written by runGate's own trail writer; losing the synthesis fold is LOUD.
    log(`regate: claude-synthesis.json could not be updated (${(e as Error).message})`);
  }

  return {
    headSha,
    ok: !gate.synthesis.degraded,
    reviews: reviews.length,
    synthesis: gate.synthesis,
    verdicts,
  };
}
