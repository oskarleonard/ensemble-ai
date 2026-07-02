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
  // `maxBytes` (when given) BOUNDS THE READ itself — a reader must not pull more than
  // maxBytes bytes into memory (a multi-GB doc in the tree must never be slurped whole
  // just to be trimmed afterwards). The gatherer only ever emits ≤ capBytes of any one
  // file, so a maxBytes-bounded content is always enough to fill the budget.
  read(relPath: string, maxBytes?: number): Promise<string | null>;
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
  bytes: number; // file size as read (bounded by the read cap — see ConventionReader.read)
  included: boolean; // its content is in `text` (fully or head-truncated)
  truncated: boolean; // head-only, because it crossed the cap
  reason?: 'over-cap' | 'max-files'; // why it was truncated/omitted (cap · file-count ceiling)
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

// How far past capBytes the per-file read probes so a read-truncated file is DETECTABLE
// (see the gather loop). Must exceed the 4-byte max UTF-8 char so a trailing-partial trim
// can't mask an over-cap read; tiny vs capBytes, so no meaningful over-read.
const CAP_PROBE_MARGIN = 8;
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
    if (seen.has(rel)) return; // dedupe — also terminates any import cycle
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
  // maxFiles bounds distinct REAL (existing) files visited — NOT speculative seed
  // candidates. Entry-file / common-doc seeds are enqueued for every touched dir before
  // we know they exist; counting those misses against the ceiling would let a deep tree
  // of absent candidates starve the real linked docs. So the cap counts reads that hit.
  let visited = 0;
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    // Bound the READ to the cap — the gatherer never emits more than capBytes of any one
    // file, so a cap-bounded read is always sufficient AND a multi-GB doc in the tree is
    // never slurped whole just to be trimmed. Probe a small MARGIN past the cap so we can
    // DETECT a read-truncated file: if the bounded read comes back longer than capBytes, the
    // file exceeds the cap and what we hold is a HEAD, not the whole file — so it must NEVER
    // be reported as complete (truncated:false). The margin (> a 4-byte max UTF-8 char)
    // means a trailing-partial-multibyte TRIM at the boundary can't drag an over-cap read
    // back down to ≤ capBytes and hide the truncation. `bytes` is the (capped) length.
    const probe = await reader.read(rel, capBytes + CAP_PROBE_MARGIN);
    if (probe === null) continue; // missing/unreadable → not part of the set (no budget)
    const readTruncated = Buffer.byteLength(probe, 'utf8') > capBytes;
    const content = readTruncated ? sliceBytes(probe, capBytes) : probe;
    const bytes = Buffer.byteLength(content, 'utf8');
    // Ceiling reached: a REAL (existing) file we won't process. NAME it omitted rather
    // than SILENTLY dropping the boundary file (the honesty rule — same as over-cap), then
    // stop. Checked after the existence read so `visited` only ever counts real files.
    if (visited >= maxFiles) {
      files.push({ path: rel, bytes, included: false, truncated: false, reason: 'max-files' });
      break;
    }
    visited++;
    // Discover transitive refs BEFORE cap decisions (an over-cap file can still link
    // to a small important one; the `seen` dedupe bounds any cycle).
    const dir = dirOf(rel);
    for (const ref of extractRefs(content)) enqueue(resolveInRepo(dir, ref));

    // The emitted `text` carries the per-file framing (a header, and for a truncated
    // file a notice) — count THAT toward the cap too, so the flattened text actually
    // honors capBytes rather than overshooting by the sum of every header.
    const remaining = capBytes - used;
    const header = fileHeader(rel);
    const headerBytes = Buffer.byteLength(header, 'utf8');
    if (remaining <= headerBytes) {
      // Not even room for the header → NAMED as omitted, never silently dropped.
      files.push({ path: rel, bytes, included: false, truncated: false, reason: 'over-cap' });
      continue;
    }
    if (headerBytes + bytes <= remaining) {
      chunks.push(header + content);
      used += headerBytes + bytes;
      // A read-truncated file that still fit `remaining` is a HEAD, not the whole file —
      // record it truncated (never silently "complete"), same honesty rule as over-cap.
      files.push(
        readTruncated
          ? { path: rel, bytes, included: true, truncated: true, reason: 'over-cap' }
          : { path: rel, bytes, included: true, truncated: false }
      );
    } else {
      // Reserve room for the header + the truncation notice within `remaining` so the
      // total never exceeds the cap. noticeFor(bytes) upper-bounds the notice's digit
      // count (the real notice has ≤ as many digits) → `used` stays ≤ capBytes.
      const noticeFor = (n: number): string =>
        `\n\n…[${n} bytes truncated — over the ${capBytes}-byte conventions cap]…\n`;
      const noticeReserve = Buffer.byteLength(noticeFor(bytes), 'utf8');
      const contentBudget = remaining - headerBytes - noticeReserve;
      if (contentBudget <= 0) {
        // No room for header + notice (+ content) → NAMED as omitted, never silent.
        files.push({ path: rel, bytes, included: false, truncated: false, reason: 'over-cap' });
        continue;
      }
      const head = sliceBytes(content, contentBudget);
      const headBytes = Buffer.byteLength(head, 'utf8');
      const notice = noticeFor(bytes - headBytes);
      chunks.push(`${header}${head}${notice}`);
      used += headerBytes + headBytes + Buffer.byteLength(notice, 'utf8');
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
  // Resolve symlinks in the root ONCE so containment is compared on real paths (the
  // repo itself may live under a symlinked path, e.g. /var → /private/var on macOS).
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    realRoot = root;
  }
  // Resolve rel under root, then REALPATH it and re-check containment: a symlink INSIDE
  // the repo pointing OUTSIDE passes the lexical check (its path string is under root)
  // but must NOT be followed — realpath exposes the escape. THE load-bearing boundary
  // (defense beside resolveInRepo). Missing / broken links → null (not part of the set).
  const within = (rel: string): string | null => {
    const abs = path.resolve(root, rel);
    const back = path.relative(root, abs);
    if (back.startsWith('..') || path.isAbsolute(back)) return null; // lexical escape
    let real: string;
    try {
      real = fs.realpathSync(abs);
    } catch {
      return null; // missing / unreadable / broken symlink
    }
    const realBack = path.relative(realRoot, real);
    if (realBack.startsWith('..') || path.isAbsolute(realBack)) return null; // symlink escape
    return real;
  };
  return {
    async read(rel, maxBytes) {
      const abs = within(rel);
      if (!abs) return null;
      try {
        if (!fs.statSync(abs).isFile()) return null;
        if (maxBytes === undefined) return fs.readFileSync(abs, 'utf8');
        // Bounded read: pull at most maxBytes bytes off disk so a multi-GB file is never
        // read whole just to be trimmed. Decode + drop a trailing partial multibyte char.
        const fd = fs.openSync(abs, 'r');
        try {
          const buf = Buffer.alloc(maxBytes);
          const n = fs.readSync(fd, buf, 0, maxBytes, 0);
          return buf.subarray(0, n).toString('utf8').replace(/�$/, '');
        } finally {
          fs.closeSync(fd);
        }
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
    async read(rel, maxBytes) {
      if (!Object.prototype.hasOwnProperty.call(fileMap, rel)) return null;
      const c = fileMap[rel];
      return maxBytes === undefined ? c : sliceBytes(c, maxBytes);
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
