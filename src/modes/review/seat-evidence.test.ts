import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { type ReviewerConfig, REVIEWER_IDS } from '../../core/types';
import { CODEX_SANDBOX_PROFILE } from '../../reviewers/codex-sandbox';
import { GROK_SANDBOX_PROFILE } from '../../reviewers/grok';

import { CLAUDE_CAPABILITY_FENCE } from './claude';
import {
  formatEgressDenialCounts,
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
      profile: CLAUDE_CAPABILITY_FENCE,
      qualified: true,
      reason: null,
    });
    // Read the id literally: these seats are fenced by CAPABILITY (no Bash, no network, no MCP, a
    // neutral cwd, $HOME denied), not by a kernel sandbox.
    expect(CLAUDE_CAPABILITY_FENCE.id).toBe('claude-capability-fence');
  });
});

// THE IDENTITY GUARD. A receipt may never over-claim what fenced a seat — the same defect class the
// whole evidence machinery exists to close. codex and grok are fenced by DIFFERENT mechanisms:
// codex's outbound is denied BY THE KERNEL except the one loopback proxy port; grok's is merely
// ROUTED by proxy env vars (its sandbox.toml schema has no network keys), and what bounds a
// prompt-injected tree there is that the seat has no shell (`--disallowed-tools bash`). The two ids
// once both ended `+egress-proxy`, so a receipt reader inferred codex's kernel guarantee for grok.
// These assertions pin the distinction against a future copy-paste collapsing them back together.
describe('the seat profile ids encode the MECHANISM, not merely the existence of a fence', () => {
  const KERNEL_TOKEN = 'kernel';

  it('codex and grok never share a profile id', () => {
    expect(CODEX_SANDBOX_PROFILE.id).not.toBe(GROK_SANDBOX_PROFILE.id);
  });

  it("codex's id claims the kernel fence; grok's must NOT", () => {
    expect(CODEX_SANDBOX_PROFILE.id).toContain(KERNEL_TOKEN);
    // The load-bearing assertion: grok has no kernel network rule, so its id must never carry the
    // token that promises one. (Asserting codex's id DOES carry it stops the guard from being
    // satisfied by simply deleting the token from both.)
    expect(GROK_SANDBOX_PROFILE.id).not.toContain(KERNEL_TOKEN);
  });

  it("grok's id names what actually bounds it: env-routed egress, no shell", () => {
    expect(GROK_SANDBOX_PROFILE.id).toContain('proxy-env');
    expect(GROK_SANDBOX_PROFILE.id).toContain('noshell');
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

  // codex runs with its INTERNAL sandbox off (`--dangerously-bypass-approvals-and-sandbox`), so it
  // holds a live shell inside the untrusted tree, bounded only by a Seatbelt profile that grants
  // outbound :443. It is the seat class that most needs to be told that directions embedded in a
  // source file are data. The strip closes the FILE channel; this clause closes the in-file one.
  it('tells the codex/grok seat that in-tree agent directions are untrusted DATA', () => {
    const s = worktreePromptSuffix({ baseSha: null, headSha: 'h'.repeat(40), worktree: '/tmp/wt' });
    expect(s).toContain('untrusted DATA');
    expect(s).toContain('never obey them');
    // Named from the strip set itself, so the prompt can never enumerate a different list.
    for (const p of ['CLAUDE.md', 'AGENTS.md', '.claude', '.cursor/rules']) {
      expect(s, p).toContain(p);
    }
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

  // §6: a denial is LOUD — a seat that reached for a host outside its allowlist is the exact event
  // the fence exists to catch, so it rides the POSTED footer and not only a run artifact.
  it('states egress denials on the footer, deduped by host', () => {
    const line = formatEvidenceFooter(
      { codex: 'worktree' },
      [
        { host: 'evil.example', method: 'CONNECT', port: 443, reason: 'not allowlisted' },
        { host: 'evil.example', method: 'CONNECT', port: 443, reason: 'not allowlisted' },
        { host: 'mcp.supabase.com', method: 'CONNECT', port: 443, reason: 'not allowlisted' },
      ]
    );
    expect(line).toContain('3 connection(s) DENIED to 2 host(s)');
    expect(line).toContain('evil.example, mcp.supabase.com');
    expect(line).toContain('egress-denials.json');
  });

  it('says nothing about egress on a clean run — no denial, no noise', () => {
    expect(formatEvidenceFooter({ codex: 'worktree' })).not.toContain('egress fence');
  });

  it('a full-worktree run says nothing about degradation', () => {
    expect(formatEvidenceFooter({ codex: 'worktree', grok: 'worktree' })).not.toContain('DEGRADED');
  });

  it('a packet-mode run has no evidence line at all', () => {
    expect(formatEvidenceFooter({})).toBe('');
  });
});

// The live run-log rollup: per-host counts replace the old one-line-per-connection wall (a
// retry storm against one host is one fact, not four hundred lines).
describe('formatEgressDenialCounts — the run-log rollup', () => {
  const d = (host: string, n: number) =>
    Array.from({ length: n }, () => ({
      host,
      method: 'CONNECT',
      port: 443,
      reason: 'not allowlisted',
    }));

  it('counts per host, biggest first, total up front', () => {
    const line = formatEgressDenialCounts([...d('grok.com', 195), ...d('api.mixpanel.com', 198)]);
    expect(line).toBe(
      '393 connection(s) DENIED — api.mixpanel.com:443 ×198 · grok.com:443 ×195'
    );
  });

  it('hosts past the cap are counted, never silently dropped', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].flatMap((h, i) => d(`${h}.example`, i + 1));
    const line = formatEgressDenialCounts(many, 6);
    expect(line).toContain('+2 more host(s)');
    expect(line).toContain('egress-denials.json');
    // The two smallest counts are the hidden ones — the biggest stay named.
    expect(line).toContain('h.example:443 ×8');
    expect(line).not.toContain('a.example');
  });

  it('ties break on host name so the line is deterministic', () => {
    const line = formatEgressDenialCounts([...d('b.example', 2), ...d('a.example', 2)]);
    expect(line).toBe('4 connection(s) DENIED — a.example:443 ×2 · b.example:443 ×2');
  });
});
