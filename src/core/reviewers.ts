import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REVIEWER_IDS, type ReviewerConfig, type ReviewerId } from './types';

// Reviewers are CONFIG, not a hardcode — one JSON file controls every
// cross-vendor reviewer, editable by hand or an agent; adding a third vendor
// later is a new entry, not a code change. Read from a JSON file
// (env-overridable), falling back to a baked default so the primitive works
// before the file exists. Default: Codex on gpt-5.5 @ xhigh; Grok on grok-4.6
// @ xhigh under the deny-by-default `ensemble-review` sandbox.
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
  // Grok (xAI) — the second cross-vendor lens. grok-4.6 (2026-08-12) is the
  // current xAI flagship, and it added `xhigh` reasoning effort (grok-4.5 topped
  // out at high) — vendor seats run vendor-max, so the default rides both. A
  // retired model id fails every review at the tail with "unknown model id"
  // (grok-build did this ~2026-07): when a grok review reports failed-reviewer
  // with NO raw output, check `grok models` first. `sandbox` names the
  // OS-enforced read-only profile it runs under (kernel-blocked writes +
  // secret-read deny — see reviewers/grok.ts).
  grok: {
    cmd: 'grok',
    effort: 'xhigh',
    id: 'grok',
    model: 'grok-4.6',
    sandbox: 'ensemble-review',
    vendor: 'xai',
  },
  // Claude (Anthropic) — the capability-fenced peer (spec 2026-07-09 §3's ONE
  // Claude producer, as a registry seat; fence in modes/review/claude.ts). Default
  // matches the CLI claude layer's bar: opus @ max. It is the one EFFORT-ELASTIC
  // seat (it rides the operator's own Anthropic subscription — consumers may step
  // its effort down per diff); the vendor seats above stay at vendor-max always.
  claude: {
    cmd: 'claude',
    effort: 'max',
    id: 'claude',
    model: 'opus',
    vendor: 'anthropic',
  },
};

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

// An ISO instant, or undefined. Junk (a non-string, an unparseable date, nothing at
// all) is DROPPED rather than kept — a garbled window must never switch a seat off by
// accident. The value is stored as the operator wrote it (the parse only proves it is
// a date), so a surface can render the original string.
function isoInstant(v: unknown): string | undefined {
  const value = typeof v === 'string' ? v.trim() : '';
  return Number.isNaN(Date.parse(value)) ? undefined : value;
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
    // The two off-switches are the ONE case where config may subtract a seat, so they
    // are read STRICTLY: `enabled` only when it is a literal boolean, `disabledUntil`
    // only when it parses as a date. Anything else drops the field and the seat stays
    // ON — the same "junk can never silently disable a reviewer" rule as the rest of
    // this parse, now that disabling is a thing config can legitimately say.
    const enabled = typeof r.enabled === 'boolean' ? r.enabled : undefined;
    const disabledUntil = isoInstant(r.disabledUntil);
    out[id] = {
      cmd: str(r.cmd, REVIEWER_DEFAULTS[id].cmd),
      effort: str(r.effort, REVIEWER_DEFAULTS[id].effort),
      id,
      model: str(r.model, REVIEWER_DEFAULTS[id].model),
      vendor: str(r.vendor, REVIEWER_DEFAULTS[id].vendor),
      ...(sandbox ? { sandbox } : {}),
      ...(disabledUntil === undefined ? {} : { disabledUntil }),
      ...(enabled === undefined ? {} : { enabled }),
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

// Is ONE seat switched off at `now`? The rule, in one place: a seat is off when it is
// explicitly `enabled: false` (the indefinite switch) OR it is inside its
// `disabledUntil` quota window. The window expiring turns the seat back on with no
// restore step; `enabled: false` does not expire.
function seatOff(config: ReviewerConfig | undefined, now: Date): boolean {
  if (config?.enabled === false) return true;
  // No window, or an unparseable one a hand-built config carried (parseReviewers drops
  // junk before it can get here), parses to NaN — and every comparison against NaN is
  // false, so neither can ever read as an off-switch.
  return now.getTime() < Date.parse(config?.disabledUntil ?? '');
}

// THE ONE OWNER of "which reviewer seats are on". Every fan-out, every required-seat
// set, and every UI that greys a seat reads this — a second predicate anywhere would
// let a fired review and the gate that grades it disagree about who was supposed to
// run. Returns ids in canonical REVIEWER_IDS order. An operator switching a seat off
// is NOT a missing reviewer: the set this returns IS the roster the run is judged by.
export function enabledReviewerIds(
  config: Record<ReviewerId, ReviewerConfig>,
  now: Date = new Date()
): ReviewerId[] {
  return REVIEWER_IDS.filter((id) => !seatOff(config[id], now));
}
