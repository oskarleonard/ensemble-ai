import { describe, expect, it } from 'vitest';

import { buildClaudeVoiceArgs } from './claude';

describe('buildClaudeVoiceArgs', () => {
  it('runs headless single-shot, printing plain text to stdout', () => {
    const args = buildClaudeVoiceArgs('brainstorm prompt');
    expect(args).toEqual(['-p', 'brainstorm prompt', '--output-format', 'text']);
  });
  it('passes the prompt verbatim (no shell interpolation)', () => {
    const tricky = 'a "quoted" $VAR & topic';
    expect(buildClaudeVoiceArgs(tricky)[1]).toBe(tricky);
  });
});
