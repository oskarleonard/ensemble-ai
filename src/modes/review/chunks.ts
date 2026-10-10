import type { Coverage, FileDiff } from './diff';
import { isTestPath } from './diff';

// CHUNKED REVIEW — a change too large for one packet is reviewed in PARTS, never head+tail cut
// and never silently narrowed to "whatever fit under the ceiling".
//
// Before this module, computeCoverage admitted files until the ceiling and named the rest
// `over-limit`: run 2026-10-10-18-51-44-9acc127a (a 411-file, 2.26 MB feature-branch merge) handed the
// seats 70 backend files and nothing from web/ or mobile/, and the receipt refused. The ceiling is
// the size of ONE prompt, so the fix is not a bigger ceiling: it is several packets, each whole,
// each carrying the SAME scope note (what is in this part, what is in the others, what was omitted),
// reviewed by the same seats, judged by ONE gate over the union of their hunks.
//
// Planning is PURE and deterministic: the same files + ceiling always yield the same parts, so a
// re-run, a reseat, and the trail all agree on what "part 2" was.

export interface DiffChunk {
  bytes: number;
  // The included sections concatenated in ADMISSION order (non-test source first, then tests,
  // per area) — the bytes this part's packet carries.
  diff: string;
  // The parsed files in this part, same order as `paths` (identity-stable with the caller's
  // FileDiff objects, so coverage can mark each file's part without a lookup).
  files: FileDiff[];
  // 1-based, stable for the run (the trail, the prompts and the overview all name parts by it).
  index: number;
  // A human label for the part: the directories it covers, e.g. `backend/pkg/{services, handler}`.
  label: string;
  paths: string[];
}

export interface ChunkPlan {
  ceilingBytes: number;
  chunks: DiffChunk[];
  // Files that did not fit within `maxChunks` parts — still NAMED (coverage marks them
  // `over-limit`), never dropped. Empty whenever the change fits the chunk budget.
  overflow: FileDiff[];
}

// The default cap on parts per run. Each part costs every seat one full review, so the cap is a
// cost fence, not a quality one: raise it (`--max-chunks`) for a change that genuinely needs more.
// 8 × the default ceiling is 1.6 MB of reviewed source — more than any feature-branch merge seen
// so far once generated files are classed out.
export const DEFAULT_MAX_CHUNKS = 8;

// The directory "area" of a path at a given depth: `backend/pkg/services/ramp/x.go` at depth 2 is
// `backend/pkg`. A path shallower than the depth is its own dirname (a root file is `.`).
function areaAt(path: string, depth: number): string {
  const parts = path.split('/');
  const dirs = parts.slice(0, -1);
  if (dirs.length === 0) return '.';
  return dirs.slice(0, depth).join('/');
}

// Group files by area, splitting any group over the ceiling by the next path segment, until a
// group fits or cannot be split further (its files are then packed one by one). Order is the
// files' own order of first appearance, so the plan reads like the diff does.
function groupByArea(files: FileDiff[], ceilingBytes: number, depth: number): FileDiff[][] {
  const groups = new Map<string, FileDiff[]>();
  for (const f of files) {
    const key = areaAt(f.path, depth);
    const g = groups.get(key);
    if (g) g.push(f);
    else groups.set(key, [f]);
  }
  const out: FileDiff[][] = [];
  for (const g of groups.values()) {
    const bytes = g.reduce((n, f) => n + f.bytes, 0);
    // Splittable only if some file in the group has a deeper directory than this depth.
    const splittable = g.some((f) => f.path.split('/').length - 1 > depth);
    if (bytes > ceilingBytes && splittable && g.length > 1) {
      out.push(...groupByArea(g, ceilingBytes, depth + 1));
    } else {
      out.push(g);
    }
  }
  return out;
}

// Non-test source first, then tests, each in original order — the SAME rule computeCoverage
// uses for the single-packet case, applied per area so a part reads "the change, then its tests".
function sourceFirst(files: FileDiff[]): FileDiff[] {
  return [...files.filter((f) => !isTestPath(f.path)), ...files.filter((f) => isTestPath(f.path))];
}

// The label: the deepest directory every file in the part shares, then the distinct next-level
// directories under it (up to four), e.g. `backend/pkg/{services, handler, server}`.
export function chunkLabel(paths: string[]): string {
  if (paths.length === 0) return '(empty)';
  const dirLists = paths.map((p) => p.split('/').slice(0, -1));
  let common: string[] = [...dirLists[0]];
  for (const d of dirLists.slice(1)) {
    let i = 0;
    while (i < common.length && i < d.length && common[i] === d[i]) i++;
    common = common.slice(0, i);
  }
  const prefix = common.join('/');
  const next = new Set<string>();
  for (const d of dirLists) {
    const seg = d[common.length];
    next.add(seg === undefined ? '(files)' : seg);
  }
  const names = [...next];
  if (names.length === 1 && names[0] === '(files)') return prefix || '.';
  const shown = names.slice(0, 4).join(', ') + (names.length > 4 ? `, +${names.length - 4} more` : '');
  return prefix ? `${prefix}/{${shown}}` : `{${shown}}`;
}

// Plan the parts for the SOURCE files (binary/generated are never admitted — the caller filters).
// `files` arrive in diff order. Rules:
//   · everything fits in one part ⇒ ONE part in global admission order (non-test source, then
//     tests) — byte-identical to the single-packet coverage this engine always shipped;
//   · otherwise group by area (split oversize areas by the next directory), pack areas whole into
//     parts first-fit in order, and spill an area larger than a part across parts file by file;
//   · the first file of a part always fits, even alone over the ceiling (a review of nothing is
//     worse than a review of one large file);
//   · parts beyond `maxChunks` are not planned: their files are returned as `overflow`, NAMED.
export function planChunks(files: FileDiff[], ceilingBytes: number, maxChunks: number): ChunkPlan {
  const cap = Math.max(1, Math.floor(maxChunks));
  const total = files.reduce((n, f) => n + f.bytes, 0);
  const finish = (parts: FileDiff[][]): ChunkPlan => {
    const labels: string[] = [];
    const chunks: DiffChunk[] = parts.slice(0, cap).map((part, i) => {
      // A spilled area yields consecutive parts with the same directories; number them so the
      // trail, the prompts and the overview never show two parts with one name.
      let label = chunkLabel(part.map((f) => f.path));
      const dup = labels.filter((l) => l === label || l.startsWith(`${label} (`)).length;
      if (dup > 0) label = `${label} (${dup + 1})`;
      labels.push(label);
      return {
        bytes: part.reduce((n, f) => n + f.bytes, 0),
        diff: part.map((f) => f.raw).join(''),
        files: part,
        index: i + 1,
        label,
        paths: part.map((f) => f.path),
      };
    });
    const overflow = parts.slice(cap).flat();
    return { ceilingBytes, chunks, overflow };
  };
  if (files.length === 0) return { ceilingBytes, chunks: [], overflow: [] };
  if (total <= ceilingBytes) return finish([sourceFirst(files)]);

  const areas = groupByArea(files, ceilingBytes, 1).map(sourceFirst);
  // Classic first-fit over OPEN parts: an area that fits goes into the first part with room for
  // the whole of it (keeping areas whole and parts fewer), else opens a new part; an area larger
  // than a part spills file by file into the last part and onward. Parts keep their creation
  // order, so part 1 still begins with the first area of the diff.
  const parts: { bytes: number; files: FileDiff[] }[] = [];
  for (const area of areas) {
    const areaBytes = area.reduce((n, f) => n + f.bytes, 0);
    if (areaBytes <= ceilingBytes) {
      const home = parts.find((p) => p.bytes + areaBytes <= ceilingBytes);
      if (home) {
        home.files.push(...area);
        home.bytes += areaBytes;
      } else {
        parts.push({ bytes: areaBytes, files: [...area] });
      }
      continue;
    }
    for (const f of area) {
      const last = parts[parts.length - 1];
      if (last && last.bytes + f.bytes <= ceilingBytes) {
        last.files.push(f);
        last.bytes += f.bytes;
      } else {
        parts.push({ bytes: f.bytes, files: [f] });
      }
    }
  }
  return finish(parts.map((p) => p.files));
}

// ── The scope note ────────────────────────────────────────────────────────────────────

function fileLine(f: { added: number; path: string; removed: number }): string {
  return `${f.path} (+${f.added}/-${f.removed})`;
}

export interface ScopeInput {
  coverage: Coverage;
  plan: ChunkPlan;
}

// The per-part scope note every seat reading part k is handed: what THIS part carries, what the
// other parts carry (reviewed separately by the same seats — a finding that depends on one of
// those files should read it in the worktree), and what no reviewer ever sees (omitted, with the
// reason). A seat that reads only its own hunks and is told nothing else would file "X is never
// called" against a caller sitting in part 3 — this note is what stops that.
export function renderChangeScope(input: ScopeInput, chunkIndex: number): string {
  const { coverage, plan } = input;
  const byPath = new Map(coverage.files.map((f) => [f.path, f]));
  const part = plan.chunks.find((c) => c.index === chunkIndex);
  if (!part) return '';
  const lines: string[] = [];
  const n = plan.chunks.length;
  lines.push(
    `This change is larger than one review packet (ceiling ${plan.ceilingBytes.toLocaleString('en-US')} bytes), so it is reviewed in ${n} part(s) by the same reviewers. You are reading PART ${chunkIndex} of ${n}: ${part.label} — ${part.paths.length} file(s), ${part.bytes.toLocaleString('en-US')} bytes. Review the hunks in THIS part. Every part's findings are judged together by one verification gate.`
  );
  lines.push('');
  lines.push(`Files in THIS part (their hunks are below):`);
  for (const p of part.paths) {
    const f = byPath.get(p);
    lines.push(`  ${f ? fileLine(f) : p}`);
  }
  const others = plan.chunks.filter((c) => c.index !== chunkIndex);
  if (others.length > 0) {
    lines.push('');
    lines.push(
      `Files in the OTHER parts — also changed by this PR, reviewed separately. Their hunks are NOT below; if a finding depends on one of them, read the file as it exists at the PR head rather than assuming it is unchanged:`
    );
    for (const c of others) {
      lines.push(`  part ${c.index} — ${c.label}:`);
      for (const p of c.paths) {
        const f = byPath.get(p);
        lines.push(`    ${f ? fileLine(f) : p}`);
      }
    }
  }
  const omitted = coverage.files.filter((f) => !f.included);
  if (omitted.length > 0) {
    lines.push('');
    lines.push(`Changed but NOT shipped to any reviewer (named so nothing is silently missing):`);
    for (const f of omitted) {
      lines.push(`  ${fileLine(f)} — ${f.omitReason ?? 'omitted'}/${f.kind}`);
    }
  }
  return lines.join('\n');
}

// The lens's scope note: the whole change map in one listing. The lens reads the whole tree and
// is told exactly which files' hunks it was handed and which it must open itself.
export function renderLensScope(input: ScopeInput, materializedChunks: readonly number[]): string {
  const { coverage, plan } = input;
  const lines: string[] = [];
  const n = plan.chunks.length;
  const shown = new Set(materializedChunks);
  lines.push(
    `This change touches ${coverage.totalFiles} file(s) and was reviewed in ${n} part(s). The diff materialized below carries part(s) ${[...shown].join(', ')}; every other changed file is listed here with its +/- line counts and is readable at the PR head in the worktree — it IS part of this change even though its hunks are not below.`
  );
  for (const c of plan.chunks) {
    lines.push('');
    lines.push(`part ${c.index} — ${c.label}${shown.has(c.index) ? ' (hunks below)' : ' (hunks NOT below — read at head)'}:`);
    for (const p of c.paths) {
      const f = coverage.files.find((x) => x.path === p);
      lines.push(`  ${f ? fileLine(f) : p}`);
    }
  }
  const omitted = coverage.files.filter((f) => !f.included);
  if (omitted.length > 0) {
    lines.push('');
    lines.push(`Changed but not reviewed by any seat:`);
    for (const f of omitted) lines.push(`  ${fileLine(f)} — ${f.omitReason ?? 'omitted'}/${f.kind}`);
  }
  return lines.join('\n');
}

// ── The trail record ──────────────────────────────────────────────────────────────────

export const CHUNKS_TRAIL_FILE = 'chunks.json';
export const CHUNKS_TRAIL_SCHEMA_VERSION = 1;

export interface ChunkSeatRecord {
  elapsedMs?: number;
  findings: number;
  state: 'reviewed' | 'failed-reviewer' | 'skipped';
  // Why the seat ended short of `reviewed`, when it did (the seat's own summary head).
  why?: string;
}

export interface ChunkTrailEntry {
  bytes: number;
  files: { added: number; path: string; removed: number; test: boolean }[];
  index: number;
  label: string;
  promptChars: number;
  seats: Record<string, ChunkSeatRecord>;
}

export interface ChunksTrail {
  ceilingBytes: number;
  chunks: ChunkTrailEntry[];
  maxChunks: number;
  // Changed files no seat saw: binary/generated by kind, and overflow past `maxChunks`.
  omitted: { kind: string; path: string; reason: string }[];
  schemaVersion: number;
}

// The human overview (step 5): one markdown page a reader opens before the findings — which
// parts existed, what each seat did with each, what nobody read. Rendered from the trail record
// so the file and the JSON can never disagree.
export function renderCoverageOverview(
  trail: ChunksTrail,
  extra: { gateCounts?: Record<string, number>; headSha: string; totalFiles: number }
): string {
  const out: string[] = [];
  const reviewedParts = trail.chunks.filter((c) =>
    Object.values(c.seats).some((s) => s.state === 'reviewed')
  ).length;
  const reviewedFiles = trail.chunks
    .filter((c) => Object.values(c.seats).some((s) => s.state === 'reviewed'))
    .reduce((n, c) => n + c.files.length, 0);
  const unreadParts = trail.chunks.filter((c) => !Object.values(c.seats).some((s) => s.state === 'reviewed'));
  const overflow = trail.omitted.filter((o) => o.reason === 'over-limit');
  const junk = trail.omitted.filter((o) => o.reason !== 'over-limit');
  out.push(`# Coverage overview — ${extra.headSha.slice(0, 12)}`);
  out.push('');
  out.push(
    `${extra.totalFiles} changed file(s) · ${trail.chunks.length} part(s) planned under a ${trail.ceilingBytes.toLocaleString('en-US')}-byte ceiling (max ${trail.maxChunks}) · ${reviewedParts} part(s) reviewed by at least one seat · ${reviewedFiles} file(s) read by a seat · ${junk.length} generated/binary file(s) skipped by kind · ${overflow.length} file(s) past the part limit (NOT reviewed).`
  );
  if (extra.gateCounts) {
    const g = Object.entries(extra.gateCounts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${n} ${k}`)
      .join(' · ');
    out.push('');
    out.push(`Gate across all parts: ${g || 'no findings'}.`);
  }
  out.push('');
  out.push('## Parts');
  for (const c of trail.chunks) {
    const seats = Object.entries(c.seats)
      .map(([id, s]) => `${id} ${s.state === 'reviewed' ? `✓ ${s.findings} finding(s)` : `✗ ${s.state}${s.why ? ` — ${s.why}` : ''}`}`)
      .join(' · ');
    const tests = c.files.filter((f) => f.test).length;
    out.push('');
    out.push(`### Part ${c.index} — ${c.label}`);
    out.push(`${c.files.length} file(s) (${tests} test) · ${c.bytes.toLocaleString('en-US')} bytes · prompt ${c.promptChars.toLocaleString('en-US')} chars`);
    out.push(`Seats: ${seats || 'none ran'}`);
    out.push('');
    for (const f of c.files) out.push(`- ${f.path} (+${f.added}/-${f.removed})${f.test ? ' [test]' : ''}`);
  }
  if (unreadParts.length > 0) {
    out.push('');
    out.push('## Parts NO seat completed');
    for (const c of unreadParts) out.push(`- part ${c.index} — ${c.label} (${c.files.length} file(s))`);
  }
  if (overflow.length > 0) {
    out.push('');
    out.push(`## Not reviewed — past the ${trail.maxChunks}-part limit`);
    out.push('Raise `--max-chunks` to review these; they are part of the change.');
    for (const o of overflow) out.push(`- ${o.path} (${o.kind})`);
  }
  if (junk.length > 0) {
    out.push('');
    out.push('## Skipped by kind (generated / binary)');
    for (const o of junk) out.push(`- ${o.path} (${o.reason})`);
  }
  out.push('');
  return out.join('\n');
}
