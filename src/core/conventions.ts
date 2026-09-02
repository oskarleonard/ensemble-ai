import { execFileSync } from 'node:child_process';
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

// How strongly the repo asked for a file to be read — the budget is filled tier by tier.
//   0 MANDATORY: an entry file (CLAUDE.md / AGENTS.md at the root or a touched dir), a file
//     in a rules dir (.claude/rules, …), an explicitly configured path, or an `@`-include
//     reached from one of those (Claude Code reads an @-include as part of the entry file).
//   1 NAMED: a file an entry file points at — a markdown link, a "see …" prose ref, a
//     backticked path, or a file inside a backticked directory.
//   2 SWEPT: a common doc or a sweep-dir file nobody named, and anything reached only
//     through a tier-1/2 file.
export type ConventionTier = 0 | 1 | 2;

export interface ConventionFileEntry {
  path: string; // repo-relative
  bytes: number; // file size as read (bounded by the read cap — see ConventionReader.read)
  included: boolean; // its content is in `text` (fully or head-truncated)
  truncated: boolean; // head-only, because it crossed the cap
  // why it was truncated/omitted: cap · file-count ceiling · byte-identical to an earlier file
  reason?: 'over-cap' | 'max-files' | 'duplicate';
  duplicateOf?: string; // reason 'duplicate' only: the earlier path whose content this repeats
  tier?: ConventionTier; // absent only on manifests written before tiers existed
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

// Sized so a real repo's MANDATORY tier fits whole: one consumer backend's CLAUDE.md (19 KB) +
// its nine .claude/rules (57 KB) + the @-included docs/architecture.md (60 KB) is ~136 KB.
// Under the old 80 KB, run 2026-08-26-10-45-52 handed the seats 2 of those 9 rules and a
// head-slice of both big docs — while a local Claude session in that repo loads all of it.
// Consumers running a full (worktree) review pass a bigger cap (`--convention-cap`).
const DEFAULT_CAP_BYTES = 150_000;

// How far past capBytes the per-file read probes so a read-truncated file is DETECTABLE
// (see the gather loop). Must exceed the 4-byte max UTF-8 char so a trailing-partial trim
// can't mask an over-cap read; tiny vs capBytes, so no meaningful over-read.
const CAP_PROBE_MARGIN = 8;
const DEFAULT_MAX_FILES = 60;
// Per-dir convention entry files (root + every touched package dir).
const ENTRY_FILES = ['CLAUDE.md', 'AGENTS.md'];
// Single-file conventions other tools keep beside the entry files — same standing.
const ENTRY_LIKE_FILES = ['.github/copilot-instructions.md'];
// Dirs whose every *.md is a rule the repo asked reviewers to apply (MANDATORY tier), swept
// at the root + every touched dir. A CLAUDE.md typically says "review criteria are in
// `.claude/rules/`" and names at most a few of them in prose; the rest were never reached.
const RULES_DIRS = ['.claude/rules', '.cursor/rules', '.github/instructions'];
// Well-known docs swept at root + touched packages even when unlinked.
const COMMON_DOCS = ['CONTRIBUTING.md', 'ARCHITECTURE.md', 'TECH_DESIGN.md'];
// Dirs whose *.md files are swept (the discoveries/learnings suites — both spellings live).
const SWEEP_DIRS = ['docs', 'ai-spec', 'spec-ai'];

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

// Claude `@relative/path.md` imports — only at a boundary (skips emails foo@bar.md). An
// include is read as PART of the file that carries it, so it inherits that file's tier.
export function extractIncludes(content: string): string[] {
  const refs = new Set<string>();
  for (const m of content.matchAll(/(?:^|\s)@([^\s)]+\.md)/gm)) refs.add(m[1]);
  return [...refs];
}

// Every file reference a doc makes, since repos differ: (a) Claude `@` imports; (b) inline
// markdown links `[t](path.md)`; (c) prose refs `see/read <file>.md`; (d) a bare backticked
// path — `spec-ai/LEARNINGS.md` in a table cell, `.claude/rules/cross-stack-impact.md` at
// the head of a sentence. (d) exists because an entry file that bothers to name a file is
// pointing the reader at it whatever the surrounding verb; a resolved ref that does not
// exist simply never becomes a candidate, so an over-eager match costs nothing.
export function extractRefs(content: string): string[] {
  const refs = new Set<string>(extractIncludes(content));
  // (b) inline markdown links — [text](target)
  for (const m of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) refs.add(m[1]);
  // (c) prose references — "see/read/per/in <file>.md" (optionally backticked)
  for (const m of content.matchAll(/\b(?:see|read|per|in)\s+`?([\w./-]+\.md)`?/gi)) {
    refs.add(m[1]);
  }
  // (d) bare backticked paths
  for (const m of content.matchAll(/`([\w./-]+\.md)`/g)) refs.add(m[1]);
  return [...refs];
}

// A backticked DIRECTORY reference — `.claude/rules/`, `spec-ai/` — names every *.md
// directly inside it. The trailing slash is the signal; a bare word is not a directory.
export function extractDirRefs(content: string): string[] {
  const refs = new Set<string>();
  for (const m of content.matchAll(/`([\w./-]+\/)`/g)) refs.add(m[1]);
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

// The tier a reference confers on its target, given the referring file's tier: an
// @-include is read as part of its carrier (same tier); anything else is one tier weaker,
// bottoming out at SWEPT.
function tierOfRef(parent: ConventionTier, kind: 'include' | 'named'): ConventionTier {
  if (kind === 'include') return parent;
  return parent === 0 ? 1 : 2;
}

// A README describes what a directory IS, not how to write code in it — and the big ones
// are galleries and generated indexes (one consumer repo's 118 KB docs/diagrams/README.md, named
// by a rule, took a third of a 300 KB budget from the docs the rules actually cite). They
// never rise above SWEPT unless the repo pins one explicitly (`conventions` config).
function isReadme(rel: string): boolean {
  return /(^|\/)README\.md$/i.test(rel);
}

// Gather the repo's convention web reachable from the changed paths. Deterministic:
// seeds (entry files + rules dirs at each touched dir, roots first · explicit config
// paths · common-docs + sweeps) are enqueued in a fixed order, then links resolve BFS.
// Each file appears once, carries the STRONGEST tier any path to it confers, and total
// content is bounded by capBytes — filled tier by tier — with over-cap files NAMED.
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

  // rel → the strongest (lowest) tier claimed for it so far. Doubles as the dedupe set that
  // terminates any import cycle: a path is queued once, but a later, stronger claim still
  // lowers its tier — a docs/ sweep (tier 2) is enqueued before CLAUDE.md is read and found
  // to @-include the same file (tier 0), and the include must win.
  const tierOf = new Map<string, ConventionTier>();
  const queue: string[] = [];
  // Explicitly configured paths are the one way to lift a README above SWEPT.
  const explicit = new Set<string>();
  for (const c of config.conventions ?? []) {
    const rel = resolveInRepo('', c);
    if (rel) explicit.add(rel);
  }
  // The clamp applies to a NAMED or SWEPT claim only: an @-include (read as part of its
  // carrier), a rules-dir seed, and an explicit config path are the repo saying "read this".
  const clampTier = (rel: string, tier: ConventionTier, clamp: boolean): ConventionTier =>
    clamp && isReadme(rel) && !explicit.has(rel) ? 2 : tier;
  const enqueue = (rel: string | null, claimed: ConventionTier, clamp = true): void => {
    if (!rel || !rel.endsWith('.md')) return; // only markdown docs are conventions prose
    const tier = clampTier(rel, claimed, clamp);
    const prev = tierOf.get(rel);
    if (prev === undefined) {
      tierOf.set(rel, tier);
      queue.push(rel);
    } else if (tier < prev) {
      tierOf.set(rel, tier);
    }
  };
  // One listing per dir per gather: a repo's rules and entry files name the same dirs many
  // times over, and on the gh-backed reader every listing is an API call.
  const listMemo = new Map<string, Promise<string[]>>();
  const list = (dirRel: string): Promise<string[]> => {
    let p = listMemo.get(dirRel);
    if (!p) {
      p = reader.list(dirRel);
      listMemo.set(dirRel, p);
    }
    return p;
  };
  // Dequeue the STRONGEST-tier path first, so the file-count ceiling (maxFiles) is spent on
  // mandatory and named docs before swept ones — sweeps are seeded ahead of everything BFS
  // discovers from CLAUDE.md, so queue order alone would read seventy docs/*.md before a
  // tier-0 include. Stable among equals (discovery order).
  const dequeue = (): string => {
    let best = 0;
    for (let i = 1; i < queue.length; i++) {
      if ((tierOf.get(queue[i]) ?? 2) < (tierOf.get(queue[best]) ?? 2)) best = i;
    }
    return queue.splice(best, 1)[0];
  };

  // Seeds (deterministic order): per-dir entry files + rules dirs (MANDATORY), then
  // explicit config paths (MANDATORY), then common-docs + the sweep dirs' *.md (SWEPT).
  for (const d of orderedDirs) {
    for (const f of [...ENTRY_FILES, ...ENTRY_LIKE_FILES]) enqueue(joinDir(d, f), 0);
    for (const rulesDir of RULES_DIRS) {
      for (const item of await list(joinDir(d, rulesDir))) {
        enqueue(resolveInRepo('', item), 0, false);
      }
    }
  }
  for (const rel of explicit) enqueue(rel, 0, false);
  for (const d of orderedDirs) {
    for (const f of COMMON_DOCS) enqueue(joinDir(d, f), 2);
    for (const sweepDir of SWEEP_DIRS) {
      for (const item of await list(joinDir(d, sweepDir))) {
        enqueue(resolveInRepo('', item), 2);
      }
    }
  }

  // ── Phase 1 · DISCOVERY ────────────────────────────────────────────────────────────
  // Walk the doc web and hold every reachable file (bounded reads), deciding NOTHING about
  // budget yet. Splitting discovery from allocation is the fix for the starvation bug this
  // replaced: the old single pass spent the budget in DISCOVERY order, so one giant file
  // found early (a 180KB DISCOVERIES.md) consumed everything and a mandatory doc found one
  // link later (LEARNINGS.md) was omitted whole — which file got read was a lottery over
  // where in CLAUDE.md its link happened to sit.
  interface Candidate {
    rel: string;
    content: string;
    bytes: number;
    readTruncated: boolean;
  }
  const files: ConventionFileEntry[] = [];
  const candidates: Candidate[] = [];
  // The resolved references each REAL file makes, kept so tiers can be re-propagated after
  // discovery: a file whose tier is lowered by a later claim must lower its children too.
  const edges = new Map<string, { includes: string[]; named: string[] }>();
  // Byte-identical content → ONE candidate. Repos routinely ship AGENTS.md as a symlink to
  // (or copy of) CLAUDE.md; reading both spent the budget twice on the same prose. The
  // duplicate is NAMED in the manifest (honesty rule), never silently dropped. The twins are
  // remembered so the surviving candidate takes the STRONGEST tier any twin holds: a root
  // ARCHITECTURE.md (swept) that is a copy of an @-included docs/architecture.md must be
  // allocated as mandatory, whichever of the two was read first.
  const byContent = new Map<string, string>(); // content → first rel
  const twins = new Map<string, string[]>(); // first rel → its byte-identical twins
  // maxFiles bounds distinct REAL (existing) files visited — NOT speculative seed
  // candidates. Entry-file / common-doc seeds are enqueued for every touched dir before
  // we know they exist; counting those misses against the ceiling would let a deep tree
  // of absent candidates starve the real linked docs. So the cap counts reads that hit.
  let visited = 0;
  while (queue.length > 0) {
    const rel = dequeue();
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
    const tier = tierOf.get(rel) as ConventionTier;
    // Ceiling reached: a REAL (existing) file we won't process. NAME it omitted rather
    // than SILENTLY dropping it (the honesty rule — same as over-cap) — and every real file
    // still queued behind it, each confirmed with an existence probe so a speculative seed
    // for an absent file is never reported. Checked after the existence read so `visited`
    // only ever counts real files.
    if (visited >= maxFiles) {
      files.push({ path: rel, bytes, included: false, truncated: false, reason: 'max-files', tier });
      while (queue.length > 0) {
        const left = dequeue();
        const exists = await reader.read(left, 1);
        if (exists === null) continue;
        files.push({
          path: left,
          bytes: 0,
          included: false,
          truncated: false,
          reason: 'max-files',
          tier: tierOf.get(left) as ConventionTier,
        });
      }
      break;
    }
    visited++;
    // Discover transitive refs BEFORE cap decisions (an over-cap file can still link
    // to a small important one; the tier map's dedupe bounds any cycle). Duplicates too:
    // their RELATIVE refs resolve against their own dir, which may reach files the
    // original's dir does not.
    const dir = dirOf(rel);
    const includes = new Set(extractIncludes(content));
    const edge = { includes: [] as string[], named: [] as string[] };
    // A ref resolves relative to the referring file (markdown-link semantics). A prose or
    // backticked ref inside a nested doc is just as often written repo-relative
    // (`docs/x.md` from inside docs/), so it is tried both ways: a path that does not
    // exist never becomes a candidate, so the extra try costs nothing. Only an explicitly
    // relative spelling (`./x`, `../x`) is local-only — a dot-DIR (`.claude/rules/x.md`)
    // is a perfectly good repo-relative path.
    const explicitlyRelative = (ref: string): boolean => /^\.\.?\//.test(ref);
    const resolutions = (ref: string): string[] => {
      const local = resolveInRepo(dir, ref);
      const out = local ? [local] : [];
      if (dir !== '' && !explicitlyRelative(ref)) {
        const fromRoot = resolveInRepo('', ref);
        if (fromRoot && fromRoot !== local) out.push(fromRoot);
      }
      return out;
    };
    for (const ref of extractRefs(content)) {
      const kind = includes.has(ref) ? 'include' : 'named';
      for (const target of kind === 'include' ? [resolveInRepo(dir, ref)] : resolutions(ref)) {
        if (!target || !target.endsWith('.md')) continue;
        edge[kind === 'include' ? 'includes' : 'named'].push(target);
        enqueue(target, tierOfRef(tier, kind), kind !== 'include');
      }
    }
    // A backticked DIRECTORY is read repo-relative unless spelled `./`/`../`: that is how
    // docs name directories, and every listing is an API call on the gh-backed reader (a
    // backend's rules name ~50 dirs between them), so the local guess is not tried.
    for (const ref of extractDirRefs(content)) {
      const targetDir = explicitlyRelative(ref) ? resolveInRepo(dir, ref) : resolveInRepo('', ref);
      if (targetDir === null) continue;
      const listDir = targetDir.replace(/\/+$/, '');
      if (listDir === '') continue; // never sweep the root by accident
      for (const item of await list(listDir)) {
        const target = resolveInRepo('', item);
        if (!target) continue;
        edge.named.push(target);
        enqueue(target, tierOfRef(tier, 'named'));
      }
    }
    edges.set(rel, edge);

    const original = byContent.get(content);
    if (original !== undefined) {
      files.push({ path: rel, bytes, included: false, truncated: false, reason: 'duplicate', duplicateOf: original, tier });
      twins.set(original, [...(twins.get(original) ?? []), rel]);
      continue;
    }
    byContent.set(content, rel);
    candidates.push({ bytes, content, readTruncated, rel });
  }

  // Tiers to a fixpoint: a file first reached weakly and later claimed strongly had its
  // children enqueued at the weak tier; re-propagate until nothing lowers. Bounded by
  // (files × tiers), so it terminates quickly.
  for (let changed = true; changed; ) {
    changed = false;
    for (const [parent, edge] of edges) {
      const pt = tierOf.get(parent) as ConventionTier;
      const lower = (child: string, claimed: ConventionTier, clamp: boolean): void => {
        const t = clampTier(child, claimed, clamp);
        const cur = tierOf.get(child);
        if (cur !== undefined && t < cur) {
          tierOf.set(child, t);
          changed = true;
        }
      };
      for (const c of edge.includes) lower(c, tierOfRef(pt, 'include'), false);
      for (const c of edge.named) lower(c, tierOfRef(pt, 'named'), true);
    }
  }
  // A candidate's tier is the strongest across itself and its byte-identical twins.
  const tierOfRel = (rel: string): ConventionTier => {
    let t = tierOf.get(rel) ?? 2;
    for (const twin of twins.get(rel) ?? []) t = Math.min(t, tierOf.get(twin) ?? 2) as ConventionTier;
    return t;
  };
  // A duplicate / max-files entry was stamped at discovery time; restamp with the final tier.
  for (const f of files) f.tier = tierOfRel(f.path);

  // ── Phase 2 · TIERED FAIR-SHARE ALLOCATION (water-filling per tier) ───────────────
  // The MANDATORY tier competes for the whole cap first; what it leaves goes to the NAMED
  // tier, then to the SWEPT tier — so an on-call runbook linked from CLAUDE.md can never
  // squeeze a rule the repo asked reviewers to apply. Within a tier every candidate competes
  // for an equal share; a file smaller than the current share is taken WHOLE and its unused
  // share redistributes to the rest, until only over-share files remain — those split what
  // is left evenly as head-truncations. Deterministic, order-independent within a tier: no
  // file's fate depends on where its link sat. The emitted `text` carries per-file framing
  // (a header, and for a truncated file a notice) — each file's allocation must cover its
  // framing too, so the flattened text honors capBytes rather than overshooting by the sum
  // of every header.
  const noticeFor = (n: number): string =>
    `\n\n…[${n} bytes truncated — over the ${capBytes}-byte conventions cap]…\n`;
  interface Costed extends Candidate {
    header: string;
    headerBytes: number;
    tier: ConventionTier;
  }
  const costed: Costed[] = candidates.map((c) => {
    const header = fileHeader(c.rel);
    return { ...c, header, headerBytes: Buffer.byteLength(header, 'utf8'), tier: tierOfRel(c.rel) };
  });
  // rel → whole-content marker (-1) | sliced content budget | absent = omitted (over-cap)
  const allocation = new Map<string, number>();
  let remaining = capBytes;
  for (const tier of [0, 1, 2] as const) {
    let active = costed.filter((c) => c.tier === tier);
    // Take-whole rounds: each pass recomputes the equal share and admits every file whose
    // ENTIRE held content (+ header) fits it. When no file fits the equal share but the
    // budget could still hold the smallest one whole, that one is admitted and the round
    // repeats: a whole small doc beats a useless head of every doc (a 14 KB remainder over
    // eleven docs handed each a 1.2 KB head — none of them readable). Terminates: a pass
    // either admits ≥1 file or breaks.
    for (;;) {
      if (active.length === 0) break;
      const share = Math.floor(remaining / active.length);
      let fits = active.filter((c) => c.headerBytes + c.bytes <= share);
      if (fits.length === 0) {
        const smallest = active.reduce((a, b) =>
          b.headerBytes + b.bytes < a.headerBytes + a.bytes ? b : a
        );
        if (smallest.headerBytes + smallest.bytes <= remaining) fits = [smallest];
      }
      if (fits.length === 0) break;
      for (const c of fits) {
        allocation.set(c.rel, -1);
        remaining -= c.headerBytes + c.bytes;
      }
      active = active.filter((c) => !allocation.has(c.rel));
    }
    // Truncation rounds: the survivors are all bigger than the equal share, so each gets a
    // head sliced to its share (minus header + notice reserve — noticeFor(bytes) upper-bounds
    // the real notice's digit count, keeping the total ≤ capBytes). A share too small to even
    // frame a file omits it (NAMED over-cap) and its share redistributes to the rest.
    // Terminates: a pass either omits ≥1 file or allocates all and exits.
    while (active.length > 0) {
      const share = Math.floor(remaining / active.length);
      const unframeable = active.filter(
        (c) => share - c.headerBytes - Buffer.byteLength(noticeFor(c.bytes), 'utf8') <= 0
      );
      if (unframeable.length > 0) {
        // When NO file frames at the equal share, the budget must not leak past this tier
        // to a weaker one: give the whole remainder to the smallest file as one head (it
        // gets its own pass with active = [it]; if even that cannot frame, it is omitted
        // and the tier is done). Otherwise drop only the unframeable ones and redistribute.
        active =
          unframeable.length === active.length && active.length > 1
            ? [active.reduce((a, b) => (b.headerBytes + b.bytes < a.headerBytes + a.bytes ? b : a))]
            : active.filter((c) => !unframeable.includes(c));
        continue; // omitted — allocation has no entry for them
      }
      for (const c of active) {
        const contentBudget = share - c.headerBytes - Buffer.byteLength(noticeFor(c.bytes), 'utf8');
        allocation.set(c.rel, contentBudget);
        remaining -= share;
      }
      break;
    }
  }

  // ── Phase 3 · EMISSION — by tier, then discovery order, so the packet reads the rules
  // first and the seeds before what they link ─────────────────────────────────────────
  const chunks: string[] = [];
  let used = 0;
  const ordered = [...costed].sort((a, b) => a.tier - b.tier); // stable: discovery order within a tier
  for (const c of ordered) {
    const alloc = allocation.get(c.rel);
    if (alloc === undefined) {
      // No allocation could frame it → NAMED as omitted, never silently dropped.
      files.push({ path: c.rel, bytes: c.bytes, included: false, truncated: false, reason: 'over-cap', tier: c.tier });
      continue;
    }
    if (alloc === -1) {
      chunks.push(c.header + c.content);
      used += c.headerBytes + c.bytes;
      // A read-truncated file taken "whole" is still only a HEAD of the on-disk file —
      // record it truncated (never silently "complete"), same honesty rule as over-cap.
      files.push(
        c.readTruncated
          ? { path: c.rel, bytes: c.bytes, included: true, truncated: true, reason: 'over-cap', tier: c.tier }
          : { path: c.rel, bytes: c.bytes, included: true, truncated: false, tier: c.tier }
      );
      continue;
    }
    const head = sliceBytes(c.content, alloc);
    const headBytes = Buffer.byteLength(head, 'utf8');
    const notice = noticeFor(c.bytes - headBytes);
    chunks.push(`${c.header}${head}${notice}`);
    used += c.headerBytes + headBytes + Buffer.byteLength(notice, 'utf8');
    files.push({ path: c.rel, bytes: c.bytes, included: true, truncated: true, reason: 'over-cap', tier: c.tier });
  }

  // Manifest order = emission order for candidates; max-files / duplicate entries were
  // pushed at discovery time, so sort by path-stability is unnecessary — consumers key by path.
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
  // A gitignored file is NOT part of the repo's conventions, whatever links to it: it is
  // where developers keep local notes and credentials (`_localnotes/sentry-auth-token.md`,
  // reached from a discoveries doc), and the packet it would land in is sent to a vendor.
  // The gh-backed reader cannot see such files at all; this reader must match it. `git
  // check-ignore` exits 0 for an ignored path, 1 for a tracked/untracked-but-not-ignored
  // one, and 128 outside a repo — only 0 excludes, so a plain directory still reads.
  const ignoreCache = new Map<string, boolean>();
  const isIgnored = (rel: string): boolean => {
    const cached = ignoreCache.get(rel);
    if (cached !== undefined) return cached;
    let ignored = false;
    try {
      execFileSync('git', ['-C', root, 'check-ignore', '-q', '--', rel], { stdio: 'ignore' });
      ignored = true;
    } catch {
      ignored = false;
    }
    ignoreCache.set(rel, ignored);
    return ignored;
  };
  return {
    async read(rel, maxBytes) {
      const abs = within(rel);
      if (!abs || isIgnored(rel)) return null;
      try {
        if (!fs.statSync(abs).isFile()) return null;
        if (maxBytes === undefined) return fs.readFileSync(abs, 'utf8');
        // Bounded read: pull at most maxBytes bytes off disk so a multi-GB file is never
        // read whole just to be trimmed. Decode + drop a trailing partial multibyte char.
        // The buffer is sized to the file, not the cap: a cap-sized allocation per 2 KB
        // file is waste, and a cap past the allocator's limit would make every read fail.
        const fd = fs.openSync(abs, 'r');
        try {
          const want = Math.min(maxBytes, fs.fstatSync(fd).size);
          const buf = Buffer.alloc(want);
          const n = fs.readSync(fd, buf, 0, want, 0);
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
      if (!abs || isIgnored(dirRel)) return [];
      try {
        return fs
          .readdirSync(abs)
          .filter((n) => n.endsWith('.md'))
          .map((n) => joinDir(dirRel, n))
          .filter((rel) => !isIgnored(rel));
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
