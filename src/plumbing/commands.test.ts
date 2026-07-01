import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NO module mocks here (unlike cli.test.ts): the plumbing commands drive the REAL
// engine (acquireDiff · assembleCodePacket · listReviewers), never a reviewer spawn.
import { main } from '../cli';

let logged: string;
let errored: string;

beforeEach(() => {
  logged = '';
  errored = '';
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logged += a.join(' ') + '\n';
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errored += a.join(' ') + '\n';
  });
});
afterEach(() => vi.restoreAllMocks());

describe('reviewers / config command', () => {
  it('lists the reviewer + voice registry (exit 0) from baked defaults', async () => {
    const code = await main([
      'reviewers',
      '--reviewers-file', '/nonexistent/reviewers.json',
      '--voices-file', '/nonexistent/voices.json',
    ]);
    expect(code).toBe(0);
    expect(logged).toContain('codex');
    expect(logged).toContain('grok');
    expect(logged).toContain('claude'); // the voice roster
    expect(logged).toContain('not present, using baked defaults');
  });

  it('the `config` alias routes to the same command', async () => {
    expect(await main(['config'])).toBe(0);
    expect(logged).toContain('registry');
  });

  it('--json emits the resolved registry as JSON', async () => {
    const code = await main(['reviewers', '--json', '--reviewers-file', '/nope.json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(logged);
    expect(parsed.reviewers.map((r: { id: string }) => r.id)).toEqual(['codex', 'grok']);
    expect(parsed.reviewersFileExists).toBe(false);
  });
});

describe('diff command — assembles the packet WITHOUT spawning a reviewer', () => {
  let dir: string;
  let diffFile: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-diff-'));
    diffFile = path.join(dir, 'change.diff');
    fs.writeFileSync(
      diffFile,
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1 +1,2 @@',
        ' const a = 1;',
        '+const b = 2;',
        '',
      ].join('\n')
    );
  });
  afterEach(() => fs.rmSync(dir, { force: true, recursive: true }));

  it('--diff-file assembles a packet + cost preview (exit 0)', async () => {
    const code = await main(['diff', '--diff-file', diffFile, '--cwd', dir]);
    expect(code).toBe(0);
    expect(logged).toContain('assembled code review packet');
    expect(logged).toContain('The diff under review');
    expect(logged).toContain('reviewer(s) [codex, grok]');
    expect(logged).not.toContain('## Objective'); // no full prompt by default
  });

  it('--full prints the entire rendered prompt (the literal payload)', async () => {
    const code = await main(['diff', '--diff-file', diffFile, '--cwd', dir, '--full']);
    expect(code).toBe(0);
    expect(logged).toContain('rendered prompt');
    expect(logged).toContain('const b = 2;');
  });

  it('--profile security swaps to the security packet', async () => {
    await main(['diff', '--diff-file', diffFile, '--cwd', dir, '--full', '--profile', 'security']);
    expect(logged).toContain('SECURITY AUDIT');
  });

  it('an unknown --profile → usage error (exit 3)', async () => {
    expect(await main(['diff', '--diff-file', diffFile, '--profile', 'nope'])).toBe(3);
  });

  it('two explicit sources → usage error (exit 3)', async () => {
    expect(await main(['diff', '--staged', '--working-tree'])).toBe(3);
  });
});

describe('receipt command', () => {
  it('receipt show <path> pretty-prints a receipt file (exit 0), no git', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-receipt-'));
    const file = path.join(dir, 'r.json');
    fs.writeFileSync(
      file,
      JSON.stringify({
        baseRef: 'origin/main', baseSha: 'aaa', completed: ['codex', 'grok'],
        coverage: { includedFiles: 1, omitted: [], omittedFiles: 0, totalFiles: 1 },
        diffDigest: 'sha256:deadbeef', diffMode: 'commit', headSha: 'bbb', policyHash: 'sha256:p',
        repo: 'r', reviewerPolicy: ['codex', 'grok'], runId: 'run-1', vendors: ['openai', 'xai'],
      })
    );
    const code = await main(['receipt', 'show', file]);
    expect(code).toBe(0);
    expect(logged).toContain('sha256:deadbeef');
    expect(logged).toContain('completed: codex, grok');
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it('receipt show <missing path> → exit 3', async () => {
    expect(await main(['receipt', 'show', '/nonexistent/r.json'])).toBe(3);
  });

  it('receipt show <malformed file> → exit 3 with a clear shape error (no blind cast)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-receipt-'));
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, JSON.stringify({ runId: 'run-1' })); // partial → invalid
    const code = await main(['receipt', 'show', file]);
    expect(code).toBe(3);
    expect(errored).toContain('malformed receipt');
    expect(errored).toContain('diffDigest');
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it('receipt --help documents --strict / --require-artifacts + the attestation trust note', async () => {
    await main(['receipt', '--help']);
    expect(logged).toContain('--strict');
    expect(logged).toContain('--require-artifacts');
    expect(logged).toContain('TRUSTED BY ATTESTATION');
  });

  it('an unknown subcommand → usage error (exit 3)', async () => {
    expect(await main(['receipt', 'frobnicate'])).toBe(3);
    expect(errored).toContain('unknown subcommand');
  });

  it('receipt --help → exit 0', async () => {
    expect(await main(['receipt', '--help'])).toBe(0);
    expect(logged).toContain('gate primitive');
  });

  it('bare receipt (no subcommand) → usage, exit 3', async () => {
    expect(await main(['receipt'])).toBe(3);
  });
});
