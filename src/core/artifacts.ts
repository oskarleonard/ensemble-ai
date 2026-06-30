import fs from 'node:fs';
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

export function reviewDir(baseDir: string, runId: string): string {
  // runId may come from an untrusted caller — strip path separators defensively
  // so a crafted id can't escape the base dir.
  const safe = runId.replace(/[^a-zA-Z0-9._-]/g, '_') || 'unknown';
  return path.join(baseDir, safe);
}

function writeAtomic(dir: string, name: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, target);
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
  writeAtomic(dir, `packet.${id}.json`, JSON.stringify(input.packet, null, 2));
  writeAtomic(dir, `prompt.${id}.md`, input.prompt);
  if (input.raw !== null) writeAtomic(dir, `${id}-review.raw.md`, input.raw);
  writeAtomic(
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
  writeAtomic(dir, reviewJson(id), JSON.stringify(stored, null, 2));
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
