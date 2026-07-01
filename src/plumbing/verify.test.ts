import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { reviewDir } from '../core/artifacts';
import type { ReviewerId, StoredReview } from '../core/types';
import type { Coverage } from '../modes/review/diff';
import {
  computePolicyHash,
  type DiffReviewReceipt,
  type ReceiptKey,
} from '../modes/review/receipt';

import {
  formatReceipt,
  formatVerify,
  isAttestedOnly,
  receiptBackedReadReview,
  verifyExitCode,
  verifyReceipt,
} from './verify';

const required: ReviewerId[] = ['codex', 'grok'];
const policyHash = computePolicyHash({
  coveragePolicy: { ceilingBytes: 200_000 },
  diffMode: 'commit',
  reviewerPolicy: required,
});
const key: ReceiptKey = {
  baseSha: 'aaa',
  diffDigest: 'sha256:deadbeef',
  headSha: 'bbb',
  policyHash,
  repo: 'https://example/repo',
};

const receipt: DiffReviewReceipt = {
  baseRef: 'origin/main',
  baseSha: 'aaa',
  completed: ['codex', 'grok'],
  coverage: { includedFiles: 1, omitted: [], omittedFiles: 0, totalFiles: 1 },
  diffDigest: 'sha256:deadbeef',
  diffMode: 'commit',
  headSha: 'bbb',
  policyHash,
  repo: 'https://example/repo',
  reviewerPolicy: ['codex', 'grok'],
  runId: 'run-1',
  vendors: ['openai', 'xai'],
};

function cleanCoverage(omitSource = false): Coverage {
  const files = omitSource
    ? [{ added: 0, bytes: 1, included: false, kind: 'source' as const, omitReason: 'over-limit' as const, path: 'src/x.ts', removed: 0 }]
    : [];
  return { files, includedBytes: 0, includedFiles: 0, omittedFiles: files.length, totalBytes: 0, totalFiles: files.length };
}

describe('verifyReceipt (receipt-backed, no trail dir)', () => {
  it('VALID & CURRENT → reviewed, exit 0', () => {
    const state = verifyReceipt(
      { coverage: cleanCoverage(), key, required },
      { readReceipt: () => receipt }
    );
    expect(state).toMatchObject({ reason: 'reviewed', reviewed: true });
    expect(verifyExitCode(state)).toBe(0);
  });

  it('MISSING receipt → no-receipt, exit 3', () => {
    const state = verifyReceipt(
      { coverage: cleanCoverage(), key, required },
      { readReceipt: () => null }
    );
    expect(state.reason).toBe('no-receipt');
    expect(verifyExitCode(state)).toBe(3);
  });

  it('STALE (digest no longer matches the live diff) → stale, exit 3', () => {
    const state = verifyReceipt(
      { coverage: cleanCoverage(), key: { ...key, diffDigest: 'sha256:newcommit' }, required },
      { readReceipt: () => receipt } // receipt still on the OLD digest
    );
    expect(state.reason).toBe('stale');
    expect(verifyExitCode(state)).toBe(3);
  });

  it('UNDER-POLICY (codex-only receipt vs codex+grok policy) → incomplete-policy, exit 3', () => {
    const state = verifyReceipt(
      { coverage: cleanCoverage(), key, required },
      { readReceipt: () => ({ ...receipt, completed: ['codex'] }) }
    );
    expect(state.reason).toBe('incomplete-policy');
    expect(verifyExitCode(state)).toBe(3);
  });

  it('UNDER-COVERAGE (a live source file omitted) → incomplete-coverage, exit 3', () => {
    const state = verifyReceipt(
      { coverage: cleanCoverage(true), key, required },
      { readReceipt: () => receipt }
    );
    expect(state.reason).toBe('incomplete-coverage');
    expect(verifyExitCode(state)).toBe(3);
  });
});

describe('strict mode (--require-artifacts): artifacts are the proof, not completed[]', () => {
  const tmpDirs: string[] = [];
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { force: true, recursive: true });
  });

  // Write a real per-reviewer artifact trail so readReview(trailDir, runId, id) resolves.
  function seedTrail(runId: string, ids: ReviewerId[]): string {
    const trailDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-trail-'));
    tmpDirs.push(trailDir);
    const dir = reviewDir(trailDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    for (const id of ids) {
      const stored: StoredReview = {
        findings: [],
        packet: { complete: true, manifest: [] },
        reviewer: { effort: '', model: '', vendor: '' },
        reviewerId: id,
        runId,
        summary: 'real artifact',
        terminalState: 'reviewed',
      };
      fs.writeFileSync(path.join(dir, `review.${id}.json`), JSON.stringify(stored));
    }
    return trailDir;
  }

  it('FAILS CLOSED on an attestation-only receipt (strict, no trail) → artifact-missing, exit 3', () => {
    const state = verifyReceipt(
      { coverage: cleanCoverage(), key, required },
      { readReceipt: () => receipt, strict: true }
    );
    expect(state.reason).toBe('artifact-missing');
    expect(state.reviewed).toBe(false);
    expect(verifyExitCode(state)).toBe(3);
  });

  it('PASSES when the real per-reviewer artifacts are present (strict + trail) → exit 0', () => {
    const trailDir = seedTrail(receipt.runId, required);
    const state = verifyReceipt(
      { coverage: cleanCoverage(), key, required },
      { readReceipt: () => receipt, strict: true, trailDir }
    );
    expect(state).toMatchObject({ reason: 'reviewed', reviewed: true });
    expect(verifyExitCode(state)).toBe(0);
  });

  it('FAILS in strict + trail when an artifact is missing (one reviewer only) → artifact-missing', () => {
    const trailDir = seedTrail(receipt.runId, ['codex']); // grok artifact absent
    const state = verifyReceipt(
      { coverage: cleanCoverage(), key, required },
      { readReceipt: () => receipt, strict: true, trailDir }
    );
    expect(state.reason).toBe('artifact-missing');
    expect(verifyExitCode(state)).toBe(3);
  });

  it('isAttestedOnly: true only for default + no trail (the forgeable pass the CLI warns on)', () => {
    expect(isAttestedOnly({ readReceipt: () => receipt })).toBe(true);
    expect(isAttestedOnly({ readReceipt: () => receipt, strict: true })).toBe(false);
    expect(isAttestedOnly({ readReceipt: () => receipt, trailDir: '/x' })).toBe(false);
  });
});

describe('receiptBackedReadReview', () => {
  it('reports a claimed-complete reviewer as reviewed and an unclaimed one as null', () => {
    const read = receiptBackedReadReview({ ...receipt, completed: ['codex'] });
    expect(read('run-1', 'codex')?.terminalState).toBe('reviewed');
    expect(read('run-1', 'grok')).toBeNull();
  });
});

describe('formatting', () => {
  it('formatVerify renders PASS/FAIL + the reason', () => {
    const pass = verifyReceipt({ coverage: cleanCoverage(), key, required }, { readReceipt: () => receipt });
    expect(formatVerify(pass, key)).toContain('PASS');
    const fail = verifyReceipt({ coverage: cleanCoverage(), key, required }, { readReceipt: () => null });
    const text = formatVerify(fail, key);
    expect(text).toContain('FAIL');
    expect(text).toContain('NO RECEIPT');
  });

  it('formatReceipt prints every field, including omitted coverage', () => {
    const out = formatReceipt({
      ...receipt,
      coverage: { includedFiles: 1, omitted: [{ kind: 'generated', path: 'package-lock.json', reason: 'generated' }], omittedFiles: 1, totalFiles: 2 },
    });
    expect(out).toContain('sha256:deadbeef');
    expect(out).toContain('completed: codex, grok');
    expect(out).toContain('omitted: package-lock.json (generated/generated)');
  });
});
