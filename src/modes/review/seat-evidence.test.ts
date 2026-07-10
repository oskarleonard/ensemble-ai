import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { type ReviewerConfig, REVIEWER_IDS } from '../../core/types';
import { CODEX_SANDBOX_PROFILE } from '../../reviewers/codex-sandbox';
import { GROK_SANDBOX_PROFILE } from '../../reviewers/grok';

import { CLAUDE_HARNESS_PROFILE } from './claude';
import {
  formatEvidenceFooter,
  intendedEvidenceFor,
  qualifyCodexSeat,
  qualifyGrokSeat,
  qualifyHarnessSeat,
  sandboxProfilesFor,
  SEAT_QUALIFIERS,
  worktreePromptSuffix,
} from './seat-evidence';

const wt = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-qual-'));

describe('seat qualification — a seat gets the worktree IFF its sandbox qualifies (spec §2)', () => {
  it('codex: no Seatbelt ⇒ NOT qualified, and the reason names the platform', () => {
    const q = qualifyCodexSeat('/tmp/whatever', { supported: false });
    expect(q.qualified).toBe(false);
    expect(q.reason).toContain('no qualifying sandbox');
    // The profile identity is recorded even when unqualified: it names the fence the POLICY would
    // have applied, which is what the receipt's intended map + policyHash bind.
    expect(q.profile).toEqual(CODEX_SANDBOX_PROFILE);
  });

  it('codex: a profile that refuses to build ⇒ NOT qualified (never a costume sandbox)', () => {
    // The worktree does not exist, so the profile's realpath resolution fails before any rule is
    // emitted. Fail closed: the seat keeps the packet rather than running unfenced.
    const q = qualifyCodexSeat('/private/tmp/no-such-worktree-here', { supported: true });
    expect(q.qualified).toBe(false);
    expect(q.reason).toMatch(/^codex: /);
  });

  it('codex: a real worktree under a sane node prefix qualifies', () => {
    const dir = wt();
    const q = qualifyCodexSeat(dir, { supported: true });
    expect(q).toEqual({ profile: CODEX_SANDBOX_PROFILE, qualified: true, reason: null });
    fs.rmSync(dir, { force: true, recursive: true });
  });

  it('grok: `ensemble-review` qualifies; bare `strict` does NOT (it lacks the secret deny-list)', () => {
    expect(qualifyGrokSeat('ensemble-review').qualified).toBe(true);
    expect(qualifyGrokSeat(undefined).qualified).toBe(true); // resolves to ensemble-review
    const strict = qualifyGrokSeat('strict');
    expect(strict.qualified).toBe(false);
    expect(strict.reason).toContain('ensemble-review');
    expect(strict.profile).toEqual(GROK_SANDBOX_PROFILE);
  });

  it('the Anthropic seats are harness-controlled and always qualify, under a NAMED belt', () => {
    expect(qualifyHarnessSeat()).toEqual({
      profile: CLAUDE_HARNESS_PROFILE,
      qualified: true,
      reason: null,
    });
    // Read the id literally: this is plan-mode + a write-tool deny-list, not a kernel sandbox.
    expect(CLAUDE_HARNESS_PROFILE.id).toBe('claude-plan-mode-deny-writes');
  });
});

describe('the qualifier table is EXHAUSTIVE — a new reviewer cannot default into the worktree', () => {
  it('every REVIEWER_ID has its own qualifier, and each binds its OWN profile', () => {
    expect(Object.keys(SEAT_QUALIFIERS).sort()).toEqual([...REVIEWER_IDS].sort());
    const dir = wt();
    const config: ReviewerConfig = {
      cmd: 'x', effort: 'high', id: 'grok', model: 'm', sandbox: 'strict', vendor: 'v',
    };
    // grok's qualifier reads the seat's configured sandbox (bare `strict` ⇒ unqualified); codex's
    // reads the worktree. Routing one seat's qualifier to the other is what the table prevents.
    expect(SEAT_QUALIFIERS.grok({ config, worktree: dir }).profile).toEqual(GROK_SANDBOX_PROFILE);
    expect(SEAT_QUALIFIERS.grok({ config, worktree: dir }).qualified).toBe(false);
    expect(SEAT_QUALIFIERS.codex({ config, worktree: dir }).profile).toEqual(CODEX_SANDBOX_PROFILE);
    fs.rmSync(dir, { force: true, recursive: true });
  });
});

describe('intent is independent of qualification (spec §8)', () => {
  it('every seat that runs is INTENDED worktree — including the gate', () => {
    expect(intendedEvidenceFor(['codex', 'grok', 'claude', 'gate'])).toEqual({
      claude: 'worktree',
      codex: 'worktree',
      gate: 'worktree',
      grok: 'worktree',
    });
  });

  it('an UNQUALIFIED seat still binds its policy profile, so the receipt key is stable', () => {
    // This is the property §8 asks for: "has this diff been reviewed at full quality?" must be
    // askable BEFORE the outcome is known, so a run that degrades at runtime keys identically to
    // one that did not. The degradation lives in the realized map, never in the key.
    const profiles = sandboxProfilesFor({
      codex: qualifyCodexSeat('/private/tmp/no-such-worktree-here', { supported: false }),
      grok: qualifyGrokSeat('ensemble-review'),
    });
    expect(profiles).toEqual({ codex: CODEX_SANDBOX_PROFILE, grok: GROK_SANDBOX_PROFILE });
  });
});

describe('the worktree prompt preamble', () => {
  it('names the tree, the head, and the exact range — and forbids writes', () => {
    const s = worktreePromptSuffix({ baseSha: 'b'.repeat(40), headSha: 'h'.repeat(40), worktree: '/tmp/wt' });
    expect(s).toContain('/tmp/wt');
    expect(s).toContain(`git diff ${'b'.repeat(40)}...${'h'.repeat(40)}`);
    expect(s).toContain('may not edit, stage, or push');
    expect(s).toContain(`file:line as it exists at ${'h'.repeat(40)}`);
  });

  it('omits the range when no base SHA resolved (never invents one)', () => {
    const s = worktreePromptSuffix({ baseSha: null, headSha: 'h', worktree: '/tmp/wt' });
    expect(s).not.toContain('git diff');
    expect(s).toContain('/tmp/wt');
  });
});

describe('the evidence footer — a degraded run never reads as a full-worktree one', () => {
  it('states every seat, and says DEGRADED when any fell back', () => {
    const line = formatEvidenceFooter({ claude: 'worktree', codex: 'packet', gate: 'worktree', grok: 'worktree' });
    expect(line).toContain('codex packet');
    expect(line).toContain('grok worktree');
    expect(line).toContain('DEGRADED');
  });

  it('a full-worktree run says nothing about degradation', () => {
    expect(formatEvidenceFooter({ codex: 'worktree', grok: 'worktree' })).not.toContain('DEGRADED');
  });

  it('a packet-mode run has no evidence line at all', () => {
    expect(formatEvidenceFooter({})).toBe('');
  });
});
