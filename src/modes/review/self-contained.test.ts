import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { persistReview, reviewDir } from '../../core/artifacts';
import type { ReviewerId, StoredReview } from '../../core/types';
import type { ReviewPacket, ReviewerConfig } from '../../core/types';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';

import { persistGatePacket } from './gate-hunks';
import type { VoiceReview } from './synthesis';
import {
  CLAUDE_WORKTREE_REVIEW_TIMEOUT_MS,
  claudeLayerHasHigh,
  loadVoiceReviewsFromTrail,
  renderClaudeLayer,
  resolveReviewRoster,
  runClaudeReviewLayer,
  storedToVoiceReview,
} from './self-contained';

const CFG: VoiceConfig = { cmd: 'claude', effort: 'default', id: 'claude', model: 'default', vendor: 'anthropic' };
const HEAD = 'HEADSHA1';

const okRun = (raw: string): VoiceRunResult => ({ ok: true, raw, stderrTail: '', timedOut: false });

const CLAUDE_REVIEW = JSON.stringify({
  findings: [
    { body: 'b', confidence: 'high', evidence: { file: 'src/x.ts', line: 3 }, severity: 'medium', title: 'claude bug' },
  ],
  summary: 'claude read',
});
// The composite gate envelope (schemaVersion + synthesis prose + per-finding verdicts).
const GATE = JSON.stringify({
  schemaVersion: 1,
  synthesis: {
    agreements: [{ point: 'shared bug', voices: ['codex', 'claude'] }],
    bottomLine: 'fix then merge',
    disagreements: [],
  },
  verdicts: [
    { findingId: 'codex#1', reason: 'confirmed', verdict: 'agree' },
    { findingId: 'grok#1', reason: 'overstated', verdict: 'partial' },
    { findingId: 'claude#1', reason: 'could not ground', verdict: 'unverified' },
  ],
});

// The pinned covered diff the gate reads back; line 3 (new-side) is a unique, ≥16-non-ws line.
const GATE_DIFF = `diff --git a/src/x.ts b/src/x.ts
index 111..222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,4 +1,5 @@
 export function x() {
   const a = compute();
+  const veryUniqueGroundingLineHere = a.value.length;
   return a;
 }
`;

// A stub claude runner that branches on the round (the gate prompt says "VERIFIED GATE").
function makeRunner(opts: {
  onGate?: () => VoiceRunResult | Promise<VoiceRunResult>;
  onReview?: () => VoiceRunResult | Promise<VoiceRunResult>;
} = {}) {
  const calls: Array<{ prompt: string; round: 'gate' | 'review' }> = [];
  const run = async (prompt: string): Promise<VoiceRunResult> => {
    const round = prompt.includes('VERIFIED GATE') ? 'gate' : 'review';
    calls.push({ prompt, round });
    if (round === 'gate') return (await opts.onGate?.()) ?? okRun(GATE);
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

// Write the core reviews + the pinned gate packet the way runReviewMode does, so the layer's
// gate can read them BACK from disk (the real contract: the core is persisted first).
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
  persistGatePacket(baseDir, runId, { diff: GATE_DIFF, headSha: HEAD });
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

describe('runClaudeReviewLayer — 3-reviewer default, per-reviewer files, gate verdicts', () => {
  it('runs the Opus reviewer, writes every review.<id>.md, then gates the trail files', async () => {
    const base = tmpTrail();
    const runId = 'run1';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    const { calls, run } = makeRunner();
    const res = await runClaudeReviewLayer({
      baseDir: base,
      claudeConfig: CFG,
      coreReviews: [stored('codex'), stored('grok')],
      expectedHeadSha: HEAD,
      includeClaudeReviewer: true,
      reviewPrompt: 'REVIEW PROMPT PAYLOAD',
      run,
      runId,
    });
    expect(res.claudeReview?.ok).toBe(true);
    expect(res.claudeReview?.findings[0].title).toBe('claude bug');
    expect(res.synthesis.degraded).toBe(false);
    // one review call + one gate call
    expect(calls.map((c) => c.round)).toEqual(['review', 'gate']);
    // per-reviewer files + the pinned packet + the gate-verdicts trail all exist
    const dir = reviewDir(base, runId);
    for (const name of ['review.codex.md', 'review.grok.md', 'review.claude.md', 'review.claude.json', 'findings.claude.json', 'packet.gate.json', 'gate-verdicts.json']) {
      expect(fs.existsSync(path.join(dir, name)), name).toBe(true);
    }
    // the gate read all THREE voices back from disk → one verdict per finding, stable ids
    expect(res.gateTrailWritten).toBe(true);
    expect(res.gateVerdicts.map((v) => v.findingId).sort()).toEqual(['claude#1', 'codex#1', 'grok#1']);
    expect(res.synthesis.agreements[0].voices).toEqual(['codex', 'claude']);
    // per-reviewer review files are byte-identical before/after the gate pass (DC3)
    const codexJson = fs.readFileSync(path.join(dir, 'review.codex.json'), 'utf8');
    expect(JSON.parse(codexJson).findings[0].title).toBe('shared bug');
    // The producer SPAWNED, so the run may attest that it read the worktree.
    expect(res.claudeSpawned).toBe(true);
  });

  // `claudeSpawned` is what the run's REALIZED evidence for the `claude` seat is derived from, the
  // same way `gateSpawned` drives the `gate` seat's. A producer whose SPAWN threw (claude is not
  // installed; the capability fence refused an unfenceable read root) read NOTHING — attesting it
  // `worktree` would put a whole-project evidence claim in the posted footer and the evidence
  // manifest for a seat that never opened the tree. A seat that RAN and then timed out or replied
  // unparseably did reach the tree, so it stays honest at `worktree`.
  describe('claudeSpawned — fact, not intent', () => {
    const spawnedFor = async (
      onReview: () => VoiceRunResult | Promise<VoiceRunResult>
    ): Promise<boolean | undefined> => {
      const base = tmpTrail();
      const runId = 'spawn';
      seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
      const { run } = makeRunner({ onReview });
      const res = await runClaudeReviewLayer({
        baseDir: base,
        claudeConfig: CFG,
        coreReviews: [stored('codex'), stored('grok')],
        expectedHeadSha: HEAD,
        includeClaudeReviewer: true,
        reviewPrompt: 'REVIEW PROMPT PAYLOAD',
        run,
        runId,
        worktree: '/tmp/some-worktree',
      });
      return res.claudeSpawned;
    };

    it('false when the producer spawn THREW — the seat never existed', async () => {
      expect(
        await spawnedFor(() => {
          throw new Error('claude: command not found');
        })
      ).toBe(false);
    });

    it('true when the producer RAN but timed out or produced nothing usable', async () => {
      expect(await spawnedFor(() => ({ ok: false, raw: null, stderrTail: '', timedOut: true }))).toBe(true);
      expect(await spawnedFor(() => okRun('not json at all'))).toBe(true);
    });
  });

  // THE PRODUCER PROMPT under worktree evidence. `/code-review` hard-codes a structural-quality
  // lens, so handing it to a `security` run would silently drop the security-auditor objective
  // while still counting the seat as a completed reviewer.
  describe('the worktree producer prompt respects the review PROFILE', () => {
    const producerPromptFor = async (profile: 'code' | 'security'): Promise<string> => {
      const base = tmpTrail();
      const runId = `p-${profile}`;
      seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
      const { calls, run } = makeRunner();
      await runClaudeReviewLayer({
        baseDir: base,
        baseSha: 'b'.repeat(40),
        claudeConfig: CFG,
        coreReviews: [stored('codex'), stored('grok')],
        expectedHeadSha: HEAD,
        includeClaudeReviewer: true,
        // The capability fence removed Bash, so the engine HANDS the seat the change.
        pinnedDiff: 'PINNED DIFF BODY',
        profile,
        reviewPrompt: 'SECURITY AUDITOR OBJECTIVE PAYLOAD',
        run,
        runId,
        worktree: '/tmp/some-worktree',
      });
      return calls.find((c) => c.round === 'review')?.prompt ?? '';
    };

    it('`code` takes the /code-review skill over the whole project, diff materialized', async () => {
      const prompt = await producerPromptFor('code');
      expect(prompt).toContain('/code-review');
      expect(prompt).toContain('/tmp/some-worktree');
      expect(prompt).toContain('PINNED DIFF BODY');
      // It is TOLD the range, but never asked to compute it — it has no shell.
      expect(prompt).toContain(`git diff ${'b'.repeat(40)}...${HEAD}`);
      expect(prompt).toMatch(/NO shell and NO network/);
    });

    it('`security` KEEPS its own objective and merely learns about the worktree', async () => {
      const prompt = await producerPromptFor('security');
      expect(prompt).not.toContain('/code-review');
      expect(prompt).toContain('SECURITY AUDITOR OBJECTIVE PAYLOAD');
      // It still gets whole-project evidence — just under the objective it was asked for.
      expect(prompt).toContain('/tmp/some-worktree');
      // Its packet prompt already carries the diff, so the suffix adds the tree, not a git command.
      expect(prompt).toMatch(/NOT your working directory/);
      expect(prompt).not.toMatch(/Run that command/);
    });

    it('`code` WITHOUT the pinned diff keeps the packet prompt — never a blind skill run', async () => {
      const base = tmpTrail();
      const runId = 'p-code-nodiff';
      seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
      const { calls, run } = makeRunner();
      await runClaudeReviewLayer({
        baseDir: base,
        baseSha: 'b'.repeat(40),
        claudeConfig: CFG,
        coreReviews: [stored('codex'), stored('grok')],
        expectedHeadSha: HEAD,
        includeClaudeReviewer: true,
        profile: 'code',
        reviewPrompt: 'PACKET PROMPT WITH ITS OWN DIFF',
        run,
        runId,
        worktree: '/tmp/some-worktree',
      });
      const prompt = calls.find((c) => c.round === 'review')?.prompt ?? '';
      expect(prompt).not.toContain('/code-review');
      expect(prompt).toContain('PACKET PROMPT WITH ITS OWN DIFF');
    });
  });

  it('a failed Opus reviewer degrades to ok:false but the gate still runs over codex+grok', async () => {
    const base = tmpTrail();
    const runId = 'run2';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    const { run } = makeRunner({ onReview: () => { throw new Error('cli missing'); } });
    const res = await runClaudeReviewLayer({
      baseDir: base,
      claudeConfig: CFG,
      coreReviews: [stored('codex'), stored('grok')],
      expectedHeadSha: HEAD,
      includeClaudeReviewer: true,
      reviewPrompt: 'REVIEW PROMPT PAYLOAD',
      run,
      runId,
    });
    expect(res.claudeReview?.ok).toBe(false);
    expect(res.synthesis.degraded).toBe(false); // codex+grok still gated from the trail
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
      expectedHeadSha: HEAD,
      includeClaudeReviewer: false,
      reviewPrompt: 'REVIEW PROMPT PAYLOAD',
      run,
      runId,
    });
    expect(res.claudeReview).toBeNull();
    expect(calls.map((c) => c.round)).toEqual(['gate']);
    expect(fs.existsSync(path.join(reviewDir(base, runId), 'review.claude.md'))).toBe(false);
  });

  it('surfaces a claude reviewer PARSE failure as failed, not a masked model summary', async () => {
    const base = tmpTrail();
    const runId = 'runPF';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    // A reply with a summary but NO findings array is not a conforming review → parseError.
    const { run } = makeRunner({ onReview: () => okRun(JSON.stringify({ summary: 'looks fine to me' })) });
    const res = await runClaudeReviewLayer({
      baseDir: base, claudeConfig: CFG, coreReviews: [stored('codex'), stored('grok')],
      expectedHeadSha: HEAD, includeClaudeReviewer: true, reviewPrompt: 'P', run, runId,
    });
    expect(res.claudeReview?.ok).toBe(false);
    expect(res.claudeReview?.summary).toMatch(/not parseable/i);
  });

  it('reports the Opus reviewer INCOMPLETE (ok:false) when its findings FAIL to persist', async () => {
    const base = tmpTrail();
    const runId = 'runP';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    const dir = reviewDir(base, runId);
    fs.chmodSync(dir, 0o500);
    try {
      const { run } = makeRunner();
      const res = await runClaudeReviewLayer({
        baseDir: base, claudeConfig: CFG, coreReviews: [stored('codex'), stored('grok')],
        expectedHeadSha: HEAD, includeClaudeReviewer: true, reviewPrompt: 'P', run, runId,
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
      expectedHeadSha: HEAD, includeClaudeReviewer: true, reviewPrompt: 'P', run, runId,
    });
    expect(res.modelLabel).toBe('sonnet');
    expect(renderClaudeLayer(res).join('\n')).toContain('claude [anthropic/sonnet]');
  });
});

describe('loadVoiceReviewsFromTrail — gate input is read from the injected review files', () => {
  it('reads codex+grok+claude back from disk into the VoiceReview set', () => {
    const base = tmpTrail();
    const runId = 'runL';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    fs.writeFileSync(
      path.join(reviewDir(base, runId), 'review.claude.json'),
      JSON.stringify({ findings: [], ok: true, summary: 'claude read', voiceId: 'claude' })
    );
    const voices = loadVoiceReviewsFromTrail(base, runId);
    expect(voices.map((v) => v.voiceId).sort()).toEqual(['claude', 'codex', 'grok']);
  });
});

describe('claudeLayerHasHigh — the Opus voice feeds the SAME exit gate (unchanged in Phase 1)', () => {
  it('true only for a completed Opus review carrying a HIGH', () => {
    const high: VoiceReview = { findings: [{ body: 'b', confidence: 'high', evidence: {}, id: 'f1', severity: 'high', title: 't' }], ok: true, summary: '', voiceId: 'claude' };
    const shell = { gateTrailWritten: true, gateVerdicts: [], modelLabel: 'opus', synthesis: {} as never };
    expect(claudeLayerHasHigh({ ...shell, claudeReview: high })).toBe(true);
    expect(claudeLayerHasHigh({ ...shell, claudeReview: { ...high, ok: false } })).toBe(false);
    expect(claudeLayerHasHigh(null)).toBe(false);
    expect(claudeLayerHasHigh({ ...shell, claudeReview: null })).toBe(false);
  });
});

describe('renderClaudeLayer — grouped, scannable stdout block', () => {
  it('renders the Opus review + the synthesis + the gate verdict tags', async () => {
    const base = tmpTrail();
    const runId = 'runR';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    const { run } = makeRunner();
    const res = await runClaudeReviewLayer({
      baseDir: base, claudeConfig: CFG, coreReviews: [stored('codex'), stored('grok')],
      expectedHeadSha: HEAD, includeClaudeReviewer: true, reviewPrompt: 'P', run, runId,
    });
    const text = renderClaudeLayer(res).join('\n');
    expect(text).toContain('claude [anthropic/opus]');
    expect(text).toContain('Claude synthesis');
    expect(text).toContain('bottom line');
    // the gate block: per-finding tags + the summary counts line
    expect(text).toContain('gate — grounded verdicts');
    expect(text).toMatch(/\[agree\] codex#1/);
    expect(text).toMatch(/gate — \d+ agree · \d+ partial · \d+ false \(dismissed\) · \d+ unverified/);
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
      expectedHeadSha: HEAD, includeClaudeReviewer: true, reviewPrompt: 'P', run, runId,
    });

    // the sentinel repo is byte-identical + no files added
    expect(fs.readFileSync(tracked, 'utf8')).toBe(before);
    expect(fs.readdirSync(repo).sort()).toEqual(repoListBefore);
    // every file the layer created lives under the run's trail dir
    const trail = reviewDir(base, runId);
    expect(fs.readdirSync(base)).toEqual([path.basename(trail)]);
  });
});

// claude joined REVIEWER_IDS (the registry, for library consumers) — these pin that the
// CLI pipeline's roster semantics did NOT move with it (the double-claude fence).
describe('roster · claude in REVIEWER_IDS never leaks into the CLI core', () => {
  it('default roster core stays the cross-vendor pair', () => {
    const r = resolveReviewRoster(undefined, false);
    expect(r).toEqual({ claude: true, core: ['codex', 'grok'] });
  });

  it("an explicit ['codex','claude'] request runs claude ONCE (layer), never as core", () => {
    const r = resolveReviewRoster(['codex', 'claude'], false);
    expect(r).toEqual({ claude: true, core: ['codex'] });
  });

  it("a claude-only request still fails closed (no cross-vendor core)", () => {
    const r = resolveReviewRoster(['claude'], false);
    expect('error' in r && r.error).toMatch(/at least one cross-vendor/);
  });
});

// The producer's watchdog: a worktree /code-review pass gets the 25-min budget; packet mode
// and an explicit caller value stay untouched (run 2026-07-23-17-00-50 died at the shared
// 12-min default with zero output while every other seat finished).
describe('runClaudeReviewLayer — worktree producer timeout default', () => {
  async function producerTimeoutFor(opts: { timeoutMs?: number; worktree?: string }): Promise<number | undefined> {
    const base = tmpTrail();
    const runId = 'timeout-probe';
    seedCoreTrail(base, runId, [stored('codex'), stored('grok')]);
    const seen: Array<number | undefined> = [];
    const run = async (
      prompt: string,
      _c: VoiceConfig,
      o?: { timeoutMs?: number }
    ): Promise<VoiceRunResult> => {
      if (prompt.includes('VERIFIED GATE')) return okRun(GATE);
      seen.push(o?.timeoutMs);
      return okRun(CLAUDE_REVIEW);
    };
    await runClaudeReviewLayer({
      baseDir: base,
      claudeConfig: CFG,
      coreReviews: [stored('codex'), stored('grok')],
      expectedHeadSha: HEAD,
      includeClaudeReviewer: true,
      reviewPrompt: 'REVIEW PROMPT PAYLOAD',
      run,
      runId,
      ...(opts.worktree ? { worktree: opts.worktree } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    return seen[0];
  }

  it('worktree + no explicit timeout ⇒ the 25-min producer watchdog', async () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-wt-'));
    expect(await producerTimeoutFor({ worktree: wt })).toBe(CLAUDE_WORKTREE_REVIEW_TIMEOUT_MS);
  });

  it('packet mode keeps the shared default (undefined ⇒ REVIEW_TIMEOUT_MS at the spawn layer)', async () => {
    expect(await producerTimeoutFor({})).toBeUndefined();
  });

  it('an explicit caller timeout beats the worktree default', async () => {
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-wt-'));
    expect(await producerTimeoutFor({ timeoutMs: 123_000, worktree: wt })).toBe(123_000);
  });
});
