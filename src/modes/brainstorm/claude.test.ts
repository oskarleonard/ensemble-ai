import { describe, expect, it } from 'vitest';

import { buildClaudeVoiceArgs } from './claude';
import type { VoiceConfig } from './types';

const cfg = (over: Partial<VoiceConfig> = {}): VoiceConfig => ({
  cmd: 'claude',
  effort: 'default',
  id: 'claude',
  model: 'default',
  vendor: 'anthropic',
  ...over,
});

describe('buildClaudeVoiceArgs', () => {
  it('runs headless single-shot, printing plain text to stdout, with ALL tools disabled', () => {
    const args = buildClaudeVoiceArgs('brainstorm prompt');
    // `--tools ""` makes the voice provably read-only (ideation needs no tools).
    expect(args).toEqual(['-p', 'brainstorm prompt', '--output-format', 'text', '--tools', '']);
  });
  it('passes the prompt verbatim (no shell interpolation)', () => {
    const tricky = 'a "quoted" $VAR & topic';
    expect(buildClaudeVoiceArgs(tricky)[1]).toBe(tricky);
  });
  it('omits --model/--effort for the "default" sentinel config', () => {
    const args = buildClaudeVoiceArgs('p', cfg());
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--effort');
  });
  it('honors a configured model and a valid effort level', () => {
    const args = buildClaudeVoiceArgs('p', cfg({ model: 'claude-opus-4-8', effort: 'high' }));
    expect(args).toContain('--model');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-opus-4-8');
    expect(args).toContain('--effort');
    expect(args[args.indexOf('--effort') + 1]).toBe('high');
  });
  it('drops an invalid (non-level) effort rather than passing it', () => {
    const args = buildClaudeVoiceArgs('p', cfg({ effort: 'bogus' }));
    expect(args).not.toContain('--effort');
  });
});
