import { describe, expect, it } from 'vitest';

import {
  renderAnswerPrompt,
  renderCritiquePrompt,
  renderSynthesisPrompt,
} from './prompt';
import type { VoiceAnswerResult } from './types';

const answer = (voiceId: VoiceAnswerResult['voiceId'], summary: string): VoiceAnswerResult => ({
  answer: `full ${summary}`,
  keyPoints: [`${summary}-kp`],
  ok: true,
  raw: '{}',
  summary,
  voiceId,
});

describe('renderAnswerPrompt', () => {
  it('embeds the question and demands independence + a strict JSON contract', () => {
    const p = renderAnswerPrompt('Postgres or SQLite?');
    expect(p).toContain('Postgres or SQLite?');
    expect(p).toContain('ENTIRELY ON YOUR OWN');
    expect(p).toContain('"keyPoints"');
    // Round 1 must NOT leak any peer content — it only knows the question.
    expect(p).not.toContain('other voices');
  });
  it('includes and truncates oversized file context', () => {
    const big = 'x'.repeat(30_000);
    const p = renderAnswerPrompt('q', big);
    expect(p).toContain('## Context');
    expect(p).toContain('[context truncated]');
    expect(p.length).toBeLessThan(30_000);
  });
});

describe('renderCritiquePrompt — cross only', () => {
  it('shows the peer answers passed in and asks for agree/concern/refine notes', () => {
    const p = renderCritiquePrompt('q', [answer('grok', 'gr'), answer('claude', 'cl')]);
    expect(p).toContain('[grok]');
    expect(p).toContain('[claude]');
    expect(p).toContain('candid participant');
    expect(p).toContain('"notes"');
    // The caller filters out the critic's own answer, so a codex critic prompt built
    // from peers-only never contains a codex-authored line.
    expect(p).not.toContain('[codex]');
  });
});

describe('renderSynthesisPrompt', () => {
  it('labels each answer by voice and asks for AGREEMENTS vs DIVERGENCES', () => {
    const p = renderSynthesisPrompt('q', [answer('codex', 'co'), answer('grok', 'gr')], []);
    expect(p).toContain('SYNTHESIZER');
    expect(p).toContain('[codex]');
    expect(p).toContain('[grok]');
    expect(p).toContain('AGREEMENTS');
    expect(p).toContain('DIVERGENCES');
    expect(p).toContain('"recommendation"');
  });
  it('folds in cross-critique notes when present, and omits the section otherwise', () => {
    const withNotes = renderSynthesisPrompt('q', [answer('codex', 'co')], [
      { notes: [{ assessment: 'weak', stance: 'concern', target: 'codex' }], ok: true, raw: '{}', summary: 's', voiceId: 'grok' },
    ]);
    expect(withNotes).toContain('Cross-critique notes');
    const without = renderSynthesisPrompt('q', [answer('codex', 'co')], []);
    expect(without).not.toContain('Cross-critique notes');
  });
  it('only includes healthy answers in the synthesis body', () => {
    const p = renderSynthesisPrompt('q', [
      answer('codex', 'co'),
      { answer: '', keyPoints: [], ok: false, raw: null, summary: '', voiceId: 'grok' },
    ], []);
    expect(p).toContain('[codex]');
    expect(p).not.toContain('[grok]');
  });
});
