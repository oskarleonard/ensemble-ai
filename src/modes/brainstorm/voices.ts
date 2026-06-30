import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ReviewerConfig } from '../../core/types';
import {
  type CodexReviewResult,
  type RunReviewOpts,
  runCodexReview,
} from '../../reviewers/codex';
import { runGrokReview } from '../../reviewers/grok';

import { runClaudeVoice } from './claude';
import { VOICE_IDS, type VoiceConfig, type VoiceId } from './types';

// The uniform result every voice adapter returns ({ok, raw, stderrTail, timedOut}),
// shared with the review adapters — `raw` is the voice's reply, ready for the
// brainstorm parsers. Aliased so the brainstorm code never reads "review" types.
export type VoiceRunResult = CodexReviewResult;

// The brainstorm roster default — Codex + Grok + Claude. CONFIG, not a hardcode:
// one JSON file (env-overridable) swaps any model without a code edit. codex/grok
// reuse the proven review adapters at a LIGHTER effort (ideation, not an xhigh
// audit); grok keeps the deny-by-default `ensemble-review` sandbox (the adapter
// pins it regardless — a voice still runs read-only from a throwaway cwd). Claude
// joins as a third voice with no independence concern.
export const VOICE_DEFAULTS: Record<VoiceId, VoiceConfig> = {
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
    model: 'grok-build',
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
  codex: (p, c, o) => runCodexReview(p, toReviewerConfig(c), o),
  grok: (p, c, o) => runGrokReview(p, toReviewerConfig(c), o),
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

export function loadVoices(
  file: string = VOICES_FILE
): Record<VoiceId, VoiceConfig> {
  try {
    return parseVoices(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    return { ...VOICE_DEFAULTS };
  }
}

export function listVoices(file: string = VOICES_FILE): VoiceConfig[] {
  const all = loadVoices(file);
  return VOICE_IDS.map((id) => all[id]);
}
