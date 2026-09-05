import fs from 'node:fs';
import path from 'node:path';

import { readReview, reviewDir, writeTrailFile } from '../../core/artifacts';
import type { EgressDenial } from '../../core/egress-proxy';
import type { CoreReviewerId, ReviewerConfig, ReviewPacket, StoredReview } from '../../core/types';
import type { VoiceConfig } from '../brainstorm/types';

import type { EvidenceClass } from './evidence';
import { EVIDENCE_MANIFEST_FILE } from './evidence-manifest';
import { readGatePacketHeadSha } from './gate-hunks';
import {
  readConventionPathsFromTrail,
  type RegateOptions,
  type RegateResult,
  runRegate,
} from './regate';
import {
  formatEgressDenialCounts,
  type SeatQualification,
  WORKTREE_SUFFIX_HEADER,
  worktreePromptSuffix,
} from './seat-evidence';
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
// naming the (long reaped) worktree dir. Recover the packet prompt by PROVING the tail is a
// preamble this engine emitted, never by trusting the header text alone.
//
// The header line is CONTRIBUTOR-CONTROLLED (incident 2026-09-02b review): the persisted prompt
// embeds every packet section body raw — the PR description among them — so a PR body can contain
// `\n\n## Whole-project evidence …` plus a `git diff <base>...<head>` line of its own. Splitting at
// the FIRST occurrence then truncated the "byte-identical" pinned prompt (the diff and the findings
// contract were cut away) and re-issued the preamble with an attacker-chosen base SHA. Two things
// close it: the preamble is always appended LAST, and it is rendered — so from the candidate tail we
// recover its three fields, re-render `worktreePromptSuffix` from them, and split ONLY if the prompt
// ends with that exact rebuild. Anything else is packet-mode, unchanged.
export function splitWorktreePrompt(prompt: string): SplitPrompt {
  const asPacket: SplitPrompt = { baseSha: null, hadWorktree: false, packetPrompt: prompt };
  const idx = prompt.lastIndexOf(`\n\n${WORKTREE_SUFFIX_HEADER}`);
  if (idx === -1) return asPacket;
  const tail = prompt.slice(idx);
  const named = tail.match(/checked out READ-ONLY at (.+?) \(detached at ([^)\n]+)\)/);
  if (!named) return asPacket;
  const base = tail.match(/git diff ([0-9a-f]{7,40})\.\.\.[0-9a-f]{7,40}/);
  const baseSha = base ? base[1] : null;
  const rebuilt = worktreePromptSuffix({ baseSha, headSha: named[2], worktree: named[1] });
  // Byte-level proof: every other character of the preamble (the read-only clause, the untrusted-
  // instruction clause, the anchor line) has to be there, in order, at the very end.
  if (!prompt.endsWith(rebuilt)) return asPacket;
  return { baseSha, hadWorktree: true, packetPrompt: prompt.slice(0, prompt.length - rebuilt.length) };
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

type ReseatGate = { art: SeatArtifacts; headSha: string } | { refusal: string };

// The pre-spawn refusals, in the order that costs least. The pinned packet grounds everything; a
// mis-materialized tree is refused before a single artifact is read (a wrong tree costs nothing);
// then the seat's own artifacts; then a seat that is not actually dead.
//
// FAIL CLOSED on a mis-materialized worktree: the packet is the pinned description of ONE head, so a
// tree checked out at another commit would ground the seat's file:line citations against code the
// packet does not describe, and the gate would then verify them against the wrong text.
function checkReseat(
  baseDir: string,
  runId: string,
  seat: CoreReviewerId,
  worktreeHeadSha?: string
): ReseatGate {
  const headSha = readGatePacketHeadSha(baseDir, runId);
  if (!headSha) {
    return {
      refusal: `run ${runId} has no usable packet.gate.json under ${baseDir} — nothing to ground a reseat against (was this run made by \`review --out\`?)`,
    };
  }
  if (worktreeHeadSha && worktreeHeadSha !== headSha) {
    return {
      refusal: `worktree is at ${worktreeHeadSha.slice(0, 12)} but run ${runId}'s pinned packet is at ${headSha.slice(0, 12)} — refusing to ground a retry on a different head`,
    };
  }
  const art = readSeatArtifacts(baseDir, runId, seat);
  if ('error' in art) return { refusal: art.error };
  if (art.stored.terminalState === 'reviewed') {
    return {
      refusal: `seat ${seat} completed in run ${runId} — nothing to retry (re-running a healthy seat is a new review)`,
    };
  }
  return { art, headSha };
}

// Why this run may NOT be reseated, in the exact words the caller should print — or null when it may.
// The CLI preflights through this and `runReseat` throws through it, so the two can never drift and
// the CLI can refuse (exit 3) BEFORE it bills a seat spawn.
export function reseatRefusal(
  baseDir: string,
  runId: string,
  seat: CoreReviewerId,
  worktreeHeadSha?: string
): string | null {
  const pre = checkReseat(baseDir, runId, seat, worktreeHeadSha);
  return 'refusal' in pre ? pre.refusal : null;
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
  // Injected for tests — the regate over the union. The default is the real one.
  regate?: typeof runRegate;
  reviewer: ReviewerConfig;
  runId: string;
  seat: CoreReviewerId;
  // The PR head re-materialized by the CLI (openWorktree). Absent ⇒ the seat runs on the packet.
  worktree?: { baseSha: string | null; dir: string; headSha: string };
}

export interface ReseatResult {
  // Connections this attempt's egress proxy REFUSED. LOUD by contract, exactly as in a full run: a
  // reseat that reached for a host outside its vendor allowlist must not be quieter than the fan-out
  // that produced the dead seat in the first place.
  egressDenials: readonly EgressDenial[];
  // true ⇔ the dead attempt reviewed IN-PROJECT and this retry read only the packet. A weaker run
  // than the one it replaces — said aloud by the module's log, stamped into the `reseats[]` entry,
  // and carried here for a caller that decides what to heal next.
  evidenceDowngraded: boolean;
  // Why the seat did not get the worktree it was asked for (unqualified sandbox, or a wrapper that
  // provably broke). Null when nothing degraded. Also stamped into the `reseats[]` trail entry.
  fallbackReason: string | null;
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

// Merge this attempt's refused connections into the run's own egress-denials.json. A reseat is an
// EXTRA seat spawn against a trail that may ALREADY carry denials from the original fan-out, so the
// file is appended to, never replaced — dropping an earlier seat's denial would launder the fence.
function appendEgressDenials(
  baseDir: string,
  runId: string,
  denials: readonly EgressDenial[],
  log: (m: string) => void
): void {
  if (denials.length === 0) return;
  try {
    // Inside the try with the write: this whole record is best-effort, and a throw while merely
    // FORMATTING the rollup must not abort a reseat whose seat spawn is already paid for.
    log(`reseat: ⚠ egress fence: ${formatEgressDenialCounts(denials)}`);
    const p = path.join(reviewDir(baseDir, runId), 'egress-denials.json');
    const prior = fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as unknown) : [];
    const merged = [...(Array.isArray(prior) ? (prior as EgressDenial[]) : []), ...denials];
    writeTrailFile(baseDir, runId, 'egress-denials.json', JSON.stringify(merged, null, 2));
  } catch (e) {
    // Best-effort like every trail write — the denial also rides out on the ReseatResult.
    log(`reseat: egress-denials.json could not be recorded (${(e as Error).message})`);
  }
}

export async function runReseat(opts: ReseatOptions): Promise<ReseatResult> {
  const log = opts.log ?? (() => {});
  const { baseDir, runId, seat } = opts;
  // Every pre-spawn refusal, in the CLI's own words (reseatRefusal) — nothing is billed past here.
  const pre = checkReseat(baseDir, runId, seat, opts.worktree?.headSha);
  if ('refusal' in pre) throw new Error(pre.refusal);
  const { art, headSha } = pre;
  const split = splitWorktreePrompt(art.prompt);
  const wt = opts.worktree;
  const qualified = Boolean(wt && opts.qualification?.qualified);
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
    // The worktree rides through even when the seat does NOT qualify: runCoreSeat's packet branch
    // is what turns "asked for a worktree, could not have one" into the loud `fallbackReason` a
    // full run records. Without `worktreePrompt` it stays a packet run — the seat is never told
    // about a tree it did not get.
    ...(wt ? { worktree: wt.dir } : {}),
    ...(worktreePrompt ? { worktreePrompt } : {}),
  });
  const review = seatRun.review;
  // A worktree the caller supplied with NO qualification never reaches seat-run's own fallback
  // wording (it has no reason to report), so the run would otherwise look exactly like one that was
  // never asked for a worktree at all. Name it here — this is the loud-not-silent rule, and the
  // result, the log and the trail entry all carry the SAME string.
  const fallbackReason =
    seatRun.fallbackReason ??
    (wt && !qualified
      ? `${seat}: no sandbox qualification for the re-materialized worktree${
          opts.qualification?.reason ? ` (${opts.qualification.reason})` : ''
        } — re-ran on the PACKET`
      : null);
  // Logged ONLY when synthesized here: a reason that came from runCoreSeat was already logged there.
  if (fallbackReason && !seatRun.fallbackReason) log(`reseat: ⚠ ${fallbackReason}`);
  // An evidence DOWNGRADE is a fact of its own, and not one `fallbackReason` covers: a retry can run
  // on the packet with nothing having "fallen back" (no worktree was ever offered) and still read
  // LESS than the dead attempt did. The manifest records it silently; the run whose next step is a
  // heal has to hear it. Said here, once, so every caller of this module speaks it.
  const evidenceDowngraded = split.hadWorktree && seatRun.realized === 'packet';
  if (evidenceDowngraded) {
    log(
      `reseat: ⚠ ${seat} originally reviewed IN-PROJECT; this retry read only the diff packet — the run's realized evidence is downgraded.`
    );
  }
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
  appendEgressDenials(baseDir, runId, seatRun.egressDenials, log);
  // The attempt is on record whether or not it healed anything. `summary` carries the NEW attempt's
  // own words, so a sandbox refusal or an incomplete-packet short-circuit explains itself here
  // rather than only in the seat file a reader has to go find.
  foldSynthesis(
    baseDir,
    runId,
    (existing) => ({
      ...existing,
      reseats: [
        ...((existing.reseats as unknown[] | undefined) ?? []),
        {
          at: new Date().toISOString(),
          // The base the OLD preamble named — recovered from `prompt.<seat>.md` just before a
          // packet-mode retry overwrites it with the bare packet prompt. Without this the range the
          // dead attempt reviewed is gone from the trail entirely.
          baseSha: split.baseSha,
          evidenceDowngraded,
          fallbackReason,
          outcome: review.terminalState,
          previous: {
            // What the DEAD attempt had. A packet-mode retry of a seat that originally reviewed
            // in-project is an evidence downgrade, and the trail must still show that.
            hadWorktree: split.hadWorktree,
            summary: art.stored.summary,
            terminalState: art.stored.terminalState,
          },
          realized: seatRun.realized,
          seat,
          // 600: persistAttempt's own no-output summary already carries a 300-char stderr tail, so
          // a tighter slice would cut off the very failure text this field exists to carry.
          summary: review.summary.slice(0, 600),
        },
      ],
    }),
    log
  );
  // The manifest's REALIZED map tells consumers what each seat actually read — keep it true. So is
  // `sandboxProfiles`: it names the fence each seat's evidence was gathered behind, and leaving the
  // ORIGINAL run's profile there beside a freshly rewritten realized class would attest this retry's
  // in-project read under a fence it never ran under. Only a worktree retry touches it — a
  // packet-mode retry ran behind no fence at all, and the original entry stays the record of the
  // attempt that did.
  try {
    const mp = path.join(reviewDir(baseDir, runId), EVIDENCE_MANIFEST_FILE);
    if (fs.existsSync(mp)) {
      const manifest = JSON.parse(fs.readFileSync(mp, 'utf8')) as {
        realizedEvidence?: Record<string, string>;
        sandboxProfiles?: Record<string, unknown>;
      };
      manifest.realizedEvidence = {
        ...(manifest.realizedEvidence ?? {}),
        [seat]: seatRun.realized,
      };
      if (seatRun.realized === 'worktree' && opts.qualification) {
        manifest.sandboxProfiles = {
          ...(manifest.sandboxProfiles ?? {}),
          [seat]: opts.qualification.profile,
        };
      }
      writeTrailFile(baseDir, runId, EVIDENCE_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    }
  } catch (e) {
    log(`reseat: ${EVIDENCE_MANIFEST_FILE} could not be updated (${(e as Error).message})`);
  }
  if (review.terminalState !== 'reviewed') {
    log(`reseat: ${seat} FAILED AGAIN — ${review.summary.replace(/\s+/g, ' ').slice(0, 200)}`);
    return {
      egressDenials: seatRun.egressDenials,
      evidenceDowngraded,
      fallbackReason,
      gate: null,
      ok: false,
      realized: seatRun.realized,
      review,
    };
  }
  log(
    `reseat: ${seat} reviewed — ${review.findings.length} finding(s) · evidence ${seatRun.realized} · regating the union…`
  );
  // The regate's holistic pass lifts a finding's severity cap when it cites a convention doc, so a
  // caller that did not gather the paths gets the ones THIS RUN recorded rather than none.
  const gate = await (opts.regate ?? runRegate)({
    baseDir,
    conventionPaths: opts.conventionPaths ?? readConventionPathsFromTrail(baseDir, runId),
    gateConfig: opts.gateConfig,
    log,
    ...(opts.gateRun ? { run: opts.gateRun } : {}),
    runId,
    ...(wt ? { worktree: wt.dir } : {}),
  });
  return {
    egressDenials: seatRun.egressDenials,
    evidenceDowngraded,
    fallbackReason,
    gate,
    ok: gate.ok,
    realized: seatRun.realized,
    review,
  };
}
