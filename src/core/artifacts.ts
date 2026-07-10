import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  type ManifestEntry,
  REVIEWER_IDS,
  type ReviewerConfig,
  type ReviewerId,
  type ReviewFinding,
  type ReviewPacket,
  type StoredReview,
  type TerminalState,
} from './types';

// Immutable artifacts: every phase writes a durable file with a stable id so a
// consumer can PROVE what was reviewed vs what changed after. One dir per run
// (under a caller-supplied base dir, keyed by runId): the assembled packet, the
// rendered prompt, the reviewer's raw reply, the parsed findings, an arbiter's
// dispositions, and the final per-reviewer review index. StoredReview/
// ManifestEntry are the PURE shapes (in ./types so any consumer can import them).
//
// The base dir is a PARAMETER (not a hardcoded path): the CLI writes to its
// `--out` dir; a host (e.g. a dashboard) injects its own artifacts root — so one
// persistence implementation serves both with identical on-disk shapes.

// Reduce an untrusted string to a safe single path segment: collapse anything
// outside [A-Za-z0-9._-] to '_', so a crafted id (path separators, `..`) can't
// escape its base dir. ONE copy of this traversal defense — every on-disk key
// (the run trail, the receipt store) routes through it so they can't drift.
//
// Dots ARE legal filename chars, so a segment of ONLY dots survives the char
// filter — but `.` resolves to the base dir itself and `..` to its PARENT, so
// `path.join(base, sanitize(id))` would escape (and a recursive rm of it would
// delete the base or its parent). Neutralize any all-dots result by prefixing
// `_` so it becomes an ordinary child segment (`.` → `_.`, `..` → `_..`).
export function sanitizePathSegment(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9._-]/g, '_');
  return /^\.+$/.test(cleaned) ? `_${cleaned}` : cleaned;
}

export function reviewDir(baseDir: string, runId: string): string {
  return path.join(baseDir, sanitizePathSegment(runId) || 'unknown');
}

// A trail file can EMBED the reviewed diff (and, in a security review, whatever
// secret-adjacent lines survived the scan) — so it is written OWNER-ONLY (0600) in
// an owner-only dir (0700). writeFileSync's `mode` is masked by the process umask, so
// chmod after the write to GUARANTEE 0600 regardless of the caller's umask, then
// rename into place (an atomic swap that carries the tmp file's mode).
//
// Symlink-safe: the write must land STRICTLY INSIDE the caller-supplied trail `root`
// (the base dir). The earlier hardening lstat'd ONLY the leaf dir, so a symlink at an
// ANCESTOR component below the root (e.g. a pre-planted `reviews/` symlink, or the run-id
// dir reached through one) could still redirect the realpath'd write out of the tree. So
// now: lstat BOTH the root and the leaf dir and refuse a symlink at either, then realpath
// BOTH and REQUIRE the resolved dir to be contained under the resolved root — a symlink
// hop anywhere between root and leaf makes the resolved dir escape the root and is refused.
// (Legitimate ancestor symlinks in the caller's own base path — /tmp, ~/brain — resolve
// consistently for root and dir, so containment still holds. A symlink AT/ABOVE the root
// itself is the caller's own trusted path, outside this function's frame.) The tmp is then
// opened O_NOFOLLOW | O_EXCL so a planted symlink at the FILE component is refused too, and
// the final rename replaces `target` atomically rather than writing through a symlink.
// TRUE if a `path.relative(base, target)` result points OUTSIDE base — the shared
// containment predicate for the trail's write/delete trust boundary (writeAtomic here + the
// CLI's clearReusedRunTrail). `..` or `../…` = an ancestor/sibling escape; an absolute result
// = a different root (e.g. a symlink hop off the volume). ONE definition so the path-escape
// rule can't drift between the writer and the cleaner. An EMPTY rel (target === base) is NOT
// an escape here — a caller that must also reject the base itself adds a `!rel` guard.
export function escapesRoot(rel: string): boolean {
  return rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

// Every engine-owned temp dir is OWNER-ONLY: a shared temp root is world-readable, and these dirs
// hold the private PR source, a seat's Seatbelt profile, and a seat's reply. `mkdtemp` already
// promises 0700 — the chmod asserts it rather than trusting the platform's umask. ONE definition,
// so the posture cannot drift between the worktree parent, the sandbox profile, the seat cwd, and
// the reply dir. The caller owns the reap: mkdtemp names are random, so a leaked dir is unfindable.
export function makeOwnerOnlyTempDir(prefix: string, root: string = os.tmpdir()): string {
  const dir = fs.mkdtempSync(path.join(root, prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function writeAtomic(root: string, dir: string, name: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Recursive mkdir treats a pre-planted symlink-to-dir as "already exists" and does NOT
  // error, and realpathSync would then FOLLOW it. lstat the trail root leaf AND the run
  // dir leaf and reject a symlink at either outright rather than following it.
  for (const p of [root, dir]) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue; // not yet present (e.g. a multi-level root just made) — nothing to reject
    }
    if (st.isSymbolicLink()) {
      throw new Error(`ensemble-ai: refusing to write into a symlinked trail dir: ${p}`);
    }
  }
  // Realpath BOTH so an interior symlink between root and leaf is caught by the containment
  // check below (not silently followed like the old leaf-only realpath did).
  let realDir = dir;
  let realRoot = root;
  try {
    realDir = fs.realpathSync(dir);
    realRoot = fs.realpathSync(root);
  } catch {
    /* brand-new dir race — fall back to the lexical paths */
  }
  const rel = path.relative(realRoot, realDir);
  if (escapesRoot(rel)) {
    throw new Error(
      `ensemble-ai: refusing to write outside the trail root: ${realDir} is not under ${realRoot}`
    );
  }
  const target = path.join(realDir, name);
  const tmp = `${target}.tmp`;
  // O_NOFOLLOW: refuse if `tmp` is a symlink. O_EXCL: refuse a pre-existing tmp (a
  // planted symlink or a stale file) rather than truncating through it. Clear a stale
  // tmp from an earlier crashed write, then create fresh.
  try {
    fs.unlinkSync(tmp);
  } catch {
    /* no stale tmp — fine */
  }
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_EXCL |
    fs.constants.O_NOFOLLOW;
  // openSync can THROW (ELOOP when O_NOFOLLOW refuses a planted symlink, EEXIST on an
  // O_EXCL race, EACCES). Surface a clear, contextualized error rather than a raw errno so
  // a caller (trail writes are best-effort) can catch + degrade — and don't leak a fd.
  let fd: number;
  try {
    fd = fs.openSync(tmp, flags, 0o600);
  } catch (e) {
    throw new Error(`ensemble-ai: cannot open trail temp file ${tmp}: ${(e as Error).message}`);
  }
  try {
    fs.writeFileSync(fd, content);
    fs.fchmodSync(fd, 0o600);
  } finally {
    fs.closeSync(fd);
  }
  // On a rename failure, clean up the dangling tmp so a retry isn't blocked by O_EXCL and
  // no half-written temp is left behind (recoverable, not an un-recoverable primitive).
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw new Error(`ensemble-ai: cannot finalize trail file ${target}: ${(e as Error).message}`);
  }
}

// Public, hardened trail writer: the SAME symlink-safe atomic write persistReview uses,
// exposed so other trail writers (the CLI's convention-manifest, the per-reviewer
// review.<id>.md, the Claude reviewer's artifacts) route through ONE hardened path
// instead of a raw fs.writeFileSync that would follow a symlinked target. Keyed by the
// (sanitized) runId trail dir so every trail file lands together.
export function writeTrailFile(
  baseDir: string,
  runId: string,
  name: string,
  content: string
): string {
  const dir = reviewDir(baseDir, runId);
  writeAtomic(baseDir, dir, name, content);
  return path.join(dir, name);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function manifestOf(packet: ReviewPacket): ManifestEntry[] {
  return packet.sections.map((s) => ({
    included: s.included,
    note: s.note,
    title: s.title,
    truncated: s.truncated,
  }));
}

export interface PersistReviewInput {
  findings: ReviewFinding[];
  packet: ReviewPacket;
  prompt: string;
  raw: string | null;
  reviewer: ReviewerConfig;
  runId: string;
  summary: string;
  terminalState: TerminalState;
}

// Per-reviewer artifact file names. A run fans out to N reviewers, each writing
// its OWN independent set so a codex finding never overwrites a grok one. The
// legacy bare `review.json` (pre-fan-out, always Codex) is still READ for old
// runs — see readReview.
function reviewJson(reviewerId: ReviewerId): string {
  return `review.${reviewerId}.json`;
}

// Phase-1 write (reviewer done): packet, prompt, raw reply, findings, and the
// per-reviewer review index (no dispositions yet — those land in a second write).
export function persistReview(
  baseDir: string,
  input: PersistReviewInput
): StoredReview {
  const dir = reviewDir(baseDir, input.runId);
  const id = input.reviewer.id;
  writeAtomic(baseDir, dir, `packet.${id}.json`, JSON.stringify(input.packet, null, 2));
  writeAtomic(baseDir, dir, `prompt.${id}.md`, input.prompt);
  if (input.raw !== null) writeAtomic(baseDir, dir, `${id}-review.raw.md`, input.raw);
  writeAtomic(
    baseDir,
    dir,
    `findings.${id}.json`,
    JSON.stringify(input.findings, null, 2)
  );
  const stored: StoredReview = {
    findings: input.findings,
    packet: {
      complete: input.packet.complete,
      manifest: manifestOf(input.packet),
    },
    reviewer: {
      effort: input.reviewer.effort,
      model: input.reviewer.model,
      vendor: input.reviewer.vendor,
    },
    reviewerId: id,
    runId: input.runId,
    summary: input.summary,
    terminalState: input.terminalState,
  };
  writeAtomic(baseDir, dir, reviewJson(id), JSON.stringify(stored, null, 2));
  return stored;
}

// NOTE: folding an arbiter's dispositions + a gate into a stored review is HOST
// POLICY (it certifies a host's arbitration), so it is intentionally NOT here —
// a host reads its own StoredReview, adds those fields, and rewrites the file.
// The core only ever writes the FACTS (persistReview, above).

// Read ONE reviewer's stored review. `reviewerId` defaults to Codex, and falls
// back to the legacy bare `review.json` for pre-fan-out runs (backfilling
// reviewerId so a consumer always has it).
export function readReview(
  baseDir: string,
  runId: string,
  reviewerId: ReviewerId = 'codex'
): StoredReview | null {
  const dir = reviewDir(baseDir, runId);
  const perId = readJson<StoredReview>(path.join(dir, reviewJson(reviewerId)));
  if (perId) return perId.reviewerId ? perId : { ...perId, reviewerId };
  if (reviewerId === 'codex') {
    const legacy = readJson<StoredReview>(path.join(dir, 'review.json'));
    if (legacy) return { ...legacy, reviewerId: 'codex' };
  }
  return null;
}

// Read EVERY reviewer's stored review for a run, in registry order (codex, grok,
// …). Includes the legacy bare `review.json` (as codex) for old runs.
export function readReviewsForRun(
  baseDir: string,
  runId: string
): StoredReview[] {
  const out: StoredReview[] = [];
  for (const id of REVIEWER_IDS) {
    const r = readReview(baseDir, runId, id);
    if (r) out.push(r);
  }
  return out;
}
