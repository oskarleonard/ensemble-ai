import { describe, expect, it } from 'vitest';

import { VOICE_DEFAULTS, type VoiceRunResult } from '../brainstorm/voices';

import { runConsultMode } from './index';
import type { VoiceConfig, VoiceId } from './types';

// The result JSON names WHY a voice died (hugin spec doc-review-evidence §5): the watchdog that
// fired, the named error, and the seat's last activity — so a board never again shows a bare
// "timed out" (run 2026-10-08-19-32-31, where that was the whole explanation).

const ANS = (s: string) => `\`\`\`json\n{"summary":"${s}","answer":"reasoned ${s}","keyPoints":["a","b"]}\n\`\`\``;
const SYNTH = '{"summary":"h","agreements":[{"point":"use X","voices":["codex","claude"]}],"divergences":[],"recommendation":"do X"}';

function adapters(grokReply: VoiceRunResult) {
  const okReply = (raw: string): VoiceRunResult => ({ ok: true, raw, stderrTail: '', timedOut: false });
  return {
    claude: async (prompt: string, _c: VoiceConfig) => okReply(prompt.includes('SYNTHESIZER') ? SYNTH : ANS('cl')),
    codex: async () => okReply(ANS('co')),
    grok: async () => grokReply,
  } as Record<VoiceId, (p: string, c: VoiceConfig) => Promise<VoiceRunResult>>;
}

describe('consult result — a reclaimed voice carries its reason and last activity', () => {
  it('inactivity: error is the named stall, timedOutReason + tail ride the answer', async () => {
    const r = await runConsultMode({
      adapters: adapters({
        failWhy: 'stalled: no stream output for 10 min (wedged seat reclaimed)',
        ok: false,
        raw: null,
        stderrTail: '',
        stream: 'assistant: WebSearch · assistant',
        timedOut: true,
        timedOutReason: 'inactivity',
      }),
      question: 'X or Y?',
      voiceConfigs: VOICE_DEFAULTS,
    });
    const grok = r.answers.find((a) => a.voiceId === 'grok')!;
    expect(grok.ok).toBe(false);
    expect(grok.error).toMatch(/^stalled: no stream output/);
    expect(grok.timedOut).toBe(true);
    expect(grok.timedOutReason).toBe('inactivity');
    expect(grok.tail).toBe('assistant: WebSearch · assistant');
    // The others are untouched, and a healthy answer carries none of the failure fields.
    const codex = r.answers.find((a) => a.voiceId === 'codex')!;
    expect(codex.ok).toBe(true);
    expect(codex.timedOutReason).toBeUndefined();
    expect(codex.tail).toBeUndefined();
  });

  it('absolute: the backstop is named as such (the seat was working — give it budget)', async () => {
    const r = await runConsultMode({
      adapters: adapters({
        failWhy: 'still working when the 60-min backstop cut it — give it budget',
        ok: false,
        raw: null,
        stderrTail: 'last stderr line',
        timedOut: true,
        timedOutReason: 'absolute',
      }),
      question: 'X or Y?',
      voiceConfigs: VOICE_DEFAULTS,
    });
    const grok = r.answers.find((a) => a.voiceId === 'grok')!;
    expect(grok.timedOutReason).toBe('absolute');
    expect(grok.error).toMatch(/backstop/);
    // No stream → the stderr tail is what the seat left behind.
    expect(grok.tail).toBe('last stderr line');
  });
});
