import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewModeResult } from './modes/review';
import type { WorktreeSession } from './modes/review/worktree-run';

// `review --repo <dir>` end to end at the CLI seam: the engine and the worktree lifecycle are
// mocked, so what is under test is exactly the WIRING — which sources may ask for worktree
// evidence, what the pre-flight is given, what the engine receives, and that the worktree is
// reaped on EVERY exit path.
vi.mock('./modes/review', () => ({ runReviewMode: vi.fn() }));
vi.mock('./modes/review/worktree-run', () => ({ openWorktree: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'node:child_process';

import { main } from './cli';
import { runReviewMode } from './modes/review';
import { openWorktree } from './modes/review/worktree-run';

const mockRun = vi.mocked(runReviewMode);
const mockOpen = vi.mocked(openWorktree);
const mockExec = vi.mocked(execFileSync);

const HEAD = 'h'.repeat(40);
const BASE = 'b'.repeat(40);
const DIFF = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1 @@\n+y\n';
const URL = 'https://github.com/o/r/pull/7';

const engineResult = (): ReviewModeResult =>
  ({
    acquired: {
      baseRef: null,
      baseSha: null,
      canonicalDigest: 'sha256:x',
      coverage: { files: [], includedBytes: 0, includedFiles: 0, omittedFiles: 0, totalBytes: 0, totalFiles: 0 },
      diff: '',
      files: [],
      headSha: HEAD,
      mode: 'pr',
      rawDiff: '',
      repoId: 'o/r',
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
    secretScan: { blocked: false, inlineSecrets: [], overridden: false, sensitivePaths: [] },
  }) as unknown as ReviewModeResult;

let reaps: number;
let repoDir: string;

function session(): WorktreeSession {
  return {
    baseSha: BASE,
    dir: '/tmp/ensemble-worktree-xyz',
    headSha: HEAD,
    readableSurface: () => [],
    reap: () => {
      reaps += 1;
    },
    strippedInstructionFiles: [],
  };
}

// `gh api pulls/<N>` resolves base+head (so the source is SHA-bound) unless `resolveShas` is off.
let resolveShas = true;
beforeEach(() => {
  reaps = 0;
  resolveShas = true;
  repoDir = fs.mkdtempSync(path.join('/tmp', 'ensemble-cli-repo-'));
  mockRun.mockReset();
  mockRun.mockResolvedValue(engineResult());
  mockOpen.mockReset();
  mockOpen.mockReturnValue(session());
  mockExec.mockReset();
  mockExec.mockImplementation(((cmd: string, args: readonly string[] = []) => {
    const a = args.join(' ');
    if (cmd === 'gh' && a.includes('/pulls/')) {
      if (resolveShas) return JSON.stringify({ base: BASE, head: HEAD });
      throw new Error('gh api pulls: unresolved');
    }
    if (cmd === 'gh' && a.includes('/compare/')) return DIFF;
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'diff') return DIFF;
    throw new Error(`unexpected exec: ${cmd} ${a}`);
  }) as unknown as typeof execFileSync);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(repoDir, { force: true, recursive: true });
  vi.restoreAllMocks();
});

describe('`review --repo` refuses sources it cannot materialize (fail closed, upfront)', () => {
  it('a bare `--pr <N>` carries no base repo to verify the checkout against', async () => {
    const code = await main(['review', '--pr', '7', '--repo', repoDir, '--no-claude']);
    expect(code).toBe(3);
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it('a URL PR whose SHAs could not be bound has nothing to assert HEAD against', async () => {
    resolveShas = false;
    const code = await main(['review', URL, '--repo', repoDir, '--no-claude']);
    expect(code).toBe(3);
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('a local diff source is not a PR at all', async () => {
    const code = await main(['review', '--working-tree', '--repo', repoDir, '--no-claude']);
    expect(code).toBe(3);
    expect(mockOpen).not.toHaveBeenCalled();
  });
});

describe('`review --pr <url> --repo <dir>` materializes ONE worktree and hands it to every seat', () => {
  it('pre-flights with the PR`s base repo + head SHA, then threads the worktree into the engine', async () => {
    const code = await main(['review', URL, '--repo', repoDir, '--no-claude']);
    expect(code).toBe(0);

    expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen.mock.calls[0][0]).toEqual({
      baseSha: BASE,
      headSha: HEAD,
      pr: 7,
      prSlug: 'o/r',
      repoPath: repoDir,
    });

    const engineOpts = mockRun.mock.calls[0][0];
    expect(engineOpts.worktree).toEqual({
      baseSha: BASE,
      dir: '/tmp/ensemble-worktree-xyz',
      headSha: HEAD,
    });
    // `--no-claude` runs neither the Claude producer nor the gate, so neither is in the intent.
    expect(engineOpts.peerSeats).toEqual([]);
    expect(reaps).toBe(1);
  });

  it('the default roster puts the Claude producer AND the gate in the evidence intent', async () => {
    await main(['review', URL, '--repo', repoDir]);
    expect(mockRun.mock.calls[0][0].peerSeats).toEqual(['claude', 'gate']);
  });

  it('a pre-flight failure exits 3 by NAME and never runs a review', async () => {
    mockOpen.mockReturnValue({ kind: 'wrong-repo', message: 'no remote points at o/r' });
    const errors: string[] = [];
    vi.mocked(console.error).mockImplementation((m: unknown) => void errors.push(String(m)));
    const code = await main(['review', URL, '--repo', repoDir, '--no-claude']);
    expect(code).toBe(3);
    expect(errors.join('\n')).toContain('[wrong-repo]');
    expect(mockRun).not.toHaveBeenCalled();
    expect(reaps).toBe(0); // nothing was materialized, so nothing to reap
  });

  it('the worktree is REAPED even when the review throws (try/finally, spec §9)', async () => {
    mockRun.mockRejectedValue(new Error('engine exploded'));
    const code = await main(['review', URL, '--repo', repoDir, '--no-claude']);
    expect(code).toBe(3);
    expect(reaps).toBe(1);
  });
});

describe('packet mode is untouched — no --repo, no worktree, no pre-flight', () => {
  it('never opens a worktree and passes none to the engine', async () => {
    const code = await main(['review', URL, '--no-claude']);
    expect(code).toBe(0);
    expect(mockOpen).not.toHaveBeenCalled();
    expect(mockRun.mock.calls[0][0].worktree).toBeUndefined();
    expect(reaps).toBe(0);
  });
});

// The README is a contract with the reader. An example that no longer parses — a renamed flag, a
// source the command now refuses — is a broken promise, so the documented invocations are EXECUTED
// here, not eyeballed. (`gh` and the engine are mocked; the assertion is that each example reaches
// the worktree path rather than dying as a usage error.)
describe('the README`s `review --repo` examples are real invocations', () => {
  const readme = fs.readFileSync(path.join(process.cwd(), 'README.md'), 'utf8');

  it('the status note no longer claims `review --repo` refuses', () => {
    expect(readme).not.toContain('review --repo` is parsed and **refuses by name**');
    expect(readme).toContain('`review --repo <dir>` is **wired end to end**');
  });

  it('every documented `ensemble-ai review … --repo …` line runs the pre-flight', async () => {
    const examples = readme
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('ensemble-ai review ') && l.includes('--repo'));
    expect(examples.length).toBeGreaterThan(0);

    for (const line of examples) {
      mockOpen.mockClear();
      // `~/code/r` in the docs → this test's real temp dir; the pre-flight is mocked either way.
      const argv = line.split(/\s+/).slice(1).map((a) => (a === '~/code/r' ? repoDir : a));
      const code = await main(argv);
      expect(code, line).not.toBe(3); // 3 = usage error: the example does not parse
      expect(mockOpen, line).toHaveBeenCalledTimes(1);
      expect(mockOpen.mock.calls[0][0].repoPath, line).toBe(repoDir);
    }
  });
});
