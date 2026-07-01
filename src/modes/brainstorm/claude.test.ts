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
  it('runs headless single-shot, printing plain text to stdout, under the layered read-only policy', () => {
    const args = buildClaudeVoiceArgs('brainstorm prompt');
    // Layered read-only enforcement (provably no mutation): `--tools ""` disables every
    // tool, `--disallowed-tools` explicitly denies the mutating ones, and
    // `--permission-mode default` refuses any ambient bypass.
    expect(args).toEqual([
      '-p',
      'brainstorm prompt',
      '--output-format',
      'text',
      '--tools',
      '',
      '--disallowed-tools',
      'Bash',
      'Edit',
      'Write',
      'NotebookEdit',
      '--permission-mode',
      'default',
    ]);
  });
  it('disables all tools AND explicitly denies every mutating tool (read-only, defense-in-depth)', () => {
    const args = buildClaudeVoiceArgs('p');
    // `--tools ""` = the hard disable.
    expect(args[args.indexOf('--tools') + 1]).toBe('');
    // The mutating tools are also named in the deny list, and none is granted back.
    for (const tool of ['Bash', 'Edit', 'Write', 'NotebookEdit']) {
      expect(args).toContain(tool);
    }
    expect(args).not.toContain('--dangerously-skip-permissions');
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('default');
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
