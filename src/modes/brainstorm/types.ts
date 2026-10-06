// Brainstorm mode — divergent ideation → cross-critique → synthesized
// recommendation. Vendor-neutral typed contracts, mirroring the review mode's
// "config + typed wire shapes" discipline. NO node imports — this is shared by the
// orchestrator, the prompt builders, the CLI, and the unit tests.

// The brainstorm ROSTER. Unlike the review reviewers (Codex + Grok, where Claude
// arbitrates and must stay INDEPENDENT), brainstorm adds Claude as a third VOICE —
// there is no independence concern when every voice is just contributing ideas.
export const VOICE_IDS = ['codex', 'grok', 'claude'] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

export function isVoiceId(v: unknown): v is VoiceId {
  return (VOICE_IDS as readonly string[]).includes(v as string);
}

// Parse an untrusted comma-string or array of voice ids to the known set (deduped,
// order preserved). Returns undefined when nothing valid survives, so a junk value
// degrades to "the default roster" rather than an empty run. The ONE place the
// voices field is coerced, so the leniency rule can't drift between callers.
export function parseVoiceIds(raw: unknown): VoiceId[] | undefined {
  const arr = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(',')
      : [];
  const ids = [
    ...new Set(
      arr.map((s) => (typeof s === 'string' ? s.trim() : s)).filter(isVoiceId)
    ),
  ];
  return ids.length > 0 ? ids : undefined;
}

// A voice = its CLI command + the model/effort it runs at + an optional OS-enforced
// sandbox profile (grok). Structurally a ReviewerConfig (a voice run IS a read-only
// agent run with a prompt), kept as DATA so a model is swappable without a code edit.
export interface VoiceConfig {
  // The claude seat's advisor model — a model id or "off"; absent = inherit the operator's
  // setting. `unknown` because a parsed voices.json carries WHATEVER the file says (parseVoices
  // never throws — `null` or a typo is kept, so `config` can show it marked invalid and a run
  // that spawns the seat refuses it). The rule (core/types parseSeatAdvisor) is applied where a
  // seat is about to spawn: its up-front resolution, then claudeAdvisorArgs at the spawn.
  advisor?: unknown;
  cmd: string;
  effort: string;
  id: VoiceId;
  model: string;
  sandbox?: string;
  vendor: string;
  // WEB for a VOICE (brainstorm / consult only — the review seats never read it). claude: WebSearch
  // + WebFetch, pre-approved for the headless spawn, under a turn cap (buildClaudeVoiceArgs) — the
  // fetch is the local CLI reaching an arbitrary URL, so a prompt-injected topic or file can carry
  // text out in a URL; a voice reads only the prompt and the shared file, which is why this is a
  // per-voice choice. codex / grok: the VENDOR's own search (`--search` / grok's `web_search`),
  // executed behind the API host the fence already allows — no new local egress. Off by default.
  web?: boolean;
}

// A seat config whose advisor has passed parseSeatAdvisor — what the seat resolvers (gate-seat,
// holistic) return and what the review layer's recording sites read, so a trail records a plain
// string ("off" vs absent = inherit) with no re-validation.
export type ResolvedVoiceConfig = VoiceConfig & { advisor?: string };

// One idea — a typed unit so critique + synthesis can reference it stably. `id` is
// assigned by the orchestrator (e.g. `codex-1`); `voiceId` records its author.
export interface Idea {
  body: string;
  id: string;
  title: string;
  voiceId?: VoiceId;
}

// A bare idea as a voice emits it, before the orchestrator assigns an id/author.
export interface RawIdea {
  body: string;
  title: string;
}

export const CRITIQUE_STANCES = ['support', 'concern', 'extend'] as const;
export type CritiqueStance = (typeof CRITIQUE_STANCES)[number];

// One critique of (or note on) another voice's idea. `target` is free text (the
// id or title the critic referenced) — the model is not forced to echo our ids.
export interface Critique {
  assessment: string;
  stance: CritiqueStance;
  target: string;
}

// One ranked recommendation in the synthesis. `rank` is assigned from array order
// (best-first) at parse time, never trusted from the model. `contributors` credits
// the voices whose ideas fed it.
export interface RankedIdea {
  contributors: string[];
  rank: number;
  risks?: string;
  title: string;
  why: string;
}

// ── Per-round results (the orchestration's FACTS shape) ──────────────────────

// Round 1 — one voice's independent ideas. `ok` = ran and produced parseable
// ideas; a failure (crash / timeout / no-parse) degrades to ok:false with the
// reason, never taking down the other voices.
export interface VoiceGenerateResult {
  error?: string;
  ideas: Idea[];
  ok: boolean;
  raw: string | null;
  summary: string;
  timedOut?: boolean;
  voiceId: VoiceId;
}

// Round 2 — one voice's critique + extensions over the OTHER voices' ideas.
export interface VoiceCritiqueResult {
  critiques: Critique[];
  error?: string;
  extensions: RawIdea[];
  ok: boolean;
  raw: string | null;
  summary: string;
  timedOut?: boolean;
  voiceId: VoiceId;
}

// Round 3 — the converged recommendation. `degraded` = the synthesizer voice was
// unavailable and a DETERMINISTIC fallback (dedupe-by-title) produced the list, so
// a reader knows the ranking is not model-judged.
export interface SynthesisResult {
  by: VoiceId | null;
  degraded: boolean;
  error?: string;
  ok: boolean;
  ranked: RankedIdea[];
  raw: string | null;
  summary: string;
}

// The whole brainstorm — FACTS only (the three rounds), no gate/verdict.
export interface BrainstormResult {
  critique: VoiceCritiqueResult[];
  generate: VoiceGenerateResult[];
  roster: VoiceId[];
  synthesis: SynthesisResult;
  topic: string;
}
