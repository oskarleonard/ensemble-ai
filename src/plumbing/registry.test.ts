import { describe, expect, it } from 'vitest';

import type { ReviewerConfig } from '../core/types';
import type { VoiceConfig } from '../modes/brainstorm/types';

import { offSeatsOf, renderRegistry, type RegistryView } from './registry';

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
    enabledReviewerIds: ['codex', 'grok'],
    gate: { effort: 'default', effortSource: 'default', model: 'default', modelSource: 'default' },
    holistic: { effort: 'high', model: 'opus' },
    offSeats: [],
    reviewers,
    reviewersFile: '/home/x/.ensemble-ai/reviewers.json',
    reviewersFileExists: true,
    voices,
    voicesFile: '/home/x/.ensemble-ai/voices.json',
    voicesFileExists: true,
    ...over,
  };
}

describe('offSeatsOf', () => {
  const cfg = {
    claude: { cmd: 'claude', effort: 'max', id: 'claude', model: 'opus', vendor: 'anthropic' },
    codex: { cmd: 'codex', effort: 'xhigh', enabled: false, id: 'codex', model: 'gpt-5.5', vendor: 'openai' },
    grok: { cmd: 'grok', disabledUntil: '2099-01-01T00:00:00Z', effort: 'high', id: 'grok', model: 'grok-4.5', vendor: 'xai' },
  } as const;

  it('lists every seat the enabled set leaves out, with its window only when the window holds it off', () => {
    expect(offSeatsOf(cfg, ['claude'])).toEqual([
      { id: 'codex', until: null },
      { id: 'grok', until: '2099-01-01T00:00:00Z' },
    ]);
  });

  it('an enabled:false seat that also carries a date reports null — the date is not what holds it off', () => {
    const both = { ...cfg, codex: { ...cfg.codex, disabledUntil: '2099-01-01T00:00:00Z' } };
    expect(offSeatsOf(both, ['claude', 'grok'])).toEqual([{ id: 'codex', until: null }]);
  });

  it('nothing off → empty', () => {
    expect(offSeatsOf(cfg, ['codex', 'grok', 'claude'])).toEqual([]);
  });
});

describe('renderRegistry', () => {
  it('marks a switched-off seat on its own row and prints who is on', () => {
    const out = renderRegistry(
      view({
        enabledReviewerIds: ['codex'],
        offSeats: [{ id: 'grok', until: '2099-01-01T00:00:00Z' }],
      })
    );
    expect(out).toContain('grok    xai · grok-4.5 @ high · sandbox ensemble-review · OFF until 2099-01-01T00:00:00Z');
    expect(out).toContain('on right now: codex');
    expect(out).not.toContain('codex   openai · gpt-5.5 @ xhigh · OFF');
  });

  it('an indefinite switch says so, and an all-off roster says NONE', () => {
    const out = renderRegistry(
      view({ enabledReviewerIds: [], offSeats: [{ id: 'codex', until: null }, { id: 'grok', until: null }] })
    );
    expect(out).toContain('OFF (enabled: false)');
    expect(out).toContain('on right now: NONE — every seat is switched off');
  });

  it('with every seat on, the roster block is byte-identical to before (no "on right now" line)', () => {
    expect(renderRegistry(view())).not.toContain('on right now');
  });

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

  it('an invalid gate advisor marks only the advisor — the resolved vendor, model, effort and sources stay', () => {
    const gateLine = renderRegistry(
      view({ gate: { advisor: null, effort: 'max', effortSource: 'file', model: 'fable', modelSource: 'file' } })
    )
      .split('\n')
      .find((l) => l.trimStart().startsWith('gate'))!;
    expect(gateLine).toContain('anthropic · fable @ max · advisor null (INVALID');
    expect(gateLine).toContain('source model:file · effort:file');
  });
});

describe('renderRegistry — the holistic lens row', () => {
  const holisticLine = (holistic: RegistryView['holistic']): string =>
    renderRegistry(view({ holistic }))
      .split('\n')
      .find((l) => l.startsWith('    holistic '))!;

  it('a valid advisor is shown beside the lens model and effort', () => {
    expect(holisticLine({ advisor: 'claude-fable-5-1', effort: 'max', model: 'fable' })).toBe(
      '    holistic anthropic · fable @ max · advisor claude-fable-5-1'
    );
  });

  it('an absent advisor shows nothing (the lens inherits the operator setting)', () => {
    expect(holisticLine({ effort: 'high', model: 'opus' })).toBe('    holistic anthropic · opus @ high');
  });

  it('an invalid advisor is shown as written and marked, the model and effort kept', () => {
    expect(holisticLine({ advisor: 7, effort: 'high', model: 'opus' })).toBe(
      '    holistic anthropic · opus @ high · advisor 7 (INVALID — a command that runs this seat refuses it)'
    );
  });
});
