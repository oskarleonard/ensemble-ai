import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { companionsClause, installCompanions, parseCompanionFlags, setCompanionNames } from './companions';

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
    expect(parseCompanionFlags([`lisk-infra=${d}`])).toEqual([{ name: 'lisk-infra', dir: fs.realpathSync(d) }]);
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
    const [c] = installCompanions(wt, [{ name: 'lisk-infra', dir: d }]);
    expect(c.installedAt).toBe(path.join(wt, '.companions', 'lisk-infra'));
    expect(fs.existsSync(path.join(c.installedAt, 'terraform', 'main.tf'))).toBe(true);
    expect(fs.existsSync(path.join(c.installedAt, 'CLAUDE.md'))).toBe(false);
    expect(fs.existsSync(path.join(c.installedAt, 'AGENTS.md'))).toBe(false);
    expect(fs.existsSync(path.join(c.installedAt, 'leak'))).toBe(false);
    expect(c.files).toBe(1);
    expect(companionsClause()).toContain('`.companions/<name>/`');
    expect(companionsClause()).toContain('`lisk-infra`');
  });
  it('no companions → no clause', () => {
    expect(installCompanions(tmp, [])).toEqual([]);
    expect(companionsClause()).toBe('');
  });
});
