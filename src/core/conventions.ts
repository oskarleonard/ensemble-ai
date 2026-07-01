import fs from 'node:fs';
import path from 'node:path';

// The conventions GATHERER — feed reviewers the repo's real markdown web instead
// of a single AGENTS.md (or, as the CLI did, nothing at all). PURE over an injected
// READER, so ONE implementation serves BOTH a local fs checkout (CLI local mode)
// and a remote gh-backed reader (CLI `--pr <url>` + the dashboard) — one path, no
// drift. Monorepo-aware (walk up from each changed file), resolves the linked md
// web three ways (@-imports · markdown links · prose refs) + sweeps common docs,
// flattens/dedupes/bounds the result, and — LOAD-BEARING — resolves IN-TREE ONLY
// (a personal `@~/brain/...` import must never pull the brain into a review packet;
// a _work packet contains only that repo's own files — review-only, nothing external).

// Repo-relative, async so the same core serves a sync fs reader and an async gh reader.
export interface ConventionReader {
  // Read a repo-relative file's UTF-8 content; null if missing/unreadable/not a file.
  read(relPath: string): Promise<string | null>;
  // Repo-relative *.md paths directly under a repo-relative dir (one level), for the
  // docs/ + ai-spec/ sweeps. [] when the dir is absent.
  list(dirRelPath: string): Promise<string[]>;
}

export interface GatherConfig {
  // Total size cap on the flattened conventions text. Over-cap files are NAMED as
  // truncated/omitted in the manifest — never silently dropped (the honesty rule).
  capBytes?: number;
  // Hard ceiling on distinct files visited — terminates any import cycle / runaway.
  maxFiles?: number;
  // Explicit extra entry paths (`.ensemble-ai.json` `conventions:[]` / `--conventions`)
  // — a belt for non-standard layouts. Additive to the auto-detected set.
  conventions?: string[];
}

export interface ConventionFileEntry {
  path: string; // repo-relative
  bytes: number; // full file size
  included: boolean; // its content is in `text` (fully or head-truncated)
  truncated: boolean; // head-only, because it crossed the cap
  reason?: 'over-cap'; // why it was truncated/omitted
}

export interface ConventionManifest {
  capBytes: number;
  totalBytes: number; // included bytes in `text`
  files: ConventionFileEntry[];
}

export interface GatheredConventions {
  text: string;
  manifest: ConventionManifest;
}

const DEFAULT_CAP_BYTES = 80_000;
const DEFAULT_MAX_FILES = 60;
// Per-dir convention entry files (root + every touched package dir).
const ENTRY_FILES = ['CLAUDE.md', 'AGENTS.md'];
// Well-known docs swept at root + touched packages even when unlinked.
const COMMON_DOCS = ['CONTRIBUTING.md', 'ARCHITECTURE.md', 'TECH_DESIGN.md'];
// Dirs whose *.md files are swept (the discoveries/learnings suites).
const SWEEP_DIRS = ['docs', 'ai-spec'];

// The LOAD-BEARING boundary guard. Resolve a reference (a changed path, an @-import,
// a markdown-link/prose target) relative to the referring dir and return a clean
// repo-relative path — or null if it is absolute / home (`~/…`) / a URL scheme / or
// escapes the repo root. Nothing outside repoRoot can ever be resolved.
export function resolveInRepo(fromDir: string, ref: string): string | null {
  // Drop a #fragment / ?query / trailing title so `path.md#x` and `[t](p.md "x")` resolve.
  const first = ref.trim().split(/[#?\s]/)[0];
  if (!first) return null;
  if (first.startsWith('/') || first.startsWith('~')) return null; // absolute / home
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(first)) return null; // http: file: mailto: …
  const joined = path.posix.normalize(path.posix.join(fromDir || '.', first));
  if (joined === '..' || joined.startsWith('../')) return null; // escapes the root
  if (joined.startsWith('/')) return null; // defensive
  return joined === '.' ? '' : joined.replace(/^\.\//, '');
}

function dirOf(relPath: string): string {
  const d = path.posix.dirname(relPath);
  return d === '.' ? '' : d;
}

function joinDir(dir: string, file: string): string {
  return dir === '' ? file : `${dir}/${file}`;
}

// Every ancestor dir of a changed path, leaf → root (root '' always included).
function ancestorDirs(relPath: string): string[] {
  const dirs: string[] = [];
  let d = dirOf(relPath);
  for (;;) {
    dirs.push(d);
    if (d === '') break;
    d = dirOf(d);
  }
  return dirs;
}

// Three link mechanisms, since repos differ: (a) Claude `@relative/path.md` imports
// + inline markdown links `[t](path.md)`; (c) prose refs `see/read <file>.md`.
export function extractRefs(content: string): string[] {
  const refs = new Set<string>();
  // (a) @-imports — `@relative/path.md`, only at a boundary (skips emails foo@bar.md).
  for (const m of content.matchAll(/(?:^|\s)@([^\s)]+\.md)/gm)) refs.add(m[1]);
  // (a) inline markdown links — [text](target)
  for (const m of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) refs.add(m[1]);
  // (c) prose references — "see/read/per/in <file>.md" (optionally backticked)
  for (const m of content.matchAll(/\b(?:see|read|per|in)\s+`?([\w./-]+\.md)`?/gi)) {
    refs.add(m[1]);
  }
  return [...refs];
}

// Slice to at most maxBytes UTF-8 bytes without splitting a multibyte char.
function sliceBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString('utf8').replace(/�$/, '');
}

function fileHeader(rel: string): string {
  return `\n\n===== ${rel} =====\n`;
}

// Gather the repo's convention web reachable from the changed paths. Deterministic:
// seeds (entry files at each touched dir, roots first · explicit config paths ·
// common-docs + sweeps) are enqueued in a fixed order, then links resolve BFS. Each
// file appears once; total content is bounded by capBytes with over-cap files NAMED.
export async function gatherConventions(
  reader: ConventionReader,
  changedPaths: string[],
  config: GatherConfig = {}
): Promise<GatheredConventions> {
  const capBytes = config.capBytes ?? DEFAULT_CAP_BYTES;
  const maxFiles = config.maxFiles ?? DEFAULT_MAX_FILES;

  // Touched dirs = root ∪ every ancestor dir of each (in-repo) changed path.
  const dirs = new Set<string>(['']);
  for (const p of changedPaths) {
    const rel = resolveInRepo('', p);
    if (rel === null || rel === '') continue;
    for (const d of ancestorDirs(rel)) dirs.add(d);
  }
  const orderedDirs = [...dirs].sort(
    (a, b) => a.length - b.length || (a < b ? -1 : 1)
  );

  const seen = new Set<string>();
  const queue: string[] = [];
  const enqueue = (rel: string | null): void => {
    if (!rel || !rel.endsWith('.md')) return; // only markdown docs are conventions prose
    if (seen.has(rel) || seen.size >= maxFiles) return;
    seen.add(rel);
    queue.push(rel);
  };

  // Seeds (deterministic order): per-dir entry files, then explicit config paths,
  // then common-docs + the sweep dirs' *.md.
  for (const d of orderedDirs) {
    for (const f of ENTRY_FILES) enqueue(joinDir(d, f));
  }
  for (const c of config.conventions ?? []) enqueue(resolveInRepo('', c));
  for (const d of orderedDirs) {
    for (const f of COMMON_DOCS) enqueue(joinDir(d, f));
    for (const sweepDir of SWEEP_DIRS) {
      for (const item of await reader.list(joinDir(d, sweepDir))) {
        enqueue(resolveInRepo('', item));
      }
    }
  }

  const files: ConventionFileEntry[] = [];
  const chunks: string[] = [];
  let used = 0;
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    const content = await reader.read(rel);
    if (content === null) continue; // missing/unreadable → not part of the set
    const bytes = Buffer.byteLength(content, 'utf8');
    // Discover transitive refs BEFORE cap decisions (an over-cap file can still link
    // to a small important one; enqueue's maxFiles guard bounds any cycle).
    const dir = dirOf(rel);
    for (const ref of extractRefs(content)) enqueue(resolveInRepo(dir, ref));

    const remaining = capBytes - used;
    if (remaining <= 0) {
      // Nothing left in the budget → NAMED as omitted, never silently dropped.
      files.push({ path: rel, bytes, included: false, truncated: false, reason: 'over-cap' });
      continue;
    }
    if (bytes <= remaining) {
      chunks.push(fileHeader(rel) + content);
      used += bytes;
      files.push({ path: rel, bytes, included: true, truncated: false });
    } else {
      const head = sliceBytes(content, remaining);
      chunks.push(
        `${fileHeader(rel)}${head}\n\n…[${bytes - Buffer.byteLength(head, 'utf8')} bytes truncated — over the ${capBytes}-byte conventions cap]…\n`
      );
      used += Buffer.byteLength(head, 'utf8');
      files.push({ path: rel, bytes, included: true, truncated: true, reason: 'over-cap' });
    }
  }

  return {
    text: chunks.join('').replace(/^\n+/, ''),
    manifest: { capBytes, files, totalBytes: used },
  };
}

// A filesystem-backed reader rooted at repoRoot (CLI local mode). Reads stay WITHIN
// root (defense in depth beside resolveInRepo).
export function fsConventionReader(repoRoot: string): ConventionReader {
  const root = path.resolve(repoRoot);
  const within = (rel: string): string | null => {
    const abs = path.resolve(root, rel);
    const back = path.relative(root, abs);
    if (back.startsWith('..') || path.isAbsolute(back)) return null;
    return abs;
  };
  return {
    async read(rel) {
      const abs = within(rel);
      if (!abs) return null;
      try {
        if (!fs.statSync(abs).isFile()) return null;
        return fs.readFileSync(abs, 'utf8');
      } catch {
        return null;
      }
    },
    async list(dirRel) {
      const abs = within(dirRel);
      if (!abs) return [];
      try {
        return fs
          .readdirSync(abs)
          .filter((n) => n.endsWith('.md'))
          .map((n) => joinDir(dirRel, n));
      } catch {
        return [];
      }
    },
  };
}

// An in-memory reader over a { repoRelativePath: content } map — the unit-test seam
// (and a model for the gh-backed reader the CLI/dashboard build over their own I/O).
export function memoryConventionReader(
  fileMap: Record<string, string>
): ConventionReader {
  return {
    async read(rel) {
      return Object.prototype.hasOwnProperty.call(fileMap, rel) ? fileMap[rel] : null;
    },
    async list(dirRel) {
      const prefix = dirRel === '' ? '' : `${dirRel}/`;
      return Object.keys(fileMap).filter(
        (p) =>
          p.endsWith('.md') &&
          p.startsWith(prefix) &&
          !p.slice(prefix.length).includes('/')
      );
    },
  };
}
