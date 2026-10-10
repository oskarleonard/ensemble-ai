import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// VOICES_FILE is read from the env once, at import — point it at a private file BEFORE the CLI loads.
const VOICES = vi.hoisted(() => {
  const p = `${process.env.TMPDIR ?? '/tmp'}/ensemble-cli-advisor-${process.pid}-voices.json`;
  process.env.ENSEMBLE_VOICES_FILE = p;
  return p;
});

// Mock the engine: the question is only WHETHER the paid core fan-out starts.
vi.mock('./modes/review', () => ({ runReviewMode: vi.fn() }));
// The brainstorm/consult voices are mocked adapters (no model turn ever runs): the question is
// WHICH voices a run spawns, and whether an advisor refusal lands before any of them.
const voiceCalls = vi.hoisted(() => [] as string[]);
vi.mock('./modes/brainstorm/voices', async (importActual) => {
  const actual = await importActual<typeof import('./modes/brainstorm/voices')>();
  const fake = (id: string) => async () => {
    voiceCalls.push(id);
    return { ok: false, raw: null, stderrTail: '', timedOut: false };
  };
  return { ...actual, VOICE_ADAPTERS: { claude: fake('claude'), codex: fake('codex'), grok: fake('grok') } };
});
vi.mock('./modes/review/self-contained', async (importActual) => ({
  ...(await importActual<typeof import('./modes/review/self-contained')>()),
  runClaudeReviewLayer: vi.fn(),
}));

import { main, toCommentGateSeat } from './cli';
import { runReviewMode, type ReviewModeResult } from './modes/review';
import { VOICE_DEFAULTS } from './modes/brainstorm/voices';
import { runClaudeReviewLayer } from './modes/review/self-contained';

const mockRun = vi.mocked(runReviewMode);
const mockLayer = vi.mocked(runClaudeReviewLayer);
const stderr = (): string => vi.mocked(console.error).mock.calls.map((c) => c.join(' ')).join('\n');

beforeEach(() => {
  mockRun.mockReset();
  mockLayer.mockReset();
  voiceCalls.length = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(() => {
  fs.rmSync(VOICES, { force: true });
});

describe('review — an invalid Anthropic-seat advisor fails BEFORE the core fan-out (nothing billed)', () => {
  // The holistic lens refuses only on a run that can spawn it — with worktree evidence; that case
  // lives beside the worktree harness (cli.worktree.test.ts).
  it.each(['claude', 'gate'])('voices.json %s.advisor: exit 3, the seat named, runReviewMode never called', async (seat) => {
    fs.writeFileSync(VOICES, JSON.stringify({ [seat]: { advisor: 'Not A Model' } }));
    expect(await main(['review', '--working-tree'])).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
    expect(stderr()).toContain(`voices.json ${seat} seat: \`advisor\``);
  });

  it('`--holistic` without `--repo` never spawns the lens, so its advisor is not read — the review runs and the skip stays loud', async () => {
    fs.writeFileSync(VOICES, JSON.stringify({ holistic: { advisor: 'Not A Model' } }));
    // A built packet (`prompt`), so the claude layer is expected and receives the lens request.
    mockRun.mockResolvedValue({
      acquired: {
        baseRef: null,
        baseSha: null,
        canonicalDigest: 'sha256:x',
        coverage: { files: [], includedBytes: 0, includedFiles: 0, omittedFiles: 0, totalBytes: 0, totalFiles: 0 },
        diff: '',
        files: [],
        headSha: 'h'.repeat(40),
        mode: 'working-tree',
        rawDiff: '',
        repoId: 'o/r',
      },
      blocked: false,
      prompt: 'the packet',
      reviews: [],
      secretScan: { blocked: false, inlineSecrets: [], inlineSecretsOmitted: [], overridden: false, sensitivePaths: [] },
    } as unknown as ReviewModeResult);
    mockLayer.mockRejectedValue(new Error('layer reached'));
    await main(['review', '--working-tree', '--holistic']);
    expect(mockRun).toHaveBeenCalledOnce();
    expect(stderr()).not.toContain('holistic seat: `advisor`');
    // The request still reaches the layer (its presence is what renders the loud skip), with no
    // seat config: the run has no worktree, so the lens seat was never resolved.
    expect(mockLayer).toHaveBeenCalledOnce();
    const opts = mockLayer.mock.calls[0][0];
    expect(opts.holistic).toBeDefined();
    expect(opts.holistic).not.toHaveProperty('config');
    expect(opts.worktree).toBeUndefined();
  });

  it('`--no-claude` runs no Anthropic seat, so it reads none of their advisors', async () => {
    fs.writeFileSync(
      VOICES,
      JSON.stringify({ claude: { advisor: 'Opus 5' }, gate: { advisor: null }, holistic: { advisor: 7 } })
    );
    mockRun.mockRejectedValue(new Error('engine reached'));
    expect(await main(['review', '--working-tree', '--no-claude'])).toBe(3);
    expect(mockRun).toHaveBeenCalledOnce();
    expect(stderr()).not.toContain('advisor');
  });
});

// A REUSED `--run-id` clears that run's old trail — but only once the run is past every refusal: a
// usage error or an invalid seat advisor (exit 3) must leave the old trail exactly as it was.
describe('review — a refused `--run-id` reuse never deletes the old trail', () => {
  const reusedTrail = (): { out: string; sentinel: string } => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-cli-reuse-'));
    fs.mkdirSync(path.join(out, 'r1'));
    const sentinel = path.join(out, 'r1', 'review.codex.json');
    fs.writeFileSync(sentinel, '{}');
    return { out, sentinel };
  };

  it.each([
    ['an invalid claude advisor', { claude: { advisor: 'Not A Model' } }, [] as string[]],
    ['an invalid gate advisor', { gate: { advisor: null } }, [] as string[]],
    ['a bad --ceiling', {}, ['--ceiling', '0']],
    ['a bad --convention-cap', {}, ['--convention-cap', 'x']],
  ])('%s: exit 3 and the reused trail survives', async (_why, voices, flags) => {
    const { out, sentinel } = reusedTrail();
    try {
      fs.writeFileSync(VOICES, JSON.stringify(voices));
      expect(await main(['review', '--working-tree', '--out', out, '--run-id', 'r1', ...flags])).toBe(3);
      expect(mockRun).not.toHaveBeenCalled();
      expect(fs.existsSync(sentinel)).toBe(true);
    } finally {
      fs.rmSync(out, { force: true, recursive: true });
    }
  });

  it('a run that reaches the engine still clears the reused trail first', async () => {
    const { out, sentinel } = reusedTrail();
    try {
      fs.writeFileSync(VOICES, JSON.stringify({}));
      mockRun.mockImplementation(async () => {
        expect(fs.existsSync(sentinel)).toBe(false); // cleared BEFORE the engine reads the trail
        throw new Error('engine reached');
      });
      expect(await main(['review', '--working-tree', '--out', out, '--run-id', 'r1'])).toBe(3);
      expect(mockRun).toHaveBeenCalledOnce();
      expect(fs.existsSync(sentinel)).toBe(false);
    } finally {
      fs.rmSync(out, { force: true, recursive: true });
    }
  });
});

describe('regate — an invalid gate advisor is a pre-spawn refusal (exit 3), not a crash', () => {
  it('names the seat and exits 3 before any gate spawn', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-cli-advisor-'));
    try {
      fs.mkdirSync(path.join(out, 'r1'));
      fs.writeFileSync(path.join(out, 'r1', 'packet.gate.json'), JSON.stringify({ headSha: 'a'.repeat(40), schemaVersion: 2 }));
      fs.writeFileSync(VOICES, JSON.stringify({ gate: { advisor: '' } }));
      expect(await main(['regate', '--out', out, '--run-id', 'r1'])).toBe(3);
      expect(stderr()).toContain('ensemble-ai: voices.json gate seat: `advisor`');
    } finally {
      fs.rmSync(out, { force: true, recursive: true });
    }
  });

  // regate pins its gate to anthropic. A codex-scoped `gate` entry does not apply to that claude
  // spawn, so its advisor comes from the `claude` entry — validated up front like any spawned seat.
  it('a codex-scoped gate entry: the claude entry\'s advisor is the one checked, before any gate spawn', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-cli-advisor-'));
    try {
      fs.mkdirSync(path.join(out, 'r1'));
      fs.writeFileSync(path.join(out, 'r1', 'packet.gate.json'), JSON.stringify({ headSha: 'a'.repeat(40), schemaVersion: 2 }));
      fs.writeFileSync(VOICES, JSON.stringify({ claude: { advisor: null }, gate: { advisor: 'off', vendor: 'codex' } }));
      expect(await main(['regate', '--out', out, '--run-id', 'r1'])).toBe(3);
      expect(stderr()).toContain('ensemble-ai: voices.json claude seat: `advisor`');
    } finally {
      fs.rmSync(out, { force: true, recursive: true });
    }
  });
});

describe('brainstorm · consult — only the roster advisors are checked, before any voice spawns', () => {
  it('`brainstorm --voices codex,grok` runs despite an invalid claude advisor (the voice is unused)', async () => {
    fs.writeFileSync(VOICES, JSON.stringify({ claude: { advisor: 'Opus 5' } }));
    const code = await main(['brainstorm', 'a topic', '--voices', 'codex,grok']);
    expect(code).not.toBe(3);
    expect(voiceCalls.sort()).toEqual(['codex', 'grok']);
    expect(stderr()).not.toContain('advisor');
  });

  it('`brainstorm` with claude in the roster refuses (exit 3) before ANY voice spawns', async () => {
    fs.writeFileSync(VOICES, JSON.stringify({ claude: { advisor: 'Opus 5' } }));
    expect(await main(['brainstorm', 'a topic', '--voices', 'codex,claude'])).toBe(3);
    expect(voiceCalls).toEqual([]);
    expect(stderr()).toContain('voices.json claude seat: `advisor`');
  });

  it('`consult` follows the same rule', async () => {
    fs.writeFileSync(VOICES, JSON.stringify({ claude: { advisor: null } }));
    expect(await main(['consult', 'a question'])).toBe(3);
    expect(voiceCalls).toEqual([]);
    expect(await main(['consult', 'a question', '--voices', 'grok'])).not.toBe(3);
    expect(voiceCalls).toEqual(['grok']);
  });
});

describe('the posted gate seat line records the advisor beside model/effort', () => {
  const seat = (advisor?: string) => ({
    config: { ...VOICE_DEFAULTS.claude, ...(advisor === undefined ? {} : { advisor }), effort: 'max', model: 'opus' },
    effortSource: 'file' as const,
    modelSource: 'file' as const,
    vendor: 'anthropic' as const,
    vendorSource: 'default' as const,
  });

  it('"off" is recorded; an inheriting seat has NO advisor key — the two stay distinguishable', () => {
    expect(toCommentGateSeat(seat('off'))).toEqual({
      advisor: 'off', effort: 'max', effortSource: 'file', model: 'opus', modelSource: 'file',
    });
    expect(toCommentGateSeat(seat())).not.toHaveProperty('advisor');
  });
});
