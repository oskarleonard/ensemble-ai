import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { reviewDir } from '../../core/artifacts';
import type { VoiceConfig } from '../brainstorm/types';

import type { ProbeRecord, ProbeReport } from './probe';
import {
  attachGateVerdicts,
  parseProbeGateVerdicts,
  renderProbeGatePrompt,
  runProbeGate,
  selectGateTargets,
} from './probe-gate';

const CFG: VoiceConfig = { cmd: 'claude', effort: 'max', id: 'claude', model: 'opus', vendor: 'anthropic' };

function probe(over: Partial<ProbeRecord> = {}): ProbeRecord {
  return {
    command: 'curl ...',
    evidence: { file: 'pkg/services/actor/repo/account_member_repo.go', line: 259 },
    hypothesis: 'accountsCount must not count portfolio memberships',
    id: 'p1',
    kind: 'guard',
    outcome: 'broke',
    receipt: 'accountsCount=5, list=4',
    severity: 'low',
    ...over,
  };
}
const report = (probes: ProbeRecord[]): ProbeReport => ({ probes, summary: 's' });

describe('gate targets — only broke findings are adjudicated', () => {
  it('selects broke, ignores held/blocked', () => {
    const r = report([probe(), probe({ id: 'p2', outcome: 'held', severity: null }), probe({ id: 'p3', outcome: 'blocked', severity: null })]);
    expect(selectGateTargets(r).map((p) => p.id)).toEqual(['p1']);
  });
});

describe('the gate prompt — refute against the contract, citation required', () => {
  const prompt = renderProbeGatePrompt([probe()], { worktree: '/tmp/wt' });
  it('is adversarial and names the worktree + the claim/receipt', () => {
    expect(prompt).toContain('ADVERSARIAL GATE');
    expect(prompt).toContain('try to REFUTE');
    expect(prompt).toContain('/tmp/wt');
    expect(prompt).toContain('accountsCount=5, list=4');
  });
  it('pins the taxonomy: refuted needs a citation; inconclusive still stands', () => {
    expect(prompt).toMatch(/refuted\s+= the behavior is CORRECT/);
    expect(prompt).toContain('No citation ⇒ not a refutation');
    expect(prompt).toMatch(/inconclusive[\s\S]*STILL STANDING/);
    expect(prompt).toContain('"verdict":"confirmed|refuted|inconclusive"');
  });
});

describe('parse — host-owned, and a citation-less refutation cannot clear a broke', () => {
  const known = new Set(['p1', 'p2']);
  const block = (verdicts: unknown) => '```json\n' + JSON.stringify({ verdicts }) + '\n```';

  it('parses a grounded refutation and a confirmation; tldr rides a confirmed only', () => {
    const { verdicts, warnings } = parseProbeGateVerdicts(
      block([
        { citation: { file: 'workspace.go', line: 268 }, id: 'p1', reason: 'accountsCount predicts the kind-blind leave guard', tldr: 'ignored on refuted', verdict: 'refuted' },
        { id: 'p2', reason: 'real auth gap', tldr: 'A viewer can move funds; gate the write on signer role.', verdict: 'confirmed' },
      ]),
      known,
    );
    expect(warnings).toEqual([]);
    expect(verdicts.get('p1')).toMatchObject({ verdict: 'refuted' });
    expect(verdicts.get('p1')?.citation?.line).toBe(268);
    expect(verdicts.get('p1')?.tldr).toBeUndefined(); // tldr is dropped on a non-confirmed verdict
    expect(verdicts.get('p2')?.verdict).toBe('confirmed');
    expect(verdicts.get('p2')?.tldr).toContain('gate the write on signer role');
  });

  it('downgrades a refuted-without-citation to inconclusive (loudly) — it must not clear a broke', () => {
    const { verdicts, warnings } = parseProbeGateVerdicts(
      block([{ id: 'p1', reason: 'seems fine', verdict: 'refuted' }]),
      known,
    );
    expect(verdicts.get('p1')?.verdict).toBe('inconclusive');
    expect(warnings.some((w) => w.includes('without a citation'))).toBe(true);
  });

  it('ignores unknown ids, keeps first duplicate, maps bad enums to inconclusive', () => {
    const { verdicts, warnings } = parseProbeGateVerdicts(
      block([
        { id: 'ghost', reason: 'r', verdict: 'refuted' },
        { citation: { file: 'a', line: 1 }, id: 'p1', reason: 'first', verdict: 'refuted' },
        { id: 'p1', reason: 'second', verdict: 'confirmed' },
        { id: 'p2', reason: 'r', verdict: 'meh' },
      ]),
      known,
    );
    expect(verdicts.get('p1')?.reason).toBe('first');
    expect(verdicts.get('p2')?.verdict).toBe('inconclusive');
    expect(warnings.length).toBe(3);
  });

  it('no verdicts block is a warned empty map, never a throw', () => {
    const { verdicts, warnings } = parseProbeGateVerdicts('I looked, trust me.', known);
    expect(verdicts.size).toBe(0);
    expect(warnings).toHaveLength(1);
  });
});

describe('attach — every broke gets a verdict, held/blocked untouched', () => {
  it('fills a missing broke with an inconclusive absence marker; leaves held alone', () => {
    const r = report([probe(), probe({ id: 'p2', outcome: 'held', severity: null })]);
    const out = attachGateVerdicts(r, new Map(), 'gate did not return a verdict');
    expect(out.probes[0].gate?.verdict).toBe('inconclusive');
    expect(out.probes[0].gate?.reason).toContain('did not return');
    expect(out.probes[1].gate).toBeUndefined();
  });
});

describe('runProbeGate — the stage end-to-end (injected runner)', () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-probegate-'));

  it('does nothing when there are no broke findings', async () => {
    const r = report([probe({ outcome: 'held', severity: null })]);
    const out = await runProbeGate({ baseDir: tmp(), config: CFG, report: r, run: async () => { throw new Error('must not spawn'); }, runId: 'g0', worktree: '/tmp/wt' });
    expect(out.ran).toBe(false);
    expect(out.report).toBe(r);
  });

  it('refutes a broke, clears it, and rewrites probe-report.json with the verdict', async () => {
    const base = tmp();
    const reply = '```json\n' + JSON.stringify({ verdicts: [{ citation: { file: 'pkg/services/actor/workspace.go', line: 268 }, id: 'p1', reason: 'accountsCount is the leave-guard predictor (kind-blind by contract)', verdict: 'refuted' }] }) + '\n```';
    const out = await runProbeGate({
      baseDir: base,
      config: CFG,
      report: report([probe()]),
      run: async () => ({ ok: true, raw: reply, stderrTail: '', timedOut: false }),
      runId: 'g1',
      worktree: '/tmp/wt',
    });
    expect(out.ran).toBe(true);
    expect(out.report.probes[0].gate?.verdict).toBe('refuted');
    const trail = JSON.parse(fs.readFileSync(path.join(reviewDir(base, 'g1'), 'probe-report.json'), 'utf8'));
    expect(trail.report.probes[0].gate.citation.line).toBe(268);
  });

  it('a failed gate leaves the broke STANDING as inconclusive (fail toward caution)', async () => {
    const out = await runProbeGate({
      baseDir: tmp(),
      config: CFG,
      report: report([probe()]),
      run: async () => ({ failWhy: 'timed out', ok: false, raw: null, stderrTail: '', timedOut: true }),
      runId: 'g2',
      worktree: '/tmp/wt',
    });
    expect(out.report.probes[0].gate?.verdict).toBe('inconclusive');
    expect(out.report.probes[0].gate?.reason).toContain('did not complete');
  });
});
