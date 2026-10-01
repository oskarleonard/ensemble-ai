import { describe, expect, it } from 'vitest';

import { buildClaudeVoiceArgs, claudeAdvisorArgs } from './claude';
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

// The value of the one `--settings` flag, parsed — never string-matched.
const settingsOf = (args: string[]): unknown => JSON.parse(args[args.indexOf('--settings') + 1]);

describe('claudeAdvisorArgs — the advisor half of every claude invocation', () => {
  it('absent → no flag at all (the seat inherits the operator settings)', () => {
    expect(claudeAdvisorArgs(cfg())).toEqual([]);
    expect(claudeAdvisorArgs(undefined)).toEqual([]);
  });

  it('a model id → --settings {"advisorModel":"<id>"}', () => {
    const args = claudeAdvisorArgs(cfg({ advisor: 'claude-fable-5-1' }));
    expect(args).toHaveLength(2);
    expect(args[0]).toBe('--settings');
    expect(settingsOf(args)).toEqual({ advisorModel: 'claude-fable-5-1' });
  });

  it('"off" → {"advisorModel":""} — the empty string DISABLES it; null is never emitted', () => {
    const args = claudeAdvisorArgs(cfg({ advisor: 'off' }));
    expect(settingsOf(args)).toEqual({ advisorModel: '' });
    expect(args[1]).not.toContain('null');
  });

  it('a hand-built config with an invalid advisor throws, naming the seat — it never reaches the CLI', () => {
    expect(() => claudeAdvisorArgs(cfg({ advisor: 'x"}, "permissions": {' }))).toThrow(/claude seat: `advisor`/);
  });
});

describe('buildClaudeVoiceArgs — the brainstorm/consult voice carries the advisor', () => {
  it('omits --settings when the advisor is absent', () => {
    expect(buildClaudeVoiceArgs('p', cfg())).not.toContain('--settings');
  });

  it('a model id and "off" each ride --settings after --model/--effort', () => {
    const withModel = buildClaudeVoiceArgs('p', cfg({ advisor: 'claude-opus-5-5', effort: 'high', model: 'opus' }));
    expect(settingsOf(withModel)).toEqual({ advisorModel: 'claude-opus-5-5' });
    expect(withModel.indexOf('--settings')).toBeGreaterThan(withModel.indexOf('--effort'));
    expect(settingsOf(buildClaudeVoiceArgs('p', cfg({ advisor: 'off' })))).toEqual({ advisorModel: '' });
    // The tool-less posture is untouched.
    expect(withModel.slice(0, 6)).toEqual(['-p', 'p', '--output-format', 'text', '--tools', '']);
  });
});
