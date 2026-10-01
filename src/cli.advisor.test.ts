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
import { runReviewMode } from './modes/review';
import { VOICE_DEFAULTS } from './modes/brainstorm/voices';

const mockRun = vi.mocked(runReviewMode);
const stderr = (): string => vi.mocked(console.error).mock.calls.map((c) => c.join(' ')).join('\n');

beforeEach(() => {
  mockRun.mockReset();
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
  it.each([
    ['claude', {}],
    ['gate', {}],
    ['holistic', { holistic: true }],
  ])('voices.json %s.advisor: exit 3, the seat named, runReviewMode never called', async (seat, o) => {
    fs.writeFileSync(VOICES, JSON.stringify({ [seat]: { advisor: 'Not A Model' } }));
    const argv = ['review', '--working-tree', ...('holistic' in o ? ['--holistic'] : [])];
    expect(await main(argv)).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
    expect(stderr()).toContain(`voices.json ${seat} seat: \`advisor\``);
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
