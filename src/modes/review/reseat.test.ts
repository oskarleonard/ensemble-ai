import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { persistReview, reviewDir } from '../../core/artifacts';
import type { ReviewerConfig, ReviewPacket } from '../../core/types';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';

import { persistGatePacket } from './gate-hunks';
import { readSeatArtifacts, runReseat, splitWorktreePrompt } from './reseat';
import { qualifyHarnessSeat, WORKTREE_SUFFIX_HEADER, worktreePromptSuffix } from './seat-evidence';
import type { ReviewAdapter } from './seat-run';

const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);

describe('splitWorktreePrompt — recover the pinned packet prompt from a persisted seat prompt', () => {
  it('returns a packet-mode prompt unchanged', () => {
    expect(splitWorktreePrompt('PINNED PROMPT')).toEqual({ baseSha: null, hadWorktree: false, packetPrompt: 'PINNED PROMPT' });
  });

  it('strips the worktree preamble at the shared header and recovers the base SHA', () => {
    const prompt = 'PINNED PROMPT' + worktreePromptSuffix({ baseSha: BASE, headSha: HEAD, worktree: '/tmp/old-worktree' });
    expect(prompt).toContain(WORKTREE_SUFFIX_HEADER);
    const split = splitWorktreePrompt(prompt);
    expect(split.packetPrompt).toBe('PINNED PROMPT');
    expect(split.hadWorktree).toBe(true);
    expect(split.baseSha).toBe(BASE);
  });

  it('a preamble with no base range yields baseSha null', () => {
    const prompt = 'P' + worktreePromptSuffix({ baseSha: null, headSha: HEAD, worktree: '/tmp/w' });
    expect(splitWorktreePrompt(prompt)).toEqual({ baseSha: null, hadWorktree: true, packetPrompt: 'P' });
  });
});

const GATE_CFG: VoiceConfig = { cmd: 'claude', effort: 'max', id: 'claude', model: 'opus', vendor: 'anthropic' };
const RUN_HEAD = 'd'.repeat(40);
const PACKET: ReviewPacket = { complete: true, objective: 'o', pr: 0, repo: 'acme/webapp', sections: [] };
const GROK: ReviewerConfig = { cmd: 'grok', effort: 'xhigh', id: 'grok', model: 'grok-x', sandbox: 'ensemble-review', vendor: 'xai' };
const CODEX: ReviewerConfig = { cmd: 'codex', effort: 'xhigh', id: 'codex', model: 'gpt-x', vendor: 'openai' };

const GATE_DIFF = `diff --git a/src/x.ts b/src/x.ts
index 111..222 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,4 +1,5 @@
 export function x() {
   const a = compute();
+  const veryUniqueReseatGroundingLine = a.value.length;
   return a;
 }
`;

// The composite gate envelope over the UNION (codex#1 + the healed grok#1).
const GATE = JSON.stringify({
  schemaVersion: 1,
  synthesis: { agreements: [{ point: 'shared bug', voices: ['codex', 'grok'] }], bottomLine: 'fix then merge', disagreements: [] },
  verdicts: [
    { findingId: 'codex#1', reason: 'confirmed against the hunk', verdict: 'agree' },
    { findingId: 'grok#1', reason: 'confirmed', verdict: 'agree' },
  ],
});
const gateOk = async (): Promise<VoiceRunResult> => ({ ok: true, raw: GATE, stderrTail: '', timedOut: false });

// A seat reply in the STRICT findings contract (core/findings.ts).
const SEAT_REPLY = '```json\n' + JSON.stringify({
  findings: [
    { body: 'b', confidence: 'high', evidence: { file: 'src/x.ts', line: 3 }, severity: 'high', title: 'grok finds the shared bug' },
  ],
  summary: 'grok summary',
}) + '\n```';
const adapterOk: ReviewAdapter = async () => ({ ok: true, raw: SEAT_REPLY, stderrTail: '', timedOut: false });
const adapterDead: ReviewAdapter = async () => ({ ok: false, raw: null, stderrTail: 'sandbox refused again', timedOut: false });

// Exactly what a real run with a dead grok leaves behind: a reviewed codex, a failed grok stub
// whose prompt carries the OLD worktree preamble, and the pinned gate packet.
function seedRun(grokPrompt = 'PINNED PROMPT'): { base: string; runId: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-reseat-'));
  const runId = 'reseat-run';
  persistReview(base, {
    findings: [{ body: 'b', confidence: 'high', evidence: { file: 'src/x.ts', line: 3 }, id: 'f1', severity: 'high', title: 'shared bug' }],
    packet: PACKET, prompt: 'PINNED PROMPT', raw: '{}', reviewer: CODEX, runId, summary: 'codex summary', terminalState: 'reviewed',
  });
  persistReview(base, {
    findings: [], packet: PACKET, prompt: grokPrompt, raw: null, reviewer: GROK, runId,
    summary: 'The grok reviewer produced no parseable findings: sandbox could not be applied', terminalState: 'failed-reviewer',
  });
  persistGatePacket(base, runId, { diff: GATE_DIFF, headSha: RUN_HEAD });
  fs.writeFileSync(path.join(reviewDir(base, runId), 'claude-synthesis.json'), JSON.stringify({ claudeReview: { ok: true, voiceId: 'claude' }, synthesis: { degraded: false } }));
  fs.writeFileSync(path.join(reviewDir(base, runId), 'evidence-manifest.json'), JSON.stringify({ headSha: RUN_HEAD, intendedEvidence: { codex: 'worktree', grok: 'worktree' }, readableSurface: [], realizedEvidence: { codex: 'worktree', grok: 'worktree' }, sandboxProfiles: {}, schemaVersion: 1, scopeNote: '' }));
  return { base, runId };
}

describe('readSeatArtifacts', () => {
  it('returns the stored review, packet and prompt for a persisted seat', () => {
    const { base, runId } = seedRun();
    const art = readSeatArtifacts(base, runId, 'grok');
    expect('error' in art).toBe(false);
    if ('error' in art) return;
    expect(art.stored.terminalState).toBe('failed-reviewer');
    expect(art.prompt).toBe('PINNED PROMPT');
    expect(art.packet.repo).toBe('acme/webapp');
  });

  it('names the missing artifact', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-reseat-'));
    expect(readSeatArtifacts(base, 'nope', 'grok')).toEqual({ error: expect.stringContaining('review.grok.json') });
  });
});

describe('runReseat — re-run the dead seat on the pinned packet, then regate the union', () => {
  it('heals: grok reviewed, its artifacts rewritten, the gate re-run over BOTH voices, synthesis stamped', async () => {
    const { base, runId } = seedRun();
    const gatePrompts: string[] = [];
    const res = await runReseat({
      adapter: adapterOk, baseDir: base, gateConfig: GATE_CFG,
      gateRun: async (p) => { gatePrompts.push(p); return gateOk(); },
      reviewer: GROK, runId, seat: 'grok',
    });
    expect(res.ok).toBe(true);
    expect(res.review.terminalState).toBe('reviewed');
    expect(res.review.findings).toHaveLength(1);
    expect(res.realized).toBe('packet');
    expect(gatePrompts).toHaveLength(1);
    expect(gatePrompts[0]).toContain('grok#1');
    const dir = reviewDir(base, runId);
    const stored = JSON.parse(fs.readFileSync(path.join(dir, 'review.grok.json'), 'utf8')) as { terminalState: string };
    expect(stored.terminalState).toBe('reviewed');
    expect(fs.readFileSync(path.join(dir, 'review.grok.md'), 'utf8')).toContain('_status: reviewed_');
    const verdicts = JSON.parse(fs.readFileSync(path.join(dir, 'gate-verdicts.json'), 'utf8')) as { verdicts: Array<{ findingId: string }> };
    expect(verdicts.verdicts.map((v) => v.findingId)).toEqual(expect.arrayContaining(['codex#1', 'grok#1']));
    const synth = JSON.parse(fs.readFileSync(path.join(dir, 'claude-synthesis.json'), 'utf8')) as {
      claudeReview: { voiceId: string }; regatedAt: string;
      reseats: Array<{ outcome: string; previous: { terminalState: string }; realized: string; seat: string }>;
    };
    expect(synth.claudeReview.voiceId).toBe('claude'); // merged, never clobbered
    expect(typeof synth.regatedAt).toBe('string');
    expect(synth.reseats).toHaveLength(1);
    expect(synth.reseats[0]).toMatchObject({ outcome: 'reviewed', previous: { terminalState: 'failed-reviewer' }, realized: 'packet', seat: 'grok' });
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'evidence-manifest.json'), 'utf8')) as { realizedEvidence: Record<string, string> };
    expect(manifest.realizedEvidence.grok).toBe('packet'); // truth after a packet-mode retry
    expect(manifest.realizedEvidence.codex).toBe('worktree'); // untouched
  });

  it('refuses a HEALTHY seat by name', async () => {
    const { base, runId } = seedRun();
    await expect(
      runReseat({ adapter: adapterOk, baseDir: base, gateConfig: GATE_CFG, gateRun: gateOk, reviewer: CODEX, runId, seat: 'codex' })
    ).rejects.toThrow(/seat codex completed .* nothing to retry/);
  });

  it('a seat that fails AGAIN stops before the gate — no regate, verdicts untouched', async () => {
    const { base, runId } = seedRun();
    let gateCalls = 0;
    const res = await runReseat({
      adapter: adapterDead, baseDir: base, gateConfig: GATE_CFG,
      gateRun: async () => { gateCalls += 1; return gateOk(); },
      reviewer: GROK, runId, seat: 'grok',
    });
    expect(res.ok).toBe(false);
    expect(res.gate).toBeNull();
    expect(res.review.terminalState).toBe('failed-reviewer');
    expect(gateCalls).toBe(0);
    expect(fs.existsSync(path.join(reviewDir(base, runId), 'gate-verdicts.json'))).toBe(false);
    const synth = JSON.parse(fs.readFileSync(path.join(reviewDir(base, runId), 'claude-synthesis.json'), 'utf8')) as { reseats: Array<{ outcome: string }> };
    expect(synth.reseats[0].outcome).toBe('failed-reviewer'); // the attempt is on record either way
  });

  it('worktree mode: the seat gets the pinned prompt + a FRESH preamble naming the new dir and the recovered base', async () => {
    const oldPrompt = 'PINNED PROMPT' + `\n\n## Whole-project evidence — you are running inside the project\n\nThe full project at the PR head is checked out READ-ONLY at /tmp/reaped-long-ago (detached at ${RUN_HEAD}), and it is your working directory.\nThe change under review is exactly: git diff ${BASE}...${RUN_HEAD}\n`;
    const { base, runId } = seedRun(oldPrompt);
    const seen: Array<{ prompt: string; worktree?: string }> = [];
    const adapter: ReviewAdapter = async (prompt, _cfg, opts) => { seen.push({ prompt, worktree: opts?.worktree }); return { ok: true, raw: SEAT_REPLY, stderrTail: '', timedOut: false }; };
    const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-reseat-wt-'));
    const res = await runReseat({
      adapter, baseDir: base, gateConfig: GATE_CFG, gateRun: gateOk, qualification: qualifyHarnessSeat(),
      reviewer: GROK, runId, seat: 'grok', worktree: { baseSha: null, dir: wt, headSha: RUN_HEAD },
    });
    expect(res.ok).toBe(true);
    expect(res.realized).toBe('worktree');
    expect(seen).toHaveLength(1);
    expect(seen[0].worktree).toBe(wt);
    expect(seen[0].prompt.startsWith('PINNED PROMPT\n\n## Whole-project evidence')).toBe(true);
    expect(seen[0].prompt).toContain(wt);
    expect(seen[0].prompt).not.toContain('/tmp/reaped-long-ago');
    expect(seen[0].prompt).toContain(`git diff ${BASE}...${RUN_HEAD}`); // base recovered from the OLD prompt
  });

  it('fails CLOSED when the run has no gate packet', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-reseat-'));
    await expect(
      runReseat({ adapter: adapterOk, baseDir: empty, gateConfig: GATE_CFG, gateRun: gateOk, reviewer: GROK, runId: 'nope', seat: 'grok' })
    ).rejects.toThrow(/packet\.gate\.json/);
  });
});
