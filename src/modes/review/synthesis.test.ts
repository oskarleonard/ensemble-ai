import { describe, expect, it } from 'vitest';

import type { ReviewFinding } from '../../core/types';

import {
  fallbackReviewSynthesis,
  parseReviewSynthesis,
  reconcileSynthesis,
  renderReviewSynthesisPrompt,
  type ReviewSynthesis,
  type VoiceReview,
} from './synthesis';

function synth(over: Partial<ReviewSynthesis> = {}): ReviewSynthesis {
  return {
    agreements: [],
    bottomLine: 'bl',
    by: 'claude',
    degraded: false,
    disagreements: [],
    ok: true,
    raw: null,
    sanityChecks: [],
    summary: 's',
    ...over,
  };
}

function finding(over: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    body: 'the body',
    confidence: 'high',
    evidence: { file: 'src/foo.ts', line: 12 },
    id: 'f1',
    severity: 'high',
    title: 'null deref in foo',
    ...over,
  };
}

function review(voiceId: string, over: Partial<VoiceReview> = {}): VoiceReview {
  return { findings: [finding()], ok: true, summary: `${voiceId} read`, voiceId, ...over };
}

// A conforming synthesizer reply (the shape the STRICT prompt asks for).
const SYNTH = JSON.stringify({
  agreements: [{ point: 'null deref in foo', voices: ['codex', 'grok'] }],
  bottomLine: 'safe to merge after the null-deref fix',
  disagreements: [{ point: 'style nit', positions: ['grok: real', 'claude: false positive'] }],
  sanityChecks: [
    { finding: 'null deref in foo', note: 'two voices concur', verdict: 'likely-real' },
    { finding: 'style nit', note: 'cosmetic', verdict: 'likely-false' },
  ],
  summary: 'mostly fine, one real bug',
});

describe('renderReviewSynthesisPrompt', () => {
  it('embeds each healthy voice + its findings, and states review-only + the strict JSON contract', () => {
    const prompt = renderReviewSynthesisPrompt([
      review('codex'),
      review('grok', { findings: [] }),
      review('claude', { ok: false }),
    ]);
    expect(prompt).toContain('[codex]');
    expect(prompt).toContain('[grok]');
    // ok:false voices are not shown as findings
    expect(prompt).not.toContain('[claude]');
    expect(prompt).toContain('src/foo.ts:12');
    expect(prompt).toContain('SYNTHESIZER');
    expect(prompt).toMatch(/do NOT propose editing the code/i);
    expect(prompt).toContain('```json');
    expect(prompt).toContain('bottomLine');
  });
});

describe('parseReviewSynthesis — structure over injected output', () => {
  it('parses agreements / disagreements / sanityChecks / bottomLine deterministically', () => {
    const p = parseReviewSynthesis(`prose before\n\`\`\`json\n${SYNTH}\n\`\`\`\nprose after`);
    expect(p.parseError).toBeUndefined();
    expect(p.agreements).toEqual([{ point: 'null deref in foo', voices: ['codex', 'grok'] }]);
    expect(p.disagreements[0].positions).toEqual(['grok: real', 'claude: false positive']);
    expect(p.sanityChecks.map((s) => s.verdict)).toEqual(['likely-real', 'likely-false']);
    expect(p.bottomLine).toMatch(/safe to merge/);
  });

  it('coerces an unknown sanity verdict to look-closer and drops malformed entries', () => {
    const raw = JSON.stringify({
      bottomLine: 'bl',
      sanityChecks: [
        { finding: 'x', verdict: 'nonsense' },
        { verdict: 'likely-real' }, // no finding → dropped
        'garbage',
      ],
    });
    const p = parseReviewSynthesis(raw);
    expect(p.sanityChecks).toEqual([{ finding: 'x', note: '', verdict: 'look-closer' }]);
  });

  it('flags a reply with neither bottomLine nor summary as a parseError (→ fallback)', () => {
    expect(parseReviewSynthesis('{"agreements":[]}').parseError).toBeTruthy();
    expect(parseReviewSynthesis('no json here').parseError).toBeTruthy();
  });
});

describe('fallbackReviewSynthesis — deterministic, flagged degraded', () => {
  it('lists each healthy voice\'s findings with NO agreement claim + degraded=true', () => {
    const fb = fallbackReviewSynthesis([
      review('codex'),
      review('grok', { findings: [finding({ title: 'other bug', evidence: { file: 'b.ts' } })] }),
      review('claude', { ok: false }),
    ]);
    expect(fb.degraded).toBe(true);
    expect(fb.ok).toBe(false);
    expect(fb.agreements).toEqual([]);
    // one disagreement per healthy voice's finding, crediting the voice
    expect(fb.disagreements).toHaveLength(2);
    expect(fb.disagreements[0].positions[0]).toContain('codex');
    expect(fb.bottomLine).toMatch(/Synthesizer unavailable/i);
  });

  it('says so plainly when no voice produced a usable review', () => {
    const fb = fallbackReviewSynthesis([review('codex', { ok: false })]);
    expect(fb.disagreements).toEqual([]);
    expect(fb.summary).toMatch(/No reviews/i);
  });
});

describe('reconcileSynthesis — no invented consensus (validate vs real voices)', () => {
  const reviews = [review('codex'), review('grok')];

  it('keeps a genuine agreement (≥2 real concurring voices), stripping only phantom ids', () => {
    const { synthesis, demoted } = reconcileSynthesis(
      synth({ agreements: [{ point: 'real bug', voices: ['codex', 'grok', 'phantom'] }] }),
      reviews
    );
    expect(demoted).toBe(0);
    expect(synthesis.agreements).toEqual([{ point: 'real bug', voices: ['codex', 'grok'] }]);
  });

  it('demotes an agreement crediting a voice that never reviewed (phantom consensus)', () => {
    const { synthesis, demoted } = reconcileSynthesis(
      synth({ agreements: [{ point: 'fabricated', voices: ['codex', 'claude'] }] }),
      reviews // claude never reviewed
    );
    expect(demoted).toBe(1);
    expect(synthesis.agreements).toEqual([]);
    expect(synthesis.disagreements[0].point).toBe('fabricated');
    expect(synthesis.disagreements[0].positions).toEqual(['codex: raised']);
  });

  it('demotes an agreement with no corroborating voice at all', () => {
    const { synthesis } = reconcileSynthesis(
      synth({ agreements: [{ point: 'unsupported', voices: [] }] }),
      reviews
    );
    expect(synthesis.agreements).toEqual([]);
    expect(synthesis.disagreements[0].positions[0]).toMatch(/unverified/i);
  });

  it('matches voice ids case-insensitively', () => {
    const { demoted } = reconcileSynthesis(
      synth({ agreements: [{ point: 'p', voices: ['CODEX', 'Grok'] }] }),
      reviews
    );
    expect(demoted).toBe(0);
  });

  it('leaves a degraded (deterministic) synthesis untouched', () => {
    const d = synth({ agreements: [{ point: 'p', voices: ['x'] }], degraded: true });
    expect(reconcileSynthesis(d, reviews)).toEqual({ synthesis: d, demoted: 0 });
  });
});
