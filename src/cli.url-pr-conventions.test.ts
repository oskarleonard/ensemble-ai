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
    // With SHAs resolved, conventions come from the PR repo — a non-null reader, proving the
    // suppression is scoped to the unresolvable case only.
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({ conventionReader: expect.anything() })
    );
  });
});

// Conventions land VERBATIM in every seat's prompt, so the ref they are read at is a security
// boundary, not a freshness preference: at the PR head a contributor could add a `CLAUDE.md` and
// address the reviewers directly. The base ref is the repo owner's text.
describe('URL PR conventions are read at the BASE ref, never the PR head', () => {
  const BASE = 'b'.repeat(40);
  const HEAD = 'h'.repeat(40);

  const ghUrls = (): string[] =>
    mockExec.mock.calls.map((c) => ((c[1] ?? []) as string[]).join(' '));

  it('the threaded reader fetches file contents at ?ref=<baseSha>', async () => {
    resolveShas = true;
    expect(await main(['review', 'https://github.com/o/r/pull/7'])).toBe(0);

    const reader = mockRun.mock.calls[0][0].conventionReader;
    expect(reader).toBeTruthy();
    mockExec.mockClear();
    // The gh reader mints its URL from the ref it closed over — exercise it, read that URL back.
    await reader?.read('CLAUDE.md');

    expect(ghUrls().some((u) => u.includes(`contents/CLAUDE.md?ref=${BASE}`))).toBe(true);
    expect(ghUrls().some((u) => u.includes(HEAD))).toBe(false);
  });

  it('the same base ref governs the directory sweeps (docs/, ai-spec/)', async () => {
    resolveShas = true;
    expect(await main(['review', 'https://github.com/o/r/pull/7'])).toBe(0);

    const reader = mockRun.mock.calls[0][0].conventionReader;
    mockExec.mockClear();
    await reader?.list('docs');

    expect(ghUrls().some((u) => u.includes(`?ref=${BASE}`))).toBe(true);
    expect(ghUrls().some((u) => u.includes(HEAD))).toBe(false);
  });
});

// A probe MISS is the gatherer's normal case (candidate paths mostly don't exist) — it must be
// SILENT (the old mirrored `gh: Not Found (HTTP 404)` printed ~60 lines per URL-PR run). A
// NON-404 failure (auth expiry, rate limit) must stay LOUD exactly once per distinct message:
// the reader degrades to null/[] by design, so a broken gh would otherwise read as "0/N
// gathered" with no visible cause.
describe('URL PR conventions probes — misses silent, real gh failures loud ONCE', () => {
  const ghErr = (stderr: string): Error => Object.assign(new Error('gh failed'), { stderr });

  const probeLines = (): string[] =>
    vi
      .mocked(console.error)
      .mock.calls.map((c) => String(c[0]))
      .filter((s) => s.includes('conventions probe'));

  it('404 misses print nothing', async () => {
    resolveShas = true;
    expect(await main(['review', 'https://github.com/o/r/pull/7'])).toBe(0);
    const reader = mockRun.mock.calls[0][0].conventionReader;
    expect(reader).toBeTruthy();

    mockExec.mockImplementation((() => {
      throw ghErr('gh: Not Found (HTTP 404)');
    }) as unknown as typeof execFileSync);
    expect(await reader?.read('AGENTS.md')).toBeNull();
    expect(await reader?.read('docs/NOPE.md')).toBeNull();
    expect(await reader?.list('docs')).toEqual([]);
    expect(probeLines()).toEqual([]);
  });

  it('a non-404 failure surfaces once per distinct message, deduped across probes', async () => {
    resolveShas = true;
    expect(await main(['review', 'https://github.com/o/r/pull/7'])).toBe(0);
    const reader = mockRun.mock.calls[0][0].conventionReader;

    mockExec.mockImplementation((() => {
      throw ghErr('gh: HTTP 401 — bad credentials');
    }) as unknown as typeof execFileSync);
    expect(await reader?.read('CLAUDE.md')).toBeNull();
    expect(await reader?.read('AGENTS.md')).toBeNull();
    expect(await reader?.list('docs')).toEqual([]);

    const lines = probeLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('bad credentials');
  });
});
