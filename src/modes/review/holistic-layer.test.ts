import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { persistReview, reviewDir } from '../../core/artifacts';
import type { ReviewerConfig, ReviewPacket } from '../../core/types';
import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';

import { persistGatePacket } from './gate-hunks';
import { HOLISTIC_SEAT_ID } from './holistic';
import { runClaudeReviewLayer } from './self-contained';

// The LENS-OFF guarantee, and the lens-on path end to end through the real layer + real gate
// reconcile. The seat is stubbed (no live model); the worktree is a real directory on disk, so the
// host's two-site verification runs against real bytes.

const CFG: VoiceConfig = { cmd: 'claude', effort: 'default', id: 'claude', model: 'default', vendor: 'anthropic' };
const HOLISTIC_CFG: VoiceConfig = { cmd: 'claude', effort: 'max', id: 'claude', model: 'opus', vendor: 'anthropic' };
const HEAD = 'HEADSHA1';
const BASE = 'BASESHA1';
const okRun = (raw: string): VoiceRunResult => ({ ok: true, raw, stderrTail: '', timedOut: false });

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

// The worktree the seats read: the PR head as files on disk. `src/x.ts` carries the diff's new
// line; `src/util/money.ts` is the unchanged file holding the pattern the lens points at.
const WORKTREE_X = `export function x() {
  const a = compute();
  const veryUniqueGroundingLineHere = a.value.length;
  return a;
}
`;
const WORKTREE_MONEY = `// The ONE currency formatter.
export function formatCents(cents: number, currency = 'USD'): string {
  return String(cents);
}
`;
const DIFF_QUOTE = 'const veryUniqueGroundingLineHere = a.value.length;';
const PATTERN_QUOTE = "export function formatCents(cents: number, currency = 'USD'): string {";

const CLAUDE_REVIEW = JSON.stringify({
  findings: [{ body: 'b', confidence: 'high', evidence: { file: 'src/x.ts', line: 3 }, severity: 'medium', title: 'claude bug' }],
  summary: 'claude read',
});

// The lens claims the diff's new line reinvents formatCents — a HIGH it is not entitled to keep.
const HOLISTIC_REVIEW = JSON.stringify({
  findings: [
    {
      body: 'This recomputes what formatCents already does (src/util/money.ts:2).',
      confidence: 'high',
      evidence: { file: 'src/x.ts', line: 3 },
      severity: 'high',
      title: 'reinvented formatter',
    },
  ],
  summary: 'read the whole tree',
});

const gateEnvelope = (withHolistic: boolean): string =>
  JSON.stringify({
    schemaVersion: 1,
    synthesis: { agreements: [], bottomLine: 'ok', disagreements: [] },
    verdicts: [
      { findingId: 'codex#1', reason: 'confirmed', verdict: 'agree' },
      { findingId: 'claude#1', reason: 'could not ground', verdict: 'unverified' },
      ...(withHolistic
        ? [
            {
              findingId: `${HOLISTIC_SEAT_ID}#1`,
              reason: 'both sites read',
              sites: [
                { file: 'src/x.ts', line: 3, quote: DIFF_QUOTE, role: 'diff' },
                { file: 'src/util/money.ts', line: 2, quote: PATTERN_QUOTE, role: 'pattern' },
              ],
              verdict: 'agree',
            },
          ]
        : []),
    ],
  });

interface Call {
  prompt: string;
  round: 'claude' | 'gate' | 'holistic';
  worktree?: string;
}

function makeRunner(withHolistic: boolean) {
  const calls: Call[] = [];
  const run = async (prompt: string, _c: VoiceConfig, opts?: { worktree?: string }): Promise<VoiceRunResult> => {
    const round: Call['round'] = prompt.includes('VERIFIED GATE')
      ? 'gate'
      : prompt.includes('HOLISTIC / ARCHITECTURE lens')
        ? 'holistic'
        : 'claude';
    calls.push({ prompt, round, worktree: opts?.worktree });
    if (round === 'gate') return okRun(gateEnvelope(withHolistic));
    if (round === 'holistic') return okRun(HOLISTIC_REVIEW);
    return okRun(CLAUDE_REVIEW);
  };
  return { calls, run };
}

const PACKET: ReviewPacket = { complete: true, objective: 'o', pr: 0, repo: 'r', sections: [] };
const CODEX: ReviewerConfig = { cmd: 'codex', effort: 'high', id: 'codex', model: 'm', vendor: 'openai' };

function seed(): { baseDir: string; runId: string } {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-lens-'));
  const runId = 'run1';
  persistReview(baseDir, {
    findings: [{ body: 'b', confidence: 'high', evidence: { file: 'src/x.ts', line: 3 }, id: 'f1', severity: 'medium', title: 'codex bug' }],
    packet: PACKET,
    prompt: 'PINNED',
    raw: '{}',
    reviewer: CODEX,
    runId,
    summary: 'codex summary',
    terminalState: 'reviewed',
  });
  persistGatePacket(baseDir, runId, { diff: GATE_DIFF, headSha: HEAD });
  return { baseDir, runId };
}

function seedWorktree(): string {
  const wt = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-wt-'));
  fs.mkdirSync(path.join(wt, 'src', 'util'), { recursive: true });
  fs.writeFileSync(path.join(wt, 'src', 'x.ts'), WORKTREE_X);
  fs.writeFileSync(path.join(wt, 'src', 'util', 'money.ts'), WORKTREE_MONEY);
  return wt;
}

const layerArgs = (baseDir: string, runId: string, run: ReturnType<typeof makeRunner>['run']) => ({
  baseDir,
  claudeConfig: CFG,
  coreReviews: [],
  expectedHeadSha: HEAD,
  includeClaudeReviewer: true,
  // The capability fence removed Bash from the Anthropic seats, so the lens (like the producer) is
  // HANDED the change instead of running `git diff` for it.
  pinnedDiff: GATE_DIFF,
  reviewPrompt: 'PINNED',
  run,
  runId,
});

describe('the lens is DEFAULT OFF — nothing is added', () => {
  it('no seat, no findings, no trail file, no gate-prompt clause, no worktree on any spawn', async () => {
    const { baseDir, runId } = seed();
    const { calls, run } = makeRunner(false);
    const result = await runClaudeReviewLayer(layerArgs(baseDir, runId, run));

    expect(calls.map((c) => c.round)).toEqual(['claude', 'gate']); // the lens was never spawned
    expect(calls.every((c) => c.worktree === undefined)).toBe(true);
    expect(fs.existsSync(path.join(reviewDir(baseDir, runId), `review.${HOLISTIC_SEAT_ID}.json`))).toBe(false);
    expect(result.holisticReview).toBeNull();
    expect(result.holisticSkipped).toBeNull();
    expect(result.gateVerdicts.some((r) => r.reviewer === HOLISTIC_SEAT_ID)).toBe(false);
    expect(result.gateVerdicts.some((r) => r.holistic)).toBe(false);

    // The gate prompt is the pre-lens one: no holistic clause, and (packet evidence) no
    // reference-not-found clause either.
    const gatePrompt = calls.find((c) => c.round === 'gate')!.prompt;
    expect(gatePrompt).not.toContain(`${HOLISTIC_SEAT_ID}#`);
    expect(gatePrompt).not.toContain('Holistic severity is CAPPED');
    expect(gatePrompt).not.toContain('reference-not-found');
    fs.rmSync(baseDir, { force: true, recursive: true });
  });
});

describe('the lens-OFF path is unchanged by the capability fence', () => {
  it('a worktree run with no lens spawns exactly claude + gate, and adds no lens clause', async () => {
    const { baseDir, runId } = seed();
    const wt = seedWorktree();
    const { calls, run } = makeRunner(false);
    const result = await runClaudeReviewLayer({ ...layerArgs(baseDir, runId, run), worktree: wt });

    // Two seats, never three. The lens is a SEAT: absent means absent.
    expect(calls.map((c) => c.round)).toEqual(['claude', 'gate']);
    expect(result.holisticReview).toBeNull();
    expect(result.holisticSkipped).toBeNull(); // not requested ⇒ silence, not a skip notice
    expect(result.gateVerdicts.some((r) => r.reviewer === HOLISTIC_SEAT_ID)).toBe(false);
    expect(fs.existsSync(path.join(reviewDir(baseDir, runId), `review.${HOLISTIC_SEAT_ID}.json`))).toBe(false);

    const gatePrompt = calls.find((c) => c.round === 'gate')!.prompt;
    expect(gatePrompt).not.toContain('Holistic severity is CAPPED');
    fs.rmSync(baseDir, { force: true, recursive: true });
    fs.rmSync(wt, { force: true, recursive: true });
  });
});

describe('the lens REFUSES packet evidence', () => {
  it('requested without a worktree: loud skip, no seat spawned, no findings', async () => {
    const { baseDir, runId } = seed();
    const { calls, run } = makeRunner(false);
    const result = await runClaudeReviewLayer({
      ...layerArgs(baseDir, runId, run),
      holistic: { baseSha: BASE, config: HOLISTIC_CFG },
    });

    expect(calls.map((c) => c.round)).toEqual(['claude', 'gate']);
    expect(result.holisticReview).toBeNull();
    expect(result.holisticSkipped).toContain('NO worktree evidence');
    expect(result.gateVerdicts.some((r) => r.reviewer === HOLISTIC_SEAT_ID)).toBe(false);
    fs.rmSync(baseDir, { force: true, recursive: true });
  });
});

describe('the lens ON — seat, gate, and the host-verified guardrails end to end', () => {
  it('spawns in the worktree, feeds the gate, and posts only what the host verified', async () => {
    const { baseDir, runId } = seed();
    const wt = seedWorktree();
    const { calls, run } = makeRunner(true);
    const result = await runClaudeReviewLayer({
      ...layerArgs(baseDir, runId, run),
      conventionPaths: ['AGENTS.md'],
      holistic: { baseSha: BASE, config: HOLISTIC_CFG },
      worktree: wt,
    });

    // The seat ran IN the worktree, and so did the gate (spec §5 — it reads the same tree).
    expect(calls.map((c) => c.round)).toEqual(['claude', 'holistic', 'gate']);
    expect(calls.find((c) => c.round === 'holistic')?.worktree).toBe(wt);
    expect(calls.find((c) => c.round === 'gate')?.worktree).toBe(wt);
    expect(result.holisticSkipped).toBeNull();
    expect(result.holisticReview?.ok).toBe(true);

    // The trail carries the lens's own review, like every other voice.
    expect(fs.existsSync(path.join(reviewDir(baseDir, runId), `review.${HOLISTIC_SEAT_ID}.json`))).toBe(true);

    // Worktree evidence ⇒ the gate is taught the reference-not-found cause AND the holistic contract.
    const gatePrompt = calls.find((c) => c.round === 'gate')!.prompt;
    expect(gatePrompt).toContain('reference-not-found');
    expect(gatePrompt).toContain('Holistic severity is CAPPED');
    expect(gatePrompt).toContain(`${HOLISTIC_SEAT_ID}#1`);

    const lens = result.gateVerdicts.find((r) => r.reviewer === HOLISTIC_SEAT_ID)!;
    expect(lens.effectiveVerdict).toBe('agree');
    expect(lens.postableStatus).toBe('postable');
    // The lens reported HIGH; with no conventions citation the host capped it at MED.
    expect(lens.severity).toBe('medium');
    expect(lens.holistic?.cappedFrom).toBe('high');
    expect(lens.holistic?.singleSeat).toBe(true);
    expect(lens.holistic?.verifiedSites).toHaveLength(2);
    // One seat: never clustered, never corroborated.
    expect(lens.cluster).toBeUndefined();

    // The other reviewers' verdicts are untouched by any of this.
    expect(result.gateVerdicts.find((r) => r.findingId === 'codex#1')?.effectiveVerdict).toBe('agree');
    fs.rmSync(baseDir, { force: true, recursive: true });
    fs.rmSync(wt, { force: true, recursive: true });
  });

  it('a lens agree whose pattern home is NOT in the tree is refused, not posted', async () => {
    const { baseDir, runId } = seed();
    const wt = seedWorktree();
    fs.rmSync(path.join(wt, 'src', 'util', 'money.ts')); // the cited pattern does not exist at headSha
    const { run } = makeRunner(true);
    const result = await runClaudeReviewLayer({
      ...layerArgs(baseDir, runId, run),
      holistic: { baseSha: BASE, config: HOLISTIC_CFG },
      worktree: wt,
    });

    const lens = result.gateVerdicts.find((r) => r.reviewer === HOLISTIC_SEAT_ID)!;
    expect(lens.effectiveVerdict).toBe('unverified');
    expect(lens.downgradeReason).toBe('reference-not-found');
    expect(lens.postableStatus).toBe('not-postable');
    expect(lens.postableBody).toBeNull();
    fs.rmSync(baseDir, { force: true, recursive: true });
    fs.rmSync(wt, { force: true, recursive: true });
  });
});
