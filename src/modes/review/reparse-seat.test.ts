import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { reviewDir } from '../../core/artifacts';
import type { ResolvedVoiceConfig } from '../brainstorm/types';

import type { RegateOptions, RegateResult } from './regate';
import { checkReparse, reparseRefusal, runReparseSeat } from './reparse-seat';

const GATE_CFG: ResolvedVoiceConfig = { cmd: 'claude', effort: 'max', id: 'claude', model: 'opus', vendor: 'anthropic' };
const REGATE_OK: RegateResult = {
  headSha: 'd'.repeat(40),
  ok: true,
  reviews: 3,
  synthesis: { agreements: [], bottomLine: 'fix then merge', by: 'claude', degraded: false, disagreements: [], ok: true, raw: null, summary: 's' },
  verdicts: [],
};

// The reply the stray-brace runs left behind: prose, then a fenced JSON block with one `}` too
// many after each finding's evidence object.
const BROKEN_RAW = [
  'I found no high- or medium-severity defects. Two lows below.',
  '',
  '```json',
  '{"summary":"Two lows.","findings":[',
  '{"title":"Pressed row goes lighter","body":"a","severity":"low","confidence":"medium","evidence":{"file":"src/row.tsx","line":162}}},',
  '{"title":"Group still check-marks a disabled pick","body":"b","severity":"low","confidence":"medium","evidence":{"file":"src/group.tsx","line":103}}}]}',
  '```',
].join('\n');

const FAILED_STUB = {
  advisor: 'off',
  diagnostics: { elapsedMs: 364_600, endedAt: 't1', startedAt: 't0', stderrTail: '', usage: { turns: 50 } },
  findings: [],
  ok: false,
  summary: 'output not parseable (no parseable JSON block in the reviewer output)',
  voiceId: 'claude',
};

function seedRun(opts: { raw?: string | null; review?: Record<string, unknown>; chunks?: boolean } = {}): { base: string; runId: string; dir: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-reparse-'));
  const runId = 'reparse-run';
  const dir = reviewDir(base, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review.claude.json'), JSON.stringify(opts.review ?? FAILED_STUB, null, 2));
  fs.writeFileSync(path.join(dir, 'findings.claude.json'), '[]');
  const raw = opts.raw === undefined ? BROKEN_RAW : opts.raw;
  if (raw !== null) fs.writeFileSync(path.join(dir, 'claude-review.raw.md'), raw);
  if (opts.chunks !== false) {
    fs.writeFileSync(
      path.join(dir, 'chunks.json'),
      JSON.stringify({
        ceilingBytes: 1,
        chunks: [
          {
            files: ['src/row.tsx'],
            index: 1,
            label: 'all',
            seats: {
              claude: { effort: 'xhigh', findings: 0, model: 'opus', state: 'failed-reviewer', why: 'output not parseable' },
              codex: { findings: 0, state: 'reviewed' },
            },
          },
        ],
        maxChunks: 1,
        omitted: [],
        schemaVersion: 1,
      })
    );
  }
  fs.writeFileSync(path.join(dir, 'evidence-manifest.json'), JSON.stringify({ realizedEvidence: { claude: 'worktree', codex: 'worktree' } }));
  fs.writeFileSync(path.join(dir, 'claude-synthesis.json'), JSON.stringify({ claudeReview: FAILED_STUB, gateSpawned: true }));
  return { base, dir, runId };
}

describe('checkReparse — the pre-touch refusals', () => {
  it('refuses a healthy seat', () => {
    const { base, runId } = seedRun({ review: { ...FAILED_STUB, ok: true } });
    expect(reparseRefusal(base, runId, 'claude')).toMatch(/completed in run .* nothing to heal/);
  });

  it('refuses when the seat never persisted a review', () => {
    const { base, dir, runId } = seedRun();
    fs.rmSync(path.join(dir, 'review.claude.json'));
    expect(reparseRefusal(base, runId, 'claude')).toMatch(/no review\.claude\.json/);
  });

  it('refuses when there is no persisted reply to re-read', () => {
    const { base, runId } = seedRun({ raw: null });
    expect(reparseRefusal(base, runId, 'claude')).toMatch(/left no reply/);
  });

  it('refuses a cut-off reply even when what survived parses', () => {
    const { base, runId } = seedRun({
      review: { ...FAILED_STUB, diagnostics: { ...FAILED_STUB.diagnostics, timedOutReason: 'inactivity' } },
    });
    expect(reparseRefusal(base, runId, 'claude')).toMatch(/cut off .* \(inactivity\)/);
  });

  it('refuses a reply this engine still cannot read — a re-run is not what this path does', () => {
    const { base, runId } = seedRun({ raw: "You've hit your session limit · resets 5:10pm" });
    expect(reparseRefusal(base, runId, 'claude')).toMatch(/still does not parse .* re-run of this seat is not supported yet/);
  });

  it('refuses a multi-part reply for now', () => {
    const { base, dir, runId } = seedRun();
    fs.writeFileSync(path.join(dir, 'claude-review.c1.raw.md'), BROKEN_RAW);
    fs.writeFileSync(path.join(dir, 'claude-review.c2.raw.md'), BROKEN_RAW);
    expect(reparseRefusal(base, runId, 'claude')).toMatch(/in 2 parts/);
  });

  it('reads the broken reply into findings when nothing refuses', () => {
    const { base, runId } = seedRun();
    const pre = checkReparse(base, runId, 'claude');
    expect('refusal' in pre).toBe(false);
    if ('refusal' in pre) return;
    expect(pre.findings.map((f) => f.evidence.line)).toEqual([162, 103]);
    expect(pre.summary).toBe('Two lows.');
  });
});

describe('runReparseSeat — heals the trail without a spawn, then regates the union', () => {
  it('rewrites the seat as reviewed, keeps its diagnostics, stamps the heal and regates once', async () => {
    const { base, dir, runId } = seedRun();
    const regates: RegateOptions[] = [];
    const log: string[] = [];
    const res = await runReparseSeat({
      baseDir: base,
      gateConfig: GATE_CFG,
      log: (m) => log.push(m),
      regate: async (o) => {
        regates.push(o);
        return REGATE_OK;
      },
      runId,
      seat: 'claude',
    });
    expect(res.ok).toBe(true);
    expect(res.stampWritten).toBe(true);
    expect(res.review.findings).toHaveLength(2);

    const review = JSON.parse(fs.readFileSync(path.join(dir, 'review.claude.json'), 'utf8'));
    expect(review.ok).toBe(true);
    expect(review.voiceId).toBe('claude');
    expect(review.summary).toBe('Two lows.');
    expect(review.findings.map((f: { id: string }) => f.id)).toEqual(['f1', 'f2']);
    // The run facts of the attempt that produced the reply stay on the record.
    expect(review.diagnostics.elapsedMs).toBe(364_600);
    expect(review.advisor).toBe('off');
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'findings.claude.json'), 'utf8'))).toHaveLength(2);
    // The reply itself is untouched — it is what the heal was read from.
    expect(fs.readFileSync(path.join(dir, 'claude-review.raw.md'), 'utf8')).toBe(BROKEN_RAW);
    expect(fs.readFileSync(path.join(dir, 'review.claude.md'), 'utf8')).toContain('_status: reviewed_');

    const chunks = JSON.parse(fs.readFileSync(path.join(dir, 'chunks.json'), 'utf8'));
    expect(chunks.chunks[0].seats.claude).toMatchObject({ effort: 'xhigh', findings: 2, state: 'reviewed' });
    expect(chunks.chunks[0].seats.claude.why).toBeUndefined();
    expect(chunks.chunks[0].seats.codex).toEqual({ findings: 0, state: 'reviewed' });

    const synth = JSON.parse(fs.readFileSync(path.join(dir, 'claude-synthesis.json'), 'utf8'));
    expect(synth.gateSpawned).toBe(true);
    expect(synth.claudeReview.ok).toBe(true);
    expect(synth.reseats).toHaveLength(1);
    expect(synth.reseats[0]).toMatchObject({
      evidenceDowngraded: false,
      outcome: 'reviewed',
      previous: { ok: false, summary: FAILED_STUB.summary },
      realized: 'worktree',
      reparsed: true,
      seat: 'claude',
    });

    expect(regates).toHaveLength(1);
    expect(regates[0].runId).toBe(runId);
    expect(regates[0].gateConfig).toBe(GATE_CFG);
    expect(regates[0].worktree).toBeUndefined();
    expect(log.some((l) => /nothing re-billed/.test(l))).toBe(true);
  });

  it('threads the worktree and the premise flag to the regate', async () => {
    const { base, runId } = seedRun({ chunks: false });
    const regates: RegateOptions[] = [];
    await runReparseSeat({
      baseDir: base,
      gateConfig: GATE_CFG,
      premise: true,
      regate: async (o) => {
        regates.push(o);
        return REGATE_OK;
      },
      runId,
      seat: 'claude',
      worktree: '/tmp/wt',
    });
    expect(regates[0]).toMatchObject({ premise: true, worktree: '/tmp/wt' });
  });

  it('throws the refusal and touches nothing when the seat is healthy', async () => {
    const { base, dir, runId } = seedRun({ review: { ...FAILED_STUB, ok: true } });
    const before = fs.readFileSync(path.join(dir, 'review.claude.json'), 'utf8');
    await expect(
      runReparseSeat({ baseDir: base, gateConfig: GATE_CFG, regate: async () => REGATE_OK, runId, seat: 'claude' })
    ).rejects.toThrow(/nothing to heal/);
    expect(fs.readFileSync(path.join(dir, 'review.claude.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(dir, 'reseat.lock'))).toBe(false);
  });

  it('releases the lock after a heal', async () => {
    const { base, dir, runId } = seedRun();
    await runReparseSeat({ baseDir: base, gateConfig: GATE_CFG, regate: async () => REGATE_OK, runId, seat: 'claude' });
    expect(fs.existsSync(path.join(dir, 'reseat.lock'))).toBe(false);
  });
});
