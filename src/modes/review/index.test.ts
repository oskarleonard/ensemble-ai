import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reviewDir } from '../../core/artifacts';

import { runReviewMode } from './index';

// A diff that stages a `.env` file — the secret-scan blocks it (fail-closed) before any
// reviewer runs, so NO packet/trail file should ever hit disk (no secret-on-disk).
const ENV_DIFF = [
  'diff --git a/.env b/.env',
  'new file mode 100644',
  'index 0000000..1111111',
  '--- /dev/null',
  '+++ b/.env',
  '@@ -0,0 +1 @@',
  '+API_KEY=super-secret-value',
  '',
].join('\n');

describe('runReviewMode — no trail write before the secret-scan clears', () => {
  let base: string;
  let cwd: string;
  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-secfence-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-secfence-cwd-'));
  });
  afterEach(() => {
    fs.rmSync(base, { force: true, recursive: true });
    fs.rmSync(cwd, { force: true, recursive: true });
  });

  it('a secret-carrying diff blocks AND writes nothing to the trail dir', async () => {
    const out = path.join(base, 'trail'); // does not exist yet
    const result = await runReviewMode({
      conventionReader: null,
      cwd,
      diffMode: 'raw',
      diffText: ENV_DIFF,
      noConventions: true,
      out,
      reviewers: ['codex'], // never actually invoked — the block precedes the fan-out
      runId: 'sec-run',
    });
    expect(result.blocked).toBe(true);
    // The trail base + the per-run dir were never created — nothing (least of all the
    // packet embedding the .env line) was written to disk before the scan passed.
    expect(fs.existsSync(out)).toBe(false);
    expect(fs.existsSync(reviewDir(out, 'sec-run'))).toBe(false);
  });
});
