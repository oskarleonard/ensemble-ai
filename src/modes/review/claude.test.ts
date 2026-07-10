import { describe, expect, it } from 'vitest';

import type { VoiceConfig } from '../brainstorm/types';

import { buildClaudeReviewArgs, CLAUDE_REVIEW_DENIED_TOOLS } from './claude';

const CFG = (over: Partial<VoiceConfig> = {}): VoiceConfig => ({
  cmd: 'claude', effort: 'default', id: 'claude', model: 'default', vendor: 'anthropic', ...over,
});

describe('buildClaudeReviewArgs — the capability fence (pinned as data)', () => {
  it('always headless, plain output, plan-mode + the execution/egress deny-list', () => {
    const args = buildClaudeReviewArgs('THE PROMPT', CFG());
    expect(args.slice(0, 4)).toEqual(['-p', 'THE PROMPT', '--output-format', 'text']);
    // Plan mode alone is NOT a fence — it still executes Bash. Removing the tools is.
    expect(args).toContain('--permission-mode');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('plan');
    expect(args).toContain('--disallowedTools');
    for (const t of CLAUDE_REVIEW_DENIED_TOOLS) expect(args).toContain(t);
    expect([...CLAUDE_REVIEW_DENIED_TOOLS]).toEqual([
      'Bash', 'WebFetch', 'WebSearch', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit',
    ]);
  });

  it('omits --model/--effort at the "default" sentinel, includes them when configured', () => {
    expect(buildClaudeReviewArgs('p', CFG())).not.toContain('--model');
    expect(buildClaudeReviewArgs('p', CFG())).not.toContain('--effort');
    const args = buildClaudeReviewArgs('p', CFG({ model: 'claude-opus-4-8', effort: 'high' }));
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-8');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });

  it('rejects an invalid effort (leaves it to the CLI default)', () => {
    expect(buildClaudeReviewArgs('p', CFG({ effort: 'bogus' }))).not.toContain('--effort');
  });
});
