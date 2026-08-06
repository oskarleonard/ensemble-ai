import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewModeResult } from './modes/review';

// Same harness as cli.url-pr-conventions.test.ts: mock the engine so we can inspect the packet
// inputs the CLI threads in, and mock child_process so every `gh` call is scripted — including the
// `gh pr view --json title,body` this file is about, which can be made to FAIL on demand.
vi.mock('./modes/review', () => ({ runReviewMode: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'node:child_process';

import { main } from './cli';
import { runReviewMode } from './modes/review';

const mockRun = vi.mocked(runReviewMode);
const mockExec = vi.mocked(execFileSync);

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
const TITLE = 'MOBI-554 · gate Next on loaded accounts';
const BODY = 'Adds the loading guard.\n\nRider: also bumps the SDK.';

// Script the gh calls the review path makes. `prView` decides what `gh pr view --json title,body`
// does — the one call under test.
let prView: () => string = () => JSON.stringify({ body: BODY, title: TITLE });
function scriptGh(): void {
  mockExec.mockImplementation(((cmd: string, args: readonly string[] = []) => {
    const a = args.join(' ');
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') return prView();
    if (cmd === 'gh' && a.includes('/pulls/')) throw new Error('gh api pulls: unresolved');
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'diff') return DIFF;
    throw new Error(`unexpected exec: ${cmd} ${a}`);
  }) as unknown as typeof execFileSync);
}

const prViewCalls = (): string[][] =>
  mockExec.mock.calls
    .filter((c) => c[0] === 'gh' && ((c[1] ?? []) as string[])[1] === 'view')
    .map((c) => (c[1] ?? []) as string[]);

const directiveOf = (): string | undefined => mockRun.mock.calls[0]?.[0].directive;

const errorLines = (): string[] =>
  vi.mocked(console.error).mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  mockRun.mockReset();
  mockRun.mockResolvedValue(engineResult());
  mockExec.mockReset();
  prView = () => JSON.stringify({ body: BODY, title: TITLE });
  scriptGh();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

// The packet's `directive` slot sat empty for the whole PR path, so a reviewer had to infer intent
// from the diff — which is how a deliberate, ticket-sanctioned change gets flagged as out-of-scope.
// The PR's own description is the author's stated intent, and it costs one `gh pr view`.
describe('the PR description fills the packet directive slot', () => {
  it('a URL PR threads title + body, addressed with -R so it works from any cwd', async () => {
    expect(await main(['review', 'https://github.com/o/r/pull/7'])).toBe(0);
    expect(prViewCalls()).toEqual([
      ['pr', 'view', '7', '-R', 'o/r', '--json', 'title,body'],
    ]);
    expect(directiveOf()).toBe(`${TITLE}\n\n${BODY}`);
  });

  it('a bare `--pr <N>` omits -R (it targets the cwd repo, exactly as the diff fetch did)', async () => {
    expect(await main(['review', '--pr', '7'])).toBe(0);
    expect(prViewCalls()).toEqual([['pr', 'view', '7', '--json', 'title,body']]);
    expect(directiveOf()).toBe(`${TITLE}\n\n${BODY}`);
  });

  it('an EMPTY description still yields the title — a titled PR always states something', async () => {
    prView = () => JSON.stringify({ body: '', title: TITLE });
    expect(await main(['review', '--pr', '7'])).toBe(0);
    expect(directiveOf()).toBe(TITLE);
  });

  it('a NON-PR source fetches nothing — a working-tree diff has no stated intent to read', async () => {
    expect(await main(['review', '--working-tree'])).toBe(0);
    expect(prViewCalls()).toEqual([]);
    expect(directiveOf()).toBeUndefined();
  });
});

// The directive is CONTEXT, never evidence: losing it must degrade the review, not block it. But a
// silently missing directive is indistinguishable from a PR with no description, so the absence is
// stated in the run log — the same posture as the conventions-skipped line.
describe('a directive that cannot be fetched degrades LOUDLY, never silently', () => {
  it('a gh failure leaves the directive unset and says so in the run log', async () => {
    prView = () => {
      throw Object.assign(new Error('gh failed'), { stderr: 'gh: HTTP 401 — bad credentials' });
    };
    expect(await main(['review', '--pr', '7'])).toBe(0); // the review still runs
    expect(directiveOf()).toBeUndefined();
    const line = errorLines().find((l) => l.includes('directive:'));
    expect(line).toContain('bad credentials');
    expect(line).toContain("WITHOUT the author's stated intent");
  });

  it('an unparseable gh payload is a failure, not a half-read directive', async () => {
    prView = () => 'not json';
    expect(await main(['review', '--pr', '7'])).toBe(0);
    expect(directiveOf()).toBeUndefined();
    expect(errorLines().some((l) => l.includes('directive:'))).toBe(true);
  });

  it('a PR with neither title nor body is reported too (nothing to hand the reviewers)', async () => {
    prView = () => JSON.stringify({ body: '   ', title: '' });
    expect(await main(['review', '--pr', '7'])).toBe(0);
    expect(directiveOf()).toBeUndefined();
    expect(errorLines().some((l) => l.includes('no title or description'))).toBe(true);
  });
});
