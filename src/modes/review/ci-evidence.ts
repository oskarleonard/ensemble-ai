import { scanTextForSecrets } from './secret-scan';
import type { GhRunner } from './stage';

// CI EVIDENCE — the head commit's check runs, their annotations, and its commit statuses, fetched
// by the ENGINE through `gh` and handed to every seat as DATA in the packet.
//
// WHY (incident 2026-08-10): the worst defect of a reviewed change — a migration no database
// accepts — was printed VERBATIM in a GREEN CI job. The validation step executed it, got the
// error, and downgraded it to a `::warning`. Every reviewer read the SQL as text while the
// machine's own execution result sat unread in a passing job. Reading a green job's warnings is
// exactly the cheap, mechanical evidence a seat never gathers on its own.
//
// TRUST. Check output is repo-CI text: the same class as the diff and the PR description the seats
// already receive — bytes the seat reads, never orders it takes. The rendered text still passes the
// engine's inline credential patterns; any hit WITHHOLDS the whole section (loudly).
//
// BEST-EFFORT. A `gh` failure degrades to `{ ok: false, error }`; the caller renders a named
// UNAVAILABLE section and one stderr line. Nothing here throws.

export interface CiEvidenceLimits {
  // At most this many checks get their annotations fetched (failure/warning-bearing first).
  maxAnnotationChecks: number;
  maxAnnotationsPerCheck: number;
  // Structural cap on the rendered text — the packet section's own budget is the last resort.
  maxChars: number;
}

export const CI_EVIDENCE_LIMITS: CiEvidenceLimits = {
  maxAnnotationChecks: 10,
  maxAnnotationsPerCheck: 25,
  maxChars: 14_000,
};

export const CI_EVIDENCE_TRAIL_FILE = 'ci-evidence.md';

export interface CiEvidenceInput {
  gh: GhRunner;
  // The PR head. Absent ⇒ one `gh pr view` resolves it.
  headSha?: string;
  limits?: Partial<CiEvidenceLimits>;
  pr: number;
  repoSlug: string;
}

export type CiEvidenceResult =
  | {
      annotations: number;
      checks: number;
      failed: number;
      headSha: string;
      ok: true;
      text: string;
      truncated: boolean;
    }
  | { error: string; ok: false };

// The API's documented shapes. Declared for readability — NOTHING here is trusted at runtime:
// every field is read back through the coercions below, because a payload is whatever `gh`
// actually returned (a proxy's error envelope, a future schema, an empty object).
interface CheckRun {
  app?: { slug?: string | null } | null;
  conclusion: string | null;
  details_url?: string | null;
  id: number;
  name: string;
  output?: { annotations_count?: number; summary?: string | null; title?: string | null } | null;
  status: string;
}

interface Annotation {
  annotation_level: string;
  message: string;
  path: string;
  raw_details?: string | null;
  start_line: number;
  title?: string | null;
}

interface CommitStatus {
  context: string;
  description?: string | null;
  state: string;
  target_url?: string | null;
}

// SHAPE COERCIONS. `ghJson` guards the PARSE; these guard the SHAPE. Anything the API hands
// back that is not what the type claims becomes an empty value plus a note in the text — never
// a thrown TypeError out of a function whose whole contract is best-effort.
const asArray = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);
const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const isArrayish = (v: unknown): boolean => v === undefined || v === null || Array.isArray(v);

const UNEXPECTED_SHAPE = 'unexpected payload shape';

// `gh <args>` → parsed JSON, or a named error. Never throws.
function ghJson<T>(gh: GhRunner, args: string[]): { ok: true; value: T } | { error: string; ok: false } {
  const res = gh(args);
  if (!res.ok) return { error: res.error, ok: false };
  try {
    return { ok: true, value: JSON.parse(res.text) as T };
  } catch {
    return { error: `gh returned unparseable JSON for \`gh ${args.join(' ')}\``, ok: false };
  }
}

// Failed/attention-needing first, then inconclusive, then pending, then green. Only the exact
// string `success` earns the green tier: a conclusion GitHub adds after this was written is
// INCONCLUSIVE (tier 1), so it keeps its summary instead of being filed away as a passing job.
const FAILED = new Set(['action_required', 'failure', 'startup_failure', 'timed_out']);
const SUCCESS_RANK = 3;
function conclusionRank(c: CheckRun): number {
  const conclusion = typeof c.conclusion === 'string' ? c.conclusion : null;
  if (conclusion && FAILED.has(conclusion)) return 0;
  if (conclusion === 'success') return SUCCESS_RANK;
  if (!conclusion) return 2;
  return 1;
}

// Any JSON value → one trimmed, length-capped line. Coerces rather than assuming a string:
// `.replace` on a number the API sent where a string was documented would throw.
const oneLine = (s: unknown, max: number): string =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

const label = (c: CheckRun): string => oneLine(c.conclusion ?? c.status ?? 'unknown', 40).toLowerCase();
const name = (c: CheckRun): string => oneLine(c.name, 200) || '(unnamed check)';
const output = (c: CheckRun): Record<string, unknown> => asRecord(c.output);
const annotationsCount = (c: CheckRun): number => {
  const n = output(c).annotations_count;
  return typeof n === 'number' && Number.isFinite(n) ? n : 0;
};

// `gh`'s own stderr can echo the credential it just failed to authenticate with. Error strings
// leave this module (to the trail file, to stderr, to the packet's UNAVAILABLE note), so they
// get the same inline-credential scan as the rendered evidence.
const safe = (s: string): string => {
  const hit = scanTextForSecrets(s);
  return hit ? `[redacted: ${hit.label}]` : s;
};

// One candidate block of rendered lines, admitted to the text as a UNIT (an annotation block is
// its heading plus its own annotation lines — half a block is not evidence).
interface Item {
  // Annotation lines this item renders — the only source of the reported annotation count.
  annotations: number;
  // Annotations of the same check this item does NOT render (per-check cap or per_page).
  annotationsBehind: number;
  lines: string[];
}

// A line costs its own length plus the newline that joins it.
const cost = (lines: readonly string[]): number => lines.reduce((n, l) => n + l.length + 1, 0);

// Room held back so the bookkeeping lines the selection itself causes still fit inside
// `maxChars` — three sections can each end in one `… N more … not shown` line.
const OMISSION_LINE_RESERVE = 80;
const OMISSION_LINE_KINDS = 3;

const ANNOTATIONS_HEADING = '## Annotations (the checks\' own remarks on this head — level, then path:line)';

export function fetchCiEvidence(input: CiEvidenceInput): CiEvidenceResult {
  const limits = { ...CI_EVIDENCE_LIMITS, ...(input.limits ?? {}) };
  const { gh, repoSlug } = input;

  let headSha = input.headSha;
  if (!headSha) {
    const head = ghJson<unknown>(gh, ['pr', 'view', String(input.pr), '-R', repoSlug, '--json', 'headRefOid']);
    if (!head.ok) return { error: `head SHA unavailable: ${safe(head.error)}`, ok: false };
    const oid = asRecord(head.value).headRefOid;
    if (typeof oid !== 'string' || !oid) {
      return { error: 'head SHA unavailable: `gh pr view` returned no headRefOid', ok: false };
    }
    headSha = oid;
  }

  const runs = ghJson<unknown>(gh, ['api', `repos/${repoSlug}/commits/${headSha}/check-runs?per_page=100`]);
  if (!runs.ok) return { error: `check runs unavailable: ${safe(runs.error)}`, ok: false };
  const rawChecks = asRecord(runs.value).check_runs;
  const checks = asArray<CheckRun>(rawChecks).sort(
    // `localeCompare` with an explicit locale: the sort order of the evidence a reviewer reads
    // must not depend on the machine that gathered it.
    (a, b) => conclusionRank(a) - conclusionRank(b) || name(a).localeCompare(name(b), 'en')
  );
  const failed = checks.filter((c) => conclusionRank(c) === 0).length;
  const pending = checks.filter((c) => conclusionRank(c) === 2).length;
  const success = checks.filter((c) => conclusionRank(c) === SUCCESS_RANK).length;

  // ── Check runs ───────────────────────────────────────────────────────────────────────
  const rowFor = (c: CheckRun): Item => {
    const app = oneLine(asRecord(c.app).slug, 60);
    const title = oneLine(output(c).title, 120);
    const url = oneLine(c.details_url, 300);
    const lines = [
      `- ${label(c)} · ${name(c)}${app ? ` (${app})` : ''}${title ? ` — ${title}` : ''}${url ? ` — ${url}` : ''}`,
    ];
    const summary = oneLine(output(c).summary, 500);
    if (conclusionRank(c) !== SUCCESS_RANK && summary) lines.push(`  summary: ${summary}`);
    return { annotations: 0, annotationsBehind: 0, lines };
  };
  const failingRows = checks.filter((c) => conclusionRank(c) !== SUCCESS_RANK).map(rowFor);
  const successRows = checks.filter((c) => conclusionRank(c) === SUCCESS_RANK).map(rowFor);
  const checkRunsNote = !isArrayish(rawChecks)
    ? `(check runs unavailable: ${UNEXPECTED_SHAPE})`
    : checks.length === 0
      ? '(no check runs on this commit)'
      : '';

  // ── Annotations (failure/warning-bearing checks first) ──────────────────────────────
  const annotatedAll = checks.filter((c) => annotationsCount(c) > 0);
  const annotated = annotatedAll.slice(0, Math.max(0, limits.maxAnnotationChecks));
  const notFetched = annotatedAll.length - annotated.length;

  const blocks: Item[] = [];
  for (const c of annotated) {
    const lines = [`### ${name(c)} (${label(c)})`];
    const res = ghJson<unknown>(gh, [
      'api',
      `repos/${repoSlug}/check-runs/${oneLine(c.id, 40)}/annotations?per_page=50`,
    ]);
    if (!res.ok || !Array.isArray(res.value)) {
      lines.push(`- annotations unavailable: ${res.ok ? UNEXPECTED_SHAPE : safe(oneLine(res.error, 200))}`);
      blocks.push({ annotations: 0, annotationsBehind: 0, lines });
      continue;
    }
    const all = asArray<Annotation>(res.value);
    const shown = all.slice(0, Math.max(0, limits.maxAnnotationsPerCheck));
    // The response itself is per_page-capped, so its length is a FLOOR on how many exist; the
    // check's own annotations_count is the real denominator.
    const behind = Math.max(0, Math.max(annotationsCount(c), all.length) - shown.length);
    for (const raw of shown) {
      const a = asRecord(raw);
      const title = oneLine(a.title, 120);
      const where = `[${oneLine(a.annotation_level, 40) || 'note'}] ${oneLine(a.path, 300)}:${oneLine(a.start_line, 20)}`;
      lines.push(`- ${where}${title && title !== name(c) ? ` — ${title}` : ''} — ${oneLine(a.message, 600)}`);
      const details = oneLine(a.raw_details, 300);
      if (details) lines.push(`  details: ${details}`);
    }
    if (behind > 0) lines.push(`… ${behind} more annotation(s) not shown`);
    blocks.push({ annotations: shown.length, annotationsBehind: behind, lines });
  }

  // ── Commit statuses (legacy API — bots post here) ───────────────────────────────────
  const st = ghJson<unknown>(gh, ['api', `repos/${repoSlug}/commits/${headSha}/status`]);
  const rawStatuses = st.ok ? asRecord(st.value).statuses : undefined;
  const statusRows: Item[] = asArray<CommitStatus>(rawStatuses).map((raw) => {
    const s = asRecord(raw);
    const desc = oneLine(s.description, 200);
    const url = oneLine(s.target_url, 300);
    return {
      annotations: 0,
      annotationsBehind: 0,
      lines: [
        `- ${oneLine(s.state, 40) || 'unknown'} · ${oneLine(s.context, 200) || '(unnamed status)'}${desc ? ` — ${desc}` : ''}${url ? ` (${url})` : ''}`,
      ],
    };
  });
  const statusNote = !st.ok
    ? `(statuses unavailable: ${safe(oneLine(st.error, 200))})`
    : !isArrayish(rawStatuses)
      ? `(statuses unavailable: ${UNEXPECTED_SHAPE})`
      : statusRows.length === 0
        ? '(none)'
        : '';

  // ── Selection under maxChars: by PRIORITY, then rendered in canonical order ──────────
  // A tail-slice keeps whatever the renderer happened to emit first — the green rows — and
  // drops the last section, which is exactly the annotation this module exists to surface
  // (incident 2026-08-10). So each item is admitted on what it is WORTH: annotation blocks,
  // then the checks that failed, then the statuses, then the green rows.
  const headerLine = (annotations: number): string =>
    `Check runs: ${checks.length} total · ${failed} failed · ${success} success · ${pending} pending · ${annotations} annotation(s) shown`;
  const notFetchedLine = `… ${notFetched} annotated check(s) not fetched (cap: maxAnnotationChecks)`;
  // Charged up front: the header (at its longest — every block kept) and every heading/note
  // that is always rendered. Only what is left over is up for selection.
  let used = cost([
    `Head commit: ${headSha}`,
    headerLine(blocks.reduce((n, b) => n + b.annotations, 0)),
    '',
    '## Check runs',
    ...(checkRunsNote ? [checkRunsNote] : []),
    '',
    ANNOTATIONS_HEADING,
    ...(notFetched > 0 ? [notFetchedLine] : []),
    ...(blocks.length === 0 ? ['(no annotations)'] : []),
    '',
    '## Commit statuses',
    ...(statusNote ? [statusNote] : []),
  ]);
  // What is left after the always-rendered scaffolding and the reserve. If even that scaffolding
  // overruns `maxChars` (a budget smaller than a header) nothing is admitted — the caller's cap
  // is a budget for evidence, not a licence to render a document with no head.
  const budget = limits.maxChars - OMISSION_LINE_RESERVE * OMISSION_LINE_KINDS;
  // Greedy, in priority order: each call spends from the shared `used` running total.
  const keep = (items: Item[]): Item[] =>
    items.filter((item) => {
      if (used + cost(item.lines) > budget) return false;
      used += cost(item.lines);
      return true;
    });
  const keptBlocks = keep(blocks);
  const keptFailing = keep(failingRows);
  const keptStatuses = keep(statusRows);
  const keptSuccess = keep(successRows);

  const kept = new Set(keptBlocks);
  const droppedAnnotations = blocks
    .filter((b) => !kept.has(b))
    .reduce((n, b) => n + b.annotations + b.annotationsBehind, 0);
  const omittedChecks = failingRows.length + successRows.length - keptFailing.length - keptSuccess.length;
  const omittedStatuses = statusRows.length - keptStatuses.length;
  const shownAnnotations = keptBlocks.reduce((n, b) => n + b.annotations, 0);
  const behindShown = keptBlocks.reduce((n, b) => n + b.annotationsBehind, 0);
  const truncated =
    notFetched > 0 || behindShown > 0 || droppedAnnotations > 0 || omittedChecks > 0 || omittedStatuses > 0;

  const text = [
    `Head commit: ${headSha}`,
    headerLine(shownAnnotations),
    '',
    '## Check runs',
    ...(checkRunsNote ? [checkRunsNote] : []),
    ...keptFailing.flatMap((i) => i.lines),
    ...keptSuccess.flatMap((i) => i.lines),
    ...(omittedChecks > 0 ? [`… ${omittedChecks} more check run(s) not shown`] : []),
    '',
    ANNOTATIONS_HEADING,
    ...keptBlocks.flatMap((i) => i.lines),
    ...(notFetched > 0 ? [notFetchedLine] : []),
    ...(droppedAnnotations > 0 ? [`… ${droppedAnnotations} more annotation(s) not shown`] : []),
    ...(blocks.length === 0 && notFetched === 0 ? ['(no annotations)'] : []),
    '',
    '## Commit statuses',
    ...(statusNote ? [statusNote] : []),
    ...keptStatuses.flatMap((i) => i.lines),
    ...(omittedStatuses > 0 ? [`… ${omittedStatuses} more status(es) not shown`] : []),
  ].join('\n');

  const secret = scanTextForSecrets(text);
  if (secret) {
    return {
      error: `withheld: an inline credential pattern (${secret.label}) appeared in check output`,
      ok: false,
    };
  }
  return { annotations: shownAnnotations, checks: checks.length, failed, headSha, ok: true, text, truncated };
}
