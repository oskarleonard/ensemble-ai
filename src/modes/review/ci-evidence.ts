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
  // At most this many checks get their annotations fetched. The slots are shared round-robin
  // between the non-green checks and the green ones (non-green first), so a cap never spends
  // itself entirely on failures and leaves a passing job's annotations unread.
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
const isRecord = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v);
const asRecord = (v: unknown): Record<string, unknown> => (isRecord(v) ? (v as Record<string, unknown>) : {});

const UNEXPECTED_SHAPE = 'unexpected payload shape';

// A commit id, and nothing else: sha1 (40 hex) or sha256 (64 hex).
const COMMIT_SHA = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

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
const INCONCLUSIVE_RANK = 1;
const SUCCESS_RANK = 3;
function conclusionRank(c: CheckRun): number {
  const conclusion = typeof c.conclusion === 'string' ? c.conclusion : null;
  if (conclusion && FAILED.has(conclusion)) return 0;
  if (conclusion === 'success') return SUCCESS_RANK;
  if (!conclusion) return 2;
  return INCONCLUSIVE_RANK;
}

// Any JSON value → one trimmed, length-capped line. Only the JSON SCALARS render: `String(v)` on
// an object throws when the payload defines away its own primitive conversion (`{ toString: null,
// valueOf: null }` survives a JSON round-trip), and an object rendered as `[object Object]` was
// never evidence anyway — so a non-scalar is absent, not an exception out of a best-effort path.
const oneLine = (v: unknown, max: number): string =>
  (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

// A URL is rendered only when it IS one: an http(s) address, with its query string and fragment
// dropped. A check's `details_url` is a pointer for the human reading the review, and the payload
// is whatever `gh` returned — a `javascript:`/`data:` scheme is not a check page, and a query
// string on a CI link routinely carries a signed token nobody needs in the packet.
const httpUrl = (v: unknown, max: number): string => {
  const bare = (typeof v === 'string' ? v : '').trim().split(/[?#]/)[0];
  return bare.startsWith('http://') || bare.startsWith('https://') ? oneLine(bare, max) : '';
};

const label = (c: CheckRun): string =>
  oneLine(c.conclusion ?? c.status ?? 'unknown', 40).toLowerCase() || 'unknown';
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

// One candidate row, admitted to the text as a UNIT (a check row plus its summary line; one
// commit status). Half a row is not evidence.
interface Item {
  lines: string[];
}

// One check's annotations. Unlike a row, a block is admitted PARTIALLY: a check that annotates
// verbosely can cost more than the whole budget on its own (25 × ~1 KB), and dropping it whole
// would strand the budget and lose exactly the evidence this module exists for.
interface AnnotationBlock {
  heading: string;
  // The check's TRUE annotation total — its own annotations_count, floored by the response
  // length. The denominator of the block's `… N more annotation(s) not shown`. Zero for a
  // block that could not be fetched: its note is the trace, a count would be a guess.
  knownTotal: number;
  // `- annotations unavailable: …` in place of any units.
  note: string;
  // One entry per annotation: its `- […]` line plus its optional `details:` line, kept
  // together — a line of detail without the annotation it details is noise.
  units: string[][];
}

// A line costs its own length plus the newline that joins it.
const cost = (lines: readonly string[]): number => lines.reduce((n, l) => n + l.length + 1, 0);

// Room held back so the bookkeeping lines the selection itself causes still fit inside
// `maxChars` — four section-level ones (check runs not shown, check runs the API page cap left
// unfetched, annotated checks not shown, statuses not shown). A block's own `… N more
// annotation(s) …` line is charged to the block.
const OMISSION_LINE_RESERVE = 80;
const OMISSION_LINE_KINDS = 4;

const ANNOTATIONS_HEADING = '## Annotations (the checks\' own remarks on this head — level, then path:line)';

export function fetchCiEvidence(input: CiEvidenceInput): CiEvidenceResult {
  const limits = { ...CI_EVIDENCE_LIMITS, ...(input.limits ?? {}) };
  const { gh, repoSlug } = input;

  let headSha = input.headSha;
  if (!headSha) {
    const head = ghJson<unknown>(gh, ['pr', 'view', String(input.pr), '-R', repoSlug, '--json', 'headRefOid']);
    if (!head.ok) return { error: `head SHA unavailable: ${safe(oneLine(head.error, 200))}`, ok: false };
    const oid = asRecord(head.value).headRefOid;
    if (typeof oid !== 'string' || !oid) {
      return { error: 'head SHA unavailable: `gh pr view` returned no headRefOid', ok: false };
    }
    headSha = oid;
  }
  // The head SHA is interpolated into `gh api` PATHS (check-runs, /status) and it arrives either
  // from the caller or from a payload — so it is admitted only as what a commit id is: 40 hex
  // (sha1) or 64 hex (sha256). Anything else is junk or a path fragment, and neither is a commit
  // to ask the API about. Rejected HERE, before the first call that interpolates it.
  if (!COMMIT_SHA.test(headSha)) {
    return { error: 'head SHA rejected: not a 40/64-hex commit SHA', ok: false };
  }
  // Whether the caller PINNED the head or we resolved it just now. The difference is the
  // reviewer's to know, not ours to hide — see the head line below.
  const headResolved = !input.headSha;

  const runs = ghJson<unknown>(gh, ['api', `repos/${repoSlug}/commits/${headSha}/check-runs?per_page=100`]);
  if (!runs.ok) return { error: `check runs unavailable: ${safe(oneLine(runs.error, 200))}`, ok: false };
  const rawChecks = asRecord(runs.value).check_runs;
  // `check_runs` is an ARRAY or it is not the payload this module was told to read. A non-object
  // top level, a missing field, a `null` — each is a shape to REPORT, never "no check runs on
  // this commit": that sentence is a claim about the commit's CI, and reading it out of a payload
  // we did not understand is exactly the false green this section exists to prevent.
  const checkRunsShaped = Array.isArray(rawChecks);
  // A non-object ELEMENT (`null`, a string, a number) carries no evidence and every accessor
  // below would dereference it — drop it here, where the array is first read.
  const checks = asArray<CheckRun>(rawChecks)
    .filter((c) => isRecord(c))
    .sort(
      // `localeCompare` with an explicit locale: the sort order of the evidence a reviewer
      // reads must not depend on the machine that gathered it.
      (a, b) => conclusionRank(a) - conclusionRank(b) || name(a).localeCompare(name(b), 'en')
    );
  // THE PAGE CAP. The call above asks for one page of 100. A commit with more check runs than
  // that returns exactly 100 and the rest are simply absent — so the API's own `total_count` is
  // the only way to know they existed. Without it the header would call 100 the "total" and a
  // reviewer would read "no failures" out of a page that never contained them. Guarded: the
  // payload is whatever `gh` returned, so a missing, non-finite, or under-counting field is
  // ignored rather than believed.
  const rawTotal = asRecord(runs.value).total_count;
  const totalChecks =
    typeof rawTotal === 'number' && Number.isFinite(rawTotal) && rawTotal > checks.length
      ? rawTotal
      : checks.length;
  const checksNotFetched = totalChecks - checks.length;
  // The buckets are the RANKS, and every fetched check lands in exactly one of them — so they sum
  // to `checks.length`. Without the inconclusive bucket a cancelled/skipped/neutral/stale check
  // (and every conclusion GitHub adds after this was written) vanished from the tally, and a
  // reviewer subtracting failed+success+pending from the total read the remainder as nothing.
  const failed = checks.filter((c) => conclusionRank(c) === 0).length;
  const inconclusive = checks.filter((c) => conclusionRank(c) === INCONCLUSIVE_RANK).length;
  const pending = checks.filter((c) => conclusionRank(c) === 2).length;
  const success = checks.filter((c) => conclusionRank(c) === SUCCESS_RANK).length;

  // ── Check runs ───────────────────────────────────────────────────────────────────────
  const rowFor = (c: CheckRun): Item => {
    const app = oneLine(asRecord(c.app).slug, 60);
    const title = oneLine(output(c).title, 120);
    const url = httpUrl(c.details_url, 300);
    const lines = [
      `- ${label(c)} · ${name(c)}${app ? ` (${app})` : ''}${title ? ` — ${title}` : ''}${url ? ` — ${url}` : ''}`,
    ];
    // A GREEN job's summary is evidence too (incident 2026-08-10: the migration the database
    // refused was printed in a passing job's own output). Green rows are still admitted LAST
    // under `maxChars`, so this line only ever costs the budget when there was room left.
    const summary = oneLine(output(c).summary, 500);
    if (summary) lines.push(`  summary: ${summary}`);
    return { lines };
  };
  const failingRows = checks.filter((c) => conclusionRank(c) !== SUCCESS_RANK).map(rowFor);
  const successRows = checks.filter((c) => conclusionRank(c) === SUCCESS_RANK).map(rowFor);
  const checkRunsNote = !checkRunsShaped
    ? `(check runs unavailable: ${UNEXPECTED_SHAPE})`
    : checks.length === 0
      ? '(no check runs on this commit)'
      : '';

  // ── Annotations (non-green and green checks INTERLEAVED, non-green first) ───────────
  // The cap used to be a plain head-slice of the rank order, which handed every slot to the
  // failing checks and left the green ones unfetched — and a green job's annotation is the exact
  // evidence this module exists for (incident 2026-08-10). So the slots are shared: one non-green,
  // one green, one non-green, … each side in its own rank/name order, non-green taking the odd
  // slot when the sides are uneven. Whatever the cap is, both kinds get through it.
  const annotatedAll = checks.filter((c) => annotationsCount(c) > 0);
  const annotatedOther = annotatedAll.filter((c) => conclusionRank(c) !== SUCCESS_RANK);
  const annotatedGreen = annotatedAll.filter((c) => conclusionRank(c) === SUCCESS_RANK);
  const annotationChecks = Math.max(0, limits.maxAnnotationChecks);
  const annotated: CheckRun[] = [];
  for (let i = 0; i < Math.max(annotatedOther.length, annotatedGreen.length); i += 1) {
    if (annotated.length >= annotationChecks) break;
    if (i < annotatedOther.length) annotated.push(annotatedOther[i]);
    if (annotated.length >= annotationChecks) break;
    if (i < annotatedGreen.length) annotated.push(annotatedGreen[i]);
  }
  const notFetched = annotatedAll.length - annotated.length;

  const blocks: AnnotationBlock[] = [];
  for (const c of annotated) {
    const heading = `### ${name(c)} (${label(c)})`;
    // The id is interpolated into a `gh api` PATH, and the payload is whatever `gh` returned —
    // so it is admitted only as what the API documents it to be: an integer. Anything else is
    // junk or a path fragment, and neither is a check run to fetch.
    const checkId = Number.isInteger(c.id) ? String(c.id) : null;
    if (checkId === null) {
      blocks.push({ heading, knownTotal: 0, note: '- annotations unavailable: non-numeric check id', units: [] });
      continue;
    }
    const res = ghJson<unknown>(gh, [
      'api',
      `repos/${repoSlug}/check-runs/${checkId}/annotations?per_page=50`,
    ]);
    if (!res.ok || !Array.isArray(res.value)) {
      const why = res.ok ? UNEXPECTED_SHAPE : safe(oneLine(res.error, 200));
      blocks.push({ heading, knownTotal: 0, note: `- annotations unavailable: ${why}`, units: [] });
      continue;
    }
    // The same ELEMENT guard the check runs get: a `null`/string/number element carries no
    // evidence, and admitting it renders an empty `- [note] :` row that reads like a real
    // annotation — and inflates the count the header reports.
    const all = asArray<Annotation>(res.value).filter((a) => isRecord(a));
    const fetched = all.slice(0, Math.max(0, limits.maxAnnotationsPerCheck));
    const units = fetched.map((raw) => {
      const a = asRecord(raw);
      const title = oneLine(a.title, 120);
      const where = `[${oneLine(a.annotation_level, 40) || 'note'}] ${oneLine(a.path, 300)}:${oneLine(a.start_line, 20)}`;
      const unit = [`- ${where}${title && title !== name(c) ? ` — ${title}` : ''} — ${oneLine(a.message, 600)}`];
      const details = oneLine(a.raw_details, 300);
      if (details) unit.push(`  details: ${details}`);
      return unit;
    });
    // The response itself is per_page-capped, so its length is a FLOOR on how many exist; the
    // check's own annotations_count is the real denominator.
    blocks.push({
      heading,
      knownTotal: Math.max(annotationsCount(c), all.length),
      note: '',
      units,
    });
  }

  // ── Commit statuses (legacy API — bots post here) ───────────────────────────────────
  const st = ghJson<unknown>(gh, ['api', `repos/${repoSlug}/commits/${headSha}/status`]);
  const rawStatuses = st.ok ? asRecord(st.value).statuses : undefined;
  // Same rule as `check_runs`: an array, or a shape to report. `(none)` is a claim that this
  // commit has no statuses — only a real empty array earns it.
  const statusesShaped = Array.isArray(rawStatuses);
  const statusRows: Item[] = asArray<CommitStatus>(rawStatuses).map((raw) => {
    const s = asRecord(raw);
    const desc = oneLine(s.description, 200);
    const url = httpUrl(s.target_url, 300);
    return {
      lines: [
        `- ${oneLine(s.state, 40) || 'unknown'} · ${oneLine(s.context, 200) || '(unnamed status)'}${desc ? ` — ${desc}` : ''}${url ? ` (${url})` : ''}`,
      ],
    };
  });
  const statusNote = !st.ok
    ? `(statuses unavailable: ${safe(oneLine(st.error, 200))})`
    : !statusesShaped
      ? `(statuses unavailable: ${UNEXPECTED_SHAPE})`
      : statusRows.length === 0
        ? '(none)'
        : '';

  // ── Selection under maxChars: by PRIORITY, then rendered in canonical order ──────────
  // A tail-slice keeps whatever the renderer happened to emit first — the green rows — and
  // drops the last section, which is exactly the annotation this module exists to surface
  // (incident 2026-08-10). So each item is admitted on what it is WORTH: annotation blocks,
  // then the checks that failed, then the statuses, then the green rows.
  // `total` is only honest when the page held everything; otherwise the header says which it is.
  //
  // HEAD IDENTITY. A pinned head came from the caller and provably names the reviewed bytes. A
  // RESOLVED one was read off the PR at gather time — and `gh pr diff` carries no commit identity,
  // so a push between the diff and this call makes the checks below describe a different tree.
  // The seat cannot tell those apart from the SHA alone, so the line says which it is.
  const headLine = headResolved
    ? `Head commit: ${headSha} (resolved when the evidence was gathered — the reviewed diff carries no commit identity, so a push in between can make them differ)`
    : `Head commit: ${headSha}`;
  const headerLine = (annotations: number): string =>
    `Check runs: ${checksNotFetched > 0 ? `${checks.length} fetched of ${totalChecks}` : `${checks.length} total`} · ${failed} failed · ${inconclusive} inconclusive · ${success} success · ${pending} pending · ${annotations} annotation(s) shown`;
  const checksNotFetchedLine = `… ${checksNotFetched} check run(s) not fetched (API page cap)`;
  const notFetchedLine = `… ${notFetched} annotated check(s) not fetched (cap: maxAnnotationChecks)`;
  const moreAnnotations = (n: number): string => `… ${n} more annotation(s) not shown`;
  // Charged up front: the header (at its longest — every fetched annotation kept) and every
  // heading/note that is always rendered. Only what is left over is up for selection.
  let used = cost([
    headLine,
    headerLine(blocks.reduce((n, b) => n + b.units.length, 0)),
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
  // What is left after the always-rendered scaffolding and the reserve. Below roughly 408 chars
  // (the scaffolding of a typical commit — two header lines, three section headings, a cap note
  // — plus its omission lines) nothing is admitted and the text is the scaffolding alone, which
  // can itself exceed the cap: the caller's budget is a budget for EVIDENCE, not a licence to
  // render a document with no head. That floor is not fixed — it RISES with whatever the
  // scaffolding embeds, and a `gh` error note (a statuses failure, capped at 200 chars) is part
  // of the scaffolding.
  const budget = limits.maxChars - OMISSION_LINE_RESERVE * OMISSION_LINE_KINDS;
  // Greedy, in priority order: each call spends from the shared `used` running total.
  const keep = (items: Item[]): Item[] =>
    items.filter((item) => {
      if (used + cost(item.lines) > budget) return false;
      used += cost(item.lines);
      return true;
    });
  // Blocks come first, and a block too big to afford WHOLE is admitted for as many of its
  // annotations as fit: its heading and its own `… N more …` line are charged first (at their
  // worst — nothing shown), then units, each kept with its `details:` line. A block that cannot
  // even afford its heading plus its first annotation is dropped and counted — a heading over
  // nothing is not evidence, and the count is the trace it leaves.
  const keptBlocks: { block: AnnotationBlock; shown: number }[] = [];
  let blocksDropped = 0;
  for (const block of blocks) {
    const base = cost([
      block.heading,
      ...(block.note ? [block.note] : []),
      ...(block.knownTotal > 0 ? [moreAnnotations(block.knownTotal)] : []),
    ]);
    const first = block.units.length > 0 ? cost(block.units[0]) : 0;
    if (used + base + first > budget) {
      blocksDropped += 1;
      continue;
    }
    used += base;
    let shown = 0;
    for (const unit of block.units) {
      if (used + cost(unit) > budget) break;
      used += cost(unit);
      shown += 1;
    }
    keptBlocks.push({ block, shown });
  }
  const keptFailing = keep(failingRows);
  const keptStatuses = keep(statusRows);
  const keptSuccess = keep(successRows);

  const omittedChecks = failingRows.length + successRows.length - keptFailing.length - keptSuccess.length;
  const omittedStatuses = statusRows.length - keptStatuses.length;
  const shownAnnotations = keptBlocks.reduce((n, k) => n + k.shown, 0);
  const truncated =
    checksNotFetched > 0 ||
    notFetched > 0 ||
    blocksDropped > 0 ||
    omittedChecks > 0 ||
    omittedStatuses > 0 ||
    keptBlocks.some((k) => k.block.knownTotal > k.shown);

  const text = [
    headLine,
    headerLine(shownAnnotations),
    '',
    '## Check runs',
    ...(checkRunsNote ? [checkRunsNote] : []),
    ...keptFailing.flatMap((i) => i.lines),
    ...keptSuccess.flatMap((i) => i.lines),
    ...(omittedChecks > 0 ? [`… ${omittedChecks} more check run(s) not shown`] : []),
    ...(checksNotFetched > 0 ? [checksNotFetchedLine] : []),
    '',
    ANNOTATIONS_HEADING,
    ...keptBlocks.flatMap(({ block, shown }) => [
      block.heading,
      ...(block.note ? [block.note] : []),
      ...block.units.slice(0, shown).flat(),
      ...(block.knownTotal - shown > 0 ? [moreAnnotations(block.knownTotal - shown)] : []),
    ]),
    ...(notFetched > 0 ? [notFetchedLine] : []),
    ...(blocksDropped > 0 ? [`… ${blocksDropped} annotated check(s) not shown`] : []),
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
