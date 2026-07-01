import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { isEntrypoint } from './entrypoint';

describe('isEntrypoint', () => {
  const savedArgv = process.argv;
  const tmpDirs: string[] = [];
  afterEach(() => {
    process.argv = savedArgv;
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const mkTmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ep-'));
    tmpDirs.push(d);
    return d;
  };

  it('is false when the process has no entry script', () => {
    process.argv = [savedArgv[0]];
    expect(isEntrypoint(import.meta.url)).toBe(false);
  });

  it('matches through a symlinked entry path (realpath-robust, no fail-open)', () => {
    const dir = mkTmp();
    const real = path.join(dir, 'real.js');
    fs.writeFileSync(real, '');
    const link = path.join(dir, 'link.js');
    fs.symlinkSync(real, link);
    // Invoked via the symlink (like an npm/.bin shim); the module URL resolves to the
    // real file, as Node does for import.meta.url. A plain string compare would be
    // false here — realpath on both sides makes it correctly true.
    process.argv = [savedArgv[0], link];
    expect(isEntrypoint(pathToFileURL(real).href)).toBe(true);
  });

  it('does not match an unrelated entry script', () => {
    const dir = mkTmp();
    const a = path.join(dir, 'a.js');
    const b = path.join(dir, 'b.js');
    fs.writeFileSync(a, '');
    fs.writeFileSync(b, '');
    process.argv = [savedArgv[0], a];
    expect(isEntrypoint(pathToFileURL(b).href)).toBe(false);
  });
});
