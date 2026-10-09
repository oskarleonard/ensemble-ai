import { describe, expect, it } from 'vitest';

import { VOICE_DEFAULTS, type VoiceRunResult } from '../brainstorm/voices';

import { runConsultMode } from './index';
import type { VoiceConfig, VoiceId } from './types';

// Hugin spec doc-review-evidence §3, principle 1: EVERY call — answer, critique, synthesis, debate,
// judge — carries the evidence root. Never a per-round choice.
const ANS = (s: string) => `\`\`\`json\n{"summary":"${s}","answer":"reasoned ${s}","keyPoints":["a","b"]}\n\`\`\``;
const CRIT = '{"summary":"cs","notes":[{"target":"codex","stance":"concern","assessment":"doubt"}]}';
const SYNTH = '{"summary":"h","agreements":[],"divergences":[{"point":"scale","positions":["codex: now","claude: later"]}],"recommendation":"do X"}';
const DEBATE = '{"entries":[{"splitId":"split-1","stance":"hold","position":"now","evidence":[{"source":"doc §1","quote":"q","bearing":"b"}],"rebuttal":"r"}]}';
const JUDGE = '{"rulings":[{"splitId":"split-1","outcome":"judgement","direction":"d","why":"w","evidenceCited":["codex: doc §1"]}],"recommendation":"final","summary":"s"}';

describe('consult --evidence-root — every call carries the root', () => {
  it('answer, critique, synthesis, debate and judge adapters all receive evidenceRoot', async () => {
    const roots: string[] = [];
    const adapter = (id: VoiceId) => async (prompt: string, _c: VoiceConfig, o?: { evidenceRoot?: string }): Promise<VoiceRunResult> => {
      roots.push(o?.evidenceRoot ?? 'MISSING');
      const raw = prompt.includes('You are the JUDGE') ? JUDGE : prompt.includes('evidence DEBATE') ? DEBATE : prompt.includes('SYNTHESIZER') ? SYNTH : prompt.includes('candid participant') ? CRIT : ANS(id);
      return { ok: true, raw, stderrTail: '', timedOut: false };
    };
    const r = await runConsultMode({
      adapters: { claude: adapter('claude'), codex: adapter('codex'), grok: adapter('grok') },
      critique: true,
      debate: { rounds: 1, judge: 'grok' },
      evidenceRoot: '/private/tmp/evidence/runs/x',
      question: 'X or Y?',
      voiceConfigs: VOICE_DEFAULTS,
      voices: ['codex', 'claude', 'grok'],
    });
    expect(roots.length).toBeGreaterThanOrEqual(7); // 3 answers + 3 critiques + synthesis (+ debate + judge)
    expect(roots.every((x) => x === '/private/tmp/evidence/runs/x')).toBe(true);
    expect(r.answers.every((a) => a.ok)).toBe(true);
  });
});
