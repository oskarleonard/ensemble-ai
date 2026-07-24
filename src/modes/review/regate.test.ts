import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { persistReview, reviewDir } from '../../core/artifacts';
import type { ReviewerConfig, ReviewerId, ReviewPacket } from '../../core/types';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';

import { persistGatePacket, readGatePacketHeadSha } from './gate-hunks';
import { readConventionPathsFromTrail, runRegate } from './regate';
import { GATE_WORKTREE_TIMEOUT_MS, persistSeatReview } from './self-contained';

const CFG: VoiceConfig = { cmd: 'claude', effort: 'max', id: 'claude', model: 'opus', vendor: 'anthropic' };
const HEAD = 'REGATEHEADSHA1';
const PACKET: ReviewPacket = { complete: true, objective: 'o', pr: 0, repo: 'r', sections: [] };

const okRun = (raw: string): VoiceRunResult => ({ ok: true, raw, stderrTail: '', timedOut: false });

// The composite envelope a HEALED gate returns — verdicts for both core findings.
const GATE = JSON.stringify({
  schemaVersion: 1,
  synthesis: {
    agreements: [{ point: 'shared bug', voices: ['codex', 'grok'] }],
    bottomLine: 'fix then merge',
    disagreements: [],
  },
  verdicts: [
    { findingId: 'codex#1', reason: 'confirmed against the hunk', verdict: 'agree' },
    { findingId: 'grok#1', reason: 'overstated', verdict: 'partial' },
  ],
});

// The pinned covered diff; line 3 (new side) is a unique, ≥16-non-ws grounding line.
const GATE_DIFF = `diff --git a/src/x.ts b/src/x.ts
index 111..222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,4 +1,5 @@
 export function x() {
   const a = compute();
+  const veryUniqueRegateGroundingLine = a.value.length;
   return a;
 }
`;

// Seed exactly what a real run leaves behind: two persisted core reviews + the pinned
// gate packet — the trail contract regate rehydrates from.
function seedRun(): { base: string; runId: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-regate-'));
  const runId = 'regate-run';
  for (const id of ['codex', 'grok'] as ReviewerId[]) {
    const reviewer: ReviewerConfig = { cmd: id, effort: 'high', id, model: 'm', vendor: id };
    persistReview(base, {
      findings: [
        {
          body: 'b',
          confidence: 'high',
          evidence: { file: 'src/x.ts', line: 3 },
          id: 'f1',
          severity: 'high',
          title: 'shared bug',
        },
      ],
      packet: PACKET,
      prompt: 'PINNED PROMPT',
      raw: '{}',
      reviewer,
      runId,
      summary: `${id} summary`,
      terminalState: 'reviewed',
    });
  }
  persistGatePacket(base, runId, { diff: GATE_DIFF, headSha: HEAD });
  return { base, runId };
}

describe('runRegate — heal a dead gate from the persisted trail, no reviewer re-runs', () => {
  it('rehydrates the reviews, re-runs the gate, and rewrites both trail artifacts', async () => {
    const { base, runId } = seedRun();
    // Simulate the ORIGINAL failed layer output the regate must merge into, not clobber.
    fs.writeFileSync(
      path.join(reviewDir(base, runId), 'claude-synthesis.json'),
      JSON.stringify({ claudeReview: { ok: true, voiceId: 'claude' }, synthesis: { degraded: true } })
    );
    const prompts: string[] = [];
    const res = await runRegate({
      baseDir: base,
      gateConfig: CFG,
      run: async (prompt) => {
        prompts.push(prompt);
        return okRun(GATE);
      },
      runId,
    });
    expect(res.ok).toBe(true);
    expect(res.headSha).toBe(HEAD);
    expect(res.reviews).toBe(2);
    // ONE spawn — the gate. No reviewer prompt ever fired.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('VERIFIED GATE');
    // gate-verdicts.json carries the healed verdicts…
    const verdicts = JSON.parse(
      fs.readFileSync(path.join(reviewDir(base, runId), 'gate-verdicts.json'), 'utf8')
    ) as { verdicts: Array<{ findingId: string; effectiveVerdict: string }> };
    const byId = new Map(verdicts.verdicts.map((v) => [v.findingId, v.effectiveVerdict]));
    expect(byId.get('codex#1')).toBe('agree');
    expect(byId.get('grok#1')).toBe('partial');
    // …and claude-synthesis.json was MERGED: healed gate fields in, original seats kept.
    const synth = JSON.parse(
      fs.readFileSync(path.join(reviewDir(base, runId), 'claude-synthesis.json'), 'utf8')
    ) as Record<string, unknown>;
    expect((synth.claudeReview as { voiceId: string }).voiceId).toBe('claude');
    expect((synth.synthesis as { degraded: boolean }).degraded).toBe(false);
    expect(typeof synth.regatedAt).toBe('string');
  });

  it('a gate that times out AGAIN stays fail-closed and reports ok:false', async () => {
    const { base, runId } = seedRun();
    const res = await runRegate({
      baseDir: base,
      gateConfig: CFG,
      run: async () => ({ ok: false, raw: '', stderrTail: '', timedOut: true }),
      runId,
    });
    expect(res.ok).toBe(false);
    expect(res.verdicts.every((v) => v.effectiveVerdict === 'unverified')).toBe(true);
  });

  it('worktree evidence threads the heavy-pass watchdog; packet mode leaves the default', async () => {
    const { base, runId } = seedRun();
    const seen: Array<number | undefined> = [];
    const run = async (
      _p: string,
      _c: VoiceConfig,
      o?: { timeoutMs?: number }
    ): Promise<VoiceRunResult> => {
      seen.push(o?.timeoutMs);
      return okRun(GATE);
    };
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-regate-wt-'));
    await runRegate({ baseDir: base, gateConfig: CFG, run, runId, worktree: wt });
    await runRegate({ baseDir: base, gateConfig: CFG, run, runId });
    expect(seen[0]).toBe(GATE_WORKTREE_TIMEOUT_MS);
    expect(seen[1]).toBeUndefined();
  });

  it('fails CLOSED with a clear error when the packet or the reviews are missing', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-regate-'));
    await expect(
      runRegate({ baseDir: empty, gateConfig: CFG, run: async () => okRun(GATE), runId: 'nope' })
    ).rejects.toThrow(/packet\.gate\.json/);
    // Packet present but no reviews → the other closed door.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-regate-'));
    persistGatePacket(base, 'bare', { diff: GATE_DIFF, headSha: HEAD });
    await expect(
      runRegate({ baseDir: base, gateConfig: CFG, run: async () => okRun(GATE), runId: 'bare' })
    ).rejects.toThrow(/no persisted reviews/);
  });
});

describe('trail readers regate leans on', () => {
  it('readGatePacketHeadSha returns the pinned head, null when absent', () => {
    const { base, runId } = seedRun();
    expect(readGatePacketHeadSha(base, runId)).toBe(HEAD);
    expect(readGatePacketHeadSha(base, 'missing')).toBeNull();
  });

  it('readConventionPathsFromTrail filters to included paths, undefined when absent', () => {
    const { base, runId } = seedRun();
    expect(readConventionPathsFromTrail(base, runId)).toBeUndefined();
    fs.writeFileSync(
      path.join(reviewDir(base, runId), 'conventions.json'),
      JSON.stringify({
        files: [
          { included: true, path: 'CLAUDE.md' },
          { included: false, path: 'docs/BIG.md' },
        ],
      })
    );
    expect(readConventionPathsFromTrail(base, runId)).toEqual(['CLAUDE.md']);
  });
});

// persistSeatReview is re-exported through the regate path indirectly (loadVoiceReviewsFromTrail
// reads what it wrote) — pin that a claude seat file joins the rehydrated voice set.
describe('regate rehydrates the Anthropic seats too', () => {
  it('a persisted claude voice rides into the gate set', async () => {
    const { base, runId } = seedRun();
    persistSeatReview(
      base,
      runId,
      'claude',
      { findings: [], ok: true, summary: 'cold read', voiceId: 'claude' },
      'raw'
    );
    const res = await runRegate({
      baseDir: base,
      gateConfig: CFG,
      run: async () => okRun(GATE),
      runId,
    });
    expect(res.reviews).toBe(3);
  });
});
