import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseSeatAdvisor, type ReviewerConfig } from '../../core/types';
import {
  type CodexReviewResult,
  type RunReviewOpts,
  runCodexReview,
} from '../../reviewers/codex';
import { runGrokReview } from '../../reviewers/grok';

import { runClaudeVoice } from './claude';
import { type ResolvedVoiceConfig, VOICE_IDS, type VoiceConfig, type VoiceId } from './types';

// The uniform result every voice adapter returns ({ok, raw, stderrTail, timedOut}),
// shared with the review adapters — `raw` is the voice's reply, ready for the
// brainstorm parsers. Aliased so the brainstorm code never reads "review" types.
export type VoiceRunResult = CodexReviewResult;

// Which watchdog reclaimed a seat: `absolute` (still working when the runaway backstop cut it —
// give it budget) or `inactivity` (it went silent — it wedged). Carried into every mode's result
// JSON (2026-10-09) so a board can say WHY a voice died, not just that it did.
export type SeatTimeoutReason = 'absolute' | 'inactivity';

// PURE: the failure facts a mode's result carries beside `error` — whether and why the seat timed
// out, and what it was doing last (the stream tail when the seat streamed, else its stderr tail),
// bounded. Absent fields stay absent so a healthy result's JSON does not grow.
export function seatFailureMeta(res: VoiceRunResult): {
  tail?: string;
  timedOut?: boolean;
  timedOutReason?: SeatTimeoutReason;
} {
  const tail = (res.stream ?? res.stderrTail ?? '').trim().slice(-600);
  return {
    ...(res.timedOut ? { timedOut: true } : {}),
    ...(res.timedOutReason ? { timedOutReason: res.timedOutReason } : {}),
    ...(tail ? { tail } : {}),
  };
}

// The brainstorm roster default — Codex + Grok + Claude. CONFIG, not a hardcode:
// one JSON file (env-overridable) swaps any model without a code edit. codex/grok
// reuse the proven review adapters at a LIGHTER effort (ideation, not an xhigh
// audit); grok keeps the deny-by-default `ensemble-review` sandbox (the adapter
// pins it regardless — a voice still runs read-only from a throwaway cwd). Claude
// joins as a third voice with no independence concern.
// Baked defaults state no advisor (every seat inherits until configured) — so they are resolved.
export const VOICE_DEFAULTS: Record<VoiceId, ResolvedVoiceConfig> = {
  claude: {
    cmd: 'claude',
    effort: 'default',
    id: 'claude',
    model: 'default',
    vendor: 'anthropic',
  },
  codex: {
    cmd: 'codex',
    effort: 'high',
    id: 'codex',
    model: 'gpt-5.5',
    vendor: 'openai',
  },
  grok: {
    cmd: 'grok',
    effort: 'high',
    id: 'grok',
    model: 'grok-4.6',
    sandbox: 'ensemble-review',
    vendor: 'xai',
  },
};

// codex/grok adapters take a ReviewerConfig; a VoiceConfig is structurally the same
// (its id 'codex'/'grok' IS a ReviewerId). Cast at the boundary so the brainstorm
// roster can carry 'claude' without widening the review ReviewerId union.
function toReviewerConfig(c: VoiceConfig): ReviewerConfig {
  return {
    cmd: c.cmd,
    effort: c.effort,
    id: c.id as ReviewerConfig['id'],
    model: c.model,
    vendor: c.vendor,
    ...(c.sandbox ? { sandbox: c.sandbox } : {}),
  };
}

// Per-voice invocation adapters, keyed by id. EXHAUSTIVE over VoiceId — TS errors
// if a new voice joins VOICE_IDS without an adapter here. codex + grok REUSE the
// review engine's watchdog'd, group-killed spawn (a voice run IS a read-only agent
// run with a prompt → raw text); claude is a thin sibling over the same spawn
// primitive. A new voice = one entry + a thin adapter.
export const VOICE_ADAPTERS: Record<
  VoiceId,
  (
    prompt: string,
    config: VoiceConfig,
    opts?: RunReviewOpts
  ) => Promise<VoiceRunResult>
> = {
  claude: (p, c, o) => runClaudeVoice(p, c, o),
  // `web: true` on a cross-vendor voice = the vendor's own search tool (RunReviewOpts.web); it
  // rides the per-call opts so a ReviewerConfig never carries it and the review seats never see it.
  codex: (p, c, o) => runCodexReview(p, toReviewerConfig(c), { ...o, ...(c.web ? { web: true } : {}) }),
  grok: (p, c, o) => runGrokReview(p, toReviewerConfig(c), { ...o, ...(c.web ? { web: true } : {}) }),
};

export const VOICES_FILE =
  process.env.ENSEMBLE_VOICES_FILE ||
  path.join(os.homedir(), '.ensemble-ai', 'voices.json');

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' && v.trim() ? v.trim() : fallback;
}

// Defensive parse: trust only well-formed per-voice overrides; anything malformed
// falls back to the baked default for that id, so a junk config can never silently
// disable a voice or inject a bad model string. Mirrors core/reviewers parseReviewers.
// NEVER throws. The claude voice's `advisor` is the one field carried AS-IS, valid or not: its
// only fallback would be "inherit the operator's setting" (the accident the field exists to end),
// so a bad value is kept for `config` to show marked invalid and for a command that runs the
// claude voice to refuse (assertRosterAdvisors) — while a command that never runs it is
// untouched by its typo.
export function parseVoices(raw: unknown): Record<VoiceId, VoiceConfig> {
  const out: Record<VoiceId, VoiceConfig> = { ...VOICE_DEFAULTS };
  if (!raw || typeof raw !== 'object') return out;
  const o = raw as Record<string, unknown>;
  for (const id of VOICE_IDS) {
    const e = o[id];
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    const sandbox = str(r.sandbox, VOICE_DEFAULTS[id].sandbox ?? '');
    out[id] = {
      ...(id === 'claude' && r.advisor !== undefined ? { advisor: r.advisor } : {}),
      // Exactly `true` turns it on; anything else is the default (off) — never a string "yes".
      ...(r.web === true ? { web: true } : {}),
      cmd: str(r.cmd, VOICE_DEFAULTS[id].cmd),
      effort: str(r.effort, VOICE_DEFAULTS[id].effort),
      id,
      model: str(r.model, VOICE_DEFAULTS[id].model),
      vendor: str(r.vendor, VOICE_DEFAULTS[id].vendor),
      ...(sandbox ? { sandbox } : {}),
    };
  }
  return out;
}

// The JUDGE seat for `consult --debate` — voices.json `judge`: { "voice": "claude", "model":
// "…", "effort": "…" }. A voice id to spawn through, with the model/effort the ruling runs at,
// over that voice's own cmd/vendor/sandbox/advisor. The point of the override: the seat that
// rules should not be the model that argued a side. Absent or malformed = the voice's own
// config (the run then reports the judge as not independent). NEVER throws.
export interface JudgeSpec {
  effort?: string;
  model?: string;
  voice?: VoiceId;
}

export function parseJudge(raw: unknown): JudgeSpec {
  if (!raw || typeof raw !== 'object') return {};
  const j = (raw as Record<string, unknown>).judge;
  if (!j || typeof j !== 'object') return {};
  const r = j as Record<string, unknown>;
  const voice = typeof r.voice === 'string' && (VOICE_IDS as readonly string[]).includes(r.voice) ? (r.voice as VoiceId) : undefined;
  const model = typeof r.model === 'string' && r.model.trim() ? r.model.trim() : undefined;
  const effort = typeof r.effort === 'string' && r.effort.trim() ? r.effort.trim() : undefined;
  return { ...(voice ? { voice } : {}), ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
}

export function loadJudge(file: string = VOICES_FILE): JudgeSpec {
  try {
    return parseJudge(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return {};
  }
}

// The judge's VoiceConfig: the chosen voice's config with the spec's model/effort over it.
export function judgeConfig(
  spec: JudgeSpec,
  voiceId: VoiceId,
  configs: Record<VoiceId, VoiceConfig>
): VoiceConfig {
  const base = configs[voiceId];
  return { ...base, ...(spec.model ? { model: spec.model } : {}), ...(spec.effort ? { effort: spec.effort } : {}) };
}

export function loadVoices(
  file: string = VOICES_FILE
): Record<VoiceId, VoiceConfig> {
  try {
    return parseVoices(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...VOICE_DEFAULTS };
  }
}

// The up-front check of the voices a brainstorm/consult run WILL spawn (its roster — the
// synthesizer is always one of them): each one's `advisor` through the one rule, so an invalid
// value refuses the run before any voice is spawned, naming the seat — and a voice outside the
// roster is never read. `source` labels the seat (`voices.json` when the configs came from the
// file). Throws; the CLI turns the throw into exit 3.
export function assertRosterAdvisors(
  roster: readonly VoiceId[],
  configs: Record<VoiceId, VoiceConfig>,
  source?: string
): void {
  for (const id of roster) parseSeatAdvisor(configs[id]?.advisor, source ? `${source} ${id}` : id);
}

export function listVoices(file: string = VOICES_FILE): VoiceConfig[] {
  const all = loadVoices(file);
  return VOICE_IDS.map((id) => all[id]);
}
