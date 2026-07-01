import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ReviewerId, StoredReview } from '../../core/types';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';

import type { VoiceReview } from './synthesis';
import {
  enforceTrailBoundary,
  isUnderWorkPath,
  renderClaudeLayer,
  resolveReviewRoster,
  runClaudeReviewLayer,
  storedToVoiceReview,
  synthesizeReviews,
  trailBoundaryViolation,
} from './with-claude';

const CFG: VoiceConfig = { cmd: 'claude', effort: 'default', id: 'claude', model: 'default', vendor: 'anthropic' };

const okRun = (raw: string): VoiceRunResult => ({ ok: true, raw, stderrTail: '', timedOut: false });

const CLAUDE_REVIEW = JSON.stringify({
  findings: [
    { body: 'b', confidence: 'high', evidence: { file: 'src/x.ts', line: 3 }, severity: 'medium', title: 'claude bug' },
  ],
  summary: 'claude read',
});
const SYNTH = JSON.stringify({
  agreements: [{ point: 'shared bug', voices: ['codex', 'claude'] }],
  bottomLine: 'fix then merge',
  disagreements: [],
  sanityChecks: [{ finding: 'shared bug', note: 'concur', verdict: 'likely-real' }],
  summary: 'ok',
});

// A stub claude runner that branches on the round (synthesis prompts say "SYNTHESIZER").
function makeRunner(opts: {
  onReview?: () => VoiceRunResult | Promise<VoiceRunResult>;
  onSynth?: () => VoiceRunResult | Promise<VoiceRunResult>;
} = {}) {
  const calls: Array<{ prompt: string; round: 'review' | 'synth' }> = [];
  const run = async (prompt: string): Promise<VoiceRunResult> => {
    const round = prompt.includes('SYNTHESIZER') ? 'synth' : 'review';
    calls.push({ prompt, round });
    if (round === 'synth') return (await opts.onSynth?.()) ?? okRun(SYNTH);
    return (await opts.onReview?.()) ?? okRun(CLAUDE_REVIEW);
  };
  return { calls, run };
}

function stored(id: ReviewerId, over: Partial<StoredReview> = {}): StoredReview {
  return {
    findings: [
      { body: 'b', confidence: 'high', evidence: { file: 'src/x.ts', line: 3 }, id: 'f1', severity: 'high', title: 'shared bug' },
    ],
    packet: { complete: true, manifest: [] },
    reviewer: { effort: 'high', model: 'm', vendor: id },
    reviewerId: id,
    runId: 'r',
    summary: `${id} summary`,
    terminalState: 'reviewed',
    ...over,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('resolveReviewRoster — registry-driven, --reviewers subsets, fail-closed', () => {
  it('no --reviewers → full core; claude only when --with-claude', () => {
    expect(resolveReviewRoster(undefined, false)).toEqual({ claude: false, core: ['codex', 'grok'] });
    expect(resolveReviewRoster(undefined, true)).toEqual({ claude: true, core: ['codex', 'grok'] });
  });

  it('--reviewers subsets the roster, and "claude" is a valid id only with --with-claude', () => {
    expect(resolveReviewRoster(['codex'], true)).toEqual({ claude: false, core: ['codex'] });
    expect(resolveReviewRoster(['codex', 'claude'], true)).toEqual({ claude: true, core: ['codex'] });
    expect(resolveReviewRoster(['grok', 'claude'], true)).toEqual({ claude: true, core: ['grok'] });
  });

  it('fails closed on a typo, and on "claude" without --with-claude (with a hint)', () => {
    expect(resolveReviewRoster(['codex', 'grokk'], true)).toMatchObject({ error: expect.stringContaining('grokk') });
    const noFlag = resolveReviewRoster(['claude'], false);
    expect(noFlag).toMatchObject({ error: expect.stringContaining('--with-claude') });
  });

  it('requires ≥1 cross-vendor core (claude is additive, not standalone)', () => {
    expect(resolveReviewRoster(['claude'], true)).toMatchObject({ error: expect.stringContaining('at least one') });
  });
});

describe('storedToVoiceReview', () => {
  it('maps terminalState → ok and carries findings/summary/voiceId', () => {
    expect(storedToVoiceReview(stored('codex'))).toMatchObject({ ok: true, voiceId: 'codex' });
    expect(storedToVoiceReview(stored('grok', { terminalState: 'failed-reviewer' })).ok).toBe(false);
  });
});

describe('synthesizeReviews — injected runner, deterministic degrade', () => {
  const reviews: VoiceReview[] = [
    { findings: [], ok: true, summary: 'codex', voiceId: 'codex' },
    { findings: [], ok: true, summary: 'grok', voiceId: 'grok' },
    { findings: [], ok: true, summary: 'claude', voiceId: 'claude' },
  ];

  it('parses a conforming synthesis into the agree/disagree/sanity/bottom-line structure', async () => {
    const { run } = makeRunner();
    const s = await synthesizeReviews(reviews, run, CFG);
    expect(s.degraded).toBe(false);
    expect(s.by).toBe('claude');
    expect(s.agreements[0].voices).toEqual(['codex', 'claude']);
    expect(s.sanityChecks[0].verdict).toBe('likely-real');
    expect(s.bottomLine).toBe('fix then merge');
  });

  it('DEMOTES a fabricated agreement (a phantom voice / <2 real voices) to look-closer', async () => {
    // SYNTH credits ['codex','claude'] — run it with ONLY codex present, so "claude" is a
    // phantom voice and the agreement no longer clears the ≥2-real-voices bar.
    const { run } = makeRunner();
    const s = await synthesizeReviews(
      [{ findings: [], ok: true, summary: 'codex', voiceId: 'codex' }],
      run,
      CFG
    );
    expect(s.agreements).toHaveLength(0);
    expect(s.disagreements.some((d) => d.point === 'shared bug')).toBe(true);
  });

  it('degrades to the deterministic fallback when the synthesizer throws / is empty / unparseable', async () => {
    for (const onSynth of [
      () => { throw new Error('boom'); },
      (): VoiceRunResult => ({ ok: false, raw: null, stderrTail: '', timedOut: false }),
      () => okRun('not json'),
    ]) {
      const { run } = makeRunner({ onSynth });
      const s = await synthesizeReviews(reviews, run, CFG);
      expect(s.degraded).toBe(true);
      expect(s.by).toBeNull();
      expect(s.error).toBeTruthy();
    }
  });

  it('falls back without calling the model when no voice is healthy', async () => {
    const { calls, run } = makeRunner();
    const s = await synthesizeReviews([{ findings: [], ok: false, summary: '', voiceId: 'codex' }], run, CFG);
    expect(s.degraded).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe('runClaudeReviewLayer — cold claude reviewer + synthesis, graceful degrade', () => {
  it('runs the claude reviewer when in the roster, then synthesizes all voices', async () => {
    const { calls, run } = makeRunner();
    const res = await runClaudeReviewLayer({
      claudeConfig: CFG,
      coreReviews: [stored('codex'), stored('grok')],
      includeClaudeReviewer: true,
      reviewPrompt: 'REVIEW PROMPT PAYLOAD',
      run,
    });
    expect(res.claudeReview?.ok).toBe(true);
    expect(res.claudeReview?.findings[0].title).toBe('claude bug');
    expect(res.synthesis.degraded).toBe(false);
    // one review call + one synth call
    expect(calls.map((c) => c.round)).toEqual(['review', 'synth']);
  });

  it('a failed claude reviewer degrades to ok:false but synthesis still runs over codex+grok', async () => {
    const { run } = makeRunner({ onReview: () => { throw new Error('cli missing'); } });
    const res = await runClaudeReviewLayer({
      claudeConfig: CFG,
      coreReviews: [stored('codex'), stored('grok')],
      includeClaudeReviewer: true,
      reviewPrompt: 'REVIEW PROMPT PAYLOAD',
      run,
    });
    expect(res.claudeReview?.ok).toBe(false);
    expect(res.synthesis.degraded).toBe(false); // codex+grok still synthesized
  });

  it('skips the claude reviewer when not in the roster (claudeReview=null)', async () => {
    const { calls, run } = makeRunner();
    const res = await runClaudeReviewLayer({
      claudeConfig: CFG,
      coreReviews: [stored('codex'), stored('grok')],
      includeClaudeReviewer: false,
      reviewPrompt: 'REVIEW PROMPT PAYLOAD',
      run,
    });
    expect(res.claudeReview).toBeNull();
    expect(calls.map((c) => c.round)).toEqual(['synth']);
  });
});

describe('trail boundary guard — a _work repo\'s trail is fenced out of the brain (item 4)', () => {
  const brainRoots = ['/home/o/brain', '/home/o/programming/projects/_personal/my-brain'];

  it('isUnderWorkPath detects the _work fence', () => {
    expect(isUnderWorkPath('/home/o/programming/projects/_work/lisk-app')).toBe(true);
    expect(isUnderWorkPath('/home/o/programming/projects/_personal/levmeup')).toBe(false);
  });

  it('violation only when a _work repo would write INTO a brain root', () => {
    expect(trailBoundaryViolation('/x/_work/repo', '/home/o/brain/journal/runs', brainRoots)).toBe(true);
    expect(trailBoundaryViolation('/x/_work/repo', '/tmp/ensemble-ai/r', brainRoots)).toBe(false);
    expect(trailBoundaryViolation('/x/_personal/repo', '/home/o/brain/x', brainRoots)).toBe(false);
  });

  it('enforceTrailBoundary overrides a brain-bound _work trail to a local temp dir', () => {
    const forced = enforceTrailBoundary('/x/_work/repo', '/home/o/brain/x', 'run7', brainRoots);
    expect(forced.overridden).toBe(true);
    expect(forced.out.startsWith(os.tmpdir())).toBe(true);
    const kept = enforceTrailBoundary('/x/_personal/repo', '/home/o/brain/x', 'run7', brainRoots);
    expect(kept).toEqual({ out: '/home/o/brain/x', overridden: false });
  });
});

describe('renderClaudeLayer — scannable stdout block', () => {
  it('renders the claude findings + the synthesis map', async () => {
    const { run } = makeRunner();
    const res = await runClaudeReviewLayer({
      claudeConfig: CFG,
      coreReviews: [stored('codex'), stored('grok')],
      includeClaudeReviewer: true,
      reviewPrompt: 'PAYLOAD',
      run,
    });
    const text = renderClaudeLayer(res).join('\n');
    expect(text).toContain('claude [anthropic]');
    expect(text).toContain('AGREE (confident)');
    expect(text).toContain('bottom line');
  });
});

describe('REVIEW-ONLY: the layer makes zero writes to a tracked working tree (B8)', () => {
  it('leaves a real git repo clean and performs no fs writes', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ea-review-only-'));
    try {
      execFileSync('git', ['init', '-q'], { cwd: repo });
      execFileSync('git', ['config', 'user.email', 't@t'], { cwd: repo });
      execFileSync('git', ['config', 'user.name', 't'], { cwd: repo });
      fs.writeFileSync(path.join(repo, 'a.ts'), 'export const a = 1;\n');
      execFileSync('git', ['add', '-A'], { cwd: repo });
      execFileSync('git', ['commit', '-qm', 'init'], { cwd: repo });

      const writeSpy = vi.spyOn(fs, 'writeFileSync');
      const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
      const { run } = makeRunner();
      await runClaudeReviewLayer({
        claudeConfig: CFG,
        coreReviews: [stored('codex'), stored('grok')],
        includeClaudeReviewer: true,
        reviewPrompt: 'PAYLOAD',
        run,
      });
      expect(writeSpy).not.toHaveBeenCalled();
      expect(mkdirSpy).not.toHaveBeenCalled();
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
      expect(status.trim()).toBe('');
    } finally {
      fs.rmSync(repo, { force: true, recursive: true });
    }
  });
});
