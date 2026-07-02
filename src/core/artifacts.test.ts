import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  persistReview,
  readReview,
  readReviewsForRun,
  reviewDir,
  sanitizePathSegment,
  writeTrailFile,
} from './artifacts';
import type { ReviewerConfig, ReviewFinding, ReviewPacket } from './types';

// baseDir is now an explicit first arg (no env-driven path) — give every test a
// fresh tmp dir to write artifacts into, and clean it up.
let baseDir: string;

beforeEach(() => {
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-artifacts-'));
});

afterEach(() => {
  fs.rmSync(baseDir, { force: true, recursive: true });
});

const cfg = (id: 'codex' | 'grok'): ReviewerConfig =>
  id === 'grok'
    ? {
        cmd: 'grok',
        effort: 'high',
        id: 'grok',
        model: 'grok-build',
        sandbox: 'ensemble-review',
        vendor: 'xai',
      }
    : { cmd: 'codex', effort: 'xhigh', id: 'codex', model: 'gpt-5.5', vendor: 'openai' };

const finding = (id: string): ReviewFinding => ({
  body: '',
  confidence: 'high',
  evidence: { file: 'x.ts' },
  id,
  severity: 'high',
  title: id,
});

const packet = (): ReviewPacket => ({
  complete: true,
  objective: 'o',
  pr: 1,
  repo: 'r',
  sections: [],
});

describe('per-reviewer artifacts', () => {
  it('keys by (runId, reviewerId) so a codex-f1 and a grok-f1 never collide', () => {
    const runId = 'run-1';
    for (const id of ['codex', 'grok'] as const) {
      persistReview(baseDir, {
        findings: [finding('f1')],
        packet: packet(),
        prompt: 'p',
        raw: 'raw',
        reviewer: cfg(id),
        runId,
        summary: id,
        terminalState: 'reviewed',
      });
    }
    // SAME findingId f1 in both, written to SEPARATE per-reviewer artifacts — so a
    // codex finding never overwrites a grok one (the (runId, reviewerId) key holds).
    const reviews = readReviewsForRun(baseDir, runId);
    expect(reviews.map((r) => r.reviewerId)).toEqual(['codex', 'grok']);
    const codex = reviews.find((r) => r.reviewerId === 'codex');
    const grok = reviews.find((r) => r.reviewerId === 'grok');
    expect(codex?.findings[0]?.id).toBe('f1');
    expect(grok?.findings[0]?.id).toBe('f1');
    expect(codex?.summary).toBe('codex');
    expect(grok?.summary).toBe('grok');
    // each reviewer wrote its OWN review.<id>.json (no shared review.json)
    expect(fs.existsSync(path.join(baseDir, runId, 'review.codex.json'))).toBe(true);
    expect(fs.existsSync(path.join(baseDir, runId, 'review.grok.json'))).toBe(true);
  });

  it('backfills reviewerId from a legacy bare review.json (pre-fan-out run)', () => {
    const runId = 'legacy-1';
    const dir = path.join(baseDir, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'review.json'),
      JSON.stringify({
        findings: [],
        packet: { complete: true, manifest: [] },
        reviewer: { effort: 'xhigh', model: 'gpt-5.5', vendor: 'openai' },
        runId,
        summary: 'old',
        terminalState: 'reviewed',
      })
    );
    expect(readReview(baseDir, runId, 'codex')?.reviewerId).toBe('codex');
    expect(readReviewsForRun(baseDir, runId).map((r) => r.reviewerId)).toEqual(
      ['codex']
    );
  });
});

describe('trail security', () => {
  it('sanitizes a traversal-laden runId so a trail can never escape its base', () => {
    // A crafted --run-id must not climb out of baseDir. sanitize collapses every path
    // SEPARATOR (and any other non-[A-Za-z0-9._-] char) to `_`, so the result is always a
    // SINGLE child segment — a leftover `..` substring is harmless without a separator.
    // reviewDir routes EVERY key through it.
    for (const evil of ['../../etc', '..\\..\\win', 'a/b/../../c', '/abs/path']) {
      const dir = reviewDir(baseDir, evil);
      const rel = path.relative(baseDir, dir);
      // A real traversal would make `rel` climb (`..` as its own component) or go absolute.
      // A leftover `..` INSIDE a single segment name (e.g. `.._.._etc`) is not a traversal.
      expect(rel === '..' || rel.startsWith(`..${path.sep}`)).toBe(false);
      expect(path.isAbsolute(rel)).toBe(false);
      expect(path.dirname(dir)).toBe(baseDir); // exactly one level under the base
      expect(path.basename(dir)).not.toMatch(/[/\\]/); // no separator survived
    }
    // The sanitizer itself leaves no path SEPARATORS (dots are allowed → no traversal
    // without a separator to act on).
    expect(sanitizePathSegment('../../etc/passwd')).not.toMatch(/[/\\]/);
    expect(sanitizePathSegment('../../etc')).toBe('.._.._etc');
  });

  it('writes every persisted trail file owner-only (0600)', () => {
    persistReview(baseDir, {
      findings: [finding('f1')],
      packet: packet(),
      prompt: 'the rendered prompt',
      raw: 'raw reply',
      reviewer: cfg('codex'),
      runId: 'perm-run',
      summary: 's',
      terminalState: 'reviewed',
    });
    const dir = reviewDir(baseDir, 'perm-run');
    for (const name of [
      'packet.codex.json',
      'prompt.codex.md',
      'codex-review.raw.md',
      'findings.codex.json',
      'review.codex.json',
    ]) {
      const mode = fs.statSync(path.join(dir, name)).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});

describe('writeTrailFile — hardened, symlink-safe trail writer', () => {
  it('writes under the run trail dir at 0600 and returns the path', () => {
    const p = writeTrailFile(baseDir, 'runX', 'conventions.json', '{"ok":true}');
    expect(p).toBe(path.join(reviewDir(baseDir, 'runX'), 'conventions.json'));
    expect(fs.readFileSync(p, 'utf8')).toBe('{"ok":true}');
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it('a symlink pre-planted at the TARGET is replaced, not written through', () => {
    const outside = path.join(baseDir, 'OUTSIDE.txt');
    fs.writeFileSync(outside, 'SECRET');
    const dir = reviewDir(baseDir, 'runS');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'conventions.json'));
    writeTrailFile(baseDir, 'runS', 'conventions.json', 'NEW');
    // the symlink was replaced by a real file with our content; the outside target is intact
    expect(fs.readFileSync(path.join(dir, 'conventions.json'), 'utf8')).toBe('NEW');
    expect(fs.lstatSync(path.join(dir, 'conventions.json')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(outside, 'utf8')).toBe('SECRET');
  });

  it('a symlink pre-planted at the .tmp path is not followed to clobber an outside file', () => {
    const outside = path.join(baseDir, 'OUTSIDE2.txt');
    fs.writeFileSync(outside, 'SECRET2');
    const dir = reviewDir(baseDir, 'runT');
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(outside, path.join(dir, 'conventions.json.tmp'));
    writeTrailFile(baseDir, 'runT', 'conventions.json', 'FRESH');
    expect(fs.readFileSync(path.join(dir, 'conventions.json'), 'utf8')).toBe('FRESH');
    expect(fs.readFileSync(outside, 'utf8')).toBe('SECRET2');
  });
});
