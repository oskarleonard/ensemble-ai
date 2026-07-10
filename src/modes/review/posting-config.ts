import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { SEVERITIES, type Severity } from '../../core/types';

import type { ReviewProfile } from './profile';

// THE POSTING POSTURE — per-profile thresholds, read from CONSUMER CONFIG (spec §6, §Open's
// "posture config surface"). Thresholds are the consumer's to tune; the HARD CAPS are the
// engine's and are clamped here, so no config file can turn a staged review into a nag.
//
// ~/.ensemble-ai/config.json:
//   { "posting": { "code":     { "suggestionCap": 3, "maxSuggestionLines": 6, "inlineSeverityFloor": "low" },
//                  "security": { "suggestionCap": 0 } } }
//
// Absent / malformed ⇒ the built-in defaults, exactly as if no file existed. A posting posture is
// never a security boundary — it is a SOCIAL budget on someone else's pull request.

export interface PostingPosture {
  // The lowest severity that earns an INLINE comment. Anything below it is real, and still posts —
  // in the summary body, not on the author's line. Default `low` ⇒ every verified bug goes inline.
  inlineSeverityFloor: Severity;
  // Max LINES in one ```suggestion``` block. A longer replacement is not a "small verified fix".
  maxSuggestionLines: number;
  // Max ```suggestion``` blocks in ONE review. Spec §6 caps this at 2–3 — one-click apply is a
  // gift, not a nag — so SUGGESTION_HARD_CAP clamps whatever the config asks for.
  suggestionCap: number;
}

// The engine's own ceiling on `suggestionCap`. Spec §6: "capped at 2–3 per review". Config may
// lower it (0 disables suggestions entirely); it can never raise it.
export const SUGGESTION_HARD_CAP = 3;
const MAX_SUGGESTION_LINES_CEILING = 10;

export const DEFAULT_POSTURE: PostingPosture = {
  inlineSeverityFloor: 'low',
  maxSuggestionLines: 6,
  suggestionCap: SUGGESTION_HARD_CAP,
};

function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, Math.trunc(v)));
}

function parseSeverityFloor(v: unknown, fallback: Severity): Severity {
  return typeof v === 'string' && (SEVERITIES as readonly string[]).includes(v)
    ? (v as Severity)
    : fallback;
}

// PURE: fold one raw config object into a posture, clamping every field. Exported so the clamping
// is testable without touching the filesystem.
export function resolvePosture(raw: unknown): PostingPosture {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_POSTURE };
  const o = raw as Record<string, unknown>;
  return {
    inlineSeverityFloor: parseSeverityFloor(o.inlineSeverityFloor, DEFAULT_POSTURE.inlineSeverityFloor),
    maxSuggestionLines: clampInt(o.maxSuggestionLines, 1, MAX_SUGGESTION_LINES_CEILING, DEFAULT_POSTURE.maxSuggestionLines),
    suggestionCap: clampInt(o.suggestionCap, 0, SUGGESTION_HARD_CAP, DEFAULT_POSTURE.suggestionCap),
  };
}

// Read the posture for one profile from the consumer's config. Unreadable / absent / malformed ⇒
// the defaults (an ensemble-ai user with no config file must still be able to stage a review).
export function loadPostingPosture(
  profile: ReviewProfile,
  configPath = path.join(os.homedir(), '.ensemble-ai', 'config.json')
): PostingPosture {
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as { posting?: Record<string, unknown> };
    return resolvePosture(raw.posting?.[profile]);
  } catch {
    return { ...DEFAULT_POSTURE };
  }
}

// Is `severity` at least as severe as the floor? SEVERITIES is ordered most-severe-first, so a
// LOWER index is MORE severe.
export function meetsInlineFloor(severity: Severity, floor: Severity): boolean {
  return SEVERITIES.indexOf(severity) <= SEVERITIES.indexOf(floor);
}
