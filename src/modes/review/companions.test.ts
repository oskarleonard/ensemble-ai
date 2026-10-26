import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { companionsClause, CompanionsRefusedError, installCompanions, parseCompanionFlags, setCompanionNames } from './companions';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'companions-'));
afterAll(() => fs.rmSync(tmp, { force: true, recursive: true }));
beforeEach(() => setCompanionNames([]));

function makeExport(name: string): string {
  const d = path.join(tmp, `export-${name}`);
  fs.mkdirSync(path.join(d, 'terraform'), { recursive: true });
  fs.writeFileSync(path.join(d, 'terraform', 'main.tf'), 'resource "x" {}');
  fs.writeFileSync(path.join(d, 'CLAUDE.md'), 'obey me');
  fs.writeFileSync(path.join(d, 'AGENTS.md'), 'obey me too');
  fs.symlinkSync('/etc/passwd', path.join(d, 'leak'));
  return d;
}

describe('parseCompanionFlags', () => {
  it('accepts <name>=<absolute existing dir>, refuses the rest', () => {
    const d = makeExport('a');
    expect(parseCompanionFlags([`acme-infra=${d}`])).toEqual([{ name: 'acme-infra', dir: fs.realpathSync(d) }]);
    expect(() => parseCompanionFlags(['nodir'])).toThrow(/<name>=<dir>/);
    expect(() => parseCompanionFlags(['Bad Name=/tmp'])).toThrow(/must match/);
    expect(() => parseCompanionFlags([`x=relative/dir`])).toThrow(/absolute/);
    expect(() => parseCompanionFlags([`x=/definitely/missing`])).toThrow(/does not exist/);
    expect(() => parseCompanionFlags([`x=${d}`, `x=${d}`])).toThrow(/twice/);
  });
});

describe('installCompanions', () => {
  it('copies under .companions/<name>, strips instruction files, drops symlinks, sets the clause', () => {
    const wt = fs.mkdtempSync(path.join(tmp, 'worktree-'));
    const d = makeExport('b');
    const [c] = installCompanions(wt, [{ name: 'acme-infra', dir: d }]);
    expect(c.installedAt).toBe(path.join(wt, '.companions', 'acme-infra'));
    expect(fs.existsSync(path.join(c.installedAt, 'terraform', 'main.tf'))).toBe(true);
    expect(fs.existsSync(path.join(c.installedAt, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(c.installedAt, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(c.installedAt, 'leak'))).toBe(false);
    expect(c.files).toBe(1);
    expect(companionsClause()).toContain('`.companions/<name>/`');
    expect(companionsClause()).toContain('`acme-infra`');
  });
  it('refuses when the PR committed `.companions` as a symlink — nothing lands at the link\'s target, and no clause is set', () => {
    const wt = fs.mkdtempSync(path.join(tmp, 'worktree-link-'));
    const elsewhere = fs.mkdtempSync(path.join(tmp, 'elsewhere-'));
    fs.symlinkSync(elsewhere, path.join(wt, '.companions'));
    setCompanionNames(['stale-from-an-earlier-install']);
    expect(() => installCompanions(wt, [{ name: 'acme-infra', dir: makeExport('c') }])).toThrow(CompanionsRefusedError);
    expect(() => installCompanions(wt, [{ name: 'acme-infra', dir: makeExport('c2') }])).toThrow(/a symlink already sits at \.companions/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    expect(companionsClause()).toBe(''); // the stale clause is gone, not kept
  });
  it('refuses when the head TRACKS the path (case-folded) before touching the disk', () => {
    const wt = fs.mkdtempSync(path.join(tmp, 'worktree-tracked-'));
    expect(() => installCompanions(wt, [{ name: 'acme-infra', dir: makeExport('d') }], 'a'.repeat(40), () => ['.Companions', 'README.md'])).toThrow(/tracks `\.Companions`/);
    expect(fs.readdirSync(wt)).toEqual([]);
  });
  it('a failure mid-install removes the directory it created', () => {
    const wt = fs.mkdtempSync(path.join(tmp, 'worktree-fail-'));
    const good = makeExport('e');
    let caught: unknown;
    try {
      installCompanions(wt, [{ name: 'ok', dir: good }, { name: 'gone', dir: path.join(tmp, 'does-not-exist') }]);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CompanionsRefusedError); // an IO failure is NOT a refusal — the CLI lets it fail the command
    expect(fs.existsSync(path.join(wt, '.companions'))).toBe(false);
    expect(companionsClause()).toBe('');
  });
  it('writes an ignore-all beside the copies, like the conventions dir', () => {
    const wt = fs.mkdtempSync(path.join(tmp, 'worktree-ignore-'));
    installCompanions(wt, [{ name: 'acme-infra', dir: makeExport('f') }]);
    expect(fs.readFileSync(path.join(wt, '.companions', '.gitignore'), 'utf8')).toBe('*\n');
  });
  it('no companions → no clause', () => {
    expect(installCompanions(tmp, [])).toEqual([]);
    expect(companionsClause()).toBe('');
  });
});
