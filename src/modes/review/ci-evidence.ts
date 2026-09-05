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
  end_line?: number;
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

// Failed/attention-needing first, then inconclusive, then pending, then green.
const FAILED = new Set(['failure', 'timed_out', 'action_required', 'startup_failure']);
function conclusionRank(c: CheckRun): number {
  if (c.conclusion && FAILED.has(c.conclusion)) return 0;
  if (c.conclusion === 'cancelled' || c.conclusion === 'stale' || c.conclusion === 'neutral' || c.conclusion === 'skipped') return 1;
  if (!c.conclusion) return 2;
  return 3;
}

const oneLine = (s: string | null | undefined, max: number): string =>
  (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

const label = (c: CheckRun): string => (c.conclusion ?? c.status ?? 'unknown').toLowerCase();

export function fetchCiEvidence(input: CiEvidenceInput): CiEvidenceResult {
  const limits = { ...CI_EVIDENCE_LIMITS, ...(input.limits ?? {}) };
  const { gh, repoSlug } = input;

  let headSha = input.headSha;
  if (!headSha) {
    const head = ghJson<{ headRefOid?: string }>(gh, ['pr', 'view', String(input.pr), '-R', repoSlug, '--json', 'headRefOid']);
    if (!head.ok) return { error: `head SHA unavailable: ${head.error}`, ok: false };
    if (!head.value.headRefOid) return { error: 'head SHA unavailable: `gh pr view` returned no headRefOid', ok: false };
    headSha = head.value.headRefOid;
  }

  const runs = ghJson<{ check_runs?: CheckRun[]; total_count?: number }>(gh, [
    'api',
    `repos/${repoSlug}/commits/${headSha}/check-runs?per_page=100`,
  ]);
  if (!runs.ok) return { error: `check runs unavailable: ${runs.error}`, ok: false };
  const checks = [...(runs.value.check_runs ?? [])].sort((a, b) => conclusionRank(a) - conclusionRank(b) || a.name.localeCompare(b.name));
  const failed = checks.filter((c) => conclusionRank(c) === 0).length;
  const pending = checks.filter((c) => !c.conclusion).length;
  const success = checks.filter((c) => c.conclusion === 'success').length;

  const lines: string[] = [];
  lines.push(`Head commit: ${headSha}`);

  // ── Check runs ───────────────────────────────────────────────────────────────────────
  const checkLines: string[] = ['', '## Check runs'];
  if (checks.length === 0) checkLines.push('(no check runs on this commit)');
  for (const c of checks) {
    const app = c.app?.slug ? ` (${c.app.slug})` : '';
    const title = c.output?.title ? ` — ${oneLine(c.output.title, 120)}` : '';
    const url = c.details_url ? ` — ${c.details_url}` : '';
    checkLines.push(`- ${label(c)} · ${c.name}${app}${title}${url}`);
    if (conclusionRank(c) !== 3 && c.output?.summary) {
      checkLines.push(`  summary: ${oneLine(c.output.summary, 500)}`);
    }
  }

  // ── Annotations (failure/warning-bearing checks first) ──────────────────────────────
  let annotationCount = 0;
  let cut = 0;
  let truncated = false;
  const annLines: string[] = ['', '## Annotations (the checks\' own remarks on this head — level, then path:line)'];
  const annotated = checks.filter((c) => (c.output?.annotations_count ?? 0) > 0).slice(0, limits.maxAnnotationChecks);
  if (checks.filter((c) => (c.output?.annotations_count ?? 0) > 0).length > annotated.length) truncated = true;
  for (const c of annotated) {
    const res = ghJson<Annotation[]>(gh, ['api', `repos/${repoSlug}/check-runs/${c.id}/annotations?per_page=50`]);
    annLines.push(`### ${c.name} (${label(c)})`);
    if (!res.ok) {
      annLines.push(`- annotations unavailable: ${oneLine(res.error, 200)}`);
      continue;
    }
    const shown = res.value.slice(0, limits.maxAnnotationsPerCheck);
    cut += res.value.length - shown.length;
    for (const a of shown) {
      annotationCount += 1;
      const title = a.title && a.title !== c.name ? ` — ${oneLine(a.title, 120)}` : '';
      annLines.push(`- [${a.annotation_level}] ${a.path}:${a.start_line}${title} — ${oneLine(a.message, 600)}`);
      if (a.raw_details) annLines.push(`  details: ${oneLine(a.raw_details, 300)}`);
    }
  }
  if (annotated.length === 0) annLines.push('(no annotations)');
  if (cut > 0) {
    truncated = true;
    annLines.push(`… ${cut} more annotation(s) not shown`);
  }

  // ── Commit statuses (legacy API — bots post here) ───────────────────────────────────
  const statusLines: string[] = ['', '## Commit statuses'];
  const st = ghJson<{ state?: string; statuses?: CommitStatus[] }>(gh, ['api', `repos/${repoSlug}/commits/${headSha}/status`]);
  if (!st.ok) statusLines.push(`(statuses unavailable: ${oneLine(st.error, 200)})`);
  else if (!st.value.statuses || st.value.statuses.length === 0) statusLines.push('(none)');
  else {
    for (const s of st.value.statuses) {
      const desc = s.description ? ` — ${oneLine(s.description, 200)}` : '';
      const url = s.target_url ? ` (${s.target_url})` : '';
      statusLines.push(`- ${s.state} · ${s.context}${desc}${url}`);
    }
  }

  lines.push(
    `Check runs: ${checks.length} total · ${failed} failed · ${success} success · ${pending} pending · ${annotationCount} annotation(s) shown`
  );
  let text = [...lines, ...checkLines, ...annLines, ...statusLines].join('\n');
  if (text.length > limits.maxChars) {
    truncated = true;
    text = `${text.slice(0, limits.maxChars)}\n… (CI evidence cut at ${limits.maxChars} chars)`;
  }

  const secret = scanTextForSecrets(text);
  if (secret) {
    return {
      error: `withheld: an inline credential pattern (${secret.label}) appeared in check output`,
      ok: false,
    };
  }
  return { annotations: annotationCount, checks: checks.length, failed, headSha, ok: true, text, truncated };
}
