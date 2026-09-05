import { describe, expect, it } from 'vitest';

import { CI_EVIDENCE_LIMITS, fetchCiEvidence } from './ci-evidence';
import type { GhRunner } from './stage';

const SHA = 'a'.repeat(40);
const SLUG = 'acme/webapp';

// A fake `gh` keyed on the joined argv — every call the gatherer makes is one entry here.
function fakeGh(responses: Record<string, unknown>, calls: string[] = []): GhRunner {
  return (args) => {
    const key = args.join(' ');
    calls.push(key);
    const hit = Object.entries(responses).find(([k]) => key.startsWith(k));
    if (!hit) return { error: `unexpected gh call: ${key}`, ok: false };
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

  it('exports sane default limits', () => {
    expect(CI_EVIDENCE_LIMITS.maxChars).toBeLessThanOrEqual(16_000);
  });
});
