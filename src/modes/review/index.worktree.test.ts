import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ReviewerConfig, ReviewerId } from '../../core/types';
import type { CodexReviewResult, RunReviewOpts } from '../../reviewers/codex';
import { GROK_SANDBOX_PROFILE } from '../../reviewers/grok';

import { CLAUDE_CAPABILITY_FENCE } from './claude';
import { computePolicyHashAt, POLICY_VERSION_EVIDENCE, POLICY_VERSION_LEGACY } from './evidence';
import { runReviewMode } from './index';
import type { ReviewAdapter } from './seat-run';

// END-TO-END SEAT WIRING, with the vendor CLIs stubbed at the adapter seam: does `--repo`'s
// worktree actually reach each seat's spawn, under the profile its policy names, and does the
// receipt record what each seat REALIZED (spec §2, §8)?
//
// `grok` is the seat asserted on both sides of the fork, because its qualification is a pure
// config predicate (`ensemble-review` vs `strict`) and so is deterministic on every platform.
// codex's qualification depends on Seatbelt, whose absence is exercised in seat-evidence.test.ts.

// Long enough to clear DIFF_USEFUL_FLOOR — a diff too small to review never spawns a seat.
const DIFF = [
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
const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
// No reviewers.json at this path ⇒ the baked defaults (grok under `ensemble-review`).
const NO_REVIEWERS_FILE = path.join(os.tmpdir(), 'ensemble-no-such-reviewers.json');

interface Spawned {
  id: ReviewerId;
  prompt: string;
  worktree?: string;
}

function stubAdapters(replies: Partial<Record<ReviewerId, CodexReviewResult>> = {}): {
  adapters: Record<ReviewerId, ReviewAdapter>;
  spawns: Spawned[];
} {
  const spawns: Spawned[] = [];
  const make =
    (id: ReviewerId): ReviewAdapter =>
    async (prompt: string, _c: ReviewerConfig, opts?: RunReviewOpts) => {
      spawns.push({ id, prompt, worktree: opts?.worktree });
      return (
        replies[id] ?? { ok: true, raw: REVIEW, stderrTail: '', timedOut: false }
      );
    };
  return { adapters: { codex: make('codex'), grok: make('grok') }, spawns };
}

let out: string;
let cwd: string;
let worktreeDir: string;
beforeEach(() => {
  out = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-wt-e2e-'));
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-wt-cwd-'));
  worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-wt-tree-'));
});
afterEach(() => {
  for (const d of [out, cwd, worktreeDir]) fs.rmSync(d, { force: true, recursive: true });
});

const runOpts = (extra: Record<string, unknown>) => ({
  conventionReader: null,
  cwd,
  diffMode: 'pr' as const,
  diffText: DIFF,
  headShaOverride: HEAD,
  noConventions: true,
  out,
  receiptStore: path.join(out, 'receipts'),
  reviewersFile: NO_REVIEWERS_FILE,
  runId: 'wt-run',
  ...extra,
});

describe('review --repo: a QUALIFIED seat is spawned against the worktree', () => {
  it('grok gets the worktree as its cwd, sees the whole-project preamble, and realizes `worktree`', async () => {
    const { adapters, spawns } = stubAdapters();
    const result = await runReviewMode(
      runOpts({
        adapters,
        peerSeats: ['claude', 'gate'],
        reviewers: ['grok'],
        worktree: { baseSha: BASE, dir: worktreeDir, headSha: HEAD },
      })
    );

    expect(spawns).toHaveLength(1);
    expect(spawns[0].worktree).toBe(worktreeDir);
    // The pinned packet diff is still the change under review; the preamble ADDS the tree.
    expect(spawns[0].prompt).toContain('const b = 2;');
    expect(spawns[0].prompt).toContain(worktreeDir);
    expect(spawns[0].prompt).toContain(`git diff ${BASE}...${HEAD}`);

    expect(result.evidence?.realized).toEqual({ grok: 'worktree' });
    expect(result.evidence?.fallbacks).toEqual([]);
    // INTENT covers the Anthropic seats the CALLER runs — the gate is an evidence-bearing actor.
    expect(result.evidence?.intended).toEqual({
      claude: 'worktree',
      gate: 'worktree',
      grok: 'worktree',
    });
    expect(result.evidence?.sandboxProfiles).toEqual({
      claude: CLAUDE_CAPABILITY_FENCE,
      gate: CLAUDE_CAPABILITY_FENCE,
      grok: GROK_SANDBOX_PROFILE,
    });
  });

  it('mints a v2 receipt whose policyHash binds the intended map + the sandbox profiles', async () => {
    const { adapters } = stubAdapters();
    const result = await runReviewMode(
      runOpts({
        adapters,
        peerSeats: ['claude', 'gate'],
        reviewers: ['grok'],
        worktree: { baseSha: BASE, dir: worktreeDir, headSha: HEAD },
      })
    );
    const receipt = result.receiptCandidate;
    expect(receipt).toBeDefined();
    expect(receipt?.policyVersion).toBe(POLICY_VERSION_EVIDENCE);
    expect(receipt?.intendedEvidence).toEqual({ claude: 'worktree', gate: 'worktree', grok: 'worktree' });
    // The CORE seats' realized classes only — the caller stamps the Anthropic seats in (they are
    // not hashed, so folding them in afterwards cannot move the receipt key).
    expect(receipt?.realizedEvidence).toEqual({ grok: 'worktree' });
    expect(receipt?.policyHash).toBe(
      computePolicyHashAt(
        {
          coveragePolicy: { ceilingBytes: 200_000 },
          diffMode: 'pr',
          intendedEvidence: receipt!.intendedEvidence,
          reviewerPolicy: ['grok'],
          sandboxProfiles: receipt!.sandboxProfiles,
        },
        POLICY_VERSION_EVIDENCE
      )
    );
  });

  // A worktree seat's evidence is only meaningful bound to the fence that bounded it, so the receipt
  // must NAME that fence. `claude-plan-mode-deny-writes` was an honest name for a belt that did not
  // meet spec §2; a receipt minted under the real fence must say `claude-capability-fence`.
  it('binds the Anthropic seats to `claude-capability-fence` v1 in the receipt', async () => {
    const { adapters } = stubAdapters();
    const result = await runReviewMode(
      runOpts({
        adapters,
        peerSeats: ['claude', 'gate'],
        reviewers: ['grok'],
        worktree: { baseSha: BASE, dir: worktreeDir, headSha: HEAD },
      })
    );
    for (const seat of ['claude', 'gate'] as const) {
      expect(result.receiptCandidate?.sandboxProfiles?.[seat]).toEqual({
        id: 'claude-capability-fence',
        version: 1,
      });
    }
    // grok keeps its OS-enforced Seatbelt profile — the fence is per-seat, never a global claim.
    expect(result.receiptCandidate?.sandboxProfiles?.grok).toEqual(GROK_SANDBOX_PROFILE);
  });
});

describe('review --repo: an UNQUALIFIED seat falls back to the packet, LOUDLY (spec §2)', () => {
  it('grok under bare `strict` never sees the worktree, and the run records the degradation', async () => {
    const { adapters, spawns } = stubAdapters();
    const logged: string[] = [];
    const result = await runReviewMode(
      runOpts({
        adapters,
        onProgress: (m: string) => logged.push(m),
        reviewers: ['grok'],
        // `strict` is deny-by-default for reads but lacks the secret deny-list the receipt attests.
        sandbox: 'strict',
        worktree: { baseSha: BASE, dir: worktreeDir, headSha: HEAD },
      })
    );

    expect(spawns[0].worktree).toBeUndefined();
    expect(spawns[0].prompt).not.toContain(worktreeDir);
    expect(result.evidence?.realized).toEqual({ grok: 'packet' });
    // Intent still says worktree — that is what the caller ASKED for, and what the key binds.
    expect(result.evidence?.intended).toEqual({ grok: 'worktree' });
    expect(result.evidence?.fallbacks[0]).toContain('ensemble-review');
    expect(logged.join('\n')).toContain('ensemble-review');

    // A degraded run is NEVER receipt-equivalent to a full-worktree one: same key, different fact.
    expect(result.receiptCandidate?.realizedEvidence).toEqual({ grok: 'packet' });
    expect(result.receiptCandidate?.intendedEvidence).toEqual({ grok: 'worktree' });
  });
});

describe('packet mode is byte-compatible — worktree mode OFF changes no receipt identity', () => {
  it('no --repo ⇒ no worktree on any spawn, no evidence maps, a LEGACY (v1) receipt', async () => {
    const { adapters, spawns } = stubAdapters();
    const result = await runReviewMode(runOpts({ adapters, reviewers: ['grok'] }));

    expect(spawns[0].worktree).toBeUndefined();
    expect(result.evidence).toEqual({ fallbacks: [], intended: {}, realized: { grok: 'packet' }, sandboxProfiles: {} });
    const receipt = result.receiptCandidate;
    expect(receipt?.policyVersion).toBeUndefined();
    expect(receipt?.intendedEvidence).toBeUndefined();
    expect(receipt?.realizedEvidence).toBeUndefined();
    expect(receipt?.sandboxProfiles).toBeUndefined();
    expect(receipt?.policyHash).toBe(
      computePolicyHashAt(
        { coveragePolicy: { ceilingBytes: 200_000 }, diffMode: 'pr', reviewerPolicy: ['grok'] },
        POLICY_VERSION_LEGACY
      )
    );
  });
});
