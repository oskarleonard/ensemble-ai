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

import { main } from './cli';
import { runReviewMode } from './modes/review';

const mockRun = vi.mocked(runReviewMode);

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

  it('a planned-but-unimplemented mode (brainstorm) → exit 3', async () => {
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
});
