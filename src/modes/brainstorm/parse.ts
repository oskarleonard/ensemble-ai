import { extractJsonBlock, oneOf } from '../../core/findings';

import {
  type Critique,
  CRITIQUE_STANCES,
  type CritiqueStance,
  type RankedIdea,
  type RawIdea,
} from './types';

// Parse the voices' replies into typed shapes. Defensive at element granularity (a
// malformed idea/critique is dropped, never trusted) and lenient on the envelope:
// a reply with no parseable JSON returns a parseError so the orchestrator records
// the voice failed, rather than silently treating prose as zero ideas. Reuses the
// review engine's extractJsonBlock (prefer the last fenced block, else the widest
// {…} span) so both modes pull JSON out of chatty replies the same way.

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function asStance(v: unknown): CritiqueStance {
  return oneOf(CRITIQUE_STANCES, v, 'concern');
}

// Pull a {title, body} list out of a raw value's named array field. Drops entries
// that are wholly empty; a missing title degrades to a placeholder rather than
// dropping a real idea body.
function parseRawIdeas(arr: unknown, placeholder: string): RawIdea[] {
  if (!Array.isArray(arr)) return [];
  const out: RawIdea[] = [];
  arr.forEach((ri, i) => {
    if (!ri || typeof ri !== 'object') return;
    const r = ri as Record<string, unknown>;
    const title = str(r.title);
    const body = str(r.body);
    if (!title && !body) return;
    out.push({ body, title: title || `${placeholder} ${i + 1}` });
  });
  return out;
}

export interface ParsedIdeas {
  ideas: RawIdea[];
  parseError?: string;
  summary: string;
}

export function parseIdeas(raw: string): ParsedIdeas {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== 'object') {
    return { ideas: [], parseError: 'no parseable JSON block in the output', summary: '' };
  }
  const o = obj as Record<string, unknown>;
  const summary = str(o.summary);
  if (!Array.isArray(o.ideas)) {
    return { ideas: [], parseError: 'output has no "ideas" array', summary };
  }
  return { ideas: parseRawIdeas(o.ideas, 'Idea'), summary };
}

export interface ParsedCritique {
  critiques: Critique[];
  extensions: RawIdea[];
  parseError?: string;
  summary: string;
}

export function parseCritique(raw: string): ParsedCritique {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== 'object') {
    return {
      critiques: [],
      extensions: [],
      parseError: 'no parseable JSON block in the output',
      summary: '',
    };
  }
  const o = obj as Record<string, unknown>;
  const summary = str(o.summary);
  const critiques: Critique[] = [];
  if (Array.isArray(o.critiques)) {
    for (const rc of o.critiques) {
      if (!rc || typeof rc !== 'object') continue;
      const c = rc as Record<string, unknown>;
      const target = str(c.target);
      const assessment = str(c.assessment);
      if (!target && !assessment) continue;
      critiques.push({
        assessment,
        stance: asStance(c.stance),
        target: target || '(unspecified)',
      });
    }
  }
  return { critiques, extensions: parseRawIdeas(o.extensions, 'Extension'), summary };
}

export interface ParsedSynthesis {
  parseError?: string;
  ranked: RankedIdea[];
  summary: string;
}

function asContributors(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(str).filter(Boolean))];
}

export function parseSynthesis(raw: string): ParsedSynthesis {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== 'object') {
    return { parseError: 'no parseable JSON block in the output', ranked: [], summary: '' };
  }
  const o = obj as Record<string, unknown>;
  const summary = str(o.summary);
  if (!Array.isArray(o.ranked)) {
    return { parseError: 'output has no "ranked" array', ranked: [], summary };
  }
  const ranked: RankedIdea[] = [];
  o.ranked.forEach((rr) => {
    if (!rr || typeof rr !== 'object') return;
    const r = rr as Record<string, unknown>;
    const title = str(r.title);
    const why = str(r.why);
    if (!title && !why) return;
    const risks = str(r.risks);
    // rank is assigned from ARRAY ORDER (best-first), never trusted from the model.
    ranked.push({
      contributors: asContributors(r.contributors),
      rank: ranked.length + 1,
      title: title || `Recommendation ${ranked.length + 1}`,
      why,
      ...(risks ? { risks } : {}),
    });
  });
  return { ranked, summary };
}
