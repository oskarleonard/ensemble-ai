import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReviewerId, StoredReview, TerminalState } from '../../core/types';

import type { Coverage } from './diff';
import {
  buildDiffReceipt,
  computePolicyHash,
  type DiffReviewReceipt,
  isDiffReviewed,
  type ReceiptKey,
  readReceipt,
  receiptKeyHash,
  writeReceipt,
} from './receipt';

function review(
  reviewerId: ReviewerId,
  vendor: string,
  terminalState: TerminalState = 'reviewed'
): StoredReview {
  return {
    findings: [],
    packet: { complete: true, manifest: [] },
    reviewer: { effort: 'high', model: 'm', vendor },
    reviewerId,
    runId: 'run-1',
    summary: '',
    terminalState,
  };
}

function coverage(
  omitted: { kind: string; path: string; reason: string }[] = []
): Coverage {
  const files = omitted.map((o) => ({
    added: 0,
    bytes: 1,
    included: false,
    kind: o.kind as 'source' | 'generated' | 'binary',
    omitReason: o.reason as 'binary' | 'generated' | 'over-limit',
    path: o.path,
    removed: 0,
  }));
  return {
    files,
    includedBytes: 0,
    includedFiles: 0,
    omittedFiles: files.length,
    totalBytes: 0,
    totalFiles: files.length,
  };
}

const BASE = {
  baseRef: 'origin/main',
  baseSha: 'aaa',
  coveragePolicy: { ceilingBytes: 200_000 },
  diffDigest: 'sha256:deadbeef',
  diffMode: 'commit' as const,
  diffTruncated: false,
  headSha: 'bbb',
  repo: 'https://example/repo',
  runId: 'run-1',
};

describe('computePolicyHash', () => {
  it('is sha256:-prefixed and order-independent in reviewerPolicy', () => {
    const a = computePolicyHash({ coveragePolicy: { ceilingBytes: 1 }, diffMode: 'commit', reviewerPolicy: ['codex', 'grok'] });
    const b = computePolicyHash({ coveragePolicy: { ceilingBytes: 1 }, diffMode: 'commit', reviewerPolicy: ['grok', 'codex'] });
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a).toBe(b);
  });

  it('differs when the policy differs (reviewers, mode, or coverage ceiling)', () => {
    const base = { coveragePolicy: { ceilingBytes: 1 }, diffMode: 'commit' as const, reviewerPolicy: ['codex'] as ReviewerId[] };
    expect(computePolicyHash(base)).not.toBe(computePolicyHash({ ...base, reviewerPolicy: ['codex', 'grok'] }));
    expect(computePolicyHash(base)).not.toBe(computePolicyHash({ ...base, coveragePolicy: { ceilingBytes: 2 } }));
  });
});

describe('receiptKeyHash — the full reviewed identity (no collisions)', () => {
  const k: ReceiptKey = { baseSha: 'aaa', diffDigest: 'sha256:d1', headSha: 'bbb', policyHash: 'sha256:p1', repo: 'r' };
  it('is stable for the same key', () => {
    expect(receiptKeyHash(k)).toBe(receiptKeyHash({ ...k }));
  });
  it('two bases on one head do NOT collide', () => {
    expect(receiptKeyHash(k)).not.toBe(receiptKeyHash({ ...k, baseSha: 'ccc', diffDigest: 'sha256:d2' }));
  });
  it('two policies on one (head, digest) do NOT collide', () => {
    expect(receiptKeyHash(k)).not.toBe(receiptKeyHash({ ...k, policyHash: 'sha256:p2' }));
  });
});

describe('buildDiffReceipt', () => {
  it('qualifies when every required reviewer completed + coverage has no omitted source', () => {
    const r = buildDiffReceipt({
      ...BASE,
      coverage: coverage([{ kind: 'generated', path: 'package-lock.json', reason: 'generated' }]),
      required: ['codex', 'grok'],
      reviews: [review('codex', 'openai'), review('grok', 'xai')],
    });
    expect(r.ok).toBe(true);
    expect(r.receipt?.completed).toEqual(['codex', 'grok']);
    expect(r.receipt?.vendors.sort()).toEqual(['openai', 'xai']);
    expect(r.receipt?.diffDigest).toBe('sha256:deadbeef');
    expect(r.receipt?.policyHash).toMatch(/^sha256:/);
  });

  it('does NOT qualify a codex-only run against a codex+grok policy', () => {
    const r = buildDiffReceipt({ ...BASE, coverage: coverage(), required: ['codex', 'grok'], reviews: [review('codex', 'openai')] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/grok/);
  });

  it('does NOT qualify when a required reviewer failed', () => {
    const r = buildDiffReceipt({ ...BASE, coverage: coverage(), required: ['codex'], reviews: [review('codex', 'openai', 'failed-reviewer')] });
    expect(r.ok).toBe(false);
  });

  it('does NOT qualify when a SOURCE file was omitted (coverage shortfall)', () => {
    const r = buildDiffReceipt({
      ...BASE,
      coverage: coverage([{ kind: 'source', path: 'src/big.ts', reason: 'over-limit' }]),
      required: ['codex'],
      reviews: [review('codex', 'openai')],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/src\/big\.ts/);
  });

  it('does NOT qualify when the diff was truncated to fit the prompt budget', () => {
    const r = buildDiffReceipt({
      ...BASE,
      coverage: coverage(),
      diffTruncated: true,
      required: ['codex', 'grok'],
      reviews: [review('codex', 'openai'), review('grok', 'xai')],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/truncated/);
  });
});

describe('writeReceipt / readReceipt', () => {
  let store: string;
  beforeEach(() => {
    store = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-receipts-'));
  });
  afterEach(() => {
    fs.rmSync(store, { force: true, recursive: true });
  });

  it('round-trips a receipt keyed by the full identity', () => {
    const built = buildDiffReceipt({ ...BASE, coverage: coverage(), required: ['codex', 'grok'], reviews: [review('codex', 'openai'), review('grok', 'xai')] });
    const receipt = built.receipt as DiffReviewReceipt;
    writeReceipt(store, receipt);
    const key: ReceiptKey = { baseSha: receipt.baseSha, diffDigest: receipt.diffDigest, headSha: receipt.headSha, policyHash: receipt.policyHash, repo: receipt.repo };
    expect(readReceipt(store, key)?.runId).toBe('run-1');
    expect(readReceipt(store, { ...key, diffDigest: 'sha256:other' })).toBeNull();
  });
});

describe('isDiffReviewed — LIVE validation', () => {
  const required: ReviewerId[] = ['codex', 'grok'];
  const policyHash = computePolicyHash({ coveragePolicy: { ceilingBytes: 200_000 }, diffMode: 'commit', reviewerPolicy: required });
  const key: ReceiptKey = { baseSha: 'aaa', diffDigest: 'sha256:deadbeef', headSha: 'bbb', policyHash, repo: 'r' };
  const goodReceipt: DiffReviewReceipt = {
    baseRef: 'origin/main', baseSha: 'aaa', completed: ['codex', 'grok'],
    coverage: { includedFiles: 1, omitted: [], omittedFiles: 0, totalFiles: 1 },
    diffDigest: 'sha256:deadbeef', diffMode: 'commit', headSha: 'bbb', policyHash,
    repo: 'r', reviewerPolicy: ['codex', 'grok'], runId: 'run-1', vendors: ['openai', 'xai'],
  };
  const reviewed = (id: ReviewerId) => review(id, id === 'codex' ? 'openai' : 'xai');
  const cleanCoverage = coverage();

  it('reviewed: receipt matches, policy covered, coverage clean, artifacts present', () => {
    const s = isDiffReviewed(
      { coverage: cleanCoverage, key, required },
      { readReceipt: () => goodReceipt, readReview: (_r, id) => reviewed(id) }
    );
    expect(s).toMatchObject({ reason: 'reviewed', reviewed: true });
  });

  it('no-receipt when none is found', () => {
    const s = isDiffReviewed({ coverage: cleanCoverage, key, required }, { readReceipt: () => null, readReview: () => null });
    expect(s.reason).toBe('no-receipt');
    expect(s.reviewed).toBe(false);
  });

  it('stale when the receipt digest no longer matches the live diff', () => {
    const s = isDiffReviewed(
      { coverage: cleanCoverage, key: { ...key, diffDigest: 'sha256:newcommit' }, required },
      { readReceipt: () => ({ ...goodReceipt, diffDigest: 'sha256:deadbeef' }), readReview: (_r, id) => reviewed(id) }
    );
    expect(s.reason).toBe('stale');
  });

  it('incomplete-policy when completed[] misses a required reviewer (codex-only)', () => {
    const s = isDiffReviewed(
      { coverage: cleanCoverage, key, required },
      { readReceipt: () => ({ ...goodReceipt, completed: ['codex'] }), readReview: (_r, id) => reviewed(id) }
    );
    expect(s.reason).toBe('incomplete-policy');
  });

  it('incomplete-coverage when a source file is omitted in the live diff', () => {
    const s = isDiffReviewed(
      { coverage: coverage([{ kind: 'source', path: 'src/x.ts', reason: 'over-limit' }]), key, required },
      { readReceipt: () => goodReceipt, readReview: (_r, id) => reviewed(id) }
    );
    expect(s.reason).toBe('incomplete-coverage');
  });

  it('artifact-missing when a required reviewer artifact is absent or not reviewed', () => {
    const missing = isDiffReviewed({ coverage: cleanCoverage, key, required }, { readReceipt: () => goodReceipt, readReview: () => null });
    expect(missing.reason).toBe('artifact-missing');
    const failed = isDiffReviewed(
      { coverage: cleanCoverage, key, required },
      { readReceipt: () => goodReceipt, readReview: (_r, id) => review(id, 'v', 'failed-reviewer') }
    );
    expect(failed.reason).toBe('artifact-missing');
  });
});
