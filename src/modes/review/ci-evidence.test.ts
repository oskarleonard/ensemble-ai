import { describe, expect, it } from 'vitest';

import { CI_EVIDENCE_BOTH_REASON, CI_EVIDENCE_LIMITS, fetchCiEvidence, resolveCiEvidence } from './ci-evidence';
import type { GhRunner } from './stage';

const SHA = 'a'.repeat(40);
const SLUG = 'acme/webapp';

// A fake `gh` keyed on the joined argv — every call the gatherer makes is one entry here.
// An UNMATCHED call THROWS: a misordered, extra, or malformed `gh` call must fail the test
// loudly rather than degrade into a plausible-looking `{ ok: false }` nobody asserts on.
function fakeGh(responses: Record<string, unknown>, calls: string[] = []): GhRunner {
  return (args) => {
    const key = args.join(' ');
    calls.push(key);
    const hit = Object.entries(responses).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error(`unexpected gh call: ${key}`);
    const [, body] = hit;
    if (typeof body === 'string' && body.startsWith('ERR:')) return { error: body.slice(4), ok: false };
    return { ok: true, text: JSON.stringify(body) };
  };
}

const CHECK_RUNS = {
  check_runs: [
    {
      app: { slug: 'github-actions' },
      conclusion: 'success',
      details_url: 'https://ci.example/run/1',
      id: 101,
      name: 'unit-tests',
      output: { annotations_count: 0, summary: null, title: '214 passed' },
      status: 'completed',
    },
    {
      app: { slug: 'github-actions' },
      conclusion: 'success',
      details_url: 'https://ci.example/run/2',
      id: 102,
      name: 'migrate-validate',
      output: { annotations_count: 1, summary: 'validation finished', title: 'ok' },
      status: 'completed',
    },
    {
      app: { slug: 'github-actions' },
      conclusion: 'failure',
      details_url: 'https://ci.example/run/3',
      id: 103,
      name: 'lint',
      output: { annotations_count: 0, summary: 'eslint exited 1: 3 problems', title: 'lint failed' },
      status: 'completed',
    },
  ],
  total_count: 3,
};

const WARNING_WRAPPING_AN_ERROR = [
  {
    annotation_level: 'warning',
    end_line: 1,
    message: 'pq: functions in index predicate must be marked IMMUTABLE',
    path: 'db/migrations/0042_add_index.sql',
    raw_details: null,
    start_line: 1,
    title: 'migrate-validate',
  },
];

const STATUSES = {
  state: 'success',
  statuses: [{ context: 'review-bot', description: 'Review completed', state: 'success', target_url: 'https://bot.example/1' }],
};

const happy = {
  [`api repos/${SLUG}/check-runs/102/annotations`]: WARNING_WRAPPING_AN_ERROR,
  [`api repos/${SLUG}/commits/${SHA}/check-runs`]: CHECK_RUNS,
  [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
};

// N failing checks that ALL carry annotations — more evidence than a small budget can hold.
function crowded(count: number): Record<string, unknown> {
  const ids = Array.from({ length: count }, (_, i) => 200 + i);
  const responses: Record<string, unknown> = {
    [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
      check_runs: ids.map((id, i) => ({
        app: { slug: 'github-actions' },
        conclusion: 'failure',
        details_url: `https://ci.example/run/${id}`,
        id,
        name: `job-${String(i).padStart(2, '0')}`,
        output: {
          annotations_count: 2,
          summary: `job ${i} failed; ${'the summary line runs on and on for a while '.repeat(4)}`,
          title: 'failed',
        },
        status: 'completed',
      })),
      total_count: count,
    },
    [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
  };
  for (const [i, id] of ids.entries()) {
    responses[`api repos/${SLUG}/check-runs/${id}/annotations`] = [
      {
        annotation_level: 'failure',
        message: `job ${i} annotation one: ${'the machine already ran this and said no. '.repeat(3)}`,
        path: `src/job-${i}.ts`,
        raw_details: null,
        start_line: 10,
        title: null,
      },
      {
        annotation_level: 'warning',
        message: `job ${i} annotation two: ${'a green step downgraded a real error to a warning. '.repeat(3)}`,
        path: `src/job-${i}.ts`,
        raw_details: null,
        start_line: 20,
        title: null,
      },
    ];
  }
  return responses;
}

describe('fetchCiEvidence — the head commit\'s checks as DATA', () => {
  it('renders a green job\'s warning annotation that wraps an error, failed checks first', () => {
    const res = fetchCiEvidence({ gh: fakeGh(happy), headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checks).toBe(3);
    expect(res.failed).toBe(1);
    expect(res.annotations).toBe(1);
    expect(res.headSha).toBe(SHA);
    // Failed check sorts first and carries its output summary — and so does the GREEN row: a
    // passing job's own summary is evidence too, it is just admitted last under the budget.
    const lint = res.text.indexOf('lint');
    const unit = res.text.indexOf('unit-tests');
    expect(lint).toBeGreaterThan(-1);
    expect(lint).toBeLessThan(unit);
    expect(res.text).toContain('eslint exited 1: 3 problems');
    expect(res.text).toContain('summary: validation finished');
    // The incident 2026-08-10 shape: a SUCCESS job whose annotation text is an error.
    expect(res.text).toContain('[warning] db/migrations/0042_add_index.sql:1');
    expect(res.text).toContain('pq: functions in index predicate must be marked IMMUTABLE');
    expect(res.text).toContain('migrate-validate (success)');
    // Commit statuses ride along.
    expect(res.text).toContain('review-bot');
    expect(res.text).toContain('Review completed');
  });

  it('resolves the head SHA via `gh pr view` when the caller has none', () => {
    const calls: string[] = [];
    const gh = fakeGh({ ...happy, [`pr view 7 -R ${SLUG} --json headRefOid`]: { headRefOid: SHA } }, calls);
    const res = fetchCiEvidence({ gh, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    expect(calls[0]).toBe(`pr view 7 -R ${SLUG} --json headRefOid`);
    if (res.ok) expect(res.headSha).toBe(SHA);
  });

  it('degrades to ok:false with the gh error when the check-runs call fails', () => {
    const gh = fakeGh({ [`api repos/${SLUG}/commits/${SHA}/check-runs`]: 'ERR:HTTP 403: rate limited' });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res).toEqual({ error: expect.stringContaining('rate limited'), ok: false });
  });

  // THE SECOND NET. Every untrusted FIELD is scanned (and redacted) before truncation, so the
  // whole-text scan exists for the bytes no field owns — here a credential in a URL PATH, which
  // survives the query-string strip and is rendered verbatim as the human's pointer.
  // Gate-3 fix review, Finding 1: httpUrl now scans BEFORE the cap too, so a credential in a
  // `details_url` — the one field the earlier scan-before-truncate pass (G4) did not enumerate —
  // is caught there and the URL is DROPPED, the same disposal a userinfo URL already gets. It no
  // longer needs the whole-text second net to catch it, so the check itself still renders.
  it('drops a details_url that carries a credential, rather than reaching the second net', () => {
    const leaky = {
      ...happy,
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
        check_runs: [
          {
            conclusion: 'failure',
            details_url: 'https://ci.example/run/ghp_abcdefghijklmnopqrstuvwxyz0123',
            id: 111,
            name: 'lint',
            output: { annotations_count: 0, summary: null, title: null },
            status: 'completed',
          },
        ],
      },
    };
    const res = fetchCiEvidence({ gh: fakeGh(leaky), headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('lint');
    expect(res.text).not.toContain('ghp_');
    expect(res.text).not.toContain('https://ci.example/run/');
  });

  // …and a credential inside a FIELD costs that field, not the whole section: the redaction is
  // named in place and every other piece of evidence on the head still reaches the seats. The
  // section only disappears when nothing else could contain the leak.
  it('redacts a leaky FIELD in place and keeps the rest of the evidence', () => {
    const leaky = {
      ...happy,
      [`api repos/${SLUG}/check-runs/102/annotations`]: [
        { ...WARNING_WRAPPING_AN_ERROR[0], message: 'debug: GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123' },
      ],
    };
    const res = fetchCiEvidence({ gh: fakeGh(leaky), headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('[redacted: github-token]');
    expect(res.text).not.toContain('ghp_');
    // The rest of the head's evidence is untouched.
    expect(res.text).toContain('eslint exited 1: 3 problems');
    expect(res.text).toContain('review-bot');
  });

  it('caps annotations per check and says how many were cut', () => {
    const many = Array.from({ length: 4 }, (_, i) => ({
      ...WARNING_WRAPPING_AN_ERROR[0],
      message: `warning number ${i + 1}`,
      start_line: i + 1,
    }));
    const gh = fakeGh({ ...happy, [`api repos/${SLUG}/check-runs/102/annotations`]: many });
    const res = fetchCiEvidence({
      gh,
      headSha: SHA,
      limits: { maxAnnotationsPerCheck: 2 },
      pr: 7,
      repoSlug: SLUG,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('warning number 1');
    expect(res.text).toContain('warning number 2');
    expect(res.text).not.toContain('warning number 3');
    expect(res.text).toContain('2 more annotation(s) not shown');
    expect(res.truncated).toBe(true);
  });

  it('a check with no annotations makes no annotations call; a failed annotations call is noted, not fatal', () => {
    const calls: string[] = [];
    const gh = fakeGh(
      { ...happy, [`api repos/${SLUG}/check-runs/102/annotations`]: 'ERR:HTTP 500' },
      calls
    );
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.includes('check-runs/101/annotations'))).toBe(false);
    if (res.ok) expect(res.text).toContain('annotations unavailable');
  });

  it('exports the mandated default limits', () => {
    expect(CI_EVIDENCE_LIMITS).toEqual({
      maxAnnotationChecks: 10,
      maxAnnotationsPerCheck: 25,
      maxChars: 14_000,
    });
  });
});

// NEVER THROWS. `gh` returns whatever the API (or a proxy, or a future schema) hands back; a
// shape this module did not expect is DATA to report, not an exception to raise on a caller
// that asked for best-effort evidence.
describe('fetchCiEvidence — malformed payloads degrade, they never throw', () => {
  it('survives a non-array check_runs and a non-array statuses payload', () => {
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: { check_runs: { not: 'an array' } },
      [`api repos/${SLUG}/commits/${SHA}/status`]: { state: 'success', statuses: 'nope' },
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checks).toBe(0);
    expect(res.text).toContain('check runs unavailable: unexpected payload shape');
    expect(res.text).toContain('statuses unavailable: unexpected payload shape');
  });

  it('survives an annotations payload that is an object instead of an array', () => {
    const gh = fakeGh({
      ...happy,
      [`api repos/${SLUG}/check-runs/102/annotations`]: { message: 'not an array' },
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.annotations).toBe(0);
    expect(res.text).toContain('annotations unavailable: unexpected payload shape');
  });

  // An adversarial (or merely future) payload can hold a field that refuses to become a primitive.
  // `String(v)` on it throws out of a function whose whole contract is best-effort, so the
  // coercion admits only the JSON scalars and renders everything else as absent.
  it('never throws on a field that refuses to become a primitive', () => {
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
        check_runs: [
          {
            conclusion: 'failure',
            id: 701,
            name: { toString: null, valueOf: null },
            output: { annotations_count: 0, summary: 'the summary survives', title: null },
            status: 'completed',
          },
        ],
      },
      [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checks).toBe(1);
    expect(res.text).toContain('(unnamed check)');
    expect(res.text).toContain('the summary survives');
  });

  it('survives checks that tie on rank with a missing name and a non-object output', () => {
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
        check_runs: [
          { conclusion: 'failure', id: 301, output: 'not an object', status: 'completed' },
          { conclusion: 'failure', id: 302, status: 'completed' },
          { conclusion: 'failure', id: 303, name: 'named', output: null, status: 'completed' },
        ],
      },
      [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checks).toBe(3);
    expect(res.failed).toBe(3);
    expect(res.text).toContain('named');
  });
});

// THE BUDGET. `maxChars` is a structural cap, not a guillotine: what survives it must be the
// evidence the module exists for (incident 2026-08-10 — the annotation in the green job), and
// what it says about itself must be true.
describe('fetchCiEvidence — the maxChars budget keeps the evidence, not the boilerplate', () => {
  // 3160 = the 2760 chars of EVIDENCE this case has always pinned, plus the omission-line reserve
  // as it now stands (5 kinds × 80 — the check-run and status API page-cap lines joined it). The
  // evidence budget under test is unchanged; only the scaffolding held back around it grew.
  const TIGHT = 3160;

  it('keeps annotations under a tight budget, stays inside the cap, and counts only what it rendered', () => {
    const res = fetchCiEvidence({
      gh: fakeGh(crowded(12)),
      headSha: SHA,
      limits: { maxChars: TIGHT },
      pr: 7,
      repoSlug: SLUG,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text.length).toBeLessThanOrEqual(TIGHT);
    // The section the module exists for survives the cut, with real annotation lines in it.
    expect(res.text).toContain('## Annotations');
    expect(res.text).toMatch(/- \[(warning|failure)\] src\/job-\d+\.ts:\d+/);
    // …while the boilerplate rows are what got dropped, and each section says so truthfully.
    expect(res.text).toMatch(/… \d+ more check run\(s\) not shown/);
    expect(res.text).toMatch(/… \d+ more annotation\(s\) not shown/);
    expect(res.truncated).toBe(true);
    // The header's count and the result's count are the lines actually rendered — not a promise.
    const rendered = (res.text.match(/^- \[(warning|failure)\] /gm) ?? []).length;
    expect(res.annotations).toBe(rendered);
    expect(res.text).toContain(`${rendered} annotation(s) shown`);
  });

  it('caps how many checks get annotations fetched and says so', () => {
    const calls: string[] = [];
    const res = fetchCiEvidence({
      gh: fakeGh(crowded(12), calls),
      headSha: SHA,
      limits: { maxAnnotationChecks: 2 },
      pr: 7,
      repoSlug: SLUG,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(calls.filter((c) => c.includes('/annotations')).length).toBe(2);
    expect(res.text).toContain('10 annotated check(s) not fetched (cap: maxAnnotationChecks)');
    expect(res.truncated).toBe(true);
  });

  it('reports the API\'s own annotation total, not the length of a per_page-capped response', () => {
    const gh = fakeGh({
      ...happy,
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
        check_runs: [
          {
            conclusion: 'failure',
            id: 102,
            name: 'lint',
            output: { annotations_count: 300, summary: null, title: null },
            status: 'completed',
          },
        ],
      },
      [`api repos/${SLUG}/check-runs/102/annotations`]: Array.from({ length: 3 }, (_, i) => ({
        annotation_level: 'failure',
        message: `problem ${i + 1}`,
        path: 'src/a.ts',
        start_line: i + 1,
      })),
    });
    const res = fetchCiEvidence({
      gh,
      headSha: SHA,
      limits: { maxAnnotationsPerCheck: 2 },
      pr: 7,
      repoSlug: SLUG,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('298 more annotation(s) not shown');
    expect(res.annotations).toBe(2);
  });

  // The check-runs call is `per_page=100`. A commit with more checks than that returns ONE page,
  // and a header that called it the "total" would be a lie told under the word `total` — the one
  // claim this section cannot afford, because a reviewer reads "no failures" out of it.
  it('says how many check runs the API page cap left unfetched, and stops calling them the total', () => {
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
        check_runs: Array.from({ length: 100 }, (_, i) => ({
          conclusion: 'success',
          id: 1000 + i,
          name: `job-${String(i).padStart(3, '0')}`,
          output: { annotations_count: 0, summary: null, title: null },
          status: 'completed',
        })),
        total_count: 150,
      },
      [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('Check runs: 100 fetched of 150');
    expect(res.text).not.toContain('100 total');
    expect(res.text).toContain('… 50 check run(s) not fetched (API page cap)');
    expect(res.truncated).toBe(true);
  });

  it('keeps the plain `N total` header when the page held every check run', () => {
    const res = fetchCiEvidence({ gh: fakeGh(happy), headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('Check runs: 3 total');
    expect(res.text).not.toContain('not fetched (API page cap)');
    expect(res.truncated).toBe(false);
  });

  it('ignores a total_count that is missing, non-numeric, or lower than the page it returned', () => {
    for (const total of [undefined, 'many', Number.NaN, 1]) {
      const gh = fakeGh({
        [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
          check_runs: CHECK_RUNS.check_runs,
          ...(total === undefined ? {} : { total_count: total }),
        },
        [`api repos/${SLUG}/check-runs/102/annotations`]: WARNING_WRAPPING_AN_ERROR,
        [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
      });
      const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.text).toContain('Check runs: 3 total');
      expect(res.text).not.toContain('not fetched (API page cap)');
    }
  });
});

// THE CALL SEQUENCE + the degradations. Every `gh` call this module makes is part of its
// contract with the engine's runner (and with the reviewer sandbox that allows exactly these).
describe('fetchCiEvidence — gh calls and how each failure degrades', () => {
  it('calls check-runs, then the annotated check\'s annotations, then commit status — in that order', () => {
    const calls: string[] = [];
    const res = fetchCiEvidence({ gh: fakeGh(happy, calls), headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    expect(calls).toEqual([
      `api repos/${SLUG}/commits/${SHA}/check-runs?per_page=100`,
      `api repos/${SLUG}/check-runs/102/annotations?per_page=50`,
      `api repos/${SLUG}/commits/${SHA}/status?per_page=100`,
    ]);
  });

  it('notes a failing commit-status call without failing the whole gather', () => {
    const gh = fakeGh({ ...happy, [`api repos/${SLUG}/commits/${SHA}/status`]: 'ERR:HTTP 502: bad gateway' });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('(statuses unavailable: HTTP 502: bad gateway)');
    // The rest of the evidence is still there.
    expect(res.text).toContain('pq: functions in index predicate must be marked IMMUTABLE');
  });

  it('fails the gather when the head SHA cannot be resolved', () => {
    const gh = fakeGh({ [`pr view 7 -R ${SLUG} --json headRefOid`]: 'ERR:no pull requests found' });
    const res = fetchCiEvidence({ gh, pr: 7, repoSlug: SLUG });
    expect(res).toEqual({ error: expect.stringMatching(/head SHA unavailable/), ok: false });
  });

  it('fails the gather when `gh pr view` returns no headRefOid', () => {
    const gh = fakeGh({ [`pr view 7 -R ${SLUG} --json headRefOid`]: {} });
    const res = fetchCiEvidence({ gh, pr: 7, repoSlug: SLUG });
    expect(res).toEqual({ error: expect.stringMatching(/head SHA unavailable/), ok: false });
  });

  it('redacts a credential that gh printed into its own error text', () => {
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: 'ERR:HTTP 401: token ghp_abcdefghijklmnopqrstuvwxyz0123 is invalid',
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain('[redacted: github-token]');
    expect(res.error).not.toContain('ghp_');
  });

  it('treats a conclusion it does not recognise as inconclusive, so its summary is kept', () => {
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
        check_runs: [
          {
            conclusion: 'flaky_new_github_conclusion',
            id: 401,
            name: 'novel',
            output: { annotations_count: 0, summary: 'the new conclusion explains itself here', title: null },
            status: 'completed',
          },
          {
            conclusion: 'success',
            id: 402,
            name: 'aaa-sorts-first-alphabetically',
            output: { annotations_count: 0, summary: 'green summaries are noise', title: null },
            status: 'completed',
          },
        ],
      },
      [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('the new conclusion explains itself here');
    // Green summaries ride along now, so the RANK is what this pins: the unrecognised conclusion
    // is INCONCLUSIVE — counted in that bucket rather than as a pass, and rendered ahead of the
    // success row (which sorts first alphabetically, so only the rank can put it second).
    expect(res.text).toContain('· 0 failed · 1 inconclusive · 1 success · 0 pending ·');
    expect(res.text.indexOf('the new conclusion explains itself here')).toBeLessThan(
      res.text.indexOf('green summaries are noise')
    );
    expect(res.text.indexOf('novel')).toBeLessThan(res.text.indexOf('aaa-sorts-first'));
  });
});

// A check run is whatever came back in the array — including nothing at all. And a budget is a
// budget for EVIDENCE: a check that annotates verbosely must lose the tail of its annotations,
// never the whole block, and a block that could not be shown at all must leave a trace.
describe('fetchCiEvidence — junk elements and blocks too big to admit whole', () => {
  it('drops non-object elements inside check_runs instead of dereferencing them', () => {
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
        check_runs: [
          null,
          'nope',
          5,
          {
            conclusion: 'failure',
            id: 501,
            name: 'real-check',
            output: { annotations_count: 0, summary: 'the only real element', title: null },
            status: 'completed',
          },
        ],
      },
      [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checks).toBe(1);
    expect(res.failed).toBe(1);
    expect(res.text).toContain('real-check');
    expect(res.text).toContain('the only real element');
    // One check row and one status row — the three junk elements render nothing.
    expect((res.text.match(/^- /gm) ?? []).length).toBe(2);
  });

  // Same guard as `check_runs`: a junk ELEMENT inside an annotations payload carries no evidence,
  // and counting it renders an empty `- [note] :` row that reads like a real annotation.
  it('drops non-object elements inside an annotations payload instead of counting them as rows', () => {
    const gh = fakeGh({
      ...happy,
      [`api repos/${SLUG}/check-runs/102/annotations`]: [null, 'x', 5, WARNING_WRAPPING_AN_ERROR[0]],
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.annotations).toBe(1);
    expect((res.text.match(/^- \[/gm) ?? []).length).toBe(1);
    expect(res.text).toContain('must be marked IMMUTABLE');
  });

  // The check id is interpolated into a `gh api` PATH. The payload is whatever `gh` returned, so
  // a non-integer id is either junk or a path fragment — neither is a check run to fetch.
  it('never builds an annotations path out of a non-numeric check id', () => {
    const calls: string[] = [];
    const gh = fakeGh(
      {
        [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
          check_runs: [
            {
              conclusion: 'failure',
              id: '102/annotations?x=1&y=../../../repos/other/secret/actions',
              name: 'lint',
              output: { annotations_count: 3, summary: null, title: null },
              status: 'completed',
            },
          ],
        },
        [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
      },
      calls
    );
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // No annotations call was made at all (the fake `gh` throws on any call not scripted above).
    expect(calls.some((c) => c.includes('/annotations'))).toBe(false);
    // …and the block says why, rather than vanishing.
    expect(res.text).toContain('- annotations unavailable: non-numeric check id');
    expect(res.annotations).toBe(0);
  });

  it('admits a verbose check\'s block PARTIALLY rather than losing every annotation it has', () => {
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
        check_runs: [
          {
            conclusion: 'failure',
            id: 601,
            name: 'verbose',
            output: { annotations_count: 15, summary: null, title: null },
            status: 'completed',
          },
        ],
      },
      [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
      // 15 annotations at the module's own per-annotation caps: 600-char message, 300-char
      // details. The whole block is ~14 KB — more than the DEFAULT maxChars on its own.
      [`api repos/${SLUG}/check-runs/601/annotations`]: Array.from({ length: 15 }, (_, i) => ({
        annotation_level: 'failure',
        message: `annotation ${i + 1}: ${'x'.repeat(600)}`,
        path: 'src/verbose.ts',
        raw_details: 'y'.repeat(300),
        start_line: i + 1,
      })),
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const rendered = (res.text.match(/^- \[failure\] src\/verbose\.ts:\d+/gm) ?? []).length;
    expect(rendered).toBeGreaterThanOrEqual(10);
    expect(rendered).toBeLessThan(15);
    expect(res.text.length).toBeLessThanOrEqual(14_000);
    expect(res.annotations).toBe(rendered);
    // The remainder folds into this check's own line, counted off its true total.
    expect(res.text).toContain(`… ${15 - rendered} more annotation(s) not shown`);
    expect(res.truncated).toBe(true);
  });

  it('leaves a trace when a block cannot be admitted at all, even an unavailable one', () => {
    const gh = fakeGh({ ...happy, [`api repos/${SLUG}/check-runs/102/annotations`]: 'ERR:HTTP 500' });
    const res = fetchCiEvidence({ gh, headSha: SHA, limits: { maxChars: 400 }, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('1 annotated check(s) not shown');
    expect(res.text).not.toContain('annotations unavailable');
    expect(res.truncated).toBe(true);
  });
});

// THE HEAD SHA is interpolated into `gh api` PATHS and arrives either from the caller or from a
// payload. So it is admitted only as what a commit id is — 40 hex (sha1) or 64 hex (sha256) —
// and it is rejected BEFORE the first call that would carry it into a URL.
describe('fetchCiEvidence — the head SHA is admitted only as a commit id', () => {
  it('rejects a path-shaped head SHA before any gh api call interpolates it', () => {
    const calls: string[] = [];
    const res = fetchCiEvidence({ gh: fakeGh(happy, calls), headSha: '../../x', pr: 7, repoSlug: SLUG });
    expect(res).toEqual({ error: 'head SHA rejected: not a 40/64-hex commit SHA', ok: false });
    // The runner was never asked for the check runs OR the commit status — nothing at all.
    expect(calls.some((c) => c.includes('check-runs'))).toBe(false);
    expect(calls.some((c) => c.includes('/status'))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('rejects a non-hex headRefOid that `gh pr view` resolved, too', () => {
    const calls: string[] = [];
    const gh = fakeGh({ ...happy, [`pr view 7 -R ${SLUG} --json headRefOid`]: { headRefOid: 'not-a-sha' } }, calls);
    const res = fetchCiEvidence({ gh, pr: 7, repoSlug: SLUG });
    expect(res).toEqual({ error: 'head SHA rejected: not a 40/64-hex commit SHA', ok: false });
    expect(calls).toEqual([`pr view 7 -R ${SLUG} --json headRefOid`]);
  });

  it('admits a 64-hex (sha256) commit id', () => {
    const sha256 = 'b'.repeat(64);
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${sha256}/check-runs`]: { check_runs: [] },
      [`api repos/${SLUG}/commits/${sha256}/status`]: STATUSES,
    });
    const res = fetchCiEvidence({ gh, headSha: sha256, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.headSha).toBe(sha256);
  });
});

// THE TALLY. Every fetched check lands in exactly one rank, so the header's buckets must sum to
// the fetched count. Without an `inconclusive` bucket a cancelled/skipped/neutral check simply
// vanished from the header, and a reviewer subtracting the other three read the remainder as zero.
describe('fetchCiEvidence — the header buckets sum to what was fetched', () => {
  it('counts cancelled/skipped checks in an `inconclusive` bucket', () => {
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
        check_runs: [
          { conclusion: 'skipped', id: 801, name: 'skip-me', output: { annotations_count: 0 }, status: 'completed' },
          { conclusion: 'cancelled', id: 802, name: 'cancel-me', output: { annotations_count: 0 }, status: 'completed' },
          { conclusion: 'failure', id: 803, name: 'lint', output: { annotations_count: 0 }, status: 'completed' },
          { conclusion: 'success', id: 804, name: 'unit', output: { annotations_count: 0 }, status: 'completed' },
          { conclusion: null, id: 805, name: 'running', output: { annotations_count: 0 }, status: 'in_progress' },
        ],
      },
      [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain(
      'Check runs: 5 total · 1 failed · 2 inconclusive · 1 success · 1 pending · 0 annotation(s) shown'
    );
    // …and the buckets are EXHAUSTIVE: they add up to the count the same header reports.
    const nums = /· (\d+) failed · (\d+) inconclusive · (\d+) success · (\d+) pending ·/.exec(res.text);
    expect(nums).not.toBeNull();
    expect((nums ?? []).slice(1).reduce((n, s) => n + Number(s), 0)).toBe(res.checks);
  });
});

// "(no check runs on this commit)" is a CLAIM ABOUT THE COMMIT'S CI, and a reviewer reads it as
// "nothing ran". A payload this module did not understand is never allowed to make that claim —
// only a real, empty array is.
describe('fetchCiEvidence — an unreadable payload never claims the commit has no checks', () => {
  const shapes: [string, unknown][] = [
    ['a null top-level payload', null],
    ['a top-level payload with no check_runs at all', {}],
    ['a null check_runs', { check_runs: null }],
    ['a string top-level payload', 'nope'],
    ['an array top-level payload', [{ conclusion: 'failure', id: 1, name: 'x', status: 'completed' }]],
  ];
  for (const [what, payload] of shapes) {
    it(`reports ${what} as an unexpected shape`, () => {
      const gh = fakeGh({
        [`api repos/${SLUG}/commits/${SHA}/check-runs`]: payload,
        [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
      });
      const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.checks).toBe(0);
      expect(res.text).toContain('(check runs unavailable: unexpected payload shape)');
      expect(res.text).not.toContain('(no check runs on this commit)');
    });
  }

  it('keeps "(no check runs on this commit)" for a REAL empty array', () => {
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: { check_runs: [] },
      [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('(no check runs on this commit)');
    expect(res.text).not.toContain('check runs unavailable');
  });

  it('holds statuses to the same rule — `(none)` is earned only by a real empty array', () => {
    const cases: [unknown, string][] = [
      [{ state: 'success' }, '(statuses unavailable: unexpected payload shape)'],
      [{ state: 'success', statuses: null }, '(statuses unavailable: unexpected payload shape)'],
      [null, '(statuses unavailable: unexpected payload shape)'],
      [{ state: 'success', statuses: [] }, '(none)'],
    ];
    for (const [payload, expected] of cases) {
      const gh = fakeGh({
        [`api repos/${SLUG}/commits/${SHA}/check-runs`]: { check_runs: [] },
        [`api repos/${SLUG}/commits/${SHA}/status`]: payload,
      });
      const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.text).toContain(expected);
    }
  });
});

// HEAD IDENTITY. A pinned head came from the caller and names the reviewed bytes. A RESOLVED one
// was read off the PR at gather time, and `gh pr diff` carries no commit identity — so a push
// between the diff and this call makes the checks describe a different tree. The seat cannot tell
// those apart from the SHA alone, so the line does.
describe('fetchCiEvidence — the head line says whether the SHA was pinned or resolved', () => {
  it('marks a head it resolved itself', () => {
    const gh = fakeGh({ ...happy, [`pr view 7 -R ${SLUG} --json headRefOid`]: { headRefOid: SHA } });
    const res = fetchCiEvidence({ gh, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text.split('\n')[0]).toBe(
      `Head commit: ${SHA} (resolved when the evidence was gathered — the reviewed diff carries no commit identity, so a push in between can make them differ)`
    );
  });

  it('leaves the line bare when the caller pinned the head', () => {
    const res = fetchCiEvidence({ gh: fakeGh(happy), headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text.split('\n')[0]).toBe(`Head commit: ${SHA}`);
  });
});

// THE CAP IS SHARED. A head-slice of the rank order spends every annotation slot on the failing
// checks — and the green job's annotation is the exact evidence this module exists for (incident
// 2026-08-10). So the slots interleave: one non-green, one green, non-green first.
describe('fetchCiEvidence — green jobs keep their share of the annotation cap', () => {
  function mixed(): Record<string, unknown> {
    const responses: Record<string, unknown> = {
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
        check_runs: [
          ...Array.from({ length: 8 }, (_, i) => ({
            conclusion: 'failure',
            id: 900 + i,
            name: `failed-${i}`,
            output: { annotations_count: 1, summary: null, title: null },
            status: 'completed',
          })),
          ...Array.from({ length: 4 }, (_, i) => ({
            conclusion: 'success',
            id: 950 + i,
            name: `green-${i}`,
            output: { annotations_count: 1, summary: null, title: null },
            status: 'completed',
          })),
        ],
      },
      [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
    };
    for (let i = 0; i < 8; i += 1) {
      responses[`api repos/${SLUG}/check-runs/${900 + i}/annotations`] = [
        { annotation_level: 'failure', message: `failed job ${i} said no`, path: `src/f${i}.ts`, start_line: 1 },
      ];
    }
    for (let i = 0; i < 4; i += 1) {
      responses[`api repos/${SLUG}/check-runs/${950 + i}/annotations`] = [
        { annotation_level: 'warning', message: `green job ${i} wrapped an error`, path: `src/g${i}.ts`, start_line: 1 },
      ];
    }
    return responses;
  }

  it('fetches and renders EVERY green annotated check under a cap of 10, dropping failed ones', () => {
    const calls: string[] = [];
    const res = fetchCiEvidence({ gh: fakeGh(mixed(), calls), headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // All four green checks were fetched AND rendered.
    for (let i = 0; i < 4; i += 1) {
      expect(calls).toContain(`api repos/${SLUG}/check-runs/${950 + i}/annotations?per_page=50`);
      expect(res.text).toContain(`green job ${i} wrapped an error`);
    }
    // The cap still bought exactly 10 fetches, and 12 - 10 = 2 checks went unfetched…
    expect(calls.filter((c) => c.includes('/annotations')).length).toBe(10);
    expect(res.text).toContain('2 annotated check(s) not fetched (cap: maxAnnotationChecks)');
    // …and the two that lost their slot are FAILED checks — the tail of the rank order.
    for (let i = 0; i < 6; i += 1) expect(res.text).toContain(`failed job ${i} said no`);
    expect(res.text).not.toContain('failed job 6 said no');
    expect(res.text).not.toContain('failed job 7 said no');
    expect(res.truncated).toBe(true);
  });
});

// A URL in this section is the human's pointer to the check page — so it is rendered only when it
// IS one. A `javascript:`/`data:` value is not a check page, and a CI link's query string
// routinely carries a signed token that has no business in a packet handed to four vendors.
describe('fetchCiEvidence — URLs render only as http(s), without query or fragment', () => {
  it('strips ?query and #fragment, and omits a non-http scheme entirely', () => {
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
        check_runs: [
          {
            conclusion: 'failure',
            details_url: 'https://ci.example.com/run/1?token=abc#x',
            id: 1101,
            name: 'has-a-url',
            output: { annotations_count: 0, summary: null, title: null },
            status: 'completed',
          },
          {
            conclusion: 'failure',
            details_url: 'javascript:alert(1)',
            id: 1102,
            name: 'has-a-scheme',
            output: { annotations_count: 0, summary: null, title: null },
            status: 'completed',
          },
        ],
      },
      [`api repos/${SLUG}/commits/${SHA}/status`]: {
        state: 'failure',
        statuses: [
          { context: 'bot', description: 'd', state: 'failure', target_url: 'https://bot.example/1?sig=deadbeef#frag' },
        ],
      },
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('https://ci.example.com/run/1');
    expect(res.text).not.toContain('token=abc');
    expect(res.text).not.toContain('#x');
    // The check itself is still rendered — only its unusable URL is gone.
    expect(res.text).toContain('has-a-scheme');
    expect(res.text).not.toContain('javascript:');
    expect(res.text).toContain('https://bot.example/1');
    expect(res.text).not.toContain('sig=deadbeef');
    expect(res.text).not.toContain('#frag');
  });
});

// THE ONE BOTH-FIELDS RULE. `ciEvidence` and `ciEvidenceUnavailable` are mutually exclusive by
// contract, and every consumer used to decide for itself what "both" meant — the engine dropped
// the text, the worktree producer preferred it. Two seats reading different accounts of the same
// head is the failure mode, so the rule lives HERE and every seam calls it.
describe('resolveCiEvidence — one rule, at the exported boundary', () => {
  it('BOTH supplied ⇒ unavailable, naming the contradiction rather than either half', () => {
    expect(resolveCiEvidence('## Check runs\n- failure · lint', 'gh is not on PATH')).toEqual({
      kind: 'unavailable',
      reason: CI_EVIDENCE_BOTH_REASON,
    });
    expect(CI_EVIDENCE_BOTH_REASON).toBe(
      'caller supplied both CI evidence and an unavailability reason — treated as unavailable'
    );
  });

  it('text alone is text; a reason alone is that reason, verbatim', () => {
    expect(resolveCiEvidence('evidence', undefined)).toEqual({ kind: 'text', text: 'evidence' });
    expect(resolveCiEvidence(undefined, 'HTTP 403')).toEqual({ kind: 'unavailable', reason: 'HTTP 403' });
  });

  it('neither ⇒ none — no fetch was attempted, so the section must not exist', () => {
    expect(resolveCiEvidence(undefined, undefined)).toEqual({ kind: 'none' });
  });

  // An empty string renders nothing a reviewer can read; treating it as present makes a section
  // that says nothing, which reads exactly like a head with no checks.
  it('an empty / whitespace-only string is ABSENT, on either side', () => {
    expect(resolveCiEvidence('', '')).toEqual({ kind: 'none' });
    expect(resolveCiEvidence('   \n\t ', undefined)).toEqual({ kind: 'none' });
    expect(resolveCiEvidence(undefined, '  ')).toEqual({ kind: 'none' });
    // …so an empty text beside a real reason is a SINGLE field, not a contradiction.
    expect(resolveCiEvidence('  ', 'HTTP 403')).toEqual({ kind: 'unavailable', reason: 'HTTP 403' });
    expect(resolveCiEvidence('evidence', '   ')).toEqual({ kind: 'text', text: 'evidence' });
  });
});

// THE COMMIT-STATUS PAGE CAP. The legacy endpoint pages like every other: a commit with more
// statuses than a page returns a truncated array, and nothing in the array says so. A busy repo
// (one status per bot, per environment, per deploy) reaches that cap.
describe('fetchCiEvidence — the commit-status page cap is stated, never rendered as the whole', () => {
  const statusPayload = (extra: Record<string, unknown>): Record<string, unknown> => ({
    [`api repos/${SLUG}/commits/${SHA}/check-runs`]: { check_runs: [] },
    [`api repos/${SLUG}/commits/${SHA}/status`]: {
      state: 'success',
      statuses: [{ context: 'review-bot', description: 'ok', state: 'success' }],
      ...extra,
    },
  });

  it('says how many statuses the API page cap left unfetched', () => {
    const res = fetchCiEvidence({
      gh: fakeGh(statusPayload({ total_count: 140 })),
      headSha: SHA,
      pr: 7,
      repoSlug: SLUG,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('… 139 status(es) not fetched (API page cap)');
    expect(res.truncated).toBe(true);
  });

  it('ignores a total_count that is missing, non-numeric, or lower than the page it returned', () => {
    for (const total of [undefined, 'many', Number.NaN, 0]) {
      const res = fetchCiEvidence({
        gh: fakeGh(statusPayload(total === undefined ? {} : { total_count: total })),
        headSha: SHA,
        pr: 7,
        repoSlug: SLUG,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.text).toContain('review-bot');
      expect(res.text).not.toContain('status(es) not fetched (API page cap)');
    }
  });
});

// A DROPPED ELEMENT is not the same fact as an empty array. "(no check runs on this commit)" and
// "(none)" are CLAIMS ABOUT THE COMMIT; making either out of a payload this module could not read
// is the false green the whole section exists to prevent — one level below the top-level shape
// guard, which only sees whether the field was an array at all.
describe('fetchCiEvidence — junk elements are traced, never read as "nothing ran"', () => {
  it('an array of only junk reports the SHAPE, never "no check runs on this commit"', () => {
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: { check_runs: [null, 1, 'x'] },
      [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.checks).toBe(0);
    expect(res.text).toContain('(check runs unavailable: unexpected payload shape)');
    expect(res.text).not.toContain('(no check runs on this commit)');
    expect(res.truncated).toBe(true);
  });

  it('counts the drops on its own line when SOME elements survived', () => {
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
        check_runs: [
          null,
          'x',
          { conclusion: 'failure', id: 1201, name: 'real-check', output: null, status: 'completed' },
        ],
      },
      [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('real-check');
    expect(res.text).toContain('… 2 check run(s) dropped (unexpected element shape)');
    // The header's `N total` is true of what was RENDERED; the line above says what it is missing.
    expect(res.text).toContain('Check runs: 1 total');
    expect(res.truncated).toBe(true);
  });

  it('holds statuses to the SAME rule — junk elements are dropped, counted, and never "(none)"', () => {
    const onlyJunk = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: { check_runs: [] },
      [`api repos/${SLUG}/commits/${SHA}/status`]: { state: 'success', statuses: [null, 2, 'x'] },
    });
    const a = fetchCiEvidence({ gh: onlyJunk, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.text).toContain('(statuses unavailable: unexpected payload shape)');
    expect(a.text).not.toContain('(none)');

    const mixed = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: { check_runs: [] },
      [`api repos/${SLUG}/commits/${SHA}/status`]: {
        state: 'success',
        statuses: [null, 'x', { context: 'review-bot', description: 'ok', state: 'success' }],
      },
    });
    const b = fetchCiEvidence({ gh: mixed, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.text).toContain('review-bot');
    expect(b.text).toContain('… 2 status(es) dropped (unexpected element shape)');
    // A junk element must never render as a row that reads like a real status.
    expect(b.text).not.toContain('- unknown · (unnamed status)');
    expect(b.truncated).toBe(true);
  });

  // A page that held EVERYTHING (`total_count` matches the raw element count) must not also be
  // read as a page the cap cut short: the junk element is counted once, as a drop, never twice.
  it('a page that held everything, with one junk element, is a drop — not ALSO a page-cap miss', () => {
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: { check_runs: [] },
      [`api repos/${SLUG}/commits/${SHA}/status`]: {
        state: 'success',
        statuses: [
          { context: 'review-bot', description: 'ok', state: 'success' },
          null,
          { context: 'other-bot', description: 'ok', state: 'success' },
        ],
        total_count: 3,
      },
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).not.toContain('status(es) not fetched (API page cap)');
    expect(res.text).toContain('… 1 status(es) dropped (unexpected element shape)');
  });
});

// SCAN BEFORE TRUNCATION. Slicing first leaves a PREFIX of a live credential that no pattern
// matches — so the whole-text scan then sees a string it cannot recognise and passes the section
// through. The scan runs on the FULL collapsed value; only a clean value is ever sliced.
describe('fetchCiEvidence — a field is scanned whole, then truncated', () => {
  it('redacts a token that the field cap would have sliced into an unrecognisable prefix', () => {
    const summary = `${'x'.repeat(495)} ghp_${'A'.repeat(36)}`;
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
        check_runs: [
          {
            conclusion: 'failure',
            id: 1301,
            name: 'leaky',
            output: { annotations_count: 0, summary, title: null },
            status: 'completed',
          },
        ],
      },
      [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('summary: [redacted: github-token]');
    // Not even the 4-char head of the token survives — the old slice(500) landed exactly there.
    expect(res.text).not.toContain('ghp_');
    expect(res.text).not.toContain('x'.repeat(495));
  });

  // CI output is LEAKIER than a diff: it is machine-printed, so it echoes the request headers and
  // the tokens a step exported. Those shapes are scanned here and NOT on the diff.
  const CI_LEAKS: [string, string][] = [
    ['aws-access-key', 'configured AKIAIOSFODNN7EXAMPLE for the deploy step'],
    ['bearer-token', 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"'],
    [
      'jwt',
      'session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N-XgL0n3I9PlFUP0THsR8U',
    ],
    ['slack-token', 'notify failed for xoxb-1234567890-abcdefghij'],
    ['url-credentials', 'npm ERR! fetch https://ci:hunter2xyz@registry.example/pkg failed'],
  ];

  for (const [label, leak] of CI_LEAKS) {
    it(`redacts ${label} inside an annotation message`, () => {
      const gh = fakeGh({
        ...happy,
        [`api repos/${SLUG}/check-runs/102/annotations`]: [
          { ...WARNING_WRAPPING_AN_ERROR[0], message: leak },
        ],
      });
      const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.text).toContain(`[redacted: ${label}]`);
      // The value itself never reaches the packet — only its kind.
      expect(res.text).not.toContain(leak.split(' ').find((w) => w.length > 18) ?? leak);
      // …and the surrounding evidence survives: a redaction costs a FIELD, not the section.
      expect(res.text).toContain('eslint exited 1: 3 problems');
    });
  }
});

// The URL is the one field that used to reach `oneLine` (slice-then-render) without going through
// `field()`'s scan-before-truncate rule — so a credential past the cap's edge was sliced away
// UNSCANNED, and the whole-text scan at the end then saw only a harmless-looking prefix.
describe('fetchCiEvidence — a URL is scanned whole, then truncated (the same rule as field())', () => {
  it('drops a details_url whose credential the 300-char cap would otherwise slice away unscanned', () => {
    const url = `https://ci.example.com/run/${'x'.repeat(280)}/ghp_${'A'.repeat(36)}`;
    const gh = fakeGh({
      [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
        check_runs: [
          {
            conclusion: 'failure',
            details_url: url,
            id: 1501,
            name: 'leaky-url',
            output: { annotations_count: 0, summary: null, title: null },
            status: 'completed',
          },
        ],
      },
      [`api repos/${SLUG}/commits/${SHA}/status`]: STATUSES,
    });
    const res = fetchCiEvidence({ gh, headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // The check itself still renders — only its tainted URL is gone, not the whole section.
    expect(res.text).toContain('leaky-url');
    expect(res.text).not.toContain('ghp_');
    expect(res.text).not.toContain('https://ci.example.com/run/xxx');
  });
});

// A URL in this section is the human's pointer to the check page. `HTTPS://…` is the same address
// a case-sensitive prefix test threw away, and a URL whose AUTHORITY carries userinfo is a
// credential the packet must not hold — rendering the host without it would fabricate a different
// URL than the payload actually held, so the whole value is dropped.
describe('fetchCiEvidence — URL scheme is case-insensitive and userinfo is rejected', () => {
  const withUrls = (details: string, target: string): Record<string, unknown> => ({
    [`api repos/${SLUG}/commits/${SHA}/check-runs`]: {
      check_runs: [
        {
          conclusion: 'failure',
          details_url: details,
          id: 1401,
          name: 'has-a-url',
          output: { annotations_count: 0, summary: null, title: null },
          status: 'completed',
        },
      ],
    },
    [`api repos/${SLUG}/commits/${SHA}/status`]: {
      state: 'failure',
      statuses: [{ context: 'bot', description: 'd', state: 'failure', target_url: target }],
    },
  });

  it('keeps an UPPERCASE scheme, still without its query or fragment', () => {
    const res = fetchCiEvidence({
      gh: fakeGh(withUrls('HTTPS://Example.com/x?y#z', 'HtTp://Example.com/s?q=1')),
      headSha: SHA,
      pr: 7,
      repoSlug: SLUG,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('HTTPS://Example.com/x');
    expect(res.text).not.toContain('?y');
    expect(res.text).not.toContain('#z');
    expect(res.text).toContain('HtTp://Example.com/s');
    expect(res.text).not.toContain('q=1');
  });

  it('omits a URL whose authority carries userinfo — the check itself still renders', () => {
    const res = fetchCiEvidence({
      gh: fakeGh(withUrls('https://user:tok@host/p', 'https://deploy:key@bot.example/1')),
      headSha: SHA,
      pr: 7,
      repoSlug: SLUG,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('has-a-url');
    expect(res.text).toContain('bot');
    expect(res.text).not.toContain('@');
    expect(res.text).not.toContain('tok');
    expect(res.text).not.toContain('key');
  });

  // The `@` must be read in the AUTHORITY only: a path segment carrying one is an ordinary URL
  // (a scoped npm package, a pinned ref) and rejecting it would drop a usable link.
  it('keeps a URL whose `@` is in the PATH, not the authority', () => {
    const res = fetchCiEvidence({
      gh: fakeGh(withUrls('https://ci.example/pkg/@scope/name', 'https://bot.example/1')),
      headSha: SHA,
      pr: 7,
      repoSlug: SLUG,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain('https://ci.example/pkg/@scope/name');
  });
});
