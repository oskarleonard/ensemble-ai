import { describe, expect, it, vi } from 'vitest';

import type { ReviewFinding, StoredReview } from '../../core/types';

import type { GateVerdictRecord } from './gate';
import {
  capComment,
  GITHUB_COMMENT_MAX,
  type PostRunner,
  postReviewComment,
  postTargetFromSelection,
  renderReviewComment,
  type RenderCommentInput,
} from './post-comment';
import type { ClaudeLayerResult } from './self-contained';
import type { DiffSourceSelection } from './source';
import type { ReviewSynthesis } from './synthesis';

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    body: 'b',
    confidence: 'high',
    evidence: { file: 'src/a.ts', line: 12 },
    id: 'f1',
    severity: 'high',
    title: 'Unbounded read',
    ...over,
  };
}

function stored(over: Partial<StoredReview> = {}): StoredReview {
  return {
    findings: [finding()],
    packet: { complete: true, manifest: [] },
    reviewer: { effort: 'high', model: 'gpt-5', vendor: 'openai' },
    reviewerId: 'codex',
    runId: 'r',
    summary: 's',
    terminalState: 'reviewed',
    ...over,
  };
}

const SYNTHESIS: ReviewSynthesis = {
  agreements: [{ point: 'The read is unbounded', voices: ['codex', 'grok'] }],
  bottomLine: 'Fix the unbounded read before merge.',
  by: 'claude',
  degraded: false,
  disagreements: [{ point: 'Is the cache safe?', positions: ['codex: no', 'grok: yes'] }],
  error: undefined,
  ok: true,
  raw: null,
  summary: 'One real HIGH, one look-closer.',
};

function gateRecord(over: Partial<GateVerdictRecord> = {}): GateVerdictRecord {
  return {
    downgradeReason: null,
    effectiveVerdict: 'agree',
    file: 'src/a.ts',
    findingId: 'codex#1',
    line: 12,
    rawVerdict: 'agree',
    reason: 'confirmed against the hunk',
    reviewer: 'codex',
    severity: 'high',
    title: 'Unbounded read',
    ...over,
  };
}

function claudeLayer(over: Partial<ClaudeLayerResult> = {}): ClaudeLayerResult {
  return {
    claudeReview: {
      findings: [finding({ evidence: { file: 'src/b.ts', line: 3 }, id: 'f1', severity: 'medium', title: 'Naming' })],
      ok: true,
      summary: 'ok',
      voiceId: 'claude',
    },
    gateTrailWritten: true,
    gateVerdicts: [
      gateRecord(),
      gateRecord({ effectiveVerdict: 'false', findingId: 'grok#1', reason: 'refuted — the bound exists on line 9', reviewer: 'grok', title: 'Missing bound' }),
      gateRecord({ effectiveVerdict: 'unverified', findingId: 'claude#1', reason: 'could not ground', reviewer: 'claude', severity: 'medium', title: 'Naming' }),
    ],
    modelLabel: 'opus',
    synthesis: SYNTHESIS,
    ...over,
  };
}

function renderInput(over: Partial<RenderCommentInput> = {}): RenderCommentInput {
  return {
    claudeLayer: claudeLayer(),
    gateSeat: { effort: 'high', effortSource: 'flag', model: 'opus', modelSource: 'default' },
    headSha: 'abc1234',
    headline: 'codex 1H · grok 1H · claude clean · receipt sha256:deadbeef…',
    profile: 'code',
    receipt: {
      completed: ['codex', 'grok', 'claude'],
      digest: 'sha256:deadbeefcafe…',
      error: null,
      path: '/tmp/trail/receipt.json',
      vendors: ['openai', 'xai', 'anthropic/opus'],
    },
    repoId: 'oskarleonard/ensemble-ai',
    reviews: [stored(), stored({ findings: [], reviewerId: 'grok', reviewer: { effort: 'high', model: 'grok-4', vendor: 'xai' }, summary: 'no findings' })],
    trailDir: '/tmp/trail/run-1',
    ...over,
  };
}

describe('postTargetFromSelection', () => {
  it('a bare --pr N → the cwd repo (no repoSlug)', () => {
    const sel: DiffSourceSelection = { kind: 'pr', pr: 12 };
    expect(postTargetFromSelection(sel)).toEqual({ pr: 12 });
  });

  it('a URL PR → owner/repo slug (postable from any cwd)', () => {
    const sel: DiffSourceSelection = { kind: 'pr', owner: 'o', pr: 7, repo: 'r' };
    expect(postTargetFromSelection(sel)).toEqual({ pr: 7, repoSlug: 'o/r' });
  });

  it.each<DiffSourceSelection>([
    { kind: 'working-tree' },
    { kind: 'staged' },
    { kind: 'commit' },
    { kind: 'stdin' },
    { diffFile: 'x.diff', kind: 'diff-file' },
  ])('a non-PR source (%o) has NO postable target', (sel) => {
    expect(postTargetFromSelection(sel)).toBeNull();
  });
});

describe('renderReviewComment', () => {
  it('renders the full comment: synthesis + gate verdicts + per-reviewer findings + footer', () => {
    const body = renderReviewComment(renderInput());
    // header + headline
    expect(body).toContain('## 🔭 ensemble-ai review — cross-vendor review');
    expect(body).toContain('codex 1H · grok 1H · claude clean');
    expect(body).toContain('head `abc1234`');
    // synthesis
    expect(body).toContain('### Synthesis (by claude)');
    expect(body).toContain('**✓ Agree (confident)**');
    expect(body).toContain('The read is unbounded');
    expect(body).toContain('_[codex, grok]_');
    expect(body).toContain('**⚠ Disagree (look closer)**');
    expect(body).toContain('**→ Bottom line**');
    expect(body).toContain('Fix the unbounded read before merge.');
    // gate verdict tags — `false` renders as `false-dismissed`, with reasons
    expect(body).toContain('### Gate — grounded verdicts');
    expect(body).toContain('**[agree]** `codex#1`');
    expect(body).toContain('**[false-dismissed]** `grok#1`');
    expect(body).toContain('refuted — the bound exists on line 9');
    expect(body).toContain('**[unverified]** `claude#1`');
    expect(body).toContain('1 agree · 0 partial · 1 false (dismissed) · 1 unverified');
    // per-reviewer findings grouped by severity
    expect(body).toContain('### Findings by reviewer');
    expect(body).toContain('#### codex — reviewed');
    expect(body).toContain('**HIGH**');
    expect(body).toContain('`src/a.ts:12` — Unbounded read');
    expect(body).toContain('#### grok — reviewed');
    expect(body).toContain('_no findings_');
    // the cold Opus reviewer is a peer, rendered from the claude layer
    expect(body).toContain('#### claude — reviewed');
    // footer: trail + receipt + gate seat
    expect(body).toContain('trail `/tmp/trail/run-1`');
    expect(body).toContain('receipt `/tmp/trail/receipt.json`');
    expect(body).toContain('gate seat anthropic/opus @ high (model: default, effort: flag)');
  });

  it('security profile tags findings by class and labels the header', () => {
    const body = renderReviewComment(
      renderInput({
        profile: 'security',
        reviews: [stored({ findings: [finding({ title: 'SQL injection in query' })] })],
      })
    );
    expect(body).toContain('## 🔭 ensemble-ai security — cross-vendor review');
    // a security-class tag is prepended (classifySecurityFinding)
    expect(body).toMatch(/\[[a-z-]+\] SQL injection in query/);
  });

  it('omits synthesis + gate sections when the Opus layer did not run (--no-claude)', () => {
    const body = renderReviewComment(renderInput({ claudeLayer: null, gateSeat: null }));
    expect(body).not.toContain('### Synthesis');
    expect(body).not.toContain('### Gate — grounded verdicts');
    expect(body).toContain('### Findings by reviewer');
    expect(body).toContain('gate seat n/a (no gate ran)');
  });

  it('a failed reviewer renders its summary honestly, not a silent drop', () => {
    const body = renderReviewComment(
      renderInput({
        claudeLayer: null,
        gateSeat: null,
        reviews: [stored({ summary: 'grok timed out after 300s', terminalState: 'failed-reviewer' })],
      })
    );
    expect(body).toContain('#### codex — failed');
    expect(body).toContain('grok timed out after 300s');
  });

  it('renders a "none" receipt line when no receipt was minted', () => {
    const body = renderReviewComment(
      renderInput({ receipt: { completed: [], digest: null, error: 'review INCOMPLETE', path: null, vendors: [] } })
    );
    expect(body).toContain('receipt none — review INCOMPLETE');
  });
});

describe('capComment', () => {
  it('leaves a body under the limit untouched', () => {
    const body = 'short body';
    expect(capComment(body, '/tmp/t')).toBe(body);
  });

  it('truncates an over-limit body with a NAMED marker pointing at the trail', () => {
    const big = 'x'.repeat(500);
    const capped = capComment(big, '/tmp/trail/run-1', 200);
    expect(capped.length).toBeLessThanOrEqual(200);
    expect(capped).toContain('⚠ Comment truncated by ensemble-ai');
    expect(capped).toContain('/tmp/trail/run-1');
  });

  it('defaults to GitHub’s real comment limit', () => {
    expect(GITHUB_COMMENT_MAX).toBe(65536);
  });
});

describe('postReviewComment (injectable exec)', () => {
  it('builds the gh argv with -R for a URL PR and pipes the body to stdin', () => {
    const seen: { args: string[]; body: string }[] = [];
    const run: PostRunner = (args, body) => {
      seen.push({ args, body });
      return { ok: true, url: 'https://github.com/o/r/pull/7#issuecomment-1' };
    };
    const log = vi.fn();
    const res = postReviewComment('BODY', { pr: 7, repoSlug: 'o/r' }, { cmd: 'review', log, run });
    expect(res.ok).toBe(true);
    expect(seen[0].args).toEqual(['pr', 'comment', '7', '-R', 'o/r', '--body-file', '-']);
    expect(seen[0].body).toBe('BODY');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('posted the review to o/r PR #7'));
  });

  it('omits -R for a bare --pr N (targets the cwd repo)', () => {
    const seen: string[][] = [];
    const run: PostRunner = (args) => {
      seen.push(args);
      return { ok: true };
    };
    postReviewComment('BODY', { pr: 12 }, { run });
    expect(seen[0]).toEqual(['pr', 'comment', '12', '--body-file', '-']);
  });

  it('DEGRADES loudly on a gh failure — returns {ok:false}, warns, states the exit code is unaffected', () => {
    const run: PostRunner = () => ({ error: 'gh: not authenticated', ok: false });
    const log = vi.fn();
    const res = postReviewComment('BODY', { pr: 7, repoSlug: 'o/r' }, { cmd: 'security', log, run });
    expect(res).toEqual({ error: 'gh: not authenticated', ok: false });
    const warned = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('⚠ --post-comment: could NOT post to o/r PR #7');
    expect(warned).toContain('gh: not authenticated');
    expect(warned).toContain('exit code are unaffected');
  });

  it('NEVER throws even if the runner itself throws (posting can never crash the review)', () => {
    const run: PostRunner = () => {
      throw new Error('spawn gh ENOENT');
    };
    const log = vi.fn();
    let res: ReturnType<typeof postReviewComment> | undefined;
    expect(() => {
      res = postReviewComment('BODY', { pr: 1 }, { log, run });
    }).not.toThrow();
    expect(res).toEqual({ error: 'spawn gh ENOENT', ok: false });
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('could NOT post');
  });
});
