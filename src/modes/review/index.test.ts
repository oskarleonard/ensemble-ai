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

// A REVIEW IN PARTS (chunks.ts). Two files in two areas, a ceiling that holds one of them: the
// engine plans two parts, every core seat reviews BOTH (one adapter call per part), the parts
// merge into one review of record per seat, the gate packet pins the UNION, and the trail
// records what each seat did with each part.
describe('runReviewMode — a change over the ceiling is reviewed in parts', () => {
  const part = (p: string, n: number): string =>
    `diff --git a/${p} b/${p}\nindex 1..2 100644\n--- a/${p}\n+++ b/${p}\n@@ -1,1 +1,1 @@\n+${'x'.repeat(n)}\n`;
  const TWO_AREAS = part('backend/a.go', 300) + part('web/c.ts', 300);
  const FINDING_REVIEW = (file: string): string =>
    '```json\n' +
    JSON.stringify({
      findings: [{ body: 'b', confidence: 'high', evidence: { file, line: 1 }, severity: 'low', title: `bug in ${file}` }],
      summary: `looked at ${file}`,
    }) +
    '\n```';

  let out: string;
  let cwd: string;
  beforeEach(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-parts-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-parts-cwd-'));
  });
  afterEach(() => {
    for (const d of [out, cwd]) fs.rmSync(d, { force: true, recursive: true });
  });

  it('runs every seat once per part, merges, pins the union, and writes chunks.json', async () => {
    const prompts: string[] = [];
    const adapter: ReviewAdapter = async (prompt) => {
      prompts.push(prompt);
      const file = prompt.includes('diff --git a/backend/a.go') ? 'backend/a.go' : 'web/c.ts';
      return { ok: true, raw: FINDING_REVIEW(file), stderrTail: '', timedOut: false };
    };
    const res = await runReviewMode({
      adapters: { claude: adapter, codex: adapter, grok: adapter },
      ceilingBytes: 400,
      conventionReader: null,
      cwd,
      diffMode: 'pr',
      diffText: TWO_AREAS,
      headShaOverride: 'a'.repeat(40),
      noConventions: true,
      out,
      receiptStore: path.join(out, 'receipts'),
      reviewers: ['grok'],
      reviewersFile: NO_REVIEWERS_FILE,
      runId: 'parts-run',
    });
    expect(res.blocked).toBe(false);
    // two parts, two adapter calls, each carrying its own hunks + the scope note
    expect(res.acquired.plan.chunks.map((c) => c.paths)).toEqual([['backend/a.go'], ['web/c.ts']]);
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('PART 1 of 2');
    expect(prompts[0]).toContain('diff --git a/backend/a.go');
    expect(prompts[0]).not.toContain('diff --git a/web/c.ts');
    expect(prompts[0]).toContain('web/c.ts (+1/-0)'); // named as changed, hunks elsewhere
    expect(prompts[1]).toContain('PART 2 of 2');
    expect(prompts[1]).toContain('diff --git a/web/c.ts');
    // the parts come back for the Claude producer, and the lens gets a handoff with a listing
    expect(res.parts?.map((p) => p.index)).toEqual([1, 2]);
    expect(res.parts?.[1].scope).toContain('PART 2 of 2');
    expect(res.lensHandoff?.scope).toContain('part 1 — backend (hunks below)');
    expect(res.lensHandoff?.scope).toContain('part 2 — web (hunks NOT below — read at head)');
    // ONE review of record per seat: both parts' findings, in part order, tagged with their part
    const grok = res.reviews.find((r) => r.reviewerId === 'grok');
    expect(grok?.terminalState).toBe('reviewed');
    expect(grok?.findings.map((f) => [f.id, f.chunk, f.evidence.file])).toEqual([
      ['f1', 1, 'backend/a.go'],
      ['f2', 2, 'web/c.ts'],
    ]);
    expect(grok?.summary).toContain('Part 1/2');
    expect(grok?.summary).toContain('Part 2/2');
    // the parts' own artifacts survive beside the merged set
    const dir = reviewDir(out, 'parts-run');
    for (const name of ['findings.grok.c1.json', 'findings.grok.c2.json', 'prompt.grok.c1.md', 'prompt.grok.c2.md', 'review.grok.c1.json', 'review.grok.json', 'findings.grok.json', 'grok-review.raw.md']) {
      expect(fs.existsSync(path.join(dir, name)), name).toBe(true);
    }
    expect(fs.readFileSync(path.join(dir, 'grok-review.raw.md'), 'utf8')).toContain('## Part 2 of 2');
    // the gate packet pins the UNION of what the seats saw
    const gatePacket = JSON.parse(fs.readFileSync(path.join(dir, 'packet.gate.json'), 'utf8')) as { changedFiles: string[]; diff: string };
    expect(gatePacket.diff).toContain('diff --git a/backend/a.go');
    expect(gatePacket.diff).toContain('diff --git a/web/c.ts');
    expect(gatePacket.changedFiles).toEqual(['backend/a.go', 'web/c.ts']);
    expect(res.pinnedDiff).toBe(gatePacket.diff);
    // the chunk trail: two parts, the seat's outcome on each, nothing omitted
    const trail = JSON.parse(fs.readFileSync(path.join(dir, 'chunks.json'), 'utf8')) as { chunks: { index: number; seats: Record<string, { findings: number; state: string }> }[]; omitted: unknown[] };
    expect(trail.chunks.map((c) => c.index)).toEqual([1, 2]);
    expect(trail.chunks[0].seats.grok).toMatchObject({ findings: 1, state: 'reviewed' });
    expect(trail.chunks[1].seats.grok).toMatchObject({ findings: 1, state: 'reviewed' });
    expect(trail.omitted).toEqual([]);
    // every source file was reviewed whole → the core qualifies the receipt
    expect(res.receiptCandidate).toBeDefined();
    expect(res.acquired.coverage.omittedFiles).toBe(0);
  });

  it('a part that fails leaves the seat INCOMPLETE — never a clean merge over a hole', async () => {
    let calls = 0;
    const adapter: ReviewAdapter = async () => {
      calls++;
      return calls === 2
        ? { ok: false, raw: null, stderrTail: 'boom', timedOut: true }
        : { ok: true, raw: FINDING_REVIEW('backend/a.go'), stderrTail: '', timedOut: false };
    };
    const res = await runReviewMode({
      adapters: { claude: adapter, codex: adapter, grok: adapter },
      ceilingBytes: 400,
      conventionReader: null,
      cwd,
      diffMode: 'pr',
      diffText: TWO_AREAS,
      headShaOverride: 'a'.repeat(40),
      noConventions: true,
      out,
      receiptStore: path.join(out, 'receipts'),
      reviewers: ['grok'],
      reviewersFile: NO_REVIEWERS_FILE,
      runId: 'parts-fail',
    });
    const grok = res.reviews.find((r) => r.reviewerId === 'grok');
    expect(grok?.terminalState).toBe('failed-reviewer');
    expect(grok?.summary).toContain('1 part(s) did not complete');
    expect(grok?.summary).toContain('Part 2/2');
    expect(grok?.findings).toHaveLength(1); // part 1's finding is kept, flagged by the state
    expect(res.receiptCandidate).toBeUndefined();
    expect(res.receiptError).toContain('grok did not complete');
  });

  it('a change that fits one packet is one part — no scope section, no part artifacts (unchanged behavior)', async () => {
    const res = await runReviewMode({
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
      runId: 'one-part',
    });
    expect(res.acquired.plan.chunks).toHaveLength(1);
    expect(res.parts).toHaveLength(1);
    expect(res.lensHandoff).toBeUndefined();
    expect(res.prompt).not.toContain('Change scope');
    const dir = reviewDir(out, 'one-part');
    expect(fs.existsSync(path.join(dir, 'findings.grok.c1.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'chunks.json'))).toBe(true);
    expect(res.reviews[0].findings.every((f) => f.chunk === undefined)).toBe(true);
  });
});

// The Anthropic stages depend on the packet, not on the core seats' replies — so the engine
// hands the pinned packet over BEFORE the fan-out, and a caller can start them in parallel.
describe('runReviewMode — onPacketsReady fires before any core seat spawns', () => {
  let out: string;
  let cwd: string;
  beforeEach(() => {
    out = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-ready-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-ready-cwd-'));
  });
  afterEach(() => {
    for (const d of [out, cwd]) fs.rmSync(d, { force: true, recursive: true });
  });

  it('hands over the parts, the pinned diff and the head, then the seats run', async () => {
    const order: string[] = [];
    const adapter: ReviewAdapter = async () => {
      order.push('seat');
      return { ok: true, raw: REVIEW, stderrTail: '', timedOut: false };
    };
    const res = await runReviewMode({
      adapters: { claude: adapter, codex: adapter, grok: adapter },
      conventionReader: null,
      cwd,
      diffMode: 'pr',
      diffText: CODE_DIFF,
      headShaOverride: 'a'.repeat(40),
      noConventions: true,
      onPacketsReady: (ready) => {
        order.push('ready');
        expect(ready.headSha).toBe('a'.repeat(40));
        expect(ready.parts).toHaveLength(1);
        expect(ready.pinnedDiff).toContain('addTwoNumbersTogether');
        expect(ready.prompt).toContain('The diff under review');
      },
      out,
      receiptStore: path.join(out, 'receipts'),
      reviewers: ['grok'],
      reviewersFile: NO_REVIEWERS_FILE,
      runId: 'ready-run',
    });
    expect(order).toEqual(['ready', 'seat']);
    expect(res.blocked).toBe(false);
  });

  it('a throwing hook is reported and the review still runs', async () => {
    const progress: string[] = [];
    const res = await runReviewMode({
      adapters: stubAdapters(),
      conventionReader: null,
      cwd,
      diffMode: 'pr',
      diffText: CODE_DIFF,
      headShaOverride: 'a'.repeat(40),
      noConventions: true,
      onPacketsReady: () => {
        throw new Error('caller bug');
      },
      onProgress: (m) => progress.push(m),
      out,
      receiptStore: path.join(out, 'receipts'),
      reviewers: ['grok'],
      reviewersFile: NO_REVIEWERS_FILE,
      runId: 'ready-throw',
    });
    expect(res.reviews[0].terminalState).toBe('reviewed');
    expect(progress.some((m) => m.includes('onPacketsReady hook failed (caller bug)'))).toBe(true);
  });
});
