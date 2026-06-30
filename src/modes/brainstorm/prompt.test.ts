import { describe, expect, it } from 'vitest';

import {
  renderCritiquePrompt,
  renderGeneratePrompt,
  renderSynthesisPrompt,
} from './prompt';
import type { Idea, VoiceCritiqueResult } from './types';

const ideas = (): Idea[] => [
  { body: 'codex body', id: 'codex-1', title: 'Codex idea', voiceId: 'codex' },
  { body: 'grok body', id: 'grok-1', title: 'Grok idea', voiceId: 'grok' },
];

describe('renderGeneratePrompt', () => {
  it('embeds the topic and asks for INDEPENDENT ideation (no peers shown)', () => {
    const p = renderGeneratePrompt('how to name the CLI');
    expect(p).toContain('how to name the CLI');
    expect(p).toContain('ENTIRELY ON YOUR OWN');
    expect(p).toContain('"ideas"');
    // round 1 must not leak any prior ideas
    expect(p).not.toContain('Codex idea');
  });
  it('includes file context when given and truncates a huge one', () => {
    expect(renderGeneratePrompt('t', 'CONTEXT_HERE')).toContain('CONTEXT_HERE');
    const huge = 'x'.repeat(50_000);
    const p = renderGeneratePrompt('t', huge);
    expect(p).toContain('[context truncated]');
    expect(p.length).toBeLessThan(huge.length);
  });
});

describe('renderCritiquePrompt', () => {
  it('shows the peer ideas it is given (caller filters out self)', () => {
    const p = renderCritiquePrompt('topic', ideas());
    expect(p).toContain('[codex-1] Codex idea');
    expect(p).toContain('[grok-1] Grok idea');
    expect(p).toContain('"critiques"');
    expect(p).toContain('"extensions"');
  });
});

describe('renderSynthesisPrompt', () => {
  it('labels each idea with its author and folds in the critiques', () => {
    const critiques: VoiceCritiqueResult[] = [
      {
        critiques: [{ assessment: 'too vague', stance: 'concern', target: 'grok-1' }],
        extensions: [{ body: 'combine them', title: 'merge' }],
        ok: true,
        raw: null,
        summary: 's',
        voiceId: 'claude',
      },
    ];
    const p = renderSynthesisPrompt('topic', ideas(), critiques);
    expect(p).toContain('(codex) Codex idea');
    expect(p).toContain('(claude) concern on grok-1: too vague');
    expect(p).toContain('(claude) extension — merge: combine them');
    expect(p).toContain('"ranked"');
  });
  it('says "(no critiques)" when there are none, and skips failed critics', () => {
    const failed: VoiceCritiqueResult[] = [
      { critiques: [], extensions: [], ok: false, raw: null, summary: '', voiceId: 'grok' },
    ];
    expect(renderSynthesisPrompt('t', ideas(), failed)).toContain('(no critiques)');
  });
});
