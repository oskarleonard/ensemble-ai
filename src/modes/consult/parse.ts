import { extractJsonBlock, oneOf } from '../../core/findings';

import {
  type AgreementPoint,
  type AnswerNote,
  CRITIQUE_STANCES,
  type CritiqueStance,
  type DivergencePoint,
} from './types';

// Parse the voices' replies into typed shapes. Defensive at element granularity (a
// malformed entry is dropped, never trusted) and lenient on the envelope: a reply
// with no conforming JSON returns a parseError so the orchestrator records the voice
// FAILED, rather than silently treating prose as an empty answer. Reuses the review
// engine's extractJsonBlock (prefer the last fenced block, else the widest {…} span).

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function asStance(v: unknown): CritiqueStance {
  return oneOf(CRITIQUE_STANCES, v, 'concern');
}

// A string[] field: drop non-string/empty entries, dedupe. Used for keyPoints and the
// synthesis voices/positions lists.
function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.map(str).filter(Boolean))];
}

export interface ParsedAnswer {
  answer: string;
  keyPoints: string[];
  parseError?: string;
  summary: string;
}

export function parseAnswer(raw: string): ParsedAnswer {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== 'object') {
    return { answer: '', keyPoints: [], parseError: 'no parseable JSON block in the output', summary: '' };
  }
  const o = obj as Record<string, unknown>;
  const summary = str(o.summary);
  const answer = str(o.answer);
  const keyPoints = strList(o.keyPoints);
  // A conforming answer carries at least a summary or an answer body. A reply with
  // NEITHER — `{}`, an error blob like `{"error":"quota"}`, or prose that parsed to
  // the wrong braces — is not an answer: return a parseError so the orchestrator
  // records the voice FAILED, never a falsely "ok" empty answer that feeds synthesis.
  if (!summary && !answer) {
    return { answer: '', keyPoints, parseError: 'output has no "answer" or "summary"', summary: '' };
  }
  return { answer, keyPoints, summary };
}

export interface ParsedCritique {
  notes: AnswerNote[];
  parseError?: string;
  summary: string;
}

export function parseCritique(raw: string): ParsedCritique {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== 'object') {
    return { notes: [], parseError: 'no parseable JSON block in the output', summary: '' };
  }
  const o = obj as Record<string, unknown>;
  const summary = str(o.summary);
  // Must carry a "notes" array (even if empty — a genuine "nothing to add"). A reply
  // with no notes array at all is not a critique → parseError, so a failed voice
  // never reads as an "ok" empty critique.
  if (!Array.isArray(o.notes)) {
    return { notes: [], parseError: 'output has no "notes" array', summary };
  }
  const notes: AnswerNote[] = [];
  for (const rn of o.notes) {
    if (!rn || typeof rn !== 'object') continue;
    const n = rn as Record<string, unknown>;
    const target = str(n.target);
    const assessment = str(n.assessment);
    if (!target && !assessment) continue;
    notes.push({ assessment, stance: asStance(n.stance), target: target || '(unspecified)' });
  }
  return { notes, summary };
}

export interface ParsedConsultSynthesis {
  agreements: AgreementPoint[];
  divergences: DivergencePoint[];
  parseError?: string;
  recommendation: string;
  summary: string;
}

function parseAgreements(v: unknown): AgreementPoint[] {
  if (!Array.isArray(v)) return [];
  const out: AgreementPoint[] = [];
  for (const ra of v) {
    if (!ra || typeof ra !== 'object') continue;
    const a = ra as Record<string, unknown>;
    const point = str(a.point);
    if (!point) continue;
    out.push({ point, voices: strList(a.voices) });
  }
  return out;
}

function parseDivergences(v: unknown): DivergencePoint[] {
  if (!Array.isArray(v)) return [];
  const out: DivergencePoint[] = [];
  for (const rd of v) {
    if (!rd || typeof rd !== 'object') continue;
    const d = rd as Record<string, unknown>;
    const point = str(d.point);
    if (!point) continue;
    out.push({ point, positions: strList(d.positions) });
  }
  return out;
}

export function parseConsultSynthesis(raw: string): ParsedConsultSynthesis {
  const obj = extractJsonBlock(raw);
  if (!obj || typeof obj !== 'object') {
    return {
      agreements: [],
      divergences: [],
      parseError: 'no parseable JSON block in the output',
      recommendation: '',
      summary: '',
    };
  }
  const o = obj as Record<string, unknown>;
  const summary = str(o.summary);
  const recommendation = str(o.recommendation);
  const agreements = parseAgreements(o.agreements);
  const divergences = parseDivergences(o.divergences);
  // A usable synthesis has at least a recommendation or a summary — the agree/diverge
  // lists may legitimately be empty (one voice, or total concurrence). With NEITHER a
  // recommendation NOR a summary the reply is not a synthesis → parseError → fallback.
  if (!recommendation && !summary) {
    return {
      agreements,
      divergences,
      parseError: 'output has no "recommendation" or "summary"',
      recommendation: '',
      summary: '',
    };
  }
  return { agreements, divergences, recommendation, summary };
}
