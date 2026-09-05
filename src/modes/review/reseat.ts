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
  // The pinned packet prompt — byte-identical to what every seat saw, minus the preamble. Only
  // meaningful when `unverifiedTail` is false; on an unverified tail it is the WHOLE persisted
  // prompt, stale preamble included, and the caller must refuse rather than re-send it.
  packetPrompt: string;
  // The head the preamble was PINNED AT — recovered from its `(detached at <sha>)`. Null in packet
  // mode and on an unverified tail (nothing recovered from a tail the rebuild could not prove).
  // It is the only surviving record of which commit the persisted prompt described, and the reseat
  // gate refuses when it disagrees with the pinned gate packet's head.
  preambleHeadSha: string | null;
  // true ⇔ a preamble is present (the prompt does not end in a newline) but THIS version cannot
  // re-render it byte-for-byte. Not a packet-mode prompt and not a splittable one: unusable.
  unverifiedTail: boolean;
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
  const asPacket: SplitPrompt = {
    baseSha: null,
    hadWorktree: false,
    packetPrompt: prompt,
    preambleHeadSha: null,
    unverifiedTail: false,
  };
  // STRUCTURAL LOCK, read BEFORE the proof: `renderReviewPrompt` always ends its output with a
  // newline (`${head}\n\n${body}\n\n${ask}\n`), `worktreePromptSuffix` ends with '.', and
  // `persistReview` writes the prompt raw. So a persisted prompt that ends in a newline is a packet
  // prompt — whatever header text it quotes is BODY — and one that does not is a prompt some engine
  // version appended a preamble to.
  //
  // BOTH HALVES ARE PINNED BY TESTS, not by this comment: reseat.test.ts, describe 'the
  // trailing-newline lock the split classifies on' — 'renderReviewPrompt always ends with a newline,
  // in BOTH profiles' and 'worktreePromptSuffix never ends with a newline, with or without a base
  // range'. An edit to either renderer that breaks the lock fails THERE, at its cause, instead of
  // surfacing here as a mis-split.
  if (prompt.endsWith('\n')) return asPacket;
  // A preamble IS present (no packet prompt ends without a newline). From here the only two honest
  // answers are "split it" and "I cannot read this" — never "keep it as body": that would re-send
  // the stale preamble to the retried seat (two preambles, one naming a reaped dir), and would
  // silently drop the downgrade record and the recovered base with it. VERSION SKEW is the ordinary
  // cause: the proof compares against what the CURRENTLY installed renderer emits, so any edit to
  // that text (down to a filename appearing in the stripped-instruction list the untrusted clause
  // interpolates — or to the header line itself) invalidates every prompt persisted before it.
  const unverified: SplitPrompt = {
    baseSha: null,
    hadWorktree: true,
    packetPrompt: prompt,
    preambleHeadSha: null,
    unverifiedTail: true,
  };
  const idx = prompt.lastIndexOf(`\n\n${WORKTREE_SUFFIX_HEADER}`);
  // The header itself is part of the versioned text: a preamble whose header we cannot even find
  // is the same unreadable tail as one that fails the byte proof below — refuse, never keep.
  if (idx === -1) return unverified;
  const tail = prompt.slice(idx);
  const named = tail.match(/checked out READ-ONLY at (.+?) \(detached at ([^)\n]+)\)/);
  if (!named) return unverified;
  const base = tail.match(/git diff ([0-9a-f]{7,40})\.\.\.[0-9a-f]{7,40}/);
  const baseSha = base ? base[1] : null;
  const rebuilt = worktreePromptSuffix({ baseSha, headSha: named[2], worktree: named[1] });
  // Byte-level proof: every other character of the preamble (the read-only clause, the untrusted-
  // instruction clause, the anchor line) has to be there, in order, at the very end.
  if (!prompt.endsWith(rebuilt)) return unverified;
  return {
    baseSha,
    hadWorktree: true,
    packetPrompt: prompt.slice(0, prompt.length - rebuilt.length),
    preambleHeadSha: named[2],
    unverifiedTail: false,
  };
}

export interface SeatArtifacts {
  packet: ReviewPacket;
  prompt: string;
  stored: StoredReview;
}

// Is this parsed JSON actually a packet? `JSON.parse` succeeding proves only that the bytes were
// JSON — `null`, `{}` and `[]` all parse. The two fields the retry path DEREFERENCES are checked:
// `complete` (it decides the no-output short-circuit runCoreSeat applies) and `sections` (the gate
// and the receipt read it as a list of section records).
function isReviewPacketShape(v: unknown): v is ReviewPacket {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  if (typeof p.complete !== 'boolean' || !Array.isArray(p.sections)) return false;
  return (p.sections as unknown[]).every((s) => typeof s === 'object' && s !== null);
}

// The three artifacts persistReview wrote for this seat. Any one missing ⇒ a named error — the
// trail is the contract, and a partial trail is not something to guess around. Neither is a partial
// ARTIFACT: this runs inside the no-billing preflight (`checkReseat`), so a packet that parses but
// is not a packet has to be refused HERE (exit 3, nothing billed) rather than blowing up after the
// seat spawn, where the CLI can only report "failed after the seat spawn" — the opposite of the
// truth about what the operator was charged for. The stored review is shape-guarded by `readReview`.
export function readSeatArtifacts(
  baseDir: string,
  runId: string,
  seat: CoreReviewerId
): SeatArtifacts | { error: string } {
  const dir = reviewDir(baseDir, runId);
  const stored = readReview(baseDir, runId, seat);
  if (!stored) return { error: `run ${runId} has no review.${seat}.json under ${baseDir}` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, `packet.${seat}.json`), 'utf8'));
  } catch {
    return { error: `run ${runId} has no readable packet.${seat}.json` };
  }
  if (!isReviewPacketShape(parsed)) {
    return { error: `run ${runId} has an unreadable packet.${seat}.json (unexpected shape)` };
  }
  const packet = parsed;
  let prompt: string;
  try {
    prompt = fs.readFileSync(path.join(dir, `prompt.${seat}.md`), 'utf8');
  } catch {
    return { error: `run ${runId} has no readable prompt.${seat}.md` };
  }
  return { packet, prompt, stored };
}

type ReseatGate = { art: SeatArtifacts; headSha: string; split: SplitPrompt } | { refusal: string };

// The pre-spawn refusals, in the order that costs least. The pinned packet grounds everything; a
// mis-materialized tree is refused before a single artifact is read (a wrong tree costs nothing);
// then the seat's own artifacts (shape-validated); then a persisted prompt whose preamble this
// engine version cannot verify, or that was pinned at another head; then a seat that is not
// actually dead.
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
  // A pinned prompt whose preamble this version cannot re-render is not a prompt we may re-send.
  // Refusing costs one review; guessing costs a retry grounded in a prompt nobody can describe.
  const split = splitWorktreePrompt(art.prompt);
  if (split.unverifiedTail) {
    return {
      refusal: `seat ${seat}'s persisted prompt carries a worktree preamble this engine version cannot verify (the run was written by another ensemble-ai version) — refusing to retry on an unverifiable pinned prompt; re-run the review instead`,
    };
  }
  // The persisted prompt and the pinned gate packet are two records of ONE head. A VERIFIED preamble
  // naming a different commit means the trail was assembled across heads — so `packetPrompt`, which
  // this retry re-sends as "byte-identical to what every seat saw", describes code the gate packet
  // does not. Same fail-closed rule as the mis-materialized worktree above, and it costs nothing:
  // the seat has not been spawned.
  if (split.preambleHeadSha && split.preambleHeadSha !== headSha) {
    return {
      refusal: `seat ${seat}'s persisted prompt was pinned at ${split.preambleHeadSha.slice(0, 12)} but the run's gate packet is at ${headSha.slice(0, 12)} — refusing to retry across heads`,
    };
  }
  if (art.stored.terminalState === 'reviewed') {
    return {
      refusal: `seat ${seat} completed in run ${runId} — nothing to retry (re-running a healthy seat is a new review)`,
    };
  }
  return { art, headSha, split };
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
  // Why there is no `worktree` even though the caller ASKED for one (a `--repo` whose
  // materialization failed preflight). A lost worktree and a retry that never wanted one both arrive
  // here as "no worktree", and only the caller can tell them apart — so it says which, and this
  // becomes the run's `fallbackReason`: the result, one log line, and the durable `reseats[]` entry.
  worktreeUnavailable?: string;
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
  const { art, headSha, split } = pre;
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
  // …and a `--repo` that never MATERIALIZED never reaches this module as a worktree at all, so its
  // reason has to come from the caller (`worktreeUnavailable`). Without it the trail writes
  // `fallbackReason: null` for both a lost worktree and a deliberate packet retry — durable
  // provenance that cannot tell a degradation from a choice.
  const fallbackReason =
    seatRun.fallbackReason ??
    (wt && !qualified
      ? `${seat}: no sandbox qualification for the re-materialized worktree${
          opts.qualification?.reason ? ` (${opts.qualification.reason})` : ''
        } — re-ran on the PACKET`
      : (opts.worktreeUnavailable ?? null));
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
  // `sandboxProfiles`: it names the fence each seat's evidence was gathered behind, and the two are
  // read TOGETHER. A worktree retry rewrites this seat's entry to the fence it actually ran behind.
  // A packet-mode retry ran behind NO fence, so its entry is DELETED: leaving the original run's
  // profile beside a freshly rewritten `realized: packet` attests a jail this attempt never entered
  // — the manifest would claim a fence for evidence gathered outside one. Only this seat's key
  // moves; every other seat's record of its own attempt is untouched.
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
      } else if (seatRun.realized === 'packet' && manifest.sandboxProfiles) {
        const profiles = { ...manifest.sandboxProfiles };
        delete profiles[seat];
        manifest.sandboxProfiles = profiles;
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
