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
    expect(parsed.reviewers.map((r: { id: string }) => r.id)).toEqual([
      'codex',
      'grok',
      'claude',
    ]);
    expect(parsed.reviewersFileExists).toBe(false);
  });

  it('--json carries the resolved enabled set + the off seats from a reviewers.json with switches', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-switch-'));
    const reviewersFile = path.join(dir, 'reviewers.json');
    fs.writeFileSync(
      reviewersFile,
      JSON.stringify({
        codex: { enabled: false, model: 'gpt-5.5' },
        grok: { disabledUntil: '2099-01-01T00:00:00Z', model: 'grok-4.5' },
      })
    );
    const code = await main(['config', '--json', '--reviewers-file', reviewersFile, '--voices-file', '/nope.json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(logged);
    expect(parsed.enabledReviewerIds).toEqual(['claude']);
    expect(parsed.offSeats).toEqual([
      { id: 'codex', until: null },
      { id: 'grok', until: '2099-01-01T00:00:00Z' },
    ]);
    // Every configured seat is still listed — the roster is the registry, on or off.
    expect(parsed.reviewers.map((r: { id: string }) => r.id)).toEqual(['codex', 'grok', 'claude']);
  });

  it('--json with no switches: every seat on, offSeats empty', async () => {
    await main(['config', '--json', '--reviewers-file', '/nope.json', '--voices-file', '/nope.json']);
    const parsed = JSON.parse(logged);
    expect(parsed.enabledReviewerIds).toEqual(['codex', 'grok', 'claude']);
    expect(parsed.offSeats).toEqual([]);
  });

  it('surfaces the resolved GATE seat (model · effort · source) from a voices.json fixture', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-gate-'));
    const voicesFile = path.join(dir, 'voices.json');
    fs.writeFileSync(
      voicesFile,
      JSON.stringify({ claude: { effort: 'high', model: 'opus' }, gate: { effort: 'max', model: 'fable' } })
    );
    const code = await main(['config', '--voices-file', voicesFile, '--reviewers-file', '/nope.json']);
    expect(code).toBe(0);
    expect(logged).toContain('review synthesis');
    const gateLine = logged.split('\n').find((l) => l.trimStart().startsWith('gate'))!;
    expect(gateLine).toContain('anthropic · fable @ max');
    expect(gateLine).toContain('source model:file · effort:file');
    // --json carries the gate seat too
    logged = '';
    await main(['config', '--json', '--voices-file', voicesFile, '--reviewers-file', '/nope.json']);
    expect(JSON.parse(logged).gate).toEqual({
      effort: 'max', effortSource: 'file', model: 'fable', modelSource: 'file',
      // The vendor axis (sol-gate promotion): surfaced so `config` shows WHO judges.
      vendor: 'anthropic', vendorSource: 'default',
    });
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it('a `cmd` key on the gate seat warns loudly (stderr) but still renders the seat', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-gate-'));
    const voicesFile = path.join(dir, 'voices.json');
    fs.writeFileSync(voicesFile, JSON.stringify({ gate: { cmd: 'grok', model: 'fable' } }));
    const code = await main(['config', '--voices-file', voicesFile, '--reviewers-file', '/nope.json']);
    expect(code).toBe(0);
    expect(errored).toContain('`cmd` is ignored');
    expect(logged).toContain('anthropic · fable @'); // model still applied, spawn stays claude -p
    fs.rmSync(dir, { force: true, recursive: true });
  });
});

describe('config — a Claude seat\'s advisor is visible', () => {
  it('--json carries the advisor on the claude voice and the gate — never on a reviewers.json row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-advisor-'));
    const reviewersFile = path.join(dir, 'reviewers.json');
    const voicesFile = path.join(dir, 'voices.json');
    // ONE advisor home per CLI seat: no CLI spawn reads the reviewers.json claude entry, so its
    // `advisor` is neither parsed nor displayed.
    fs.writeFileSync(reviewersFile, JSON.stringify({ claude: { advisor: 'claude-fable-5-1' } }));
    fs.writeFileSync(
      voicesFile,
      JSON.stringify({ claude: { advisor: 'claude-opus-5-5' }, gate: { advisor: 'off', model: 'fable' } })
    );
    try {
      expect(await main(['config', '--json', '--reviewers-file', reviewersFile, '--voices-file', voicesFile])).toBe(0);
      const parsed = JSON.parse(logged);
      type Row = { advisor?: string; id: string };
      const byId = (rows: Row[], id: string): Row => rows.find((r) => r.id === id)!;
      for (const id of ['claude', 'codex', 'grok']) expect(byId(parsed.reviewers, id)).not.toHaveProperty('advisor');
      expect(byId(parsed.voices, 'claude').advisor).toBe('claude-opus-5-5');
      expect(parsed.gate.advisor).toBe('off');

      logged = '';
      await main(['config', '--reviewers-file', reviewersFile, '--voices-file', voicesFile]);
      expect(logged).not.toContain('claude-fable-5-1');
      expect(logged).toContain('· advisor claude-opus-5-5');
      expect(logged.split('\n').find((l) => l.trimStart().startsWith('gate'))).toContain('· advisor off');
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it('no advisor configured ⇒ no advisor key anywhere in --json (absent = inherits)', async () => {
    await main(['config', '--json', '--reviewers-file', '/nope.json', '--voices-file', '/nope.json']);
    expect(logged).not.toContain('advisor');
  });

  it('an invalid advisor is SHOWN, marked invalid — config never throws on it (exit 0)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-advisor-'));
    const voicesFile = path.join(dir, 'voices.json');
    fs.writeFileSync(
      voicesFile,
      JSON.stringify({ claude: { advisor: 'Opus 5' }, gate: { advisor: null, effort: 'max', model: 'fable' } })
    );
    try {
      expect(await main(['config', '--reviewers-file', '/nope.json', '--voices-file', voicesFile])).toBe(0);
      const voiceRow = logged.split('\n').find((l) => l.trimStart().startsWith('claude') && l.includes('advisor'));
      expect(voiceRow).toContain('· advisor "Opus 5" (INVALID');
      // The gate keeps its resolved vendor, model, effort and sources; only the advisor is marked.
      const gateRow = logged.split('\n').find((l) => l.trimStart().startsWith('gate'));
      expect(gateRow).toContain('anthropic · fable @ max · advisor null (INVALID');
      expect(gateRow).toContain('source model:file · effort:file');

      logged = '';
      expect(await main(['config', '--json', '--reviewers-file', '/nope.json', '--voices-file', voicesFile])).toBe(0);
      const parsed = JSON.parse(logged);
      expect(parsed.voices.find((v: { id: string }) => v.id === 'claude').advisor).toBe('Opus 5');
      expect(parsed.gate).toEqual({
        advisor: null, effort: 'max', effortSource: 'file', model: 'fable', modelSource: 'file',
        vendor: 'anthropic', vendorSource: 'default',
      });
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it('a codex gate ignores its advisor (warned), so config shows none on the gate row', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-advisor-'));
    const voicesFile = path.join(dir, 'voices.json');
    fs.writeFileSync(voicesFile, JSON.stringify({ gate: { advisor: 'Opus 5', vendor: 'codex' } }));
    try {
      expect(await main(['config', '--json', '--reviewers-file', '/nope.json', '--voices-file', voicesFile])).toBe(0);
      expect(JSON.parse(logged).gate).not.toHaveProperty('advisor');
      expect(errored).toContain('`advisor` is ignored');
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });
});

describe('config — the holistic lens row', () => {
  let dir: string;
  let voicesFile: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-holistic-'));
    voicesFile = path.join(dir, 'voices.json');
  });
  afterEach(() => fs.rmSync(dir, { force: true, recursive: true }));

  const show = async (): Promise<{ json: Record<string, unknown>; row: string | undefined }> => {
    logged = '';
    expect(await main(['config', '--json', '--reviewers-file', '/nope.json', '--voices-file', voicesFile])).toBe(0);
    const json = JSON.parse(logged).holistic as Record<string, unknown>;
    logged = '';
    expect(await main(['config', '--reviewers-file', '/nope.json', '--voices-file', voicesFile])).toBe(0);
    return { json, row: logged.split('\n').find((l) => l.startsWith('    holistic ')) };
  };

  it('a valid advisor is shown with the lens model and effort it resolved', async () => {
    fs.writeFileSync(voicesFile, JSON.stringify({ holistic: { advisor: 'off', effort: 'max', model: 'fable' } }));
    const { json, row } = await show();
    expect(json).toEqual({ advisor: 'off', effort: 'max', model: 'fable' });
    expect(row).toBe('    holistic anthropic · fable @ max · advisor off');
  });

  it('an absent advisor has no key (the lens inherits) — the built-in seat when unconfigured', async () => {
    fs.writeFileSync(voicesFile, JSON.stringify({}));
    const { json, row } = await show();
    expect(json).toEqual({ effort: 'high', model: 'opus' });
    expect(row).toBe('    holistic anthropic · opus @ high');
  });

  it('an invalid advisor is shown as written and marked invalid; config still exits 0', async () => {
    fs.writeFileSync(voicesFile, JSON.stringify({ holistic: { advisor: 'Opus 5', model: 'fable' } }));
    const { json, row } = await show();
    expect(json).toEqual({ advisor: 'Opus 5', effort: 'high', model: 'fable' });
    expect(row).toBe('    holistic anthropic · fable @ high · advisor "Opus 5" (INVALID — a command that runs this seat refuses it)');
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
    // Three seats IS the CLI's true default roster (core codex+grok + the
    // default-on claude layer), so the cost preview naming all three is honest.
    expect(logged).toContain('reviewer(s) [codex, grok, claude]');
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

  it('receipt verify --staged --working-tree → usage error (exit 3), never a silent staged-wins', async () => {
    const code = await main(['receipt', 'verify', '--staged', '--working-tree']);
    expect(code).toBe(3);
    expect(errored).toContain('at most one of --staged / --working-tree');
  });
});
