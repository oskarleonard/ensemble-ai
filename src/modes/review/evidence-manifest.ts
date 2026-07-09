import { writeTrailFile } from '../../core/artifacts';

import type { EvidenceMap, SandboxProfileMap } from './evidence';
import type { GitRun } from './worktree';

// THE EVIDENCE MANIFEST (spec §8) — paths + blob SHAs, recorded in the TRAIL, ADVISORY, and
// NEVER hashed into the receipt. Auditability without churn: the manifest changes every time a
// file changes, so hashing it would stale receipts for reasons the review does not care about.
//
// HONEST SCOPE — read this before trusting the name. §8 asks for "paths + blob SHAs each seat
// actually READ". We cannot know that: codex, grok and claude are opaque CLIs that do not report
// their file reads, and inferring reads from a sandbox is not something Seatbelt or Landlock
// surfaces to the parent. What we CAN record exactly is the READABLE SURFACE — the tracked tree
// at headSha that the worktree seats were given, keyed by blob SHA. So the field is named
// `readableSurface`, not `read`. It answers "what COULD this seat have read, and at what exact
// content?" — which is the auditable question — and never claims to answer "what did it read?".
//
// It inherits the trail fence like every other artifact (spec §9, codex-f1 residue): it is written
// through writeTrailFile, so a non-repo cwd puts it in OS temp and a foreign diff never writes
// into an unrelated repo.
export const EVIDENCE_MANIFEST_SCHEMA_VERSION = 1;
export const EVIDENCE_MANIFEST_FILE = 'evidence-manifest.json';

export interface ManifestBlob {
  blobSha: string;
  path: string;
}

export interface EvidenceManifest {
  headSha: string;
  intendedEvidence: EvidenceMap;
  // The tracked tree at headSha — what the worktree seats could read. Empty on a packet-only run.
  readableSurface: ManifestBlob[];
  realizedEvidence: EvidenceMap;
  sandboxProfiles: SandboxProfileMap;
  schemaVersion: number;
  // Stated plainly IN the artifact, so a reader who never opens this file cannot mistake it.
  scopeNote: string;
}

const SCOPE_NOTE =
  'readableSurface is the tracked tree at headSha that worktree seats COULD read (paths + blob SHAs). Opaque vendor CLIs do not report their reads, so this is the readable surface, not a record of what any seat actually read. Advisory; never hashed into the receipt.';

// `git ls-tree -r -z <sha>` → the tracked blobs. Symlinks/submodules (mode 120000/160000) are
// recorded like any other entry; the point is the exact content identity, not the file type.
//
// Entries are NUL-SEPARATED (`-z`), never newline-separated. Without `-z` git C-quotes any path
// holding a tab, a newline, or (under core.quotePath) a non-ASCII byte — `"ta\tb.ts"` — and the
// manifest would then record the ESCAPED LITERAL, quotes and all, as if it were the real path.
// `-z` also makes a path containing a newline unambiguous. Verified against git 2026-07-10.
export function parseLsTree(text: string): ManifestBlob[] {
  const out: ManifestBlob[] = [];
  for (const entry of text.split('\0')) {
    // <mode> SP <type> SP <sha> TAB <path>
    const m = /^\d{6} \w+ ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(entry);
    if (m) out.push({ blobSha: m[1], path: m[2] });
  }
  return out;
}

export function readReadableSurface(
  worktree: string,
  headSha: string,
  deps: { git: GitRun }
): ManifestBlob[] {
  const res = deps.git(['ls-tree', '-r', '-z', headSha], { cwd: worktree });
  return res.ok ? parseLsTree(res.text) : [];
}

export function buildEvidenceManifest(args: {
  headSha: string;
  intendedEvidence: EvidenceMap;
  readableSurface: ManifestBlob[];
  realizedEvidence: EvidenceMap;
  sandboxProfiles: SandboxProfileMap;
}): EvidenceManifest {
  return {
    headSha: args.headSha,
    intendedEvidence: args.intendedEvidence,
    readableSurface: args.readableSurface,
    realizedEvidence: args.realizedEvidence,
    sandboxProfiles: args.sandboxProfiles,
    schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
    scopeNote: SCOPE_NOTE,
  };
}

// Best-effort like every trail write — a manifest failure never takes down a review.
export function writeEvidenceManifest(
  baseDir: string,
  runId: string,
  manifest: EvidenceManifest
): boolean {
  try {
    writeTrailFile(baseDir, runId, EVIDENCE_MANIFEST_FILE, JSON.stringify(manifest, null, 2));
    return true;
  } catch {
    return false;
  }
}
