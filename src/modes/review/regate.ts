import fs from 'node:fs';
import path from 'node:path';

import { reviewDir, writeTrailFile } from '../../core/artifacts';
import type { VoiceConfig } from '../brainstorm/types';

import { runClaudeReviewVoice } from './claude';
import { type GateVerdictRecord, runGate } from './gate';
import { readGatePacketHeadSha } from './gate-hunks';
import { worktreeReader } from './holistic-gate';
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
  gateConfig: VoiceConfig;
  log?: (m: string) => void;
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

export async function runRegate(opts: RegateOptions): Promise<RegateResult> {
  const log = opts.log ?? (() => {});
  const headSha = readGatePacketHeadSha(opts.baseDir, opts.runId);
  if (!headSha) {
    throw new Error(
      `run ${opts.runId} has no usable packet.gate.json under ${opts.baseDir} — nothing to ground a regate against`
    );
  }
  const reviews = loadVoiceReviewsFromTrail(opts.baseDir, opts.runId);
  if (reviews.length === 0) {
    throw new Error(
      `run ${opts.runId} has no persisted reviews in its trail — nothing to regate`
    );
  }
  log(
    `regate: ${reviews.length} persisted reviewer voice(s) rehydrated · head ${headSha.slice(0, 12)} · ${
      opts.worktree ? 'worktree evidence' : 'packet evidence'
    }`
  );

  const gate = await runGate({
    baseDir: opts.baseDir,
    config: opts.gateConfig,
    expectedHeadSha: headSha,
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
    reviews,
    run: opts.run ?? runClaudeReviewVoice,
    runId: opts.runId,
    // Same watchdog policy as the layer: the worktree gate carries the heavy-pass budget.
    timeoutMs: opts.timeoutMs ?? (opts.worktree ? GATE_WORKTREE_TIMEOUT_MS : undefined),
    ...(opts.worktree ? { worktree: opts.worktree } : {}),
  });

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
          gateVerdicts: gate.verdicts,
          regatedAt: new Date().toISOString(),
          synthesis: gate.synthesis,
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
    verdicts: gate.verdicts,
  };
}
