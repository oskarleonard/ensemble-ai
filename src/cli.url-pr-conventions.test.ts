import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewModeResult } from './modes/review';

// Mock the engine so we can inspect the CONVENTION READER the CLI threads in for a URL
// PR — without running a real review. Mock child_process so the gh calls are scripted:
// the SHA resolution can be made to FAIL, exercising the unbound-diff fallback path.
vi.mock('./modes/review', () => ({ runReviewMode: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'node:child_process';

import { main } from './cli';
import { runReviewMode } from './modes/review';

const mockRun = vi.mocked(runReviewMode);
const mockExec = vi.mocked(execFileSync);

// A minimal engine result so reviewCommand runs to completion (exit 0).
const engineResult = (): ReviewModeResult =>
  ({
    acquired: {
      baseRef: null,
      baseSha: null,
      canonicalDigest: 'sha256:x',
      coverage: {
        files: [],
        includedBytes: 0,
        includedFiles: 0,
        omittedFiles: 0,
        totalBytes: 0,
        totalFiles: 0,
      },
      diff: '',
      files: [],
      headSha: 'h',
      mode: 'pr',
      rawDiff: '',
      repoId: null,
    },
    blocked: false,
    reviews: [
      {
        findings: [],
        packet: { complete: true, manifest: [] },
        reviewer: { effort: 'high', model: 'm', vendor: 'v' },
        reviewerId: 'codex',
        runId: 'r',
        summary: 's',
        terminalState: 'reviewed',
      },
    ],
    secretScan: {
      blocked: false,
      inlineSecrets: [],
      overridden: false,
      sensitivePaths: [],
    },
  }) as unknown as ReviewModeResult;

const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+y\n';

// Script the gh calls: `pulls` resolves the head SHA only when `resolveShas` is set;
// `compare` and `pr diff` both return the diff.
let resolveShas = false;
function scriptGh(): void {
  mockExec.mockImplementation(((cmd: string, args: readonly string[] = []) => {
    const a = args.join(' ');
    if (cmd === 'gh' && a.includes('/pulls/')) {
      if (resolveShas) {
        return JSON.stringify({ base: 'b'.repeat(40), head: 'h'.repeat(40) });
      }
      throw new Error('gh api pulls: unresolved');
    }
    if (cmd === 'gh' && a.includes('/compare/')) return DIFF;
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'diff') return DIFF;
    throw new Error(`unexpected exec: ${cmd} ${a}`);
  }) as unknown as typeof execFileSync);
}

beforeEach(() => {
  mockRun.mockReset();
  mockRun.mockResolvedValue(engineResult());
  mockExec.mockReset();
  resolveShas = false;
  scriptGh();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('URL PR conventions never fall back to the LOCAL repo', () => {
  it('unresolvable head SHA → conventionReader is null (NOT the cwd repo)', async () => {
    resolveShas = false;
    const code = await main(['review', 'https://github.com/o/r/pull/7']);
    expect(code).toBe(0);
    // The unbound fallback ran (gh pr diff -R), and conventions were suppressed —
    // never the local cwd's fsConventionReader (a DIFFERENT repo).
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ conventionReader: null })
    );
  });

  it('resolved head SHA → a (gh-backed) reader IS threaded in (control)', async () => {
    resolveShas = true;
    const code = await main(['review', 'https://github.com/o/r/pull/7']);
    expect(code).toBe(0);
    // With SHAs resolved, conventions come from the PR repo at its head — a non-null
    // reader, proving the suppression is scoped to the unresolvable case only.
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ conventionReader: expect.anything() })
    );
  });
});
