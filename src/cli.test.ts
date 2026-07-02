import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  ReviewerId,
  Severity,
  StoredReview,
  TerminalState,
} from './core/types';
import type { ReviewModeResult } from './modes/review';

// Mock the engine so the CLI's arg-parsing + exit-code CONTRACT is tested without
// running a real review (no codex/grok). The live end-to-end is a separate smoke.
vi.mock('./modes/review', () => ({ runReviewMode: vi.fn() }));
// Same for brainstorm: test the dispatch + arg-parsing contract, never spawn voices.
vi.mock('./modes/brainstorm', () => ({ runBrainstormMode: vi.fn() }));
// Same for consult: test the dispatch + arg-parsing + alias contract, never spawn.
vi.mock('./modes/consult', () => ({ runConsultMode: vi.fn() }));
// Mock ONLY the spawned Opus layer (keep the real roster/gate/render helpers) so the
// CLI's self-contained wiring is tested without spawning a real `claude -p`.
vi.mock('./modes/review/self-contained', async (importActual) => ({
  ...(await importActual<typeof import('./modes/review/self-contained')>()),
  runClaudeReviewLayer: vi.fn(),
}));

import { main, resolveTrailBase } from './cli';
import { runBrainstormMode } from './modes/brainstorm';
import type { BrainstormResult } from './modes/brainstorm/types';
import { runConsultMode } from './modes/consult';
import type { ConsultResult } from './modes/consult/types';
import { runReviewMode } from './modes/review';
import { runClaudeReviewLayer } from './modes/review/self-contained';

const mockRun = vi.mocked(runReviewMode);
const mockBrainstorm = vi.mocked(runBrainstormMode);
const mockConsult = vi.mocked(runConsultMode);
const mockLayer = vi.mocked(runClaudeReviewLayer);

function storedReview(
  reviewerId: ReviewerId,
  terminalState: TerminalState,
  findings = 0,
  severity: Severity = 'high'
): StoredReview {
  return {
    findings: Array.from({ length: findings }, (_, i) => ({
      body: '',
      confidence: 'high',
      evidence: { file: 'a.ts' },
      id: `f${i + 1}`,
      severity,
      title: 't',
    })),
    packet: { complete: true, manifest: [] },
    reviewer: { effort: 'high', model: 'm', vendor: 'v' },
    reviewerId,
    runId: 'r',
    summary: 's',
    terminalState,
  };
}

function result(over: Partial<ReviewModeResult>): ReviewModeResult {
  return {
    acquired: {
      baseRef: null,
      baseSha: null,
      canonicalDigest: 'sha256:x',
      coverage: { files: [], includedBytes: 0, includedFiles: 0, omittedFiles: 0, totalBytes: 0, totalFiles: 0 },
      diff: '',
      files: [],
      headSha: 'h',
      mode: 'working-tree',
      rawDiff: '',
      repoId: null,
    },
    blocked: false,
    reviews: [],
    secretScan: { blocked: false, inlineSecrets: [], overridden: false, sensitivePaths: [] },
    ...over,
  };
}

beforeEach(() => {
  mockRun.mockReset();
  mockBrainstorm.mockReset();
  mockConsult.mockReset();
  mockLayer.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('exit code', () => {
  it('exits 0 on a completed review with NO high findings (med/low only)', async () => {
    mockRun.mockResolvedValue(
      result({ reviews: [storedReview('codex', 'reviewed', 3, 'medium')] })
    );
    expect(await main(['review', '--working-tree'])).toBe(0);
  });

  it('exits 4 (the gate) on a completed review WITH a HIGH finding', async () => {
    mockRun.mockResolvedValue(
      result({ reviews: [storedReview('codex', 'reviewed', 1, 'high')] })
    );
    expect(await main(['review', '--working-tree'])).toBe(4);
  });

  it('--no-fail-on-high downgrades the HIGH gate back to 0', async () => {
    mockRun.mockResolvedValue(
      result({ reviews: [storedReview('codex', 'reviewed', 1, 'high')] })
    );
    expect(await main(['review', '--working-tree', '--no-fail-on-high'])).toBe(0);
  });

  it('a reviewer FAILURE (exit 1) outranks the HIGH gate', async () => {
    mockRun.mockResolvedValue(
      result({
        reviews: [
          storedReview('codex', 'reviewed', 1, 'high'),
          storedReview('grok', 'failed-reviewer'),
        ],
      })
    );
    expect(await main(['review', '--working-tree'])).toBe(1);
  });

  it('exits 2 when the secret-scan BLOCKED the review', async () => {
    mockRun.mockResolvedValue(result({ blocked: true, blockedReason: 'diff carries .env' }));
    expect(await main(['review', '--working-tree'])).toBe(2);
  });
});

describe('mode dispatch + usage', () => {
  it('--help prints usage and exits 0 (no review fired)', async () => {
    expect(await main(['--help'])).toBe(0);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('no mode → exit 1', async () => {
    expect(await main([])).toBe(1);
  });

  it('an unknown mode → exit 3', async () => {
    expect(await main(['frobnicate'])).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('brainstorm dispatches to its own command, not the review engine', async () => {
    // brainstorm is implemented now: `brainstorm` with no topic hits its OWN usage
    // error (exit 3) and the review engine is never invoked.
    expect(await main(['brainstorm'])).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('security --help → exit 0 (no review fired)', async () => {
    expect(await main(['security', '--help'])).toBe(0);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('an unknown review flag → usage error, exit 3 (no review fired)', async () => {
    expect(await main(['review', '--definitely-not-a-flag'])).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('review --help → exit 0 (no review fired)', async () => {
    expect(await main(['review', '--help'])).toBe(0);
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe('flag threading', () => {
  it('passes --reviewers, --base, --allow-sensitive through to the engine', async () => {
    mockRun.mockResolvedValue(result({ reviews: [storedReview('codex', 'reviewed')] }));
    await main(['review', '--working-tree', '--reviewers', 'codex', '--allow-sensitive']);
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ allowSensitive: true, reviewers: ['codex'], workingTree: true })
    );
  });
});

describe('reviewer roster (codex+grok core; Opus/claude default-on, --no-claude opts out)', () => {
  it('"claude" ALONE fails closed — needs ≥1 cross-vendor core (exit 3, no engine run)', async () => {
    expect(await main(['review', '--working-tree', '--reviewers', 'claude'])).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('"codex,claude" is a VALID roster now (claude is additive) — engine runs core=[codex]', async () => {
    mockRun.mockResolvedValue(result({ reviews: [storedReview('codex', 'reviewed')] }));
    expect(await main(['review', '--working-tree', '--reviewers', 'codex,claude'])).toBe(0);
    expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ reviewers: ['codex'] }));
  });

  it('a typo still fails closed (exit 3, no engine run)', async () => {
    expect(await main(['review', '--working-tree', '--reviewers', 'codex,grokk'])).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('--with-claude is not a flag → usage error, exit 3 (the opt-out is --no-claude)', async () => {
    expect(await main(['review', '--working-tree', '--with-claude'])).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe('self-contained Opus layer wiring (default-on; --no-claude opts out; feeds the gate)', () => {
  const synthesis = {
    agreements: [], bottomLine: 'ok', by: 'claude', degraded: false,
    disagreements: [], ok: true, raw: null, sanityChecks: [], summary: 's',
  };

  it('runs the Opus layer by default over the pinned packet prompt', async () => {
    mockRun.mockResolvedValue(result({ prompt: 'PINNED', reviews: [storedReview('codex', 'reviewed')] }));
    mockLayer.mockResolvedValue({ claudeReview: null, modelLabel: 'opus', synthesis });
    await main(['review', '--working-tree']);
    expect(mockLayer).toHaveBeenCalledWith(
      expect.objectContaining({ includeClaudeReviewer: true, reviewPrompt: 'PINNED' })
    );
  });

  it('--no-claude skips the Opus layer entirely', async () => {
    mockRun.mockResolvedValue(result({ prompt: 'PINNED', reviews: [storedReview('codex', 'reviewed')] }));
    await main(['review', '--working-tree', '--no-claude']);
    expect(mockLayer).not.toHaveBeenCalled();
  });

  it('a claude-only HIGH drives the exit-4 gate (the Opus voice counts)', async () => {
    mockRun.mockResolvedValue(result({ prompt: 'PINNED', reviews: [storedReview('codex', 'reviewed')] }));
    mockLayer.mockResolvedValue({
      claudeReview: {
        findings: [{ body: '', confidence: 'high', evidence: {}, id: 'f1', severity: 'high', title: 't' }],
        ok: true, summary: '', voiceId: 'claude',
      },
      modelLabel: 'opus',
      synthesis,
    });
    expect(await main(['review', '--working-tree'])).toBe(4);
  });

  it('a FAILED Opus reviewer (default-on, no HIGH from core) → exit 1, NOT a silent 0', async () => {
    // codex/grok reviewed cleanly, but the DEFAULT claude reviewer failed to complete.
    // The user asked for 3 reviewers and got 2 — must fail-loud (exit 1), never exit 0 as
    // if fully reviewed.
    mockRun.mockResolvedValue(result({ prompt: 'PINNED', reviews: [storedReview('codex', 'reviewed')] }));
    mockLayer.mockResolvedValue({
      claudeReview: { findings: [], ok: false, summary: 'claude produced no output', voiceId: 'claude' },
      modelLabel: 'opus',
      synthesis,
    });
    expect(await main(['review', '--working-tree'])).toBe(1);
  });

  it('a claude-layer CRASH (mockLayer throws) degrades → exit 1, review not falsely clean', async () => {
    mockRun.mockResolvedValue(result({ prompt: 'PINNED', reviews: [storedReview('codex', 'reviewed')] }));
    mockLayer.mockRejectedValue(new Error('unexpected FS error'));
    expect(await main(['review', '--working-tree'])).toBe(1);
  });
});

describe('profile selection (review vs security — same engine)', () => {
  it('review threads profile: "code" to the engine', async () => {
    mockRun.mockResolvedValue(result({ reviews: [storedReview('codex', 'reviewed')] }));
    await main(['review', '--working-tree']);
    expect(mockRun).toHaveBeenCalledWith(expect.objectContaining({ profile: 'code' }));
  });

  it('security threads profile: "security" to the engine (same diff-source flags)', async () => {
    mockRun.mockResolvedValue(result({ reviews: [storedReview('codex', 'reviewed')] }));
    const code = await main(['security', '--working-tree']);
    expect(code).toBe(0);
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ profile: 'security', workingTree: true })
    );
  });

  it('security honors the SAME HIGH gate (exit 4) as review', async () => {
    mockRun.mockResolvedValue(
      result({ reviews: [storedReview('codex', 'reviewed', 1, 'high')] })
    );
    expect(await main(['security', '--working-tree'])).toBe(4);
  });

  it('security rejects two explicit diff sources (exit 3), no review fired', async () => {
    expect(await main(['security', '--pr', '5', '--staged'])).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('security renders the dependency-surface block without crashing', async () => {
    mockRun.mockResolvedValue(
      result({
        depSurface: {
          manifests: [
            { added: 2, isLockfile: false, label: 'npm', path: 'package.json', samples: ['"left-pad": "^1.3.0"'] },
          ],
          riskyImports: [{ cls: 'deserialization', label: 'eval()', line: 12, path: 'src/run.ts' }],
        },
        reviews: [storedReview('codex', 'reviewed')],
      })
    );
    expect(await main(['security', '--working-tree'])).toBe(0);
  });
});

describe('diff-source resolution → engine inputs (all reviewers by default)', () => {
  it('NO --reviewers → reviewers undefined (engine runs ALL configured)', async () => {
    mockRun.mockResolvedValue(result({ reviews: [storedReview('codex', 'reviewed')] }));
    await main(['review', '--working-tree']);
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ reviewers: undefined })
    );
  });

  it('no source flag → commit mode (no diffText / staged / workingTree)', async () => {
    mockRun.mockResolvedValue(result({ reviews: [storedReview('codex', 'reviewed')] }));
    await main(['review']);
    const opts = mockRun.mock.lastCall![0];
    expect(opts.diffText).toBeUndefined();
    expect(opts.staged).toBeFalsy();
    expect(opts.workingTree).toBeFalsy();
  });

  it('--staged threads staged:true to the engine', async () => {
    mockRun.mockResolvedValue(result({ reviews: [storedReview('codex', 'reviewed')] }));
    await main(['review', '--staged']);
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ staged: true })
    );
  });

  it('--pr with a non-numeric value → usage error (exit 3), no review fired', async () => {
    expect(await main(['review', '--pr', 'abc'])).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('two explicit sources (--pr + --staged) → usage error (exit 3), no review fired', async () => {
    expect(await main(['review', '--pr', '5', '--staged'])).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('--pr with a malformed github PR URL → usage error (exit 3), no review fired', async () => {
    expect(await main(['review', '--pr', 'https://github.com/o/r/pull/abc'])).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('a bare-number positional (ambiguous with a path) → usage error (exit 3), no review', async () => {
    expect(await main(['review', '5'])).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('a non-URL positional → usage error (exit 3), no review fired', async () => {
    expect(await main(['review', 'not-a-url'])).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('a positional PR URL + --pr → conflict usage error (exit 3), no review fired', async () => {
    expect(
      await main(['review', 'https://github.com/o/r/pull/5', '--pr', '6'])
    ).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('two positionals → usage error (exit 3), no review fired', async () => {
    expect(
      await main([
        'review',
        'https://github.com/o/r/pull/5',
        'https://github.com/o/r/pull/6',
      ])
    ).toBe(3);
    expect(mockRun).not.toHaveBeenCalled();
  });
});

describe('brainstorm dispatch + arg parsing', () => {
  function brainstormResult(over: Partial<BrainstormResult> = {}): BrainstormResult {
    return {
      critique: [],
      generate: [
        {
          ideas: [{ body: 'b', id: 'codex-1', title: 't', voiceId: 'codex' }],
          ok: true,
          raw: '{}',
          summary: '',
          voiceId: 'codex',
        },
      ],
      roster: ['codex', 'grok', 'claude'],
      synthesis: { by: 'claude', degraded: false, ok: true, ranked: [], raw: null, summary: 's' },
      topic: 'name it',
      ...over,
    };
  }

  it('a topic → fires brainstorm and exits 0', async () => {
    mockBrainstorm.mockResolvedValue(brainstormResult());
    expect(await main(['brainstorm', 'name', 'the', 'CLI'])).toBe(0);
    expect(mockBrainstorm).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'name the CLI' })
    );
  });

  it('no topic → usage error (exit 3), nothing fired', async () => {
    expect(await main(['brainstorm'])).toBe(3);
    expect(mockBrainstorm).not.toHaveBeenCalled();
  });

  it('--help → exit 0, nothing fired', async () => {
    expect(await main(['brainstorm', '--help'])).toBe(0);
    expect(mockBrainstorm).not.toHaveBeenCalled();
  });

  it('--voices with an unknown id → usage error (exit 3), fail closed', async () => {
    expect(await main(['brainstorm', 'x', '--voices', 'codex,gemini'])).toBe(3);
    expect(mockBrainstorm).not.toHaveBeenCalled();
  });

  it('--synthesizer with an unknown id → usage error (exit 3)', async () => {
    expect(await main(['brainstorm', 'x', '--synthesizer', 'nope'])).toBe(3);
    expect(mockBrainstorm).not.toHaveBeenCalled();
  });

  it('--timeout seconds → milliseconds threaded to the engine', async () => {
    mockBrainstorm.mockResolvedValue(brainstormResult());
    await main(['brainstorm', 'x', '--timeout', '30', '--voices', 'codex,grok']);
    expect(mockBrainstorm).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 30_000, voices: ['codex', 'grok'] })
    );
  });

  it('--timeout that rounds to 0ms → usage error (exit 3), nothing fired', async () => {
    expect(await main(['brainstorm', 'x', '--timeout', '0.0001'])).toBe(3);
    expect(mockBrainstorm).not.toHaveBeenCalled();
  });

  it('--synthesizer outside the --voices roster → usage error (exit 3), fail closed', async () => {
    expect(
      await main(['brainstorm', 'x', '--voices', 'codex,grok', '--synthesizer', 'claude'])
    ).toBe(3);
    expect(mockBrainstorm).not.toHaveBeenCalled();
  });

  it('--synthesizer inside the roster is threaded to the engine', async () => {
    mockBrainstorm.mockResolvedValue(brainstormResult());
    await main(['brainstorm', 'x', '--voices', 'codex,grok', '--synthesizer', 'grok']);
    expect(mockBrainstorm).toHaveBeenCalledWith(
      expect.objectContaining({ synthesizer: 'grok', voices: ['codex', 'grok'] })
    );
  });

  it('an unexpected orchestration throw → exit 3 (operational error, not the all-empty 1)', async () => {
    mockBrainstorm.mockRejectedValue(new Error('boom'));
    expect(await main(['brainstorm', 'x'])).toBe(3);
  });

  it('every voice failed (no ideas) → exit 1', async () => {
    mockBrainstorm.mockResolvedValue(
      brainstormResult({
        generate: [
          { error: 'boom', ideas: [], ok: false, raw: null, summary: '', voiceId: 'codex' as const },
        ],
      })
    );
    expect(await main(['brainstorm', 'x'])).toBe(1);
  });

  it('printBrainstorm strips control/ANSI escapes from untrusted voice output', async () => {
    const ESC = '\u001b';
    mockBrainstorm.mockResolvedValue(
      brainstormResult({
        generate: [
          {
            ideas: [{ body: `body${ESC}[31m`, id: 'codex-1', title: `t${ESC}[0m`, voiceId: 'codex' }],
            ok: true,
            raw: '{}',
            summary: `sum${ESC}[1m`,
            voiceId: 'codex',
          },
        ],
        critique: [
          {
            critiques: [{ assessment: `weak${ESC}[5m`, stance: 'concern', target: `codex-1${ESC}[7m` }],
            extensions: [],
            ok: true,
            raw: null,
            summary: '',
            voiceId: 'grok',
          },
        ],
        synthesis: {
          by: 'claude',
          degraded: false,
          ok: true,
          raw: null,
          summary: `final${ESC}[2m`,
          // contributors + title + why + risks are UNTRUSTED synthesizer output.
          ranked: [
            { contributors: [`codex${ESC}[31m`, `grok${ESC}[0m`], rank: 1, title: `Winner${ESC}[0m`, why: `w${ESC}[4m`, risks: `r${ESC}[9m` },
          ],
        },
      })
    );
    expect(await main(['brainstorm', 'x'])).toBe(0);
    const printed = vi.mocked(console.log).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).not.toContain(ESC); // no escape char reached the terminal
    expect(printed).toContain('Winner'); // the cleaned content is still rendered
  });
});

describe('consult dispatch + arg parsing (+ ask alias)', () => {
  function consultResult(over: Partial<ConsultResult> = {}): ConsultResult {
    return {
      answers: [
        { answer: 'a', keyPoints: ['p'], ok: true, raw: '{}', summary: 's', voiceId: 'codex' },
      ],
      critique: [],
      question: 'q',
      roster: ['codex', 'grok', 'claude'],
      synthesis: {
        agreements: [],
        by: 'claude',
        degraded: false,
        divergences: [],
        ok: true,
        raw: null,
        recommendation: 'do X',
        summary: 's',
      },
      ...over,
    };
  }

  it('a question → fires consult and exits 0', async () => {
    mockConsult.mockResolvedValue(consultResult());
    expect(await main(['consult', 'Postgres', 'or', 'SQLite?'])).toBe(0);
    expect(mockConsult).toHaveBeenCalledWith(
      expect.objectContaining({ critique: false, question: 'Postgres or SQLite?' })
    );
  });

  it('the `ask` alias routes to consult', async () => {
    mockConsult.mockResolvedValue(consultResult());
    expect(await main(['ask', 'should I ship it?'])).toBe(0);
    expect(mockConsult).toHaveBeenCalledWith(
      expect.objectContaining({ question: 'should I ship it?' })
    );
  });

  it('no question → usage error (exit 3), nothing fired', async () => {
    expect(await main(['consult'])).toBe(3);
    expect(mockConsult).not.toHaveBeenCalled();
  });

  it('--help → exit 0, nothing fired', async () => {
    expect(await main(['consult', '--help'])).toBe(0);
    expect(mockConsult).not.toHaveBeenCalled();
  });

  it('--critique flag is threaded to the engine', async () => {
    mockConsult.mockResolvedValue(consultResult());
    await main(['consult', 'q', '--critique']);
    expect(mockConsult).toHaveBeenCalledWith(expect.objectContaining({ critique: true }));
  });

  it('--voices with an unknown id → usage error (exit 3), fail closed', async () => {
    expect(await main(['consult', 'q', '--voices', 'codex,gemini'])).toBe(3);
    expect(mockConsult).not.toHaveBeenCalled();
  });

  it('--synthesizer outside the --voices roster → usage error (exit 3)', async () => {
    expect(await main(['consult', 'q', '--voices', 'codex,grok', '--synthesizer', 'claude'])).toBe(3);
    expect(mockConsult).not.toHaveBeenCalled();
  });

  it('--timeout seconds → milliseconds threaded to the engine', async () => {
    mockConsult.mockResolvedValue(consultResult());
    await main(['consult', 'q', '--timeout', '45', '--voices', 'codex,grok']);
    expect(mockConsult).toHaveBeenCalledWith(
      expect.objectContaining({ timeoutMs: 45_000, voices: ['codex', 'grok'] })
    );
  });

  it('an unexpected orchestration throw → exit 3 (not the all-empty 1)', async () => {
    mockConsult.mockRejectedValue(new Error('boom'));
    expect(await main(['consult', 'q'])).toBe(3);
  });

  it('every voice failed (no answers) → exit 1', async () => {
    mockConsult.mockResolvedValue(
      consultResult({
        answers: [{ answer: '', error: 'boom', keyPoints: [], ok: false, raw: null, summary: '', voiceId: 'codex' }],
      })
    );
    expect(await main(['consult', 'q'])).toBe(1);
  });

  it('printConsult strips control/ANSI escapes from untrusted voice output', async () => {
    const ESC = '\u001b';
    mockConsult.mockResolvedValue(
      consultResult({
        answers: [
          { answer: `ans${ESC}[31m`, keyPoints: [`kp${ESC}[5m`], ok: true, raw: '{}', summary: `s${ESC}[1m`, voiceId: 'codex' },
        ],
        synthesis: {
          agreements: [{ point: `agree${ESC}[0m`, voices: [`codex${ESC}[31m`] }],
          by: 'claude',
          degraded: false,
          divergences: [{ point: `split${ESC}[7m`, positions: [`codex: now${ESC}[4m`] }],
          ok: true,
          raw: null,
          recommendation: `rec${ESC}[9m`,
          summary: `head${ESC}[2m`,
        },
      })
    );
    expect(await main(['consult', 'q'])).toBe(0);
    const printed = vi.mocked(console.log).mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).not.toContain(ESC);
    expect(printed).toContain('agree');
    expect(printed).toContain('split');
  });
});

// Helper: all console.log (stdout) lines the run emitted, joined.
const stdout = (): string =>
  vi.mocked(console.log).mock.calls.map((c) => c.join(' ')).join('\n');

describe('trail base (repo-local default + diff-source fence)', () => {
  it('repo-local .ensemble-ai/reviews when in a git repo reviewing its own diff', () => {
    expect(resolveTrailBase('/repo/root', true)).toBe(
      path.join('/repo/root', '.ensemble-ai', 'reviews')
    );
  });
  it('falls back to an OS temp dir when not in a git repo', () => {
    expect(resolveTrailBase(null, true)).toBe(
      path.join(os.tmpdir(), 'ensemble-ai', 'reviews')
    );
  });
  it('FENCE: an external diff source (URL PR / raw / stdin) never trails into the cwd repo', () => {
    // localRepoTrail=false models a --pr URL / --diff-file / stdin: a work/brain PR reviewed
    // from a personal cwd repo must be fenced to a temp dir, not written into that cwd repo.
    expect(resolveTrailBase('/repo/root', false)).toBe(
      path.join(os.tmpdir(), 'ensemble-ai', 'reviews')
    );
  });
});

describe('trail + pinned-input output', () => {
  it('emits the pinned review-input AND trail paths on stdout, single-nested under --out', async () => {
    mockRun.mockResolvedValue(result({ reviews: [storedReview('codex', 'reviewed')] }));
    await main(['review', '--working-tree', '--out', '/tmp/eai-out', '--run-id', 'myrun']);
    const out = stdout();
    // single <runId> segment — the double-<runId>/<runId> nesting bug is gone
    expect(out).toContain(path.join('/tmp/eai-out', 'myrun', 'prompt.codex.md'));
    expect(out).not.toContain(path.join('/tmp/eai-out', 'myrun', 'myrun'));
    // the trail path is on STDOUT (matches the doc), pointing at the per-run dir
    expect(out).toContain(`trail: ${path.join('/tmp/eai-out', 'myrun')}`);
  });

  it('always emits the pinned path when a trail exists (grok-only run, no codex)', async () => {
    mockRun.mockResolvedValue(result({ reviews: [storedReview('grok', 'reviewed')] }));
    await main(['review', '--working-tree', '--out', '/tmp/eai-out2', '--run-id', 'g']);
    expect(stdout()).toContain(path.join('/tmp/eai-out2', 'g', 'prompt.grok.md'));
  });

  it('sanitizes a traversal --run-id so the printed trail path stays under the base', async () => {
    mockRun.mockResolvedValue(result({ reviews: [storedReview('codex', 'reviewed')] }));
    await main(['review', '--working-tree', '--out', '/tmp/eai-out', '--run-id', '../evil']);
    const out = stdout();
    expect(out).toContain(path.join('/tmp/eai-out', '.._evil')); // separator collapsed
    expect(out).not.toContain(path.join('/tmp/eai-out', '..', 'evil')); // never climbs out
  });

  it('FENCE end-to-end: a --diff-file review defaults its trail to a temp dir, not the cwd repo', async () => {
    mockRun.mockResolvedValue(result({ reviews: [storedReview('codex', 'reviewed')] }));
    const df = path.join(os.tmpdir(), `eai-fence-${process.pid}.diff`);
    fs.writeFileSync(df, 'diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1 @@\n+x\n');
    try {
      // NO --out: the test cwd IS a git repo, but a --diff-file's provenance is external →
      // the trail must fence to the OS temp dir, never repo-local `.ensemble-ai`.
      await main(['review', '--diff-file', df]);
      const out = stdout();
      expect(out).toContain(path.join(os.tmpdir(), 'ensemble-ai', 'reviews'));
      expect(out).not.toContain(`${path.sep}.ensemble-ai${path.sep}reviews`);
    } finally {
      fs.rmSync(df, { force: true });
    }
  });
});
