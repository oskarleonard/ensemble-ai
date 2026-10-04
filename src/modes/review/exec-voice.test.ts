import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { VoiceConfig } from '../brainstorm/types';
import type { ReviewerExecOpts } from '../../core/spawn';

import type { ReviewerExec } from './claude';
import { buildClaudeExecArgs, runClaudeExecVoice } from './exec-voice';

const CFG: VoiceConfig = { cmd: 'claude', effort: 'max', id: 'claude', model: 'opus', vendor: 'anthropic' };

describe('the exec-voice argv — unfenced where the review seats are fenced, and that is the point', () => {
  const args = buildClaudeExecArgs('PROMPT', CFG);

  it('runs headless bypassPermissions stream-json (probed 2026-08-10: Bash executes)', () => {
    expect(args.slice(0, 2)).toEqual(['-p', 'PROMPT']);
    for (const flag of ['--output-format', 'stream-json', '--permission-mode', 'bypassPermissions', '--strict-mcp-config']) {
      expect(args).toContain(flag);
    }
  });

  it('keeps Bash and the write tools; denies ONLY fan-out (Agent/Task) + web — and last', () => {
    const denyAt = args.indexOf('--disallowedTools');
    expect(args.slice(denyAt + 1)).toEqual(['Agent', 'Task', 'WebFetch', 'WebSearch']);
    expect(args).not.toContain('Bash');
    // no home-read deny rules — exec seats are trusted-PR-only by operator decision
    expect(args.some((a) => a.startsWith('Read(/'))).toBe(false);
  });

  it('passes the seat model/effort through; the default sentinels are omitted', () => {
    expect(args).toContain('--model');
    expect(args).toContain('opus');
    expect(args).toContain('--effort');
    expect(args).toContain('max');
    const bare = buildClaudeExecArgs('P', { ...CFG, effort: 'default', model: 'default' });
    expect(bare).not.toContain('--model');
    expect(bare).not.toContain('--effort');
  });
});

describe('the exec-voice argv — the advisor rides --settings like every claude seat', () => {
  it('absent / "off" → no --settings; a model id → advisorModel, before the variadic --disallowedTools', () => {
    expect(buildClaudeExecArgs('PROMPT', CFG)).not.toContain('--settings');
    // "off" is the env kill switch (claudeAdvisorEnv) — no settings value disables the advisor.
    expect(buildClaudeExecArgs('PROMPT', { ...CFG, advisor: 'off' })).toEqual(buildClaudeExecArgs('PROMPT', CFG));
    const args = buildClaudeExecArgs('PROMPT', { ...CFG, advisor: 'claude-fable-5-1' });
    const at = args.indexOf('--settings');
    expect(JSON.parse(args[at + 1])).toEqual({ advisorModel: 'claude-fable-5-1' });
    expect(at).toBeLessThan(args.indexOf('--disallowedTools'));
    expect(args.slice(args.indexOf('--disallowedTools') + 1)).toEqual(['Agent', 'Task', 'WebFetch', 'WebSearch']);
  });
});

describe('runClaudeExecVoice — the advisor "off" reaches the spawned claude as its env', () => {
  beforeAll(() => {
    // Resolution short-circuits to an existing binary; the injected exec never spawns it.
    vi.stubEnv('CLAUDE_BIN', '/bin/echo');
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  const envOf = async (config: VoiceConfig) => {
    const calls: ReviewerExecOpts[] = [];
    const exec: ReviewerExec = (req) => {
      calls.push(req);
      return Promise.resolve({ raw: 'DONE', stderrTail: '', timedOut: false });
    };
    await runClaudeExecVoice('PROMPT', config, { timeoutMs: 1_000, worktree: '/tmp/worktree' }, { exec });
    expect(calls).toHaveLength(1);
    return calls[0].env;
  };

  it('"off" → CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1 in the child env', async () => {
    expect((await envOf({ ...CFG, advisor: 'off' }))?.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBe('1');
  });

  it('a pinned model or an absent advisor → the variable is never set', async () => {
    expect((await envOf({ ...CFG, advisor: 'claude-fable-5-1' }))?.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBeUndefined();
    expect((await envOf(CFG))?.CLAUDE_CODE_DISABLE_ADVISOR_TOOL).toBeUndefined();
  });
});
