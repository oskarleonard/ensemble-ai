import fs from 'node:fs';
import path from 'node:path';

import { reviewDir, writeTrailFile } from '../../core/artifacts';
import { parseFindings } from '../../core/findings';
import { scrubControl } from '../../core/sanitize';
import type { ReviewFinding, SeatDiagnostics } from '../../core/types';
import type { ResolvedVoiceConfig } from '../brainstorm/types';

import { CHUNKS_TRAIL_FILE, type ChunksTrail } from './chunks';
import { runClaudeReviewVoice } from './claude';
import { writeConventionsInTree } from './conventions-write';
import { verdictCounts } from './gate';
import { readGatePacketHeadSha } from './gate-hunks';
import { EVIDENCE_MANIFEST_FILE } from './evidence-manifest';
import type { HistoryPacket } from './history-packet';
import { readConventionPathsFromTrail, type RegateOptions, type RegateResult, runRegate } from './regate';
import { acquireReseatLock, foldSynthesis, rerenderOverview } from './reseat';
import {
  CLAUDE_WORKTREE_REVIEW_TIMEOUT_MS,
  type ClaudeRunner,
  CONVENTIONS_TRAIL_COPY,
  persistSeatReview,
  PRODUCER_PROMPT_SIDECAR,
  type ProducerPromptSidecar,
  producerPromptFile,
  renderReviewMarkdown,
  runClaudeReviewer,
  withSeatAdvisor,
} from './self-contained';
import type { VoiceReview } from './synthesis';
import { readTrailJson } from './trail-io';

// REPARSE — heal a seat whose reply is ON DISK but was recorded as failed because the parser of the
// day could not read it. The zero-cost half of `reseat`: nothing is spawned, nothing is re-billed;
// the persisted `<seat>-review.raw.md` is re-read with THIS engine's parser, the seat's trail
// artifacts are rewritten as a healthy review, and the gate re-runs over the union exactly as a
// reseat would. Born from the stray-brace runs (2026-09-25 … 2026-10-15): a complete review, five
// findings, `"line":54}}},{` — "no parseable JSON block", seat dropped, run red, nothing posted.
//
// Only the Anthropic producer seat today. Until 2026-11-03 it had no pinned prompt on disk, so a true
// RE-RUN of it was not possible from the trail and a reply that still did not parse was refused, not
// re-spawned — the whole review re-billed to recover one seat. Runs persisted since then carry the
// producer's prompt (self-contained.ts persistProducerPrompts: `prompt.claude.md`, or one per part, plus
// `prompt.claude.json`), and for those the RE-RUN half below heals what the re-read cannot: a reply that
// is missing, cut off, in parts, or unparseable is re-spawned from the pinned prompt — byte-identical
// but for the worktree path, re-pointed at the fresh checkout the CLI materialized — persisted, stamped
// `rerun: true`, and the union regated. A run with no pinned prompt keeps the old refusals.

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

// One part of a re-run (one entry for a single-part run). `reuse` is set for a part whose own reply
// still parses: it is merged back as it stands, never re-billed — only the failed parts spawn.
export interface RerunPart {
  index: number;
  prompt: string;
  reuse: { findings: ReviewFinding[]; raw: string; summary: string } | null;
}

export interface RerunReady {
  rerun: true;
  existing: Record<string, unknown>;
  // What the re-read could not do — the fact the stamp records as the reason for the spawn.
  why: string;
  sidecar: ProducerPromptSidecar;
  parts: RerunPart[];
}

export type ReparseGate = { refusal: string } | ReparseReady | RerunReady;

export const isRerun = (g: ReparseGate): g is RerunReady => 'rerun' in g;

// The pinned producer prompt(s) and sidecar, when the run persisted them. null ⇒ a run older than the
// pinning (or a trail that could not take it) — only the re-read exists for it.
function readPinnedProducerPrompts(dir: string): { sidecar: ProducerPromptSidecar; prompts: Map<number, string> } | null {
  let sidecar: ProducerPromptSidecar;
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, PRODUCER_PROMPT_SIDECAR), 'utf8')) as Partial<ProducerPromptSidecar>;
    if (raw.schemaVersion !== 1 || typeof raw.headSha !== 'string' || typeof raw.parts !== 'number' || raw.parts < 1) return null;
    sidecar = {
      baseSha: typeof raw.baseSha === 'string' ? raw.baseSha : null,
      conventionsPath: typeof raw.conventionsPath === 'string' ? raw.conventionsPath : null,
      headSha: raw.headSha,
      history: raw.history === true,
      parts: raw.parts,
      schemaVersion: 1,
      worktree: typeof raw.worktree === 'string' ? raw.worktree : null,
    };
  } catch {
    return null;
  }
  const prompts = new Map<number, string>();
  try {
    if (sidecar.parts === 1) prompts.set(1, fs.readFileSync(path.join(dir, producerPromptFile()), 'utf8'));
    else for (let k = 1; k <= sidecar.parts; k++) prompts.set(k, fs.readFileSync(path.join(dir, producerPromptFile(k)), 'utf8'));
  } catch {
    return null;
  }
  return { prompts, sidecar };
}

// A part's reply as it stands: reusable when it parses under this engine.
function reusablePart(raw: string | null): RerunPart['reuse'] {
  if (raw === null) return null;
  const parsed = parseFindings(raw);
  return parsed.parseError ? null : { findings: parsed.findings, raw, summary: parsed.summary };
}

// The one refusal a re-run makes beyond the pre-checks: a prompt that names a worktree is re-run only
// against a fresh worktree — a packet re-run would send the seat a prompt naming a reaped directory
// and call the result evidence.
export function rerunNeedsWorktree(pre: RerunReady, worktree: string | undefined): string | null {
  if (pre.sidecar.worktree && !worktree)
    return `the claude seat's pinned prompt names a worktree (${pre.sidecar.worktree}) — a re-run needs the PR head re-materialized: pass --repo <clone> with the PR URL`;
  return null;
}

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
  const dir = reviewDir(baseDir, runId);
  const pinned = readPinnedProducerPrompts(dir);
  // The re-run, when the trail allows one: every part's prompt is pinned, and a part whose own reply
  // still parses is reused rather than re-billed.
  const rerun = (why: string): ReparseGate => {
    if (!pinned) return { refusal: `${why}; re-fire the review (this run has no pinned producer prompt, so the seat cannot be re-run from the trail)` };
    const parts: RerunPart[] = [];
    for (const [index, prompt] of [...pinned.prompts].sort((a, b) => a[0] - b[0])) {
      const rawFile = path.join(dir, pinned.sidecar.parts === 1 ? `${seat}-review.raw.md` : `${seat}-review.c${index}.raw.md`);
      const raw = fs.existsSync(rawFile) ? fs.readFileSync(rawFile, 'utf8') : null;
      parts.push({ index, prompt, reuse: reusablePart(raw) });
    }
    return { existing, parts, rerun: true, sidecar: pinned.sidecar, why };
  };
  // A cut-off reply is not trusted even when what survived happens to parse — the same rule the
  // core seats apply at persist time (seat-run.ts persistAttempt). With a pinned prompt the seat is
  // re-run instead; a cut-off single reply never reuses what survived.
  const diag = existing.diagnostics as { timedOutReason?: unknown } | undefined;
  if (diag && typeof diag === 'object' && typeof diag.timedOutReason === 'string') {
    const r = rerun(`seat ${seat} was cut off on run ${runId} (${diag.timedOutReason}) — its reply is not a complete review and will not be re-read`);
    if (isRerun(r) && r.sidecar.parts === 1) r.parts = r.parts.map((p) => ({ ...p, reuse: null }));
    return r;
  }
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  const partRe = new RegExp(`^${seat}-review\\.c\\d+\\.raw\\.md$`);
  const parts = names.filter((n) => partRe.test(n));
  if (parts.length > 0 || (pinned && pinned.sidecar.parts > 1)) {
    return rerun(`seat ${seat} reviewed run ${runId} in ${parts.length > 0 ? parts.length : pinned?.sidecar.parts} parts — a multi-part reply is not re-read`);
  }
  const rawPath = path.join(dir, `${seat}-review.raw.md`);
  if (!fs.existsSync(rawPath)) {
    return rerun(`seat ${seat} left no reply on run ${runId} (no ${seat}-review.raw.md) — nothing to re-read`);
  }
  const raw = fs.readFileSync(rawPath, 'utf8');
  const parsed = parseFindings(raw);
  if (parsed.parseError) {
    return rerun(`seat ${seat}'s persisted reply on run ${runId} still does not parse under this engine (${parsed.parseError})`);
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
  // RE-RUN only (a reply the re-read cannot heal, with a pinned prompt on disk): the claude reviewer
  // seat to spawn, the history packet the CLI rebuilt for the fresh worktree (absent ⇒ the seat
  // reviews without one), the runner seam and the watchdog.
  seatConfig?: ResolvedVoiceConfig;
  historyPacket?: HistoryPacket;
  run?: ClaudeRunner;
  timeoutMs?: number;
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
  // null ⇔ a RE-RUN seat failed again — the gate was not re-run, verdicts stand (reseat's rule).
  gate: RegateResult | null;
  // true ⇔ the seat healed AND the regate produced a usable envelope.
  ok: boolean;
  // Set on the re-run path: which parts were spawned (every part of a single-part run).
  rerun?: { parts: number[] };
  review: VoiceReview;
  // Did the `reseats[]` provenance stamp reach claude-synthesis.json? Best-effort like reseat's,
  // and just as much not a detail to swallow: it is the only durable record that the seat's
  // findings were re-read after the fact rather than parsed at run time.
  stampWritten: boolean;
}

export async function runReparseSeat(opts: ReparseSeatOptions): Promise<ReparseSeatResult> {
  const pre = checkReparse(opts.baseDir, opts.runId, opts.seat);
  if ('refusal' in pre) throw new Error(pre.refusal);
  if (isRerun(pre)) {
    const needs = rerunNeedsWorktree(pre, opts.worktree);
    if (needs) throw new Error(needs);
    if (!opts.seatConfig) throw new Error('a re-run of the claude seat needs its reviewer seat config (seatConfig)');
  }
  // Same per-run lock as a reseat: both rewrite the same trail files and regate the same union.
  const release = acquireReseatLock(opts.baseDir, opts.runId);
  try {
    return isRerun(pre) ? await rerunUnderLock(opts, pre, opts.seatConfig as ResolvedVoiceConfig) : await reparseUnderLock(opts, pre);
  } finally {
    release();
  }
}

// The chunk trail's record of this seat, part by part — so chunks.json and the overview say what
// now stands for every part the re-run touched or reused.
function recordClaudeChunkStates(
  baseDir: string,
  runId: string,
  seat: ReparseSeat,
  states: ReadonlyMap<number, { findings: number; ok: boolean; why?: string }>,
  log: (m: string) => void
): boolean {
  try {
    const trail = readTrailJson<ChunksTrail>(baseDir, runId, CHUNKS_TRAIL_FILE);
    if (!trail || !Array.isArray(trail.chunks)) return false;
    let touched = false;
    for (const c of trail.chunks) {
      const st = states.get(c.index);
      const rec = c.seats?.[seat];
      if (!st || !rec) continue;
      const { why: _why, ...rest } = rec as typeof rec & { why?: string };
      void _why;
      c.seats[seat] = { ...rest, findings: st.findings, state: st.ok ? 'reviewed' : 'failed-reviewer', ...(st.why ? { why: st.why } : {}) };
      touched = true;
    }
    if (touched) writeTrailFile(baseDir, runId, CHUNKS_TRAIL_FILE, JSON.stringify(trail, null, 2));
    return touched;
  } catch (e) {
    log(`reseat: ${CHUNKS_TRAIL_FILE} could not be updated (${(e as Error).message})`);
    return false;
  }
}

async function rerunUnderLock(opts: ReparseSeatOptions, pre: RerunReady, seatConfig: ResolvedVoiceConfig): Promise<ReparseSeatResult> {
  const log = opts.log ?? (() => {});
  const { baseDir, runId, seat } = opts;
  const { existing, sidecar } = pre;
  const wt = opts.worktree;
  const previousSummary = typeof existing.summary === 'string' ? existing.summary : '';
  // The pinned prompt, byte-identical but for the worktree path: the fresh checkout stands where the
  // reaped one did, everywhere the prompt named it (the read root, the conventions step).
  const repoint = (text: string): string => (sidecar.worktree && wt ? text.split(sidecar.worktree).join(wt) : text);
  // The conventions file the prompt's review method points at — written into the fresh tree from
  // the copy the run kept, at the same engine-owned path. Loud when it cannot be: the seat then
  // reviews without the gathered rules, which the stamp records.
  let conventionsFile: string | undefined;
  let conventionsNote: string | undefined;
  if (sidecar.conventionsPath && wt) {
    const want = repoint(sidecar.conventionsPath);
    let body: string | null = null;
    try {
      body = fs.readFileSync(path.join(reviewDir(baseDir, runId), CONVENTIONS_TRAIL_COPY), 'utf8');
    } catch {
      body = null;
    }
    if (body === null) conventionsNote = `the conventions file was not re-created (no ${CONVENTIONS_TRAIL_COPY} in the trail) — the seat reviewed without the gathered rules`;
    else {
      const w = writeConventionsInTree(wt, sidecar.headSha, body);
      if (!w.ok) conventionsNote = `the conventions file was not re-created (${w.why}) — the seat reviewed without the gathered rules`;
      else if (w.file !== want) conventionsNote = `the conventions file was written at ${w.file} but the prompt names ${want}`;
      else conventionsFile = w.file;
    }
    if (conventionsNote) log(scrubControl(`reseat: ${conventionsNote}`));
  }
  const run = opts.run ?? runClaudeReviewVoice;
  const timeoutMs = opts.timeoutMs ?? (wt ? CLAUDE_WORKTREE_REVIEW_TIMEOUT_MS : undefined);
  const historyPacket = sidecar.history && wt ? opts.historyPacket : undefined;
  const n = pre.parts.length;
  log(
    `reseat: re-running ${seat} on run ${runId} from its pinned prompt — ${pre.why}; ${
      wt ? 'worktree evidence' : 'packet evidence'
    }${n > 1 ? ` · ${pre.parts.filter((p) => !p.reuse).length} of ${n} part(s) to re-run` : ''}`
  );
  const partsRerun: number[] = [];
  const results: { part: RerunPart; review: VoiceReview; raw: string | null; stream: string | null }[] = [];
  for (const part of pre.parts) {
    if (part.reuse) {
      log(`reseat: ${seat} part ${part.index}/${n}: its reply parses, reused (${part.reuse.findings.length} finding(s))`);
      results.push({ part, raw: part.reuse.raw, review: { findings: part.reuse.findings, ok: true, summary: part.reuse.summary, voiceId: seat }, stream: null });
      continue;
    }
    partsRerun.push(part.index);
    if (n > 1) log(`reseat: ${seat} part ${part.index}/${n}…`);
    const res = await runClaudeReviewer(repoint(part.prompt), seatConfig, run, timeoutMs, log, wt, historyPacket, conventionsFile);
    results.push({ part, raw: res.raw, review: res.review, stream: res.stream });
    if (n > 1) {
      try {
        writeTrailFile(baseDir, runId, `findings.${seat}.c${part.index}.json`, JSON.stringify(res.review.findings, null, 2));
        if (res.raw !== null) writeTrailFile(baseDir, runId, `${seat}-review.c${part.index}.raw.md`, res.raw);
        if (res.stream) writeTrailFile(baseDir, runId, `${seat}-stream.c${part.index}.jsonl`, res.stream);
      } catch (e) {
        log(`reseat: ${seat} part ${part.index} trail write failed (${(e as Error).message}) — continuing`);
      }
    }
  }
  // The review of record: one part as it came back; parts merged under the producer's own rules
  // (self-contained.ts) — findings in part order with their `chunk`, complete only if every part is.
  let review: VoiceReview;
  let raw: string | null;
  let stream: string | null = null;
  if (n === 1) {
    ({ review, raw, stream } = results[0]);
  } else {
    const failed = results.filter((r) => !r.review.ok);
    const findings: ReviewFinding[] = [];
    for (const r of results) for (const f of r.review.findings) findings.push({ ...f, chunk: r.part.index, id: `f${findings.length + 1}` });
    const line = (r: (typeof results)[number]) => `Part ${r.part.index}/${n}: ${r.review.summary}`;
    const summary =
      failed.length === 0
        ? results.map(line).join('\n')
        : [
            `Reviewed in ${n} part(s); ${failed.length} part(s) did not complete, so this reviewer is INCOMPLETE for the change.`,
            ...failed.map((r) => `Part ${r.part.index}/${n} FAILED: ${r.review.summary}`),
            ...results.filter((r) => r.review.ok).map(line),
          ].join('\n');
    review = { findings, ok: failed.length === 0, summary, voiceId: seat };
    const raws = results.filter((r) => r.raw !== null).map((r) => `## Part ${r.part.index} of ${n}\n\n${r.raw}`);
    raw = raws.length > 0 ? raws.join('\n\n') : null;
  }
  const healed = withSeatAdvisor(review, seatConfig);
  persistSeatReview(baseDir, runId, seat, healed, raw, stream);
  try {
    writeTrailFile(baseDir, runId, `review.${seat}.md`, renderReviewMarkdown(healed));
  } catch (e) {
    log(`reseat: review.${seat}.md could not be written (${(e as Error).message})`);
  }
  const chunksTouched = recordClaudeChunkStates(
    baseDir,
    runId,
    seat,
    new Map(results.map((r) => [r.part.index, { findings: r.review.findings.length, ok: r.review.ok, ...(r.review.ok ? {} : { why: r.review.summary.slice(0, 160) }) }])),
    log
  );
  // What this seat read THIS time — the manifest's realized evidence for it is rewritten to say so.
  const realized = wt ? 'worktree' : 'packet';
  try {
    const m = readTrailJson<{ realizedEvidence?: Record<string, string> }>(baseDir, runId, EVIDENCE_MANIFEST_FILE);
    if (m && m.realizedEvidence && m.realizedEvidence[seat] !== realized) {
      writeTrailFile(baseDir, runId, EVIDENCE_MANIFEST_FILE, JSON.stringify({ ...m, realizedEvidence: { ...m.realizedEvidence, [seat]: realized } }, null, 2));
    }
  } catch (e) {
    log(`reseat: ${EVIDENCE_MANIFEST_FILE} could not be updated (${(e as Error).message})`);
  }
  const stampWritten = foldSynthesis(
    baseDir,
    runId,
    (synth) => ({
      ...synth,
      [`${seat}Review`]: healed,
      reseats: [
        ...((synth.reseats as unknown[] | undefined) ?? []),
        {
          at: new Date().toISOString(),
          baseSha: sidecar.baseSha,
          ...(conventionsNote ? { conventionsNote } : {}),
          evidenceDowngraded: false,
          fallbackReason: null,
          outcome: healed.ok ? 'reviewed' : 'failed-reviewer',
          partsRerun,
          previous: { ok: false, summary: previousSummary },
          realized,
          // The one field that tells this heal from a re-read: the seat WAS re-spawned.
          rerun: true,
          seat,
          summary: healed.summary.slice(0, 600),
          why: pre.why,
        },
      ],
    }),
    log
  );
  const headSha = readGatePacketHeadSha(baseDir, runId);
  if (!healed.ok) {
    log(scrubControl(`reseat: ${seat} FAILED AGAIN — ${healed.summary.slice(0, 300)}; the gate was not re-run`));
    if (chunksTouched && headSha) rerenderOverview(baseDir, runId, headSha, undefined, log);
    return { gate: null, ok: false, rerun: { parts: partsRerun }, review: healed, stampWritten };
  }
  log(`reseat: ${seat} reviewed — ${healed.findings.length} finding(s) · evidence ${realized} · regating the union…`);
  const gate = await (opts.regate ?? runRegate)({
    baseDir,
    conventionPaths: opts.conventionPaths ?? readConventionPathsFromTrail(baseDir, runId),
    gateConfig: opts.gateConfig,
    log,
    ...(opts.premise ? { premise: true } : {}),
    ...(opts.gateRun ? { run: opts.gateRun } : {}),
    runId,
    ...(wt ? { worktree: wt } : {}),
  });
  if (chunksTouched && headSha) rerenderOverview(baseDir, runId, headSha, gate.ok ? verdictCounts(gate.verdicts) : undefined, log);
  return { gate, ok: gate.ok, rerun: { parts: partsRerun }, review: healed, stampWritten };
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
  let chunksTouched = false;
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
      chunksTouched = touched;
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
  // The human overview is rendered from the chunk trail — re-render it so it stops saying the
  // seat failed while chunks.json, review.<seat>.json and the stamp all say reviewed.
  if (chunksTouched) {
    const headSha = readGatePacketHeadSha(baseDir, runId);
    if (headSha) rerenderOverview(baseDir, runId, headSha, gate.ok ? verdictCounts(gate.verdicts) : undefined, log);
  }
  return { gate, ok: gate.ok, review: healed, stampWritten };
}
