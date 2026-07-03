import fs from 'node:fs';
import path from 'node:path';

import { reviewDir, writeTrailFile } from '../../core/artifacts';
import { segmentsWithoutTruncationSplices } from '../../core/packet';
import { readTrailJson } from './trail-io';

import { parseDiffFiles } from './diff';

// The PINNED packet + hunk mechanics the verified gate reads. The gate reviewer sees, per
// finding, the CITED diff hunk — resolved from ONE materialized-once artifact (never the
// working tree), so a tree that mutates between the run and the gate can change no outcome
// on the authority path (spec §Design 1, constraint #4). This module owns:
//   - the pinned gate packet (`packet.gate.json` = {schemaVersion, headSha, diff}) — one
//     writer at review time, one reader at gate time, head-SHA-checked (fail-closed);
//   - unified-diff HUNK parsing + deterministic file:line → hunk resolution (new-side
//     coordinates win; deletion-only hunks resolve old-side — constraint #3);
//   - the ±25-line windowing that bounds a single finding's injected hunk.
// PURE except the two thin fs helpers (persist/read) — everything else is a pure function of
// its inputs so the resolver/validator are exhaustively unit-testable over fixtures.

// The pinned-packet artifact schema. Bumped if the shape OR semantics change; a reader that does
// not recognize the version treats the packet as unusable → the gate degrades all-`unverified`
// (fail-closed), never guesses under semantics it doesn't understand. v2 (Phase 2) pins the
// reviewer-VISIBLE diff bytes (the head+tail-truncated packet section the reviewers saw), so a
// citation can only validate against bytes a reviewer actually saw — a stale v1 packet (which
// pinned the FULL pre-truncation diff) is therefore treated as corrupt → packet-fail (safe).
export const GATE_PACKET_SCHEMA_VERSION = 2;

export interface GatePacket {
  diff: string;
  headSha: string;
  schemaVersion: number;
}

// Materialize the pinned packet ONCE per run: the exact COVERED diff the reviewers saw +
// the head SHA it was resolved at. Both the hunk-resolver and the citation-validator read
// THIS, never the repo — so "a working tree that mutates between run and gate cannot change
// any authority outcome" is structural, not hoped-for. Best-effort like every trail write;
// a failure just means the gate later reads no packet → all-`unverified`.
export function persistGatePacket(
  baseDir: string,
  runId: string,
  input: { diff: string; headSha: string }
): void {
  const packet: GatePacket = {
    diff: input.diff,
    headSha: input.headSha,
    schemaVersion: GATE_PACKET_SCHEMA_VERSION,
  };
  writeTrailFile(baseDir, runId, 'packet.gate.json', JSON.stringify(packet, null, 2));
}

export type GatePacketReadFailure = 'missing' | 'corrupt' | 'sha-mismatch';

export type GatePacketRead =
  | { diff: string; ok: true }
  | { ok: false; reason: GatePacketReadFailure };

// Read the pinned packet back at gate time and PROVE its identity. Missing / unparseable /
// wrong-schema ⇒ corrupt; a head SHA that differs from what the run resolved ⇒ sha-mismatch
// (a stale or swapped packet). Any failure is a packet-fail the gate turns into
// all-`unverified` — never a silent read of the wrong bytes. Reading the persisted artifact
// (not re-deriving from the tree) is the whole TOCTOU-safety guarantee.
export function readGatePacket(
  baseDir: string,
  runId: string,
  expectedHeadSha: string
): GatePacketRead {
  // Distinguish an ABSENT packet (missing) from a present-but-unreadable one (corrupt) — both
  // fail the gate closed, but the distinction is worth recording for a debugging operator.
  const file = path.join(reviewDir(baseDir, runId), 'packet.gate.json');
  if (!fs.existsSync(file)) return { ok: false, reason: 'missing' };
  const raw = readTrailJson<Partial<GatePacket>>(baseDir, runId, 'packet.gate.json');
  if (
    raw === null ||
    typeof raw.diff !== 'string' ||
    typeof raw.headSha !== 'string' ||
    raw.schemaVersion !== GATE_PACKET_SCHEMA_VERSION
  ) {
    return { ok: false, reason: 'corrupt' };
  }
  if (raw.headSha !== expectedHeadSha) return { ok: false, reason: 'sha-mismatch' };
  return { diff: raw.diff, ok: true };
}

// ── Unified-diff hunk parsing ─────────────────────────────────────────────────────────

// One `@@ -oldStart,oldCount +newStart,newCount @@` hunk of a file: the header + its body
// lines (each still carrying its ' '/'+'/'-' marker), plus the parsed line ranges the
// resolver keys off.
export interface Hunk {
  body: string[];
  header: string;
  newCount: number;
  newStart: number;
  oldCount: number;
  oldStart: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

// Parse ONE file's diff section (as parseDiffFiles yields) into its hunks. A body line is
// everything between one `@@` header and the next (or EOF); the `\ No newline at end of
// file` marker and any pre-hunk header lines are not hunk bodies and are excluded.
export function parseFileHunks(fileSection: string): Hunk[] {
  const lines = fileSection.split('\n');
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of lines) {
    const m = HUNK_HEADER.exec(line);
    if (m) {
      cur = {
        body: [],
        header: line,
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        newStart: Number(m[3]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        oldStart: Number(m[1]),
      };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // pre-hunk header noise (diff --git / index / +++/---)
    if (line.startsWith('\\')) continue; // "\ No newline at end of file"
    cur.body.push(line);
  }
  return hunks;
}

// Parse the pinned (reviewer-visible) diff into per-file hunks, keyed by the file path
// parseDiffFiles resolves. Deterministic: the same diff bytes always yield the same map.
// TRUNCATION-AWARE: the pinned diff may carry head+tail truncation splices, so hunks are parsed
// WITHIN each splice-free segment independently — a hunk never spans a cut (no fabricated spliced
// line), and neither the marker nor a partial boundary fragment can ever become a citable line. A
// file that straddles a cut merges its per-segment hunks (disjoint ranges); a tail orphan whose
// header was truncated away resolves to 'unknown' and drops out → out-of-packet → unverified (the
// SAFE direction). A NON-truncated diff is a single segment — identical to parsing it whole.
export function parsePacketHunks(diff: string): Map<string, Hunk[]> {
  const out = new Map<string, Hunk[]>();
  for (const segment of segmentsWithoutTruncationSplices(diff)) {
    for (const f of parseDiffFiles(segment)) {
      if (f.path === 'unknown') continue;
      const existing = out.get(f.path);
      if (existing) existing.push(...parseFileHunks(f.raw));
      else out.set(f.path, parseFileHunks(f.raw));
    }
  }
  return out;
}

// A stable identity for a (file, hunk-range) pair — the dedup key so two findings citing the
// SAME hunk inject its text once. New-side range identifies the hunk (it is what the gate is
// shown); a deletion-only hunk (newCount 0) falls back to its old-side range.
export function hunkRangeKey(file: string, h: Hunk): string {
  return h.newCount > 0
    ? `${file} +${h.newStart},${h.newCount}`
    : `${file} -${h.oldStart},${h.oldCount}`;
}

export interface ResolvedHunk {
  bodyIndex: number; // index into hunk.body of the cited line (for windowing)
  hunk: Hunk;
}

// Walk a hunk body tracking the NEW-side line counter (+/space advance it, - does not) and
// the OLD-side counter (-/space advance it, + does not); return the body index whose
// tracked line equals the target on the requested side, else -1.
function bodyIndexForLine(hunk: Hunk, line: number, side: 'new' | 'old'): number {
  let newLine = hunk.newStart;
  let oldLine = hunk.oldStart;
  for (let i = 0; i < hunk.body.length; i++) {
    const l = hunk.body[i];
    const isAdd = l.startsWith('+');
    const isDel = l.startsWith('-');
    if (side === 'new' && !isDel && newLine === line) return i;
    if (side === 'old' && !isAdd && oldLine === line) return i;
    if (!isDel) newLine++;
    if (!isAdd) oldLine++;
  }
  return -1;
}

// Resolve a finding's cited `file:line` to the hunk that contains it — DETERMINISTICALLY.
// NEW-side coordinates WIN: a line is matched against each hunk's new-side range first, and
// new-side ranges never overlap within a file, so at most one hunk matches. Only a
// deletion-ONLY hunk (no new-side lines) is matched on its old-side range. This dissolves
// the mixed-hunk numeric-side collision (constraint #3 / codex-f5): a deleted line inside a
// MIXED hunk is addressed by new-side numbering, and a number that is both an old-side line
// of a mixed hunk and a new-side line elsewhere resolves to the new-side hunk, always.
// Returns null (out-of-packet ⇒ the caller marks the finding `unverified`) when nothing
// resolves — an unresolved cite is never guessed at.
export function resolveFindingHunk(hunks: Hunk[], line: number): ResolvedHunk | null {
  for (const h of hunks) {
    if (h.newCount > 0 && line >= h.newStart && line < h.newStart + h.newCount) {
      const idx = bodyIndexForLine(h, line, 'new');
      // The line is in this hunk's DECLARED new-side range but absent from its body (a
      // malformed / header-mismatched hunk) ⇒ null, NOT a fabricated body index 0. Grounding
      // an unlocatable cite on an unrelated first line would forge a resolved+dismissible
      // finding — "an unresolved cite is never guessed at" (fail-closed → unverified).
      return idx >= 0 ? { bodyIndex: idx, hunk: h } : null;
    }
  }
  for (const h of hunks) {
    if (h.newCount === 0 && line >= h.oldStart && line < h.oldStart + h.oldCount) {
      const idx = bodyIndexForLine(h, line, 'old');
      return idx >= 0 ? { bodyIndex: idx, hunk: h } : null;
    }
  }
  return null;
}

// The ±N-line window that bounds a single finding's injected hunk. Centered on the cited
// body line; `truncated` is true iff the window dropped any of the hunk body (the hunk was
// larger than the window) — which is what makes the finding dismissal-INELIGIBLE (never a
// wrong dismissal on partial context). A hunk that fits whole is not truncated.
export const HUNK_WINDOW_LINES = 25;

export interface WindowedHunk {
  text: string;
  truncated: boolean;
}

export function windowHunk(
  hunk: Hunk,
  bodyIndex: number,
  radius: number = HUNK_WINDOW_LINES
): WindowedHunk {
  const start = Math.max(0, bodyIndex - radius);
  const end = Math.min(hunk.body.length, bodyIndex + radius + 1);
  const truncated = start > 0 || end < hunk.body.length;
  const slice = hunk.body.slice(start, end);
  return { text: [hunk.header, ...slice].join('\n'), truncated };
}

// The whitespace-normalized CODE lines of a hunk — its body lines with the single leading
// ' '/'+'/'-' marker stripped, runs of whitespace collapsed, trimmed, empties dropped. This
// is the ONLY content a citation is validated against (own-hunk-scoped). Kept separate from
// windowing because citation validity is judged against the finding's FULL resolved hunk:
// for a non-truncated finding that is exactly what the gate saw, and a truncated finding is
// forced `unverified` regardless, so the full-hunk basis is always the safe one.
export function hunkCodeLines(hunk: Hunk): string[] {
  const out: string[] = [];
  for (const l of hunk.body) {
    const code = l.length > 0 && /^[ +-]/.test(l) ? l.slice(1) : l;
    const norm = code.replace(/\s+/g, ' ').trim();
    if (norm) out.push(norm);
  }
  return out;
}
