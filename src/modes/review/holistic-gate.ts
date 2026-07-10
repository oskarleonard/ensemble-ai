import fs from 'node:fs';
import path from 'node:path';

import { escapesRoot } from '../../core/artifacts';
import { SEVERITIES, type Severity } from '../../core/types';

import type { DowngradeReason, GateVerdictRecord } from './gate';
import { HOLISTIC_SEAT_ID, HOLISTIC_SEVERITY_CAP } from './holistic';

// THE HOLISTIC GATE POLICY — every guardrail spec §4 states, as CODE the host runs, never as a
// request the lens is trusted to honor. Three rules, three mechanisms:
//
//  1. BOTH SITES OR IT DOES NOT POST (spec §5). A holistic `agree` must quote the reinvention in
//     the diff AND the existing pattern's home, each at `file:line@headSha`. The host re-reads
//     both out of the worktree and matches the quotes itself. A site it cannot locate is
//     `reference-not-found` — the same hallucinated-reference cause the gate already emits, which
//     is sound here precisely because the lens only ever runs on worktree evidence.
//  2. AGREE-ONLY POSTING (spec §4). A `partial` holistic finding ("a kind-of-similar pattern
//     exists") is noise on someone else's PR. It stays in the trail; it never posts.
//  3. THE MED CAP IS LIFTED BY A CITATION, NEVER BY AN ASSERTION (gate-r2/r3 pin). Severity is
//     clamped to `medium` unless the verdict carries a citation of a CONVENTIONS DOC that the
//     host finds, verbatim, at `headSha`. The lens cannot self-authorize its own uncap: this
//     function never reads the model's opinion of importance, only whether a quote is really there.
//
// Everything here is PURE apart from the injected `readAtHead` reader (see `worktreeReader`).

// Same bar as gate.ts's `validateCitation` (MIN_ANCHOR_NONWS = 16): a quoted line must carry ≥16
// non-whitespace chars to anchor anything — `}` and short idioms prove nothing. Re-declared rather
// than imported so this module stays free of a runtime import cycle with gate.ts; a test pins the
// two constants equal.
export const HOLISTIC_MIN_ANCHOR_NONWS = 16;

// How far the cited line may sit from the matched quote span. A model quoting a function's first
// three lines and citing its declaration line lands inside the span; ±2 absorbs an off-by-one on
// a decorator or a wrapped signature without letting a citation float free of what it quoted.
const HOLISTIC_LINE_SLACK = 2;

const MAX_QUOTE_CHARS = 2000;
const MAX_FILE_BYTES = 1_048_576;
const MAX_FILE_LINES = 20_000;

// ── The site + citation wire shapes ───────────────────────────────────────────────────

const HOLISTIC_SITE_ROLES = ['diff', 'pattern'] as const;
export type HolisticSiteRole = (typeof HOLISTIC_SITE_ROLES)[number];

export interface HolisticSite {
  file: string;
  line: number;
  quote: string;
  role: HolisticSiteRole;
}

export interface ConventionCitation {
  file: string;
  line: number;
  quote: string;
}

// The holistic fields of one raw gate verdict entry, already parsed + bounded.
export interface HolisticEntry {
  conventionCitation?: ConventionCitation;
  sites?: HolisticSite[];
}

// Single-seat provenance, recorded on every holistic record so no consumer can mistake it for a
// corroborated finding. `cluster` is never set on these (see gate-dedup) — they are ONE seat.
export interface HolisticProvenance {
  // The lens's own severity before the host clamped it. Absent ⇒ nothing was clamped.
  cappedFrom?: Severity;
  lens: typeof HOLISTIC_SEAT_ID;
  singleSeat: true;
  // The gate-verified conventions citation that lifted the MED cap. Absent ⇒ the cap held.
  uncapCitation?: ConventionCitation;
  // Both sites, verified verbatim at headSha. Absent ⇒ verification did not pass.
  verifiedSites?: HolisticSite[];
}

function nonEmptyStr(v: unknown, cap: number): string | null {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : null;
}

function posInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null;
}

// Parse `sites` off an untrusted verdict entry. Anything malformed simply drops out — a dropped
// site fails the two-site requirement below, which is the fail-closed outcome we want.
export function parseHolisticSites(v: unknown): HolisticSite[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: HolisticSite[] = [];
  for (const raw of v.slice(0, 8)) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const file = nonEmptyStr(e.file, 500);
    const line = posInt(e.line);
    const quote = nonEmptyStr(e.quote, MAX_QUOTE_CHARS);
    const role = HOLISTIC_SITE_ROLES.find((r) => r === e.role);
    if (file && line && quote && role) out.push({ file, line, quote, role });
  }
  return out.length > 0 ? out : undefined;
}

export function parseConventionCitation(v: unknown): ConventionCitation | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const e = v as Record<string, unknown>;
  const file = nonEmptyStr(e.file, 500);
  const line = posInt(e.line);
  const quote = nonEmptyStr(e.quote, MAX_QUOTE_CHARS);
  return file && line && quote ? { file, line, quote } : undefined;
}

// ── Reading the tree at headSha ───────────────────────────────────────────────────────

// Returns the file's lines, or null when it cannot be read as one. The reader is the ONLY I/O in
// the holistic policy; injecting it keeps every rule above unit-testable against a real fixture
// tree without a live model or a live git repo.
export type SiteReader = (file: string) => string[] | null;

// A reader fenced to ONE worktree. The tree is untrusted PR content, so containment is checked on
// the REALPATH: a symlink planted at `docs/CONVENTIONS.md → ~/.ssh/id_ed25519` must not let a
// crafted "citation" quote a secret into gate-verdicts.json, the trail, or a posted comment.
// Containment uses the trail's own `escapesRoot`, so the path-escape rule cannot drift between
// the writer and this reader; the extra `!rel` guard rejects the worktree root itself.
export function worktreeReader(worktreeDir: string): SiteReader {
  let root: string;
  try {
    root = fs.realpathSync(path.resolve(worktreeDir));
  } catch {
    return () => null; // no worktree ⇒ nothing verifies (fail closed)
  }
  const inside = (p: string): boolean => {
    const rel = path.relative(root, p);
    return rel !== '' && !escapesRoot(rel);
  };
  return (file: string): string[] | null => {
    try {
      if (!file || file.includes('\0') || path.isAbsolute(file)) return null;
      const target = path.resolve(root, file);
      if (!inside(target)) return null;
      const real = fs.realpathSync(target);
      if (!inside(real)) return null; // symlink escape
      const st = fs.statSync(real);
      if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
      return fs.readFileSync(real, 'utf8').split(/\r?\n/).slice(0, MAX_FILE_LINES);
    } catch {
      return null;
    }
  };
}

// ── Quote matching ────────────────────────────────────────────────────────────────────

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();
const nonWsLen = (s: string): number => s.replace(/\s/g, '').length;

// Find the 1-based [start, end] line span where `quote` appears as a run of consecutive COMPLETE
// lines (whitespace-normalized). Complete-line matching is what makes the anchor meaningful: a
// substring match would let `return null;` "verify" a citation anywhere in the file.
export function findQuoteSpan(
  lines: string[],
  quote: string
): { end: number; start: number } | null {
  const want = quote.split(/\r?\n/).map(norm).filter(Boolean);
  if (want.length === 0) return null;
  if (!want.some((l) => nonWsLen(l) >= HOLISTIC_MIN_ANCHOR_NONWS)) return null;
  const hay = lines.map(norm);
  for (let i = 0; i + want.length <= hay.length; i++) {
    let hit = true;
    for (let j = 0; j < want.length; j++) {
      if (hay[i + j] !== want[j]) {
        hit = false;
        break;
      }
    }
    if (hit) return { end: i + want.length, start: i + 1 };
  }
  return null;
}

export type SiteCheck = { ok: true } | { ok: false; reason: string };

// Verify one `file:line@headSha` + quote against the tree. Two independent facts must hold: the
// quoted lines EXIST verbatim, and the cited line is where they live (±HOLISTIC_LINE_SLACK).
export function verifySiteAtHead(
  site: { file: string; line: number; quote: string },
  read: SiteReader
): SiteCheck {
  const lines = read(site.file);
  if (!lines) return { ok: false, reason: `${site.file} is not a readable file in the reviewed tree` };
  const span = findQuoteSpan(lines, site.quote);
  if (!span)
    return {
      ok: false,
      reason: `the quoted line(s) do not appear verbatim in ${site.file} (or carry no ≥${HOLISTIC_MIN_ANCHOR_NONWS}-non-whitespace-char anchor line)`,
    };
  if (site.line < span.start - HOLISTIC_LINE_SLACK || site.line > span.end + HOLISTIC_LINE_SLACK)
    return {
      ok: false,
      reason: `${site.file}:${site.line} is not where that quote lives (found at ${span.start}-${span.end})`,
    };
  return { ok: true };
}

// ── The conventions-doc predicate (the ONLY thing that may uncap) ─────────────────────

// A conventions doc is either one the run actually GATHERED (the conventions manifest — the real
// answer, supplied by the consumer) or one of the canonical filenames. Both are checked against
// the path as the lens cited it, normalized. A README is deliberately NOT a conventions doc.
const CANONICAL_CONVENTION_FILES = [
  'agents.md',
  'claude.md',
  'contributing.md',
  'conventions.md',
  'style-guide.md',
  'styleguide.md',
];

export function isConventionsDoc(file: string, gathered?: readonly string[]): boolean {
  const rel = file.replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase();
  if (gathered?.some((g) => g.replace(/^\.\//, '').replace(/\\/g, '/').toLowerCase() === rel))
    return true;
  return CANONICAL_CONVENTION_FILES.includes(rel.split('/').pop() ?? '');
}

// ── The policy ────────────────────────────────────────────────────────────────────────

export interface HolisticPolicyDeps {
  // Repo-relative conventions files this run gathered (the packet's own manifest). Additive to
  // the canonical filenames — a project may name its doc anything and declare it in config.
  conventionPaths?: readonly string[];
  // The files present in the pinned diff. The reinvention MUST be cited inside the change.
  diffFiles: ReadonlySet<string>;
  // Reads the reviewed tree at headSha. Built by `worktreeReader`.
  readAtHead: SiteReader;
}

export function isHolisticRecord(r: { reviewer: string }): boolean {
  return r.reviewer === HOLISTIC_SEAT_ID;
}

function capSeverity(s: Severity): Severity {
  return SEVERITIES.indexOf(s) < SEVERITIES.indexOf(HOLISTIC_SEVERITY_CAP) ? HOLISTIC_SEVERITY_CAP : s;
}

const notPostable = (note: string) =>
  ({ postableBody: null, postableFix: null, postableNote: note, postableStatus: 'not-postable' as const, rescoredSeverity: null });

const downgrade = (
  r: GateVerdictRecord,
  downgradeReason: DowngradeReason,
  reason: string
): GateVerdictRecord => ({
  ...r,
  ...notPostable(reason),
  downgradeReason,
  effectiveVerdict: 'unverified',
  reason,
});

// Validate an `agree`'s two sites. Exactly one `diff` site (inside the change) and one `pattern`
// site (the existing pattern's home), at different places, both quoted verbatim at headSha.
function checkSites(
  sites: HolisticSite[] | undefined,
  deps: HolisticPolicyDeps
): { ok: true; sites: HolisticSite[] } | { cause: DowngradeReason; ok: false; reason: string } {
  const diff = sites?.filter((s) => s.role === 'diff') ?? [];
  const pattern = sites?.filter((s) => s.role === 'pattern') ?? [];
  if (diff.length !== 1 || pattern.length !== 1)
    return {
      cause: 'invalid-citation',
      ok: false,
      reason: 'a holistic agree must quote BOTH sites — exactly one "diff" site (the reinvention in this PR) and one "pattern" site (the existing pattern\'s home)',
    };
  const [d] = diff;
  const [p] = pattern;
  if (!deps.diffFiles.has(d.file))
    return {
      cause: 'invalid-citation',
      ok: false,
      reason: `the "diff" site ${d.file} is not a file this PR changes — the reinvention must be cited inside the change`,
    };
  if (d.file === p.file && d.line === p.line)
    return { cause: 'invalid-citation', ok: false, reason: 'both sites point at the same line — a pattern cannot reinvent itself' };
  for (const [role, site] of [['diff', d], ['pattern', p]] as const) {
    const check = verifySiteAtHead(site, deps.readAtHead);
    if (!check.ok)
      return { cause: 'reference-not-found', ok: false, reason: `the ${role} site could not be verified at headSha — ${check.reason}` };
  }
  return { ok: true, sites: [d, p] };
}

// Apply the holistic policy to a reconciled record set. Non-holistic records pass through
// UNTOUCHED (byte-identical), so the lens-off path — and every packet-mode run — is unchanged.
// `deps: null` means the run has no worktree evidence: any holistic record present then is
// fail-closed to unverified, because its two sites cannot be checked against anything.
export function applyHolisticPolicy(
  records: GateVerdictRecord[],
  entryById: ReadonlyMap<string, HolisticEntry | undefined>,
  deps: HolisticPolicyDeps | null
): GateVerdictRecord[] {
  return records.map((r) => {
    if (!isHolisticRecord(r)) return r;
    const entry = entryById.get(r.findingId);

    // The MED cap, and the ONE thing that lifts it: a conventions-doc citation the host itself
    // locates at headSha. Computed before the verdict branches so the provenance records the
    // truth either way (a verified citation on a finding the gate then downgraded still says so).
    const cit = entry?.conventionCitation;
    const uncapped = Boolean(
      deps &&
        cit &&
        isConventionsDoc(cit.file, deps.conventionPaths) &&
        verifySiteAtHead(cit, deps.readAtHead).ok
    );
    const severity = uncapped ? r.severity : capSeverity(r.severity);
    const holistic: HolisticProvenance = {
      lens: HOLISTIC_SEAT_ID,
      singleSeat: true,
      ...(severity !== r.severity ? { cappedFrom: r.severity } : {}),
      ...(uncapped && cit ? { uncapCitation: cit } : {}),
    };
    const based = { ...r, holistic, severity };

    if (!deps)
      return downgrade(
        based,
        'invalid-citation',
        'a holistic finding cannot be verified without worktree evidence — the lens must not run on packet evidence'
      );

    if (based.effectiveVerdict !== 'agree') {
      // Agree-only posting. The verdict itself is preserved (the trail stays honest); only the
      // POSTABLE decision changes: a "kind-of-similar pattern exists" never crosses to a PR.
      return {
        ...based,
        ...notPostable(
          `the holistic lens posts agree-only — a "${based.effectiveVerdict}" architecture claim is not grounded enough to put on someone else's PR`
        ),
      };
    }

    const sites = checkSites(entry?.sites, deps);
    if (!sites.ok) return downgrade(based, sites.cause, sites.reason);
    // An `agree` that already failed the postable derivation (e.g. it carried edit-ops) stays
    // escalated — this policy only ever REMOVES posting authority, never grants it.
    return { ...based, holistic: { ...holistic, verifiedSites: sites.sites } };
  });
}
