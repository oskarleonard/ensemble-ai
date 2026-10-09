declare const VOICE_IDS: readonly ["codex", "grok", "claude"];
type VoiceId = (typeof VOICE_IDS)[number];
declare function isVoiceId(v: unknown): v is VoiceId;
declare function parseVoiceIds(raw: unknown): VoiceId[] | undefined;
interface VoiceConfig {
    advisor?: unknown;
    cmd: string;
    effort: string;
    id: VoiceId;
    model: string;
    sandbox?: string;
    vendor: string;
    web?: boolean;
}
type ResolvedVoiceConfig = VoiceConfig & {
    advisor?: string;
};
interface Idea {
    body: string;
    id: string;
    title: string;
    voiceId?: VoiceId;
}
interface RawIdea {
    body: string;
    title: string;
}
declare const CRITIQUE_STANCES: readonly ["support", "concern", "extend"];
type CritiqueStance = (typeof CRITIQUE_STANCES)[number];
interface Critique {
    assessment: string;
    stance: CritiqueStance;
    target: string;
}
interface RankedIdea {
    contributors: string[];
    rank: number;
    risks?: string;
    title: string;
    why: string;
}
interface VoiceGenerateResult {
    error?: string;
    ideas: Idea[];
    ok: boolean;
    raw: string | null;
    summary: string;
    tail?: string;
    timedOut?: boolean;
    timedOutReason?: 'absolute' | 'inactivity';
    voiceId: VoiceId;
}
interface VoiceCritiqueResult {
    critiques: Critique[];
    error?: string;
    extensions: RawIdea[];
    ok: boolean;
    raw: string | null;
    summary: string;
    tail?: string;
    timedOut?: boolean;
    timedOutReason?: 'absolute' | 'inactivity';
    voiceId: VoiceId;
}
interface SynthesisResult {
    by: VoiceId | null;
    degraded: boolean;
    error?: string;
    tail?: string;
    timedOut?: boolean;
    timedOutReason?: 'absolute' | 'inactivity';
    ok: boolean;
    ranked: RankedIdea[];
    raw: string | null;
    summary: string;
}
interface BrainstormResult {
    critique: VoiceCritiqueResult[];
    generate: VoiceGenerateResult[];
    roster: VoiceId[];
    synthesis: SynthesisResult;
    topic: string;
}

export { type BrainstormResult as B, type Critique as C, type Idea as I, type ResolvedVoiceConfig as R, type SynthesisResult as S, type VoiceId as V, type VoiceConfig as a, type VoiceGenerateResult as b, type VoiceCritiqueResult as c, type RawIdea as d, type RankedIdea as e, type CritiqueStance as f, CRITIQUE_STANCES as g, VOICE_IDS as h, isVoiceId as i, parseVoiceIds as p };
