import fs from 'node:fs';
import path from 'node:path';

import { persistReview, reviewDir } from '../../core/artifacts';
import type { EgressDenial } from '../../core/egress-proxy';
import type { assembleCodePacket } from '../../core/packet';
import type { ReviewerConfig, ReviewFinding, SeatDiagnostics, StoredReview } from '../../core/types';

import type { EvidenceClass } from './evidence';
import type { SeatRunResult } from './seat-run';

// MERGING A SEAT'S PARTS (chunks.ts). One reviewer, N parts, N seat runs — and ONE review of record:
// `review.<id>.json` describes the merged result so every downstream reader (the gate, the receipt,
// the dashboard, `reseat`) keeps reading one file per reviewer. The parts' own artifacts survive
// beside it under their `.c<k>` suffix (core/artifacts).
//
// Rules, all fail-closed:
//   · the merged seat is `reviewed` only if EVERY part is — a part that timed out leaves the
//     reviewer incomplete, exactly as a single packet that timed out would;
//   · findings keep their order (part 1 first), are renumbered `f1..fn` so ids stay unique within
//     the reviewer (the gate mints `<voice>#<n>` from position), and carry `chunk` so a reader can
//     tell which packet produced them;
//   · realized evidence is the WEAKEST part's (a part that fell back to the packet means this
//     reviewer did not read the tree for the whole change);
//   · every part's fallback reason and egress denial is kept — nothing is laundered by the merge.

export interface ChunkSeatRun {
  index: number;
  label: string;
  seat: SeatRunResult;
}

export interface MergeChunkSeatRunsArgs {
  out: string;
  // Part 1's packet + prompt — the canonical `packet.<id>.json` / `prompt.<id>.md` after the merge
  // (each part's own pair is on disk under its suffix). Part 1 is the representative because its
  // scope section lists every part.
  packet: ReturnType<typeof assembleCodePacket>;
  prompt: string;
  reviewer: ReviewerConfig;
  runId: string;
  runs: readonly ChunkSeatRun[];
}

function mergedDiagnostics(runs: readonly ChunkSeatRun[]): SeatDiagnostics | undefined {
  const ds = runs.map((r) => r.seat.review.diagnostics).filter((d): d is SeatDiagnostics => Boolean(d));
  if (ds.length === 0) return undefined;
  const failed = runs.find((r) => r.seat.review.terminalState !== 'reviewed')?.seat.review.diagnostics;
  const timedOut = ds.find((d) => d.timedOutReason);
  const failWhy = ds.map((d) => d.failWhy).filter(Boolean);
  const warnings = ds.flatMap((d) => d.preflightWarnings ?? []);
  return {
    elapsedMs: ds.reduce((n, d) => n + d.elapsedMs, 0),
    endedAt: ds.map((d) => d.endedAt).sort().at(-1) as string,
    ...(failWhy.length > 0 ? { failWhy: failWhy.join(' · ') } : {}),
    ...(warnings.length > 0 ? { preflightWarnings: [...new Set(warnings)] } : {}),
    startedAt: ds.map((d) => d.startedAt).sort()[0],
    // The stderr that matters is the failing part's; a clean merge keeps the last part's tail.
    stderrTail: (failed ?? ds[ds.length - 1]).stderrTail,
    ...(timedOut?.timedOutReason ? { timedOutReason: timedOut.timedOutReason } : {}),
  };
}

export function mergeChunkSeatRuns(args: MergeChunkSeatRunsArgs): SeatRunResult {
  const runs = [...args.runs].sort((a, b) => a.index - b.index);
  const n = runs.length;
  const findings: ReviewFinding[] = [];
  for (const r of runs) {
    for (const f of r.seat.review.findings) {
      findings.push({ ...f, chunk: r.index, id: `f${findings.length + 1}` });
    }
  }
  const failed = runs.filter((r) => r.seat.review.terminalState !== 'reviewed');
  const terminalState: StoredReview['terminalState'] = failed.length === 0 ? 'reviewed' : 'failed-reviewer';
  const summary =
    failed.length === 0
      ? runs.map((r) => `Part ${r.index}/${n} (${r.label}): ${r.seat.review.summary}`).join('\n')
      : [
          `Reviewed in ${n} part(s); ${failed.length} part(s) did not complete, so this reviewer is INCOMPLETE for the change.`,
          ...failed.map((r) => `Part ${r.index}/${n} (${r.label}) FAILED: ${r.seat.review.summary}`),
          ...runs
            .filter((r) => r.seat.review.terminalState === 'reviewed')
            .map((r) => `Part ${r.index}/${n} (${r.label}): ${r.seat.review.summary}`),
        ].join('\n');
  // Each part's raw reply is on disk under its suffix (persistAttempt wrote it); the merged
  // `<id>-review.raw.md` concatenates them under part headings. Best-effort: a part whose reply
  // cannot be read back is simply absent from the merged file (its findings are already merged).
  const dir = reviewDir(args.out, args.runId);
  const raws = runs
    .map((r) => {
      try {
        const raw = fs.readFileSync(path.join(dir, `${args.reviewer.id}-review.c${r.index}.raw.md`), 'utf8');
        return `## Part ${r.index} of ${n} — ${r.label}\n\n${raw}`;
      } catch {
        return null;
      }
    })
    .filter((x): x is string => x !== null);
  const review = persistReview(args.out, {
    diagnostics: mergedDiagnostics(runs),
    findings,
    packet: args.packet,
    prompt: args.prompt,
    raw: raws.length > 0 ? raws.join('\n\n') : null,
    reviewer: args.reviewer,
    runId: args.runId,
    summary,
    terminalState,
  });
  const realized: EvidenceClass = runs.every((r) => r.seat.realized === 'worktree') ? 'worktree' : 'packet';
  const fallbacks = runs
    .map((r) => (r.seat.fallbackReason ? `part ${r.index}/${n}: ${r.seat.fallbackReason}` : null))
    .filter((x): x is string => x !== null);
  const egressDenials: EgressDenial[] = runs.flatMap((r) => [...r.seat.egressDenials]);
  return {
    egressDenials,
    fallbackReason: fallbacks.length > 0 ? fallbacks.join('; ') : null,
    realized,
    review,
  };
}
