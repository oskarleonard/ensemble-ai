import { describe, expect, it } from 'vitest';

import type { ReviewerConfig } from '../core/types';
import type { VoiceConfig } from '../modes/brainstorm/types';

import { renderRegistry, type RegistryView } from './registry';

const reviewers: ReviewerConfig[] = [
  { cmd: 'codex', effort: 'xhigh', id: 'codex', model: 'gpt-5.5', vendor: 'openai' },
  { cmd: 'grok', effort: 'high', id: 'grok', model: 'grok-4.5', sandbox: 'ensemble-review', vendor: 'xai' },
];
const voices: VoiceConfig[] = [
  { cmd: 'codex', effort: 'high', id: 'codex', model: 'gpt-5.5', vendor: 'openai' },
  { cmd: 'grok', effort: 'high', id: 'grok', model: 'grok-4.5', sandbox: 'ensemble-review', vendor: 'xai' },
  { cmd: 'claude', effort: 'default', id: 'claude', model: 'default', vendor: 'anthropic' },
];

function view(over: Partial<RegistryView> = {}): RegistryView {
  return {
    gate: { effort: 'default', effortSource: 'default', model: 'default', modelSource: 'default' },
    reviewers,
    reviewersFile: '/home/x/.ensemble-ai/reviewers.json',
    reviewersFileExists: true,
    voices,
    voicesFile: '/home/x/.ensemble-ai/voices.json',
    voicesFileExists: true,
    ...over,
  };
}

describe('renderRegistry', () => {
  it('lists every reviewer + voice with vendor · model · effort', () => {
    const out = renderRegistry(view());
    // reviewers
    expect(out).toContain('openai · gpt-5.5 @ xhigh');
    // voices (claude joins the voice roster)
    expect(out).toContain('anthropic · default @ default');
    // all ids present
    for (const id of ['codex', 'grok', 'claude']) expect(out).toContain(id);
  });

  it('shows the sandbox for a sandboxed agent and omits it otherwise', () => {
    const out = renderRegistry(view());
    expect(out).toContain('sandbox ensemble-review');
    // codex has no sandbox → its line must not carry the sandbox suffix
    const codexLine = out.split('\n').find((l) => l.includes('gpt-5.5 @ xhigh'))!;
    expect(codexLine).not.toContain('sandbox');
  });

  it('names the config source, flagging baked defaults when a file is absent', () => {
    const out = renderRegistry(view({ reviewersFileExists: false }));
    expect(out).toContain('/home/x/.ensemble-ai/reviewers.json — not present, using baked defaults');
    // the present voices file shows its path with no "not present" note
    expect(out).toContain('config: /home/x/.ensemble-ai/voices.json');
    expect(out).not.toContain('voices.json — not present');
  });

  it('renders the review-synthesis GATE seat with model · effort · per-field source', () => {
    const out = renderRegistry(
      view({ gate: { effort: 'max', effortSource: 'file', model: 'fable', modelSource: 'file' } })
    );
    expect(out).toContain('review synthesis');
    const gateLine = out.split('\n').find((l) => l.trimStart().startsWith('gate'))!;
    expect(gateLine).toContain('anthropic · fable @ max');
    expect(gateLine).toContain('source model:file · effort:file');
  });

  it('shows the built-in default gate seat (Opus) with default sources when unconfigured', () => {
    const gateLine = renderRegistry(view())
      .split('\n')
      .find((l) => l.trimStart().startsWith('gate'))!;
    expect(gateLine).toContain('anthropic · default @ default');
    expect(gateLine).toContain('model:default · effort:default');
  });
});
