import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { persistReview, reviewDir } from '../../core/artifacts';
import type { ReviewerId, StoredReview } from '../../core/types';
import type { ReviewPacket, ReviewerConfig } from '../../core/types';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';

import type { VoiceReview } from './synthesis';
import {
  claudeLayerHasHigh,
  loadVoiceReviewsFromTrail,
  renderClaudeLayer,
  resolveReviewRoster,
  runClaudeReviewLayer,
  storedToVoiceReview,
  synthesizeReviews,
} from './self-contained';

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

const PACKET: ReviewPacket = { complete: true, objective: 'o', pr: 0, repo: 'r', sections: [] };

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

// Write the core reviews to a temp trail the way runReviewMode does, so the layer's
// synthesis can read them BACK from disk (the real contract: the core is persisted first).
function seedCoreTrail(baseDir: string, runId: string, reviews: StoredReview[]): void {
  for (const r of reviews) {
    const reviewer: ReviewerConfig = {
      cmd: (r.reviewerId ?? 'codex') as string,
      effort: r.reviewer.effort,
      id: (r.reviewerId ?? 'codex') as ReviewerId,
      model: r.reviewer.model,
      vendor: r.reviewer.vendor,
    };
    persistReview(baseDir, {
      findings: r.findings,
      packet: PACKET,
      prompt: 'PINNED PROMPT',
      raw: JSON.stringify({ findings: r.findings, summary: r.summary }),
      reviewer,
      runId,
      summary: r.summary,
      terminalState: r.terminalState,
    });
  }
}

function tmpTrail(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-sc-'));
}

afterEach(() => vi.restoreAllMocks());

describe('resolveReviewRoster — claude default-on, --no-claude opts out, --reviewers subsets', () => {
  it('no --reviewers → full core; claude on unless --no-claude', () => {
    expect(resolveReviewRoster(undefined, false)).toEqual({ claude: true, core: ['codex', 'grok'] });
    expect(resolveReviewRoster(undefined, true)).toEqual({ claude: false, core: ['codex', 'grok'] });
  });

  it('--reviewers subsets the roster; "claude" is a valid id', () => {
    expect(resolveReviewRoster(['codex'], false)).toEqual({ claude: false, core: ['codex'] });
    expect(resolveReviewRoster(['codex', 'claude'], false)).toEqual({ claude: true, core: ['codex'] });
    expect(resolveReviewRoster(['grok', 'claude'], false)).toEqual({ claude: true, core: ['grok'] });
  });

  it('--no-claude forces the Opus voice off even if "claude" is listed', () => {
    expect(resolveReviewRoster(['codex', 'claude'], true)).toEqual({ claude: false, core: ['codex'] });
  });

  it('fails closed on a typo', () => {
    expect(resolveReviewRoster(['codex', 'grokk'], false)).toMatchObject({ error: expect.stringContaining('grokk') });
  });

  it('requires ≥1 cross-vendor core (claude is additive, not standalone)', () => {
    expect(resolveReviewRoster(['claude'], false)).toMatchObject({ error: expect.stringContaining('at least one') });
  });
});

describe('storedToVoiceReview', () => {
  it('maps terminalState → ok and carries findings/summary/voiceId', () => {
    expect(storedToVoiceReview(stored('codex'))).toMatchObject({ ok: true, voiceId: 'codex' });
    expect(storedToVoiceReview(stored('grok', { terminalState: 'failed-reviewer' })).ok).toBe(false);
  });
});

describe('synthesizeReviews — injected runner, deterministic degrade', () => {
  // Each voice actually RAISED a finding — so a claimed agreement crediting ≥2 of them is
  // corroborated by real per-voice findings (reconcileSynthesis validates against the
  // findings, not merely "the voice reviewed"; a no-findings voice can't corroborate).
  const f = (voiceId: string) => ({
    body: 'b', confidence: 'high' as const, evidence: { file: 'src/x.ts', line: 3 },
    id: 'f1', severity: 'high' as const, title: `${voiceId} bug`,
  });
  const reviews: VoiceReview[] = [
    { findings: [f('codex')], ok: true, summary: 'codex', voiceId: 'codex' },
    { findings: [f('grok')], ok: true, summary: 'grok', voiceId: 'grok' },
    { findings: [f('claude')], ok: true, summary: 'claude', voiceId: 'claude' },
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

describe('runClaudeReviewLayer — 3-reviewer default, per-reviewer files, graceful degrade', () => {
  it('runs the Opus reviewer, writes every review.<id>.md, then synthesizes the trail files', async () => {
    const base = tmpTrail();
    const runId = 'run1';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    const { calls, run } = makeRunner();
    const res = await runClaudeReviewLayer({
      baseDir: base,
      claudeConfig: CFG,
      coreReviews: [stored('codex'), stored('grok')],
      includeClaudeReviewer: true,
      reviewPrompt: 'REVIEW PROMPT PAYLOAD',
      run,
      runId,
    });
    expect(res.claudeReview?.ok).toBe(true);
    expect(res.claudeReview?.findings[0].title).toBe('claude bug');
    expect(res.synthesis.degraded).toBe(false);
    // one review call + one synth call
    expect(calls.map((c) => c.round)).toEqual(['review', 'synth']);
    // per-reviewer files exist in the trail (point 2)
    const dir = reviewDir(base, runId);
    for (const name of ['review.codex.md', 'review.grok.md', 'review.claude.md', 'review.claude.json', 'findings.claude.json']) {
      expect(fs.existsSync(path.join(dir, name)), name).toBe(true);
    }
    // the synthesizer read all THREE voices back from disk
    expect(res.synthesis.agreements[0].voices).toEqual(['codex', 'claude']);
  });

  it('a failed Opus reviewer degrades to ok:false but synthesis still runs over codex+grok', async () => {
    const base = tmpTrail();
    const runId = 'run2';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    const { run } = makeRunner({ onReview: () => { throw new Error('cli missing'); } });
    const res = await runClaudeReviewLayer({
      baseDir: base,
      claudeConfig: CFG,
      coreReviews: [stored('codex'), stored('grok')],
      includeClaudeReviewer: true,
      reviewPrompt: 'REVIEW PROMPT PAYLOAD',
      run,
      runId,
    });
    expect(res.claudeReview?.ok).toBe(false);
    expect(res.synthesis.degraded).toBe(false); // codex+grok still synthesized from the trail
  });

  it('skips the Opus reviewer when not in the roster (claudeReview=null, --no-claude)', async () => {
    const base = tmpTrail();
    const runId = 'run3';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    const { calls, run } = makeRunner();
    const res = await runClaudeReviewLayer({
      baseDir: base,
      claudeConfig: CFG,
      coreReviews: [stored('codex'), stored('grok')],
      includeClaudeReviewer: false,
      reviewPrompt: 'REVIEW PROMPT PAYLOAD',
      run,
      runId,
    });
    expect(res.claudeReview).toBeNull();
    expect(calls.map((c) => c.round)).toEqual(['synth']);
    expect(fs.existsSync(path.join(reviewDir(base, runId), 'review.claude.md'))).toBe(false);
  });

  it('surfaces a claude reviewer PARSE failure as failed, not a masked model summary', async () => {
    const base = tmpTrail();
    const runId = 'runPF';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    // A reply with a summary but NO findings array is not a conforming review → parseError.
    // It must read as FAILED, never dressed up with the model's own summary text.
    const { run } = makeRunner({ onReview: () => okRun(JSON.stringify({ summary: 'looks fine to me' })) });
    const res = await runClaudeReviewLayer({
      baseDir: base, claudeConfig: CFG, coreReviews: [stored('codex'), stored('grok')],
      includeClaudeReviewer: true, reviewPrompt: 'P', run, runId,
    });
    expect(res.claudeReview?.ok).toBe(false);
    expect(res.claudeReview?.summary).toMatch(/not parseable/i);
  });

  it('reports the Opus reviewer INCOMPLETE (ok:false) when its findings FAIL to persist', async () => {
    const base = tmpTrail();
    const runId = 'runP';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    // Make the run dir read-only so the claude trail writes raise (the core reviews are
    // already written + stay readable for the synthesis). A completed-but-unpersisted review
    // must not count as a full pass — it drops from the disk-read synthesis, so counting it
    // complete would report a 3-reviewer pass that isn't on the trail.
    const dir = reviewDir(base, runId);
    fs.chmodSync(dir, 0o500);
    try {
      const { run } = makeRunner();
      const res = await runClaudeReviewLayer({
        baseDir: base, claudeConfig: CFG, coreReviews: [stored('codex'), stored('grok')],
        includeClaudeReviewer: true, reviewPrompt: 'P', run, runId,
      });
      expect(res.claudeReview?.ok).toBe(false);
      expect(res.claudeReview?.summary).toMatch(/failed to persist/i);
    } finally {
      fs.chmodSync(dir, 0o700); // restore for tmp cleanup
    }
  });

  it('carries the ACTUAL configured claude model (not a hardcoded opus) into the output', async () => {
    const base = tmpTrail();
    const runId = 'runM';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    const { run } = makeRunner();
    const res = await runClaudeReviewLayer({
      baseDir: base, claudeConfig: { ...CFG, model: 'sonnet' },
      coreReviews: [stored('codex'), stored('grok')],
      includeClaudeReviewer: true, reviewPrompt: 'P', run, runId,
    });
    expect(res.modelLabel).toBe('sonnet');
    expect(renderClaudeLayer(res).join('\n')).toContain('claude [anthropic/sonnet]');
  });
});

describe('loadVoiceReviewsFromTrail — synthesis input is read from the injected review files', () => {
  it('reads codex+grok+claude back from disk into the VoiceReview set', () => {
    const base = tmpTrail();
    const runId = 'runL';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    // inject the claude review file
    fs.writeFileSync(
      path.join(reviewDir(base, runId), 'review.claude.json'),
      JSON.stringify({ findings: [], ok: true, summary: 'claude read', voiceId: 'claude' })
    );
    const voices = loadVoiceReviewsFromTrail(base, runId);
    expect(voices.map((v) => v.voiceId).sort()).toEqual(['claude', 'codex', 'grok']);
  });

  it('synthesizes structure over the injected files', async () => {
    const base = tmpTrail();
    const runId = 'runL2';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    // claude raised a finding too, so it can legitimately corroborate the codex+claude
    // agreement (reconcileSynthesis validates a credited voice against its real findings).
    fs.writeFileSync(
      path.join(reviewDir(base, runId), 'review.claude.json'),
      JSON.stringify({
        findings: [{ body: 'b', confidence: 'high', evidence: { file: 'src/x.ts', line: 3 }, id: 'f1', severity: 'high', title: 'claude bug' }],
        ok: true, summary: 'claude read', voiceId: 'claude',
      })
    );
    const { run } = makeRunner();
    const s = await synthesizeReviews(loadVoiceReviewsFromTrail(base, runId), run, CFG);
    expect(s.degraded).toBe(false);
    expect(s.agreements[0].voices).toEqual(['codex', 'claude']);
  });
});

describe('claudeLayerHasHigh — the Opus voice feeds the SAME exit gate', () => {
  it('true only for a completed Opus review carrying a HIGH', () => {
    const high: VoiceReview = { findings: [{ body: 'b', confidence: 'high', evidence: {}, id: 'f1', severity: 'high', title: 't' }], ok: true, summary: '', voiceId: 'claude' };
    expect(claudeLayerHasHigh({ claudeReview: high, modelLabel: 'opus', synthesis: {} as never })).toBe(true);
    expect(claudeLayerHasHigh({ claudeReview: { ...high, ok: false }, modelLabel: 'opus', synthesis: {} as never })).toBe(false);
    expect(claudeLayerHasHigh(null)).toBe(false);
    expect(claudeLayerHasHigh({ claudeReview: null, modelLabel: 'opus', synthesis: {} as never })).toBe(false);
  });
});

describe('renderClaudeLayer — grouped, scannable stdout block', () => {
  it('renders the Opus review + the synthesis agree/disagree/bottom-line', async () => {
    const base = tmpTrail();
    const runId = 'runR';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    const { run } = makeRunner();
    const res = await runClaudeReviewLayer({
      baseDir: base, claudeConfig: CFG, coreReviews: [stored('codex'), stored('grok')],
      includeClaudeReviewer: true, reviewPrompt: 'P', run, runId,
    });
    const text = renderClaudeLayer(res).join('\n');
    expect(text).toContain('claude [anthropic/opus]');
    expect(text).toContain('Claude synthesis');
    expect(text).toContain('bottom line');
  });
});

describe('REVIEW-ONLY — the layer writes ONLY to the trail dir', () => {
  it('makes zero writes to a sentinel repo dir; every new file is under the trail', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-repo-'));
    const tracked = path.join(repo, 'src.ts');
    fs.writeFileSync(tracked, 'export const x = 1;\n');
    const before = fs.readFileSync(tracked, 'utf8');
    const repoListBefore = fs.readdirSync(repo).sort();

    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-trail-'));
    const runId = 'runW';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    const { run } = makeRunner();
    await runClaudeReviewLayer({
      baseDir: base, claudeConfig: CFG, coreReviews: [stored('codex'), stored('grok')],
      includeClaudeReviewer: true, reviewPrompt: 'P', run, runId,
    });

    // the sentinel repo is byte-identical + no files added
    expect(fs.readFileSync(tracked, 'utf8')).toBe(before);
    expect(fs.readdirSync(repo).sort()).toEqual(repoListBefore);
    // every file the layer created lives under the run's trail dir
    const trail = reviewDir(base, runId);
    expect(fs.readdirSync(base)).toEqual([path.basename(trail)]);
  });
});
