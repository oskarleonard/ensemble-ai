import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewModeResult } from './modes/review';

// Same harness as cli.directive.test.ts: mock the engine so we can inspect what the CLI threads
// into the packet, and mock child_process so every `gh` call is scripted — including the check-runs
// API this file is about, which can be made to FAIL on demand.
vi.mock('./modes/review', () => ({ runReviewMode: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
// Mock ONLY the spawned Opus layer (the real roster/render helpers stay), so the OTHER consumer of
// the gathered evidence — the worktree producer, which never reads the packet prompt — is pinned
// at the CLI seam without spawning a `claude -p`.
vi.mock('./modes/review/self-contained', async (importActual) => ({
  ...(await importActual<typeof import('./modes/review/self-contained')>()),
  runClaudeReviewLayer: vi.fn(),
}));

import { execFileSync } from 'node:child_process';

import { main } from './cli';
import { runReviewMode } from './modes/review';
import { runClaudeReviewLayer } from './modes/review/self-contained';

const mockRun = vi.mocked(runReviewMode);
const mockExec = vi.mocked(execFileSync);
const mockLayer = vi.mocked(runClaudeReviewLayer);

// A minimal engine result so reviewCommand runs to completion (exit 0). No `prompt`, so the
// self-contained Opus layer is never expected and no real seat is ever spawned.
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
const HEAD = 'a'.repeat(40); // a real 40-hex commit id: the gatherer admits nothing else

// One failing check with one annotation — the shape the whole feature exists for.
const CHECK_RUNS = JSON.stringify({
  check_runs: [
    {
      conclusion: 'failure',
      id: 11,
      name: 'lint',
      output: { annotations_count: 1, title: 'eslint' },
      status: 'completed',
    },
  ],
});
const ANNOTATIONS = JSON.stringify([
  {
    annotation_level: 'warning',
    end_line: 4,
    message: 'error: could not apply the migration',
    path: 'db/0001.sql',
    start_line: 4,
  },
]);

// `checkRuns` scripts the check-runs API — the call under test.
let checkRuns: () => string = () => CHECK_RUNS;
function scriptGh(): void {
  mockExec.mockImplementation(((cmd: string, args: readonly string[] = []) => {
    const a = args.join(' ');
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
      return a.includes('headRefOid')
        ? JSON.stringify({ headRefOid: HEAD })
        : JSON.stringify({ body: 'b', title: 't' });
    }
    if (cmd === 'gh' && args[0] === 'repo' && args[1] === 'view') return 'o/r\n';
    if (cmd === 'gh' && a.includes('/check-runs?')) return checkRuns();
    if (cmd === 'gh' && a.includes('/annotations')) return ANNOTATIONS;
    if (cmd === 'gh' && a.includes('/status')) return JSON.stringify({ statuses: [] });
    if (cmd === 'gh' && a.includes('/pulls/')) throw new Error('gh api pulls: unresolved');
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'diff') return DIFF;
    throw new Error(`unexpected exec: ${cmd} ${a}`);
  }) as unknown as typeof execFileSync);
}

const threaded = (): { ciEvidence?: string; ciEvidenceUnavailable?: string } =>
  mockRun.mock.calls[0]?.[0] ?? {};

const ghCalls = (): string[] => mockExec.mock.calls.map((c) => ((c[1] ?? []) as string[]).join(' '));

const errorLines = (): string[] =>
  vi.mocked(console.error).mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  mockRun.mockReset();
  mockRun.mockResolvedValue(engineResult());
  mockLayer.mockReset();
  mockExec.mockReset();
  checkRuns = () => CHECK_RUNS;
  scriptGh();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// CI EVIDENCE (incident 2026-08-10): the head's check runs + their annotations are the machine's
// OWN execution result for this change — the cheapest evidence a seat never gathers on its own.
// Default ON for the PR path, because a review that skips it reads a migration as text while the
// database's verdict on it sits unread in a green job.
describe('the PR head’s CI evidence reaches the packet', () => {
  it('threads the rendered evidence and reports what it gathered on one line', async () => {
    expect(await main(['review', 'https://github.com/o/r/pull/7'])).toBe(0);
    const { ciEvidence, ciEvidenceUnavailable } = threaded();
    expect(ciEvidence).toContain('failure · lint');
    // The warning annotation whose text is an error — the whole point of the section.
    expect(ciEvidence).toContain('could not apply the migration');
    expect(ciEvidenceUnavailable).toBeUndefined();
    const line = errorLines().find((l) => l.includes('CI evidence:'));
    expect(line).toContain('1 check run(s) (1 failed)');
    expect(line).toContain('1 annotation(s)');
  });

  it('--no-ci-evidence fetches nothing at all (no section, no gh call)', async () => {
    expect(await main(['review', 'https://github.com/o/r/pull/7', '--no-ci-evidence'])).toBe(0);
    expect(threaded().ciEvidence).toBeUndefined();
    expect(threaded().ciEvidenceUnavailable).toBeUndefined();
    expect(ghCalls().some((c) => c.includes('check-runs'))).toBe(false);
  });

  it('a NON-PR source fetches nothing — a working-tree diff has no checks to read', async () => {
    expect(await main(['review', '--working-tree'])).toBe(0);
    expect(threaded().ciEvidence).toBeUndefined();
    expect(threaded().ciEvidenceUnavailable).toBeUndefined();
    expect(ghCalls().some((c) => c.includes('check-runs'))).toBe(false);
  });
});

// The evidence is CONTEXT, never a gate: losing it must degrade the review, not block it. But a
// silently missing section is indistinguishable from a PR with no checks, so the absence is stated
// twice — in the run log AND (by the packet) in the prompt itself.
describe('CI evidence that cannot be fetched degrades LOUDLY, never silently', () => {
  it('a gh failure names the reason and the review still runs', async () => {
    checkRuns = () => {
      throw Object.assign(new Error('gh failed'), { stderr: 'gh: HTTP 403 — forbidden' });
    };
    expect(await main(['review', 'https://github.com/o/r/pull/7'])).toBe(0);
    expect(threaded().ciEvidence).toBeUndefined();
    expect(threaded().ciEvidenceUnavailable).toContain('check runs unavailable');
    const line = errorLines().find((l) => l.includes('CI evidence:'));
    expect(line).toContain('unavailable');
    expect(line).toContain("reviewing without the head's check results");
  });
});

// The packet is not the only consumer. The worktree claude producer renders its OWN prompt
// (renderCodeReviewSeatPrompt), so the gathered text reaches that seat only if the CLI hands it to
// the Opus layer — the seam below. Without this the most valuable producer could go blind to the
// head's own check output and every renderer test would still pass.
describe('the gathered evidence also reaches the Opus layer (the worktree producer)', () => {
  const withLayer = (): void => {
    mockRun.mockResolvedValue({
      ...engineResult(),
      pinnedDiff: DIFF,
      prompt: 'PACKET PROMPT',
    } as unknown as ReviewModeResult);
    mockLayer.mockResolvedValue({
      claudeReview: null,
      gateTrailWritten: true,
      gateVerdicts: [],
      modelLabel: 'opus',
      synthesis: {
        agreements: [],
        bottomLine: 'ok',
        by: 'claude',
        degraded: false,
        disagreements: [],
        ok: true,
        raw: null,
        summary: 's',
      },
    } as unknown as Awaited<ReturnType<typeof runClaudeReviewLayer>>);
  };

  it('passes the rendered CI text into runClaudeReviewLayer', async () => {
    withLayer();
    await main(['review', 'https://github.com/o/r/pull/7']);
    expect(mockLayer).toHaveBeenCalledWith(
      expect.objectContaining({ ciEvidence: expect.stringContaining('failure \u00b7 lint') })
    );
    expect(mockLayer.mock.calls[0][0].ciEvidenceUnavailable).toBeUndefined();
  });

  it('passes the REASON instead when the fetch failed — the seat must not read silence as green', async () => {
    withLayer();
    checkRuns = () => {
      throw Object.assign(new Error('gh failed'), { stderr: 'gh: HTTP 403 — forbidden' });
    };
    await main(['review', 'https://github.com/o/r/pull/7']);
    const opts = mockLayer.mock.calls[0][0];
    expect(opts.ciEvidence).toBeUndefined();
    expect(opts.ciEvidenceUnavailable).toContain('check runs unavailable');
  });
});
