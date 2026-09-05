import fs from 'node:fs';
import path from 'node:path';

import { readReview, reviewDir, writeTrailFile } from '../../core/artifacts';
import type { CoreReviewerId, ReviewerConfig, ReviewPacket, StoredReview } from '../../core/types';
import type { VoiceConfig } from '../brainstorm/types';

import type { EvidenceClass } from './evidence';
import { EVIDENCE_MANIFEST_FILE } from './evidence-manifest';
import { readGatePacketHeadSha } from './gate-hunks';
import { type RegateOptions, type RegateResult, runRegate } from './regate';
import { type SeatQualification, WORKTREE_SUFFIX_HEADER, worktreePromptSuffix } from './seat-evidence';
import { type ReviewAdapter, RETRIES_ON_PACKET, runCoreSeat } from './seat-run';
import { renderReviewMarkdown, storedToVoiceReview } from './self-contained';

// RESEAT — re-run ONE failed core reviewer seat against a run's own pinned packet, then regate the
// union. regate's sibling, one stage earlier (incident 2026-09-02b: a vendor CLI's self-update broke
// one seat's sandbox twice in a day; every other seat and the gate completed, and the only remedies
// were a two-voice review or re-billing everyone).

export interface SplitPrompt {
  // Recovered from the preamble's `git diff <base>...<head>` line; null when it had none.
  baseSha: string | null;
  hadWorktree: boolean;
  // The pinned packet prompt — byte-identical to what every seat saw, minus the preamble.
  packetPrompt: string;
}

// PURE. The persisted `prompt.<seat>.md` is the packet prompt PLUS, in worktree mode, a preamble
// naming the (long reaped) worktree dir. Strip at the shared header; never re-render the packet.
export function splitWorktreePrompt(prompt: string): SplitPrompt {
  const idx = prompt.indexOf(`\n\n${WORKTREE_SUFFIX_HEADER}`);
  if (idx === -1) return { baseSha: null, hadWorktree: false, packetPrompt: prompt };
  const suffix = prompt.slice(idx);
  const m = suffix.match(/git diff ([0-9a-f]{7,40})\.\.\.[0-9a-f]{7,40}/);
  return { baseSha: m ? m[1] : null, hadWorktree: true, packetPrompt: prompt.slice(0, idx) };
}

export interface SeatArtifacts {
  packet: ReviewPacket;
  prompt: string;
  stored: StoredReview;
}

// The three artifacts persistReview wrote for this seat. Any one missing ⇒ a named error — the
// trail is the contract, and a partial trail is not something to guess around.
export function readSeatArtifacts(
  baseDir: string,
  runId: string,
  seat: CoreReviewerId
): SeatArtifacts | { error: string } {
  const dir = reviewDir(baseDir, runId);
  const stored = readReview(baseDir, runId, seat);
  if (!stored) return { error: `run ${runId} has no review.${seat}.json under ${baseDir}` };
  let packet: ReviewPacket;
  try {
    packet = JSON.parse(
      fs.readFileSync(path.join(dir, `packet.${seat}.json`), 'utf8')
    ) as ReviewPacket;
  } catch {
    return { error: `run ${runId} has no readable packet.${seat}.json` };
  }
  let prompt: string;
  try {
    prompt = fs.readFileSync(path.join(dir, `prompt.${seat}.md`), 'utf8');
  } catch {
    return { error: `run ${runId} has no readable prompt.${seat}.md` };
  }
  return { packet, prompt, stored };
}

export interface ReseatOptions {
  adapter: ReviewAdapter;
  baseDir: string;
  conventionPaths?: string[];
  gateConfig: VoiceConfig;
  // Injected for tests — the gate seat spawn runRegate uses.
  gateRun?: RegateOptions['run'];
  log?: (m: string) => void;
  // This seat's sandbox qualification for the NEW worktree. Absent ⇒ packet-mode run.
  qualification?: SeatQualification;
  reviewer: ReviewerConfig;
  runId: string;
  seat: CoreReviewerId;
  // The PR head re-materialized by the CLI (openWorktree). Absent ⇒ the seat runs on the packet.
  worktree?: { baseSha: string | null; dir: string; headSha: string };
}

export interface ReseatResult {
  // Null when the seat failed again (the gate is NOT re-run over an unchanged voice set).
  gate: RegateResult | null;
  // true ⇔ the seat reviewed AND the regate produced a usable envelope.
  ok: boolean;
  realized: EvidenceClass;
  review: StoredReview;
}

// Merge a record into claude-synthesis.json — never clobber (regate's own fold does the same).
function foldSynthesis(
  baseDir: string,
  runId: string,
  patch: (existing: Record<string, unknown>) => Record<string, unknown>,
  log: (m: string) => void
): void {
  try {
    const p = path.join(reviewDir(baseDir, runId), 'claude-synthesis.json');
    const existing = fs.existsSync(p)
      ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>)
      : {};
    writeTrailFile(baseDir, runId, 'claude-synthesis.json', JSON.stringify(patch(existing), null, 2));
  } catch (e) {
    log(`reseat: claude-synthesis.json could not be updated (${(e as Error).message})`);
  }
}

export async function runReseat(opts: ReseatOptions): Promise<ReseatResult> {
  const log = opts.log ?? (() => {});
  const { baseDir, runId, seat } = opts;
  const headSha = readGatePacketHeadSha(baseDir, runId);
  if (!headSha) {
    throw new Error(
      `run ${runId} has no usable packet.gate.json under ${baseDir} — nothing to ground a reseat against`
    );
  }
  const art = readSeatArtifacts(baseDir, runId, seat);
  if ('error' in art) throw new Error(art.error);
  if (art.stored.terminalState === 'reviewed') {
    throw new Error(
      `seat ${seat} completed in run ${runId} — nothing to retry (re-running a healthy seat is a new review)`
    );
  }
  const split = splitWorktreePrompt(art.prompt);
  const wt = opts.worktree;
  const qualified = Boolean(wt && opts.qualification?.qualified);
  if (wt && !qualified) {
    log(
      `reseat: ⚠ ${opts.qualification?.reason ?? 'no sandbox qualification'} — ${seat} re-runs on the PACKET`
    );
  }
  const worktreePrompt =
    wt && qualified
      ? split.packetPrompt +
        worktreePromptSuffix({
          baseSha: wt.baseSha ?? split.baseSha,
          headSha: wt.headSha,
          worktree: wt.dir,
        })
      : undefined;
  log(
    `reseat: re-running ${seat} on run ${runId} · head ${headSha.slice(0, 12)} · ${
      worktreePrompt ? 'worktree evidence' : 'packet evidence'
    } · previously ${art.stored.terminalState}`
  );

  const seatRun = await runCoreSeat({
    adapter: opts.adapter,
    log,
    out: baseDir,
    packet: art.packet,
    packetComplete: art.packet.complete,
    packetPrompt: split.packetPrompt,
    qualification: opts.qualification,
    retryOnPacket: RETRIES_ON_PACKET[seat],
    reviewer: opts.reviewer,
    runId,
    ...(worktreePrompt && wt ? { worktree: wt.dir, worktreePrompt } : {}),
  });
  const review = seatRun.review;
  try {
    writeTrailFile(
      baseDir,
      runId,
      `review.${seat}.md`,
      renderReviewMarkdown(storedToVoiceReview(review))
    );
  } catch (e) {
    log(`reseat: review.${seat}.md could not be written (${(e as Error).message})`);
  }
  // The attempt is on record whether or not it healed anything.
  foldSynthesis(
    baseDir,
    runId,
    (existing) => ({
      ...existing,
      reseats: [
        ...((existing.reseats as unknown[] | undefined) ?? []),
        {
          at: new Date().toISOString(),
          outcome: review.terminalState,
          previous: { summary: art.stored.summary, terminalState: art.stored.terminalState },
          realized: seatRun.realized,
          seat,
        },
      ],
    }),
    log
  );
  // The manifest's REALIZED map tells consumers what each seat actually read — keep it true.
  try {
    const mp = path.join(reviewDir(baseDir, runId), EVIDENCE_MANIFEST_FILE);
    if (fs.existsSync(mp)) {
      const manifest = JSON.parse(fs.readFileSync(mp, 'utf8')) as {
        realizedEvidence?: Record<string, string>;
      };
      manifest.realizedEvidence = {
        ...(manifest.realizedEvidence ?? {}),
        [seat]: seatRun.realized,
      };
      writeTrailFile(baseDir, runId, EVIDENCE_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    }
  } catch (e) {
    log(`reseat: ${EVIDENCE_MANIFEST_FILE} could not be updated (${(e as Error).message})`);
  }
  if (review.terminalState !== 'reviewed') {
    log(`reseat: ${seat} FAILED AGAIN — ${review.summary.replace(/\s+/g, ' ').slice(0, 200)}`);
    return { gate: null, ok: false, realized: seatRun.realized, review };
  }
  log(
    `reseat: ${seat} reviewed — ${review.findings.length} finding(s) · evidence ${seatRun.realized} · regating the union…`
  );
  const gate = await runRegate({
    baseDir,
    conventionPaths: opts.conventionPaths,
    gateConfig: opts.gateConfig,
    log,
    ...(opts.gateRun ? { run: opts.gateRun } : {}),
    runId,
    ...(wt ? { worktree: wt.dir } : {}),
  });
  return { gate, ok: gate.ok, realized: seatRun.realized, review };
}
