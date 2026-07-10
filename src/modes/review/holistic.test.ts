import { describe, expect, it, vi } from 'vitest';

import type { VoiceConfig } from '../brainstorm/types';
import type { VoiceRunResult } from '../brainstorm/voices';

import {
  HOLISTIC_DEFAULTS,
  HOLISTIC_SEAT_ID,
  HOLISTIC_SEVERITY_CAP,
  loadHolisticSeat,
  renderHolisticPrompt,
  resolveHolisticPlan,
  resolveHolisticSeat,
  runHolisticLens,
} from './holistic';

const CFG: VoiceConfig = { cmd: 'claude', effort: 'max', id: 'claude', model: 'opus', vendor: 'anthropic' };
const okRun = (raw: string): VoiceRunResult => ({ ok: true, raw, stderrTail: '', timedOut: false });

describe('resolveHolisticSeat — the registry entry', () => {
  it('defaults to the Anthropic top tier (vendor seat defaults = vendor maximum)', () => {
    const seat = resolveHolisticSeat({});
    expect(seat.model).toBe(HOLISTIC_DEFAULTS.model);
    expect(seat.effort).toBe(HOLISTIC_DEFAULTS.effort);
    expect(seat.vendor).toBe('anthropic');
    expect(seat.cmd).toBe('claude');
  });

  it('honors a voices.json `holistic` entry', () => {
    const seat = resolveHolisticSeat({ holistic: { effort: 'high', model: 'fable' } });
    expect(seat).toMatchObject({ effort: 'high', model: 'fable' });
  });

  it('warns and falls back on an unknown effort (junk config never disables a seat)', () => {
    const warn = vi.fn();
    const seat = resolveHolisticSeat({ holistic: { effort: 'ultra' } }, warn);
    expect(seat.effort).toBe(HOLISTIC_DEFAULTS.effort);
    expect(warn.mock.calls[0][0]).toContain('not a known effort');
  });

  it('ignores `cmd` — the lens is always a read-only `claude -p` spawn', () => {
    const warn = vi.fn();
    const seat = resolveHolisticSeat({ holistic: { cmd: 'rm -rf /' } }, warn);
    expect(seat.cmd).toBe('claude');
    expect(warn.mock.calls[0][0]).toContain('`cmd` is ignored');
  });

  it('a junk `holistic` value warns and yields the default seat', () => {
    const warn = vi.fn();
    expect(resolveHolisticSeat({ holistic: 'opus' }, warn).model).toBe(HOLISTIC_DEFAULTS.model);
    expect(warn).toHaveBeenCalled();
  });

  it('loadHolisticSeat on a missing file is the silent zero-config case', () => {
    const warn = vi.fn();
    expect(loadHolisticSeat('/nope/does/not/exist.json', warn).model).toBe(HOLISTIC_DEFAULTS.model);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('resolveHolisticPlan — default off, worktree or nothing', () => {
  it('is OFF unless requested, and says nothing about it', () => {
    expect(resolveHolisticPlan({ baseSha: 'b', requested: false, worktree: '/tmp/wt' })).toEqual({
      run: false,
      skipReason: null,
    });
  });

  it('REFUSES to run on packet evidence, loudly', () => {
    const plan = resolveHolisticPlan({ baseSha: 'b', requested: true });
    expect(plan.run).toBe(false);
    expect(plan.run === false && plan.skipReason).toContain('NO worktree evidence');
    expect(plan.run === false && plan.skipReason).toContain('never runs on packet evidence');
  });

  it('refuses without a base SHA (it could not tell the change from the tree)', () => {
    const plan = resolveHolisticPlan({ baseSha: null, requested: true, worktree: '/tmp/wt' });
    expect(plan.run).toBe(false);
    expect(plan.run === false && plan.skipReason).toContain('no base SHA');
  });

  it('refuses without the materialized diff (the fence left it no shell to derive one)', () => {
    const plan = resolveHolisticPlan({ baseSha: 'b', requested: true, worktree: '/tmp/wt' });
    expect(plan.run).toBe(false);
    expect(plan.run === false && plan.skipReason).toContain('no reviewer-visible diff');
  });

  it('runs when requested WITH a worktree, a base, and the diff', () => {
    expect(
      resolveHolisticPlan({ baseSha: 'base1', diff: 'DIFFTEXT', requested: true, worktree: '/tmp/wt' })
    ).toEqual({
      baseSha: 'base1',
      diff: 'DIFFTEXT',
      run: true,
      worktree: '/tmp/wt',
    });
  });
});

describe('renderHolisticPrompt — every clause the host mechanizes', () => {
  const prompt = renderHolisticPrompt({ baseSha: 'BASE', diff: 'DIFFTEXT', headSha: 'HEAD', worktree: '/wt' });

  it('points the seat at the whole project and the exact change', () => {
    expect(prompt).toContain('/wt');
    expect(prompt).toContain('git diff BASE...HEAD');
  });

  it('demands BOTH sites at path:line as they exist at headSha', () => {
    expect(prompt).toContain('name TWO places');
    expect(prompt).toContain('the existing pattern\'s home');
    expect(prompt).toMatch(/as they exist at HEAD/);
  });

  it('states the MED cap and that only a verifiable conventions citation lifts it', () => {
    expect(prompt).toContain(`CAPPED at "${HOLISTIC_SEVERITY_CAP}"`);
    expect(prompt).toContain('Asserting "this is important" never lifts the cap');
  });

  it('teaches the near-miss discipline the fixture negatives exist to police', () => {
    expect(prompt).toContain('check the SEMANTICS match');
    expect(prompt).toContain('is NOT a reinvention');
  });

  it('scopes the lens to architecture and bars nit classes + duplicate bug-hunting', () => {
    expect(prompt).toContain('REINVENTED PATTERN');
    expect(prompt).toContain('CONVENTION DRIFT');
    expect(prompt).toContain('SIMPLIFIABLE DESIGN');
    expect(prompt).toContain('Never report style, naming, formatting');
  });

  it('permits an empty result — finding nothing is legitimate', () => {
    expect(prompt).toContain('Finding nothing is a legitimate outcome');
  });
});

describe('runHolisticLens — the seat run', () => {
  it('spawns IN the worktree (the cwd is what makes it a worktree seat) and parses findings', async () => {
    const run = vi.fn(async (_p: string, _c: VoiceConfig, opts?: { worktree?: string }) => {
      expect(opts?.worktree).toBe('/wt');
      return okRun(
        '```json\n' +
          JSON.stringify({
            findings: [
              { body: 'reinvents src/util/money.ts:2', confidence: 'high', evidence: { file: 'src/checkout/receipt.ts', line: 4 }, severity: 'high', title: 'reinvented formatter' },
            ],
            summary: 'read the tree',
          }) +
          '\n```'
      );
    });
    const { review } = await runHolisticLens({ baseSha: 'B', config: CFG, diff: 'DIFFTEXT', headSha: 'H', run, worktree: '/wt' });
    expect(review.voiceId).toBe(HOLISTIC_SEAT_ID);
    expect(review.ok).toBe(true);
    expect(review.findings).toHaveLength(1);
    expect(run).toHaveBeenCalledOnce();
  });

  it('degrades a throw / timeout / unparseable reply to an ok:false voice, never a throw', async () => {
    const thrown = await runHolisticLens({ baseSha: 'B', config: CFG, diff: 'DIFFTEXT', headSha: 'H', run: async () => { throw new Error('no binary'); }, worktree: '/wt' });
    expect(thrown.review.ok).toBe(false);
    expect(thrown.review.summary).toContain('no binary');

    const timedOut = await runHolisticLens({ baseSha: 'B', config: CFG, diff: 'DIFFTEXT', headSha: 'H', run: async () => ({ ok: false, raw: 'partial', stderrTail: '', timedOut: true }), worktree: '/wt' });
    expect(timedOut.review.ok).toBe(false);
    expect(timedOut.review.summary).toContain('timed out');

    const junk = await runHolisticLens({ baseSha: 'B', config: CFG, diff: 'DIFFTEXT', headSha: 'H', run: async () => okRun('I think it looks fine!'), worktree: '/wt' });
    expect(junk.review.ok).toBe(false);
    expect(junk.review.findings).toEqual([]);
    expect(junk.review.summary).toContain('not parseable');
  });

  it('a clean pass is an ok:true voice with zero findings (not a failure)', async () => {
    const { review } = await runHolisticLens({
      baseSha: 'B',
      config: CFG,
      diff: 'DIFFTEXT',
      headSha: 'H',
      run: async () => okRun('```json\n{"summary":"searched the tree, found nothing","findings":[]}\n```'),
      worktree: '/wt',
    });
    expect(review.ok).toBe(true);
    expect(review.findings).toEqual([]);
  });
});
