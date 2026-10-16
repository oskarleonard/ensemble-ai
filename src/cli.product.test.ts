import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ReviewModeResult } from './modes/review';
import type { WorktreeSession } from './modes/review/worktree-run';

// `review --product-docs <file>` at the CLI seam: the engine, the worktree lifecycle and every
// Anthropic stage are mocked, so what is under test is exactly the WIRING — when the product seat
// starts, what it is handed, how it resolves, and that every reason it does not start is ONE loud
// line and never a failed review. No seat is ever spawned here.
const VOICES = vi.hoisted(() => {
  const p = `${process.env.TMPDIR ?? '/tmp'}/ensemble-cli-product-${process.pid}-voices.json`;
  process.env.ENSEMBLE_VOICES_FILE = p;
  return p;
});
vi.mock('./modes/review', () => ({ runReviewMode: vi.fn() }));
vi.mock('./modes/review/worktree-run', () => ({ openWorktree: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('./modes/review/self-contained', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./modes/review/self-contained')>();
  const never = () => new Promise<never>(() => {});
  return {
    ...orig,
    runClaudeProducer: vi.fn(never),
    runHolisticStage: vi.fn(never),
    runIntegrationStage: vi.fn(never),
    runProductStage: vi.fn(async () => ({ productReview: null, productSkipped: null })),
  };
});

import { execFileSync } from 'node:child_process';

import { main } from './cli';
import { runReviewMode } from './modes/review';
import { runProductStage } from './modes/review/self-contained';
import { PRODUCT_DOCS } from './modes/review/product-fixture';
import { openWorktree } from './modes/review/worktree-run';

const mockRun = vi.mocked(runReviewMode);
const mockOpen = vi.mocked(openWorktree);
const mockExec = vi.mocked(execFileSync);
const mockProduct = vi.mocked(runProductStage);

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
    secretScan: { blocked: false, inlineSecrets: [], inlineSecretsAllowlisted: [], inlineSecretsOmitted: [], overridden: false, sensitivePaths: [] },
  }) as unknown as ReviewModeResult;

const session = (): WorktreeSession => ({
  baseRef: null,
  baseSha: BASE,
  baseTip: null,
  dir: '/tmp/ensemble-worktree-product',
  headFetchedBySha: false,
  headSha: HEAD,
  readableSurface: () => [],
  reap: () => {},
  strippedInstructionFiles: [],
});

// What the engine hands its onPacketsReady hook: one part, or parts with a skeleton.
let ready: Record<string, unknown>;
let dir: string;
let docsFile: string;
const errorLines = (): string[] => vi.mocked(console.error).mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  dir = fs.mkdtempSync(path.join('/tmp', 'ensemble-cli-product-'));
  docsFile = path.join(dir, 'acme-1.product.md');
  fs.writeFileSync(docsFile, PRODUCT_DOCS);
  ready = { headSha: HEAD, parts: [{ diff: DIFF, index: 1, label: 'part 1', prompt: 'P' }], pinnedDiff: DIFF, prompt: 'P' };
  mockRun.mockReset();
  mockRun.mockImplementation(async (opts) => {
    opts.onPacketsReady?.(ready as never);
    return engineResult();
  });
  mockOpen.mockReset();
  mockOpen.mockReturnValue(session());
  mockProduct.mockClear();
  mockExec.mockReset();
  mockExec.mockImplementation(((cmd: string, args: readonly string[] = []) => {
    const a = args.join(' ');
    if (cmd === 'gh' && a.includes('/pulls/')) return JSON.stringify({ base: BASE, head: HEAD });
    if (cmd === 'gh' && a.includes('/compare/')) return DIFF;
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'diff') return DIFF;
    throw new Error(`unexpected exec: ${cmd} ${a}`);
  }) as unknown as typeof execFileSync);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  fs.rmSync(dir, { force: true, recursive: true });
  fs.rmSync(VOICES, { force: true });
  vi.restoreAllMocks();
});

describe('--product-docs threads the docs into ONE product seat (worktree evidence)', () => {
  it('starts the seat with the docs verbatim, opus @ high, the worktree, and the one-part diff', async () => {
    expect(await main(['review', URL, '--repo', dir, '--product-docs', docsFile])).toBe(0);
    expect(mockProduct).toHaveBeenCalledTimes(1);
    const opts = mockProduct.mock.calls[0][0];
    expect(opts.docs).toBe(PRODUCT_DOCS);
    expect(opts.config).toMatchObject({ effort: 'high', model: 'opus', vendor: 'anthropic' });
    expect(opts.worktree).toBe('/tmp/ensemble-worktree-product');
    expect(opts.change).toEqual({ diff: DIFF, kind: 'diff' });
    expect(opts.baseSha).toBe(BASE);
    const lines = errorLines();
    expect(lines).toContain(`· product docs: 3 source(s) from ${docsFile} (engineering/acme-billing-tdd, ACME-12, product/acme-billing-prd STALE) — handed to the product seat`);
    expect(lines.some((l) => l.startsWith('· anthropic stages started alongside the core:') && l.endsWith(' + product seat'))).toBe(true);
  });

  it('on a review in parts it hands the listing + the skeleton instead of a diff', async () => {
    ready = { ...ready, lensHandoff: { diff: DIFF, scope: 'part 1 — x\npart 2 — y' }, skeleton: '### x — part 1' };
    await main(['review', URL, '--repo', dir, '--product-docs', docsFile]);
    expect(mockProduct.mock.calls[0][0].change).toEqual({ kind: 'parts', scope: 'part 1 — x\npart 2 — y', skeleton: '### x — part 1' });
  });

  it('pins resolve flag → voices.json `product` → opus @ high', async () => {
    fs.writeFileSync(VOICES, JSON.stringify({ product: { effort: 'xhigh', model: 'sonnet' } }));
    await main(['review', URL, '--repo', dir, '--product-docs', docsFile]);
    expect(mockProduct.mock.calls[0][0].config).toMatchObject({ effort: 'xhigh', model: 'sonnet' });
    mockProduct.mockClear();
    await main(['review', URL, '--repo', dir, '--product-docs', docsFile, '--product-model', 'opus', '--product-effort', 'max']);
    expect(mockProduct.mock.calls[0][0].config).toMatchObject({ effort: 'max', model: 'opus' });
  });
});

describe('every reason the seat does not start is ONE loud line — never a failed review', () => {
  it.each([
    ['an unreadable file', () => ['review', URL, '--repo', dir, '--product-docs', path.join(dir, 'missing.md')], /^· product: skipped — .*missing\.md unreadable/],
    ['a file with no source', () => (fs.writeFileSync(docsFile, '# product docs: none — no ticket; product seat not spawned\n'), ['review', URL, '--repo', dir, '--product-docs', docsFile]), /^· product: skipped — .* names no source/],
    ['--no-product', () => ['review', URL, '--repo', dir, '--product-docs', docsFile, '--no-product'], /^· product: skipped — --no-product; product seat not spawned$/],
    ['no worktree evidence', () => ['review', URL, '--product-docs', docsFile], /^· product: skipped — this run has no worktree evidence \(--repo\)/],
    ['--no-claude', () => ['review', URL, '--repo', dir, '--product-docs', docsFile, '--no-claude'], /^· product: skipped — the claude layer is off/],
  ])('%s', async (_, argv, line) => {
    expect(await main(argv())).toBe(0);
    expect(mockProduct).not.toHaveBeenCalled();
    expect(errorLines().filter((l) => line.test(l))).toHaveLength(1);
  });

  it('without the flag nothing about the seat is said or started — a ticket PR runs as before', async () => {
    fs.writeFileSync(VOICES, JSON.stringify({ product: { advisor: 'Not A Model' } })); // never read
    expect(await main(['review', URL, '--repo', dir])).toBe(0);
    expect(mockProduct).not.toHaveBeenCalled();
    expect(errorLines().some((l) => /· product|product seat|product docs/.test(l))).toBe(false);
  });
});
