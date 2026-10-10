import type { ChunkPlan } from './chunks';
import type { Coverage, FileDiff } from './diff';

// THE WHOLE-CHANGE SKELETON and the SEAM NOTES (2026-10-10 architecture review, item 5).
//
// A review in parts hands every seat one part's hunks and a bare list of the other parts' files.
// The bugs a feature branch produces most — a contract changed in one part and its consumer in
// another, a guard added here and missing there, a rename half done — sit exactly on those seams,
// and no seat saw both sides. Two pure artifacts close that:
//
//   · the SKELETON: every changed file, its hunk headers, and the declarations its hunks add or
//     remove — the whole change at the resolution of signatures, small enough for one prompt
//     (~60–120 KB for 300 files). The integration seat and the holistic lens read it with the tree.
//   · the SEAMS per part: for the declarations part k adds, every line in the OTHER parts' hunks
//     that names them (and the reverse: other parts' declarations this part's hunks name), as
//     `path:line  <the line>` — so "go look" becomes "here is what to look at", and the gate has a
//     pinned hunk line to ground a cross-part claim against.
//
// Both are computed from the DIFF SECTIONS alone (pure, deterministic, no tree access), so they
// exist in packet mode too and a test can pin them byte for byte.

// Declaration shapes across the ecosystems this engine reviews. Each regex captures the NAME in
// group 1. Conservative: a miss costs a symbol its seam note, never a wrong one.
const DECL_PATTERNS: RegExp[] = [
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*[([]/, // go: func Name( / func (r *T) Name( / generic
  /^\s*type\s+([A-Z][A-Za-z0-9_]*)\s+(?:struct|interface|func|=|[A-Za-z[])/, // go: type Name struct|interface|…
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[(<]/, // ts/js
  /^\s*export\s+(?:const|let|var|class|interface|type|enum|abstract\s+class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/, // ts/js exports
  /^\s*(?:abstract\s+)?class\s+([A-Z][A-Za-z0-9_$]*)/, // class Name (ts/js/py/kt/swift/java)
  /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, // python
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/, // rust
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+([A-Z][A-Za-z0-9_]*)/, // rust types
  /^\s*(?:(?:public|private|internal|protected|open|override|suspend|static|final)\s+)*fun\s+(?:<[^>]*>\s*)?(?:[A-Za-z_][A-Za-z0-9_.]*\.)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/, // kotlin
  /^\s*(?:(?:public|private|internal|fileprivate|open|static|final|override)\s+)*func\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/, // swift
  /^\s*(?:(?:public|private|protected|static|final|abstract|synchronized)\s+)+[A-Za-z_<>[\],.? ]+\s+([a-z][A-Za-z0-9_]*)\s*\(/, // java/kt methods with modifiers
];

// Names too common to be a seam on their own (a `main`, an `init`, a `New`): they match in every
// file and would drown the note.
const NOISE_NAMES = new Set(['main', 'init', 'new', 'New', 'String', 'Error', 'Close', 'Run', 'run', 'get', 'set', 'default', 'index', 'test', 'Test']);

export interface DeclarationChange {
  // The declaration line as written (trimmed, bounded).
  line: string;
  name: string;
  // New-side line number for an added declaration; old-side for a removed one.
  lineNo: number | null;
}

export interface FileSkeleton {
  added: DeclarationChange[];
  addedLines: number;
  hunks: string[];
  path: string;
  removed: DeclarationChange[];
  removedLines: number;
}

function declName(line: string): string | null {
  for (const re of DECL_PATTERNS) {
    const m = re.exec(line);
    if (m?.[1] && m[1].length >= 2 && !NOISE_NAMES.has(m[1])) return m[1];
  }
  return null;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

// Walk one diff section with new/old line numbers, calling `on` for every hunk body line.
function walkSection(
  section: string,
  on: (args: { kind: '+' | '-' | ' '; line: string; newNo: number | null; oldNo: number | null }) => void
): string[] {
  const headers: string[] = [];
  let newNo: number | null = null;
  let oldNo: number | null = null;
  let inHunk = false;
  for (const raw of section.split('\n')) {
    const h = HUNK_RE.exec(raw);
    if (h) {
      headers.push(`@@ -${h[1]}${h[2] ? `,${h[2]}` : ''} +${h[3]}${h[4] ? `,${h[4]}` : ''} @@${h[5] ?? ''}`.trimEnd());
      oldNo = Number(h[1]);
      newNo = Number(h[3]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      on({ kind: '+', line: raw.slice(1), newNo, oldNo: null });
      if (newNo !== null) newNo++;
    } else if (raw.startsWith('-')) {
      on({ kind: '-', line: raw.slice(1), newNo: null, oldNo });
      if (oldNo !== null) oldNo++;
    } else if (raw.startsWith(' ') || raw === '') {
      on({ kind: ' ', line: raw.slice(1), newNo, oldNo });
      if (newNo !== null) newNo++;
      if (oldNo !== null) oldNo++;
    } else if (raw.startsWith('\\')) {
      /* "\ No newline at end of file" */
    } else {
      inHunk = false; // a non-hunk line (diff --git of a glued section, index, mode) ends the hunk
    }
  }
  return headers;
}

export function skeletonOf(f: FileDiff): FileSkeleton {
  const added: DeclarationChange[] = [];
  const removed: DeclarationChange[] = [];
  const hunks = walkSection(f.raw, ({ kind, line, newNo, oldNo }) => {
    if (kind === ' ') return;
    const name = declName(line);
    if (!name) return;
    const entry = { line: line.trim().slice(0, 160), lineNo: kind === '+' ? newNo : oldNo, name };
    (kind === '+' ? added : removed).push(entry);
  });
  return { added, addedLines: f.added, hunks, path: f.path, removed, removedLines: f.removed };
}

export const SKELETON_BUDGET_CHARS = 200_000;

// The whole change at signature resolution, one block per file in diff order. Omitted files
// (binary / generated / over the part limit) are listed with the reason so the reader sees the
// whole change, not the reviewed subset.
export function renderSkeleton(files: readonly FileDiff[], coverage: Coverage, plan: ChunkPlan): string {
  const partOf = new Map<string, number>();
  for (const c of plan.chunks) for (const p of c.paths) partOf.set(p, c.index);
  const entryOf = new Map(coverage.files.map((e) => [e.path, e]));
  const out: string[] = [];
  out.push(
    `Whole-change skeleton: ${files.length} file(s), ${plan.chunks.length} part(s). Per file: part, hunk headers, declarations the hunks ADD (+) and REMOVE (−) with their line numbers at the PR head. Read a file in the worktree for anything below signature level.`
  );
  let used = out[0].length;
  let cut = 0;
  for (const f of files) {
    const sk = skeletonOf(f);
    const e = entryOf.get(f.path);
    const where = e && !e.included ? `omitted: ${e.omitReason ?? 'omitted'}/${e.kind}` : `part ${partOf.get(f.path) ?? '?'}`;
    const lines: string[] = [`### ${f.path} (+${f.added}/-${f.removed}) — ${where}`];
    if (sk.hunks.length > 0) lines.push(`hunks: ${sk.hunks.slice(0, 12).join(' · ')}${sk.hunks.length > 12 ? ` · +${sk.hunks.length - 12} more` : ''}`);
    for (const d of sk.added.slice(0, 24)) lines.push(`+ ${d.lineNo ?? '?'}: ${d.line}`);
    if (sk.added.length > 24) lines.push(`+ … ${sk.added.length - 24} more added declarations`);
    for (const d of sk.removed.slice(0, 12)) lines.push(`− ${d.lineNo ?? '?'}: ${d.line}`);
    if (sk.removed.length > 12) lines.push(`− … ${sk.removed.length - 12} more removed declarations`);
    const block = lines.join('\n');
    if (used + block.length + 2 > SKELETON_BUDGET_CHARS) {
      cut++;
      continue;
    }
    out.push(block);
    used += block.length + 2;
  }
  if (cut > 0) out.push(`… ${cut} file(s) not shown — the skeleton reached its ${SKELETON_BUDGET_CHARS.toLocaleString('en-US')}-char budget; their paths are in the change listing.`);
  return out.join('\n\n');
}

// ── Seams ─────────────────────────────────────────────────────────────────────────────

export const SEAMS_PER_PART_CHARS = 24_000;
const HITS_PER_SYMBOL_FILE = 3;

interface Hit {
  line: string;
  lineNo: number | null;
  path: string;
}

// Lines in `f`'s hunks (added or context) that name `symbol` — excluding the declaration itself.
function referencesIn(f: FileDiff, symbol: string): Hit[] {
  const re = new RegExp(`(^|[^A-Za-z0-9_$])${symbol.replace(/[$]/g, '\\$')}(?![A-Za-z0-9_$])`);
  const hits: Hit[] = [];
  walkSection(f.raw, ({ kind, line, newNo }) => {
    if (kind === '-') return;
    if (hits.length >= HITS_PER_SYMBOL_FILE) return;
    if (!re.test(line)) return;
    if (declName(line) === symbol) return;
    hits.push({ line: line.trim().slice(0, 140), lineNo: newNo, path: f.path });
  });
  return hits;
}

// Per part: the seam note (or '' when the part has no seams with any other part).
export function computeSeams(plan: ChunkPlan): Map<number, string> {
  const declsByPart = new Map<number, { name: string; path: string }[]>();
  for (const c of plan.chunks) {
    const decls: { name: string; path: string }[] = [];
    const seen = new Set<string>();
    for (const f of c.files) {
      for (const d of skeletonOf(f).added) {
        if (seen.has(d.name)) continue;
        seen.add(d.name);
        decls.push({ name: d.name, path: f.path });
      }
    }
    declsByPart.set(c.index, decls);
  }
  const notes = new Map<number, string>();
  for (const c of plan.chunks) {
    const lines: string[] = [];
    let used = 0;
    const push = (s: string): boolean => {
      if (used + s.length + 1 > SEAMS_PER_PART_CHARS) return false;
      lines.push(s);
      used += s.length + 1;
      return true;
    };
    // (a) other parts that touch what THIS part declares
    const mine = declsByPart.get(c.index) ?? [];
    const outward: string[] = [];
    for (const d of mine) {
      for (const other of plan.chunks) {
        if (other.index === c.index) continue;
        for (const f of other.files) {
          for (const h of referencesIn(f, d.name)) {
            outward.push(`  ${d.name} (declared in ${d.path}) ← part ${other.index} ${h.path}:${h.lineNo ?? '?'}  ${h.line}`);
          }
        }
      }
    }
    // (b) what THIS part's hunks name that OTHER parts declare
    const inward: string[] = [];
    for (const other of plan.chunks) {
      if (other.index === c.index) continue;
      for (const d of declsByPart.get(other.index) ?? []) {
        for (const f of c.files) {
          for (const h of referencesIn(f, d.name)) {
            inward.push(`  ${h.path}:${h.lineNo ?? '?'}  ${h.line}  → ${d.name} declared in part ${other.index} ${d.path}`);
          }
        }
      }
    }
    if (outward.length === 0 && inward.length === 0) {
      notes.set(c.index, '');
      continue;
    }
    push(`Seams — where this part meets the other parts (from the hunks; read both sides at the PR head before judging either):`);
    if (outward.length > 0) {
      push(`Other parts use what THIS part declares:`);
      for (const l of outward) if (!push(l)) break;
    }
    if (inward.length > 0) {
      push(`THIS part uses what other parts declare:`);
      for (const l of inward) if (!push(l)) break;
    }
    if (used >= SEAMS_PER_PART_CHARS - 200) push(`  … seam note truncated at ${SEAMS_PER_PART_CHARS.toLocaleString('en-US')} chars`);
    notes.set(c.index, lines.join('\n'));
  }
  return notes;
}
