import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { reviewDir } from '../../core/artifacts';
import type { ReviewerId } from '../../core/types';

import { CI_EVIDENCE_TRAIL_FILE } from './ci-evidence';
import { runReviewMode } from './index';
import type { ReviewAdapter } from './seat-run';

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

// Long enough to clear DIFF_USEFUL_FLOOR — a diff too small to review assembles no packet.
const CODE_DIFF = [
  'diff --git a/src/x.ts b/src/x.ts',
  'index 1111111..2222222 100644',
  '--- a/src/x.ts',
  '+++ b/src/x.ts',
  '@@ -1,6 +1,9 @@',
  ' const a = 1;',
  '+const b = 2;',
  '+export function addTwoNumbersTogether(left: number, right: number): number {',
  '+  return left + right;',
  '+}',
  ' export { a };',
  ' // a trailing comment so the packet clears the useful-diff floor',
  ' // and the reviewer sees a coherent, complete change to look at',
  '',
].join('\n');

const REVIEW = '```json\n{"summary":"looked at it","findings":[]}\n```';
// No reviewers.json at this path ⇒ the baked defaults.
const NO_REVIEWERS_FILE = path.join(os.tmpdir(), 'ensemble-ci-no-such-reviewers.json');

function stubAdapters(): Record<ReviewerId, ReviewAdapter> {
  const reply: ReviewAdapter = async () => ({
    ok: true,
    raw: REVIEW,
    stderrTail: '',
    timedOut: false,
  });
  return { claude: reply, codex: reply, grok: reply };
}

// CI EVIDENCE (incident 2026-08-10): the head's own check output is DATA every seat must see. The
// engine gathers it; this mode's job is to put it in the packet AND on the trail, so a human and a
// dashboard can read exactly what the seats read.
describe('runReviewMode — the gathered CI evidence reaches the packet and the trail', () => {
  let out: string;
  let cwd: string;
  beforeEach(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-ci-ev-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-ci-ev-cwd-'));
  });
  afterEach(() => {
    for (const d of [out, cwd]) fs.rmSync(d, { force: true, recursive: true });
  });

  const opts = (): Parameters<typeof runReviewMode>[0] => ({
    adapters: stubAdapters(),
    conventionReader: null,
    cwd,
    diffMode: 'pr',
    diffText: CODE_DIFF,
    headShaOverride: 'a'.repeat(40),
    noConventions: true,
    out,
    receiptStore: path.join(out, 'receipts'),
    reviewers: ['grok'],
    reviewersFile: NO_REVIEWERS_FILE,
    runId: 'ci-run',
  });

  it("threads ciEvidence into every seat's packet and writes ci-evidence.md to the trail", async () => {
    const res = await runReviewMode({
      ...opts(),
      ciEvidence: 'Head commit: abc\n## Check runs\n- failure \u00b7 lint',
    });
    expect(res.blocked).toBe(false);
    expect(res.prompt).toContain('CI evidence (checks + annotations at the PR head)');
    expect(res.prompt).toContain('failure \u00b7 lint');
    expect(
      fs.existsSync(path.join(reviewDir(out, 'ci-run'), CI_EVIDENCE_TRAIL_FILE))
    ).toBe(true);
  });

  it('renders the section LOUDLY when a fetch was attempted and failed — never silently absent', async () => {
    const res = await runReviewMode({ ...opts(), ciEvidenceUnavailable: 'gh is not on PATH' });
    expect(res.prompt).toContain('CI evidence (checks + annotations at the PR head)');
    expect(res.prompt).toContain('gh is not on PATH');
    // Nothing was gathered, so nothing joins the trail.
    expect(
      fs.existsSync(path.join(reviewDir(out, 'ci-run'), CI_EVIDENCE_TRAIL_FILE))
    ).toBe(false);
  });

  // The two fields are MUTUALLY EXCLUSIVE by contract. A caller that sets both has a bug, and the
  // safe reading of a bug is the loud one: half-gathered evidence must never be presented to the
  // seats as if it were the head's whole check output.
  it('treats a caller that supplies BOTH text and a reason as UNAVAILABLE, loudly', async () => {
    const progress: string[] = [];
    const res = await runReviewMode({
      ...opts(),
      ciEvidence: 'Head commit: abc\n## Check runs\n- failure \u00b7 CI-EVIDENCE-BODY-MARKER',
      ciEvidenceUnavailable: 'gh is not on PATH',
      onProgress: (m) => progress.push(m),
    });
    expect(res.prompt).toContain('CI evidence (checks + annotations at the PR head)');
    // The reason the seats are shown is the RULE's, not the caller's: the caller's own reason
    // describes only half of a contradiction, and naming the contradiction is what makes the bug
    // findable in the prompt the seat actually read.
    expect(res.prompt).toContain(
      'caller supplied both CI evidence and an unavailability reason — treated as unavailable'
    );
    expect(res.prompt).not.toContain('CI-EVIDENCE-BODY-MARKER');
    expect(
      progress.some((m) =>
        m.includes('caller supplied both text and an unavailable reason — treating as unavailable')
      )
    ).toBe(true);
    // Nothing trustworthy was gathered, so nothing joins the trail either.
    expect(
      fs.existsSync(path.join(reviewDir(out, 'ci-run'), CI_EVIDENCE_TRAIL_FILE))
    ).toBe(false);
  });

  it('renders no CI section at all when no fetch was attempted (the local-diff path)', async () => {
    const res = await runReviewMode(opts());
    expect(res.prompt).not.toContain('CI evidence (checks + annotations at the PR head)');
    expect(
      fs.existsSync(path.join(reviewDir(out, 'ci-run'), CI_EVIDENCE_TRAIL_FILE))
    ).toBe(false);
  });
});
