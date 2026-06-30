import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REVIEWER_IDS, type ReviewerConfig, type ReviewerId } from './types';

// Reviewers are CONFIG, not a hardcode — one JSON file controls every
// cross-vendor reviewer, editable by hand or an agent; adding a third vendor
// later is a new entry, not a code change. Read from a JSON file
// (env-overridable), falling back to a baked default so the primitive works
// before the file exists. Default: Codex on gpt-5.5 @ xhigh; Grok on grok-build
// @ high under the deny-by-default `ensemble-review` sandbox.
export const REVIEWERS_FILE =
  process.env.ENSEMBLE_REVIEWERS_FILE ||
  path.join(os.homedir(), '.ensemble-ai', 'reviewers.json');

export const REVIEWER_DEFAULTS: Record<ReviewerId, ReviewerConfig> = {
  codex: {
    cmd: 'codex',
    effort: 'xhigh',
    id: 'codex',
    model: 'gpt-5.5',
    vendor: 'openai',
  },
  // Grok (xAI) — the second cross-vendor lens. grok-build is the stronger of the
  // two CLI-available models; `sandbox` names the OS-enforced read-only profile it
  // runs under (kernel-blocked writes + secret-read deny — see reviewers/grok.ts).
  grok: {
    cmd: 'grok',
    effort: 'high',
    id: 'grok',
    model: 'grok-build',
    sandbox: 'ensemble-review',
    vendor: 'xai',
  },
};

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

// Defensive parse: trust only well-formed per-reviewer overrides; anything
// malformed falls back to the baked default for that id — a junk config can
// never silently disable a reviewer or inject a bad model string.
export function parseReviewers(
  raw: unknown
): Record<ReviewerId, ReviewerConfig> {
  const out: Record<ReviewerId, ReviewerConfig> = { ...REVIEWER_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as Record<string, unknown>;
  for (const id of REVIEWER_IDS) {
    const e = o[id];
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    // sandbox is optional (only CLI-sandboxing reviewers carry it); keep it off
    // the object entirely when neither the override nor the default supplies one,
    // so a junk value can never weaken a reviewer that has no sandbox concept.
    const sandbox = str(r.sandbox, REVIEWER_DEFAULTS[id].sandbox ?? '');
    out[id] = {
      cmd: str(r.cmd, REVIEWER_DEFAULTS[id].cmd),
      effort: str(r.effort, REVIEWER_DEFAULTS[id].effort),
      id,
      model: str(r.model, REVIEWER_DEFAULTS[id].model),
      vendor: str(r.vendor, REVIEWER_DEFAULTS[id].vendor),
      ...(sandbox ? { sandbox } : {}),
    };
  }
  return out;
}

export function loadReviewers(
  file: string = REVIEWERS_FILE
): Record<ReviewerId, ReviewerConfig> {
  try {
    return parseReviewers(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...REVIEWER_DEFAULTS };
  }
}

export function resolveReviewer(
  id: ReviewerId,
  file: string = REVIEWERS_FILE
): ReviewerConfig {
  return loadReviewers(file)[id] ?? REVIEWER_DEFAULTS[id];
}

export function listReviewers(file: string = REVIEWERS_FILE): ReviewerConfig[] {
  const all = loadReviewers(file);
  return REVIEWER_IDS.map((id) => all[id]);
}
