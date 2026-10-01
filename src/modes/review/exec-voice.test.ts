import { describe, expect, it } from 'vitest';

import type { VoiceConfig } from '../brainstorm/types';

import { buildClaudeExecArgs } from './exec-voice';

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
  it('absent → no --settings; a model id / "off" → advisorModel, before the variadic --disallowedTools', () => {
    expect(buildClaudeExecArgs('PROMPT', CFG)).not.toContain('--settings');
    for (const [advisor, advisorModel] of [['claude-fable-5-1', 'claude-fable-5-1'], ['off', '']]) {
      const args = buildClaudeExecArgs('PROMPT', { ...CFG, advisor });
      const at = args.indexOf('--settings');
      expect(JSON.parse(args[at + 1])).toEqual({ advisorModel });
      expect(at).toBeLessThan(args.indexOf('--disallowedTools'));
      expect(args.slice(args.indexOf('--disallowedTools') + 1)).toEqual(['Agent', 'Task', 'WebFetch', 'WebSearch']);
    }
  });
});
