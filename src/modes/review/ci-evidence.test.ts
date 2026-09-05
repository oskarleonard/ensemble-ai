import { describe, expect, it } from 'vitest';

import { CI_EVIDENCE_LIMITS, fetchCiEvidence } from './ci-evidence';
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
    // Failed check sorts first and carries its output summary; success rows carry none.
    const lint = res.text.indexOf('lint');
    const unit = res.text.indexOf('unit-tests');
    expect(lint).toBeGreaterThan(-1);
    expect(lint).toBeLessThan(unit);
    expect(res.text).toContain('eslint exited 1: 3 problems');
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

  it('WITHHOLDS the whole section when an inline credential pattern appears in check output', () => {
    const leaky = {
      ...happy,
      [`api repos/${SLUG}/check-runs/102/annotations`]: [
        { ...WARNING_WRAPPING_AN_ERROR[0], message: 'debug: GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123' },
      ],
    };
    const res = fetchCiEvidence({ gh: fakeGh(leaky), headSha: SHA, pr: 7, repoSlug: SLUG });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain('withheld');
      expect(res.error).toContain('github-token');
      expect(res.error).not.toContain('ghp_');
    }
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
  it('keeps annotations under a tight budget, stays inside the cap, and counts only what it rendered', () => {
    const res = fetchCiEvidence({
      gh: fakeGh(crowded(12)),
      headSha: SHA,
      limits: { maxChars: 3000 },
      pr: 7,
      repoSlug: SLUG,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text.length).toBeLessThanOrEqual(3000);
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
      `api repos/${SLUG}/commits/${SHA}/status`,
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
    expect(res.text).not.toContain('green summaries are noise');
    expect(res.text.indexOf('novel')).toBeLessThan(res.text.indexOf('aaa-sorts-first'));
  });
});
