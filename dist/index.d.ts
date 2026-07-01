import { R as ReviewerId, a as ReviewerConfig, b as ReviewFinding, c as ReviewPacket, T as TerminalState, S as StoredReview, d as ReviewProfile } from './contracts-DOjPsC5x.js';
export { C as CONFIDENCES, e as Confidence, D as DIFF_USEFUL_FLOOR, E as Evidence, F as FINDINGS_INSTRUCTIONS, M as ManifestEntry, P as PACKET_BUDGETS, f as PacketInput, g as PacketSection, h as ParsedReview, i as REVIEWER_IDS, j as REVIEW_PROFILES, k as SECURITY_CLASSES, l as SECURITY_OBJECTIVE, m as SEVERITIES, n as SecurityClass, o as Severity, p as TERMINAL_STATES, q as assembleCodePacket, r as classifySecurityFinding, s as extractJsonBlock, t as isReviewProfile, u as isReviewerId, v as oneOf, w as parseFindings, x as parseReviewerIds, y as renderReviewPrompt, z as section, A as securityClassLabel, B as stripSecurityTag, G as titleCase } from './contracts-DOjPsC5x.js';

declare const REVIEWERS_FILE: string;
declare const REVIEWER_DEFAULTS: Record<ReviewerId, ReviewerConfig>;
declare function parseReviewers(raw: unknown): Record<ReviewerId, ReviewerConfig>;
declare function loadReviewers(file?: string): Record<ReviewerId, ReviewerConfig>;
declare function resolveReviewer(id: ReviewerId, file?: string): ReviewerConfig;
declare function listReviewers(file?: string): ReviewerConfig[];

declare function sanitizePathSegment(s: string): string;
declare function reviewDir(baseDir: string, runId: string): string;
interface PersistReviewInput {
    findings: ReviewFinding[];
    packet: ReviewPacket;
    prompt: string;
    raw: string | null;
    reviewer: ReviewerConfig;
    runId: string;
    summary: string;
    terminalState: TerminalState;
}
declare function persistReview(baseDir: string, input: PersistReviewInput): StoredReview;
declare function readReview(baseDir: string, runId: string, reviewerId?: ReviewerId): StoredReview | null;
declare function readReviewsForRun(baseDir: string, runId: string): StoredReview[];

declare function resolveCodexBin(): string;
declare function makeEscalatingKill(child: {
    kill: (signal: NodeJS.Signals) => void;
}, graceMs: number, schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>, cancel?: (t: ReturnType<typeof setTimeout>) => void): {
    clear: () => void;
    kill: () => void;
};
declare function killTree(child: {
    kill: (signal: NodeJS.Signals) => void;
    pid?: number;
}, signal: NodeJS.Signals, signalGroup?: (pid: number, signal: NodeJS.Signals) => void): void;
interface ReviewerExecOpts {
    /** The full CLI arg list — the caller encodes the call contract here. */
    args: string[];
    /** Resolved binary path. The CALLER resolves it (so tests can stub it). */
    bin: string;
    /**
     * Where the reply is read from. `'outfile'` (codex): the reply lands in the
     * `-o` tempfile and stdout is ignored. `'stdout'` (grok): the reply IS stdout
     * (grok `-p --output-format json` prints the envelope and exits — there is no
     * `-o` file). Defaults to `'outfile'` for the proven Codex path.
     */
    capture?: 'outfile' | 'stdout';
    /** Receives the kill handle so a caller (e.g. a cancel) can abort the child. */
    onSpawn?: (kill: () => void) => void;
    /** The -o tempfile the reply is read from, then unlinked. Required for 'outfile'. */
    outFile?: string;
    /** Cap the retained stderr tail (a noise channel) at this many chars. */
    stderrLimit: number;
    /** Watchdog timeout; on expiry the whole process GROUP is SIGTERM→SIGKILLed. */
    timeoutMs: number;
}
interface ReviewerExecResult {
    /** The reply (the -o file, or accumulated stdout) — or null if none produced. */
    raw: string | null;
    stderrTail: string;
    timedOut: boolean;
}
declare function runReviewerExec(opts: ReviewerExecOpts): Promise<ReviewerExecResult>;

declare function resolveBin(name: string, opts?: {
    candidates?: string[];
    envVar?: string;
}): string;

declare function sha256Hex(input: string): string;

declare const REVIEW_TIMEOUT_MS = 720000;
interface CodexReviewResult {
    ok: boolean;
    raw: string | null;
    stderrTail: string;
    timedOut: boolean;
}
declare function buildCodexReviewArgs(config: ReviewerConfig, outFile: string, prompt: string): string[];
interface RunReviewOpts {
    onSpawn?: (kill: () => void) => void;
    timeoutMs?: number;
}
declare function runCodexReview(prompt: string, config: ReviewerConfig, opts?: RunReviewOpts): Promise<CodexReviewResult>;

declare function resolveGrokBin(): string;
declare function resolveReviewSandbox(configured?: string): string;
declare function ensureSandboxProfile(profile: string, file?: string): void;
declare function buildGrokReviewArgs(config: ReviewerConfig, prompt: string, cwd: string): string[];
declare function extractGrokText(stdout: string): string | null;
declare function runGrokReview(prompt: string, config: ReviewerConfig, opts?: RunReviewOpts): Promise<CodexReviewResult>;

declare const REVIEW_ADAPTERS: Record<ReviewerId, (prompt: string, config: ReviewerConfig, opts?: RunReviewOpts) => Promise<CodexReviewResult>>;

type DiffMode = 'commit' | 'working-tree' | 'staged' | 'pr' | 'raw';
type FileKind = 'source' | 'generated' | 'binary';
type OmitReason = 'binary' | 'generated' | 'over-limit';
declare const DEFAULT_COVERAGE_CEILING = 200000;
declare function classifyFileKind(path: string, isBinary: boolean): FileKind;
interface FileDiff {
    added: number;
    bytes: number;
    isBinary: boolean;
    kind: FileKind;
    path: string;
    raw: string;
    removed: number;
}
declare function parseDiffFiles(raw: string): FileDiff[];
interface CoverageFileEntry {
    added: number;
    bytes: number;
    included: boolean;
    kind: FileKind;
    omitReason?: OmitReason;
    path: string;
    removed: number;
}
interface Coverage {
    files: CoverageFileEntry[];
    includedBytes: number;
    includedFiles: number;
    omittedFiles: number;
    totalBytes: number;
    totalFiles: number;
}
declare function coverageCounts(c: {
    includedFiles: number;
    omittedFiles: number;
    totalFiles: number;
}): string;
declare function omittedLine(o: {
    kind: string;
    path: string;
    reason: string | undefined;
}): string;
declare function computeCoverage(files: FileDiff[], ceilingBytes?: number): {
    coverage: Coverage;
    includedDiff: string;
};
declare function canonicalizeDiff(raw: string): string;
declare function diffDigest(raw: string): string;
declare function resolveRepoId(cwd: string): string | null;
declare function resolveBase(cwd: string, explicit?: string): string | null;
interface AcquiredDiff {
    baseRef: string | null;
    baseSha: string | null;
    canonicalDigest: string;
    coverage: Coverage;
    diff: string;
    files: FileDiff[];
    headSha: string;
    mode: DiffMode;
    rawDiff: string;
    repoId: string | null;
}
interface AcquireDiffOpts {
    base?: string;
    ceilingBytes?: number;
    cwd: string;
    diffMode?: DiffMode;
    diffText?: string;
    staged?: boolean;
    workingTree?: boolean;
}
declare function acquireDiff(opts: AcquireDiffOpts): AcquiredDiff;

interface DepManifestHit {
    added: number;
    isLockfile: boolean;
    label: string;
    path: string;
    samples: string[];
}
interface RiskyImportHit {
    cls: string;
    label: string;
    line?: number;
    path: string;
}
interface DepSurfaceResult {
    manifests: DepManifestHit[];
    riskyImports: RiskyImportHit[];
}
declare function scanDependencySurface(files: FileDiff[]): DepSurfaceResult;
declare function hasDepSurface(r: DepSurfaceResult): boolean;

interface ReceiptCoverage {
    includedFiles: number;
    omitted: {
        kind: string;
        path: string;
        reason: string;
    }[];
    omittedFiles: number;
    totalFiles: number;
}
interface DiffReviewReceipt {
    baseRef: string | null;
    baseSha: string | null;
    completed: ReviewerId[];
    coverage: ReceiptCoverage;
    diffDigest: string;
    diffMode: DiffMode;
    headSha: string;
    policyHash: string;
    repo: string | null;
    reviewerPolicy: ReviewerId[];
    runId: string;
    vendors: string[];
}
interface CoveragePolicy {
    ceilingBytes: number;
}
declare function computePolicyHash(args: {
    coveragePolicy: CoveragePolicy;
    diffMode: DiffMode;
    reviewerPolicy: ReviewerId[];
}): string;
interface ReceiptKey {
    baseSha: string | null;
    diffDigest: string;
    headSha: string;
    policyHash: string;
    repo: string | null;
}
declare function receiptKeyHash(key: ReceiptKey): string;
declare function defaultReceiptStore(): string;
declare function receiptPath(storeDir: string, key: ReceiptKey): string;
declare function keyOf(receipt: DiffReviewReceipt): ReceiptKey;
declare function receiptIdentityMatches(receipt: DiffReviewReceipt, key: ReceiptKey): boolean;
declare function writeReceipt(storeDir: string, receipt: DiffReviewReceipt): string;
declare function validateReceiptShape(value: unknown): DiffReviewReceipt;
declare function readReceipt(storeDir: string, key: ReceiptKey): DiffReviewReceipt | null;
declare function coverageShortfall(coverage: ReceiptCoverage): string[];
declare function summarizeCoverage(coverage: Coverage): ReceiptCoverage;
interface BuildReceiptResult {
    error?: string;
    ok: boolean;
    receipt?: DiffReviewReceipt;
}
declare function buildDiffReceipt(args: {
    baseRef: string | null;
    baseSha: string | null;
    coverage: Coverage;
    coveragePolicy: CoveragePolicy;
    diffDigest: string;
    diffMode: DiffMode;
    diffTruncated: boolean;
    headSha: string;
    repo: string | null;
    required: ReviewerId[];
    reviews: StoredReview[];
    runId: string;
}): BuildReceiptResult;
type DiffReviewReason = 'reviewed' | 'no-receipt' | 'stale' | 'incomplete-policy' | 'incomplete-coverage' | 'artifact-missing';
interface DiffReviewState {
    reason: DiffReviewReason;
    receipt: DiffReviewReceipt | null;
    reviewed: boolean;
}
declare function isDiffReviewed(live: {
    coverage: Coverage;
    key: ReceiptKey;
    required: ReviewerId[];
}, deps: {
    readReceipt: (key: ReceiptKey) => DiffReviewReceipt | null;
    readReview: (runId: string, reviewerId: ReviewerId) => StoredReview | null;
}): DiffReviewState;

interface SensitivePathHit {
    label: string;
    path: string;
}
interface InlineSecretHit {
    label: string;
    path: string;
}
interface SecretScanResult {
    blocked: boolean;
    inlineSecrets: InlineSecretHit[];
    overridden: boolean;
    sensitivePaths: SensitivePathHit[];
}
declare function scanDiffForSecrets(files: FileDiff[], opts?: {
    allowSensitive?: boolean;
}): SecretScanResult;

interface ReviewModeOptions {
    agentsMd?: string;
    allowSensitive?: boolean;
    authorSummary?: string;
    base?: string;
    ceilingBytes?: number;
    cwd: string;
    diffMode?: DiffMode;
    diffText?: string;
    objective?: string;
    onProgress?: (msg: string) => void;
    out: string;
    profile?: ReviewProfile;
    receiptStore?: string;
    reviewers?: ReviewerId[];
    reviewersFile?: string;
    runId: string;
    sandbox?: string;
    staged?: boolean;
    workingTree?: boolean;
}
interface ReviewModeResult {
    acquired: AcquiredDiff;
    blocked: boolean;
    blockedReason?: string;
    depSurface?: DepSurfaceResult;
    receipt?: DiffReviewReceipt;
    receiptError?: string;
    receiptPath?: string;
    reviews: StoredReview[];
    secretScan: SecretScanResult;
}
declare const DEFAULT_OBJECTIVE = "Adversarial cross-vendor review of a code diff \u2014 find correctness, security, and convention issues a same-vendor author might miss.";
declare function runReviewMode(opts: ReviewModeOptions): Promise<ReviewModeResult>;

declare const VOICE_IDS: readonly ["codex", "grok", "claude"];
type VoiceId = (typeof VOICE_IDS)[number];
declare function isVoiceId(v: unknown): v is VoiceId;
declare function parseVoiceIds(raw: unknown): VoiceId[] | undefined;
interface VoiceConfig {
    cmd: string;
    effort: string;
    id: VoiceId;
    model: string;
    sandbox?: string;
    vendor: string;
}
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
    timedOut?: boolean;
    voiceId: VoiceId;
}
interface VoiceCritiqueResult$1 {
    critiques: Critique[];
    error?: string;
    extensions: RawIdea[];
    ok: boolean;
    raw: string | null;
    summary: string;
    timedOut?: boolean;
    voiceId: VoiceId;
}
interface SynthesisResult {
    by: VoiceId | null;
    degraded: boolean;
    error?: string;
    ok: boolean;
    ranked: RankedIdea[];
    raw: string | null;
    summary: string;
}
interface BrainstormResult {
    critique: VoiceCritiqueResult$1[];
    generate: VoiceGenerateResult[];
    roster: VoiceId[];
    synthesis: SynthesisResult;
    topic: string;
}

type VoiceRunResult = CodexReviewResult;
declare const VOICE_DEFAULTS: Record<VoiceId, VoiceConfig>;
declare const VOICE_ADAPTERS: Record<VoiceId, (prompt: string, config: VoiceConfig, opts?: RunReviewOpts) => Promise<VoiceRunResult>>;
declare const VOICES_FILE: string;
declare function parseVoices(raw: unknown): Record<VoiceId, VoiceConfig>;
declare function loadVoices(file?: string): Record<VoiceId, VoiceConfig>;
declare function listVoices(file?: string): VoiceConfig[];

declare const DEFAULT_VOICE_TIMEOUT_MS$1 = 300000;
type Adapters$1 = Record<VoiceId, (prompt: string, config: VoiceConfig, opts?: {
    onSpawn?: (kill: () => void) => void;
    timeoutMs?: number;
}) => Promise<VoiceRunResult>>;
interface BrainstormOptions {
    adapters?: Adapters$1;
    fileContext?: string;
    onProgress?: (msg: string) => void;
    synthesizer?: VoiceId;
    timeoutMs?: number;
    topic: string;
    voiceConfigs?: Record<VoiceId, VoiceConfig>;
    voices?: VoiceId[];
    voicesFile?: string;
}
declare function fallbackSynthesis$1(allIdeas: Idea[]): SynthesisResult;
declare function pickSynthesizer$1(roster: VoiceId[], requested: VoiceId | undefined, generate: VoiceGenerateResult[]): VoiceId | null;
declare function runBrainstormMode(opts: BrainstormOptions): Promise<BrainstormResult>;

declare function resolveClaudeBin(): string;
declare function buildClaudeVoiceArgs(prompt: string, config?: VoiceConfig): string[];
declare function runClaudeVoice(prompt: string, config: VoiceConfig, opts?: RunReviewOpts): Promise<CodexReviewResult>;

declare function renderGeneratePrompt(topic: string, fileContext?: string): string;
declare function renderCritiquePrompt(topic: string, peerIdeas: Idea[], fileContext?: string): string;
declare function renderSynthesisPrompt(topic: string, allIdeas: Idea[], critiqueResults: VoiceCritiqueResult$1[]): string;

interface ParsedIdeas {
    ideas: RawIdea[];
    parseError?: string;
    summary: string;
}
declare function parseIdeas(raw: string): ParsedIdeas;
interface ParsedCritique {
    critiques: Critique[];
    extensions: RawIdea[];
    parseError?: string;
    summary: string;
}
declare function parseCritique(raw: string): ParsedCritique;
interface ParsedSynthesis {
    parseError?: string;
    ranked: RankedIdea[];
    summary: string;
}
declare function parseSynthesis(raw: string): ParsedSynthesis;

interface VoiceAnswerResult {
    answer: string;
    error?: string;
    keyPoints: string[];
    ok: boolean;
    raw: string | null;
    summary: string;
    timedOut?: boolean;
    voiceId: VoiceId;
}
interface AnswerNote {
    assessment: string;
    stance: CritiqueStance;
    target: string;
}
interface VoiceCritiqueResult {
    error?: string;
    notes: AnswerNote[];
    ok: boolean;
    raw: string | null;
    summary: string;
    timedOut?: boolean;
    voiceId: VoiceId;
}
interface AgreementPoint {
    point: string;
    voices: string[];
}
interface DivergencePoint {
    point: string;
    positions: string[];
}
interface ConsultSynthesis {
    agreements: AgreementPoint[];
    by: VoiceId | null;
    degraded: boolean;
    divergences: DivergencePoint[];
    error?: string;
    ok: boolean;
    raw: string | null;
    recommendation: string;
    summary: string;
}
interface ConsultResult {
    answers: VoiceAnswerResult[];
    critique: VoiceCritiqueResult[];
    question: string;
    roster: VoiceId[];
    synthesis: ConsultSynthesis;
}

declare const DEFAULT_VOICE_TIMEOUT_MS = 300000;
type Adapters = Record<VoiceId, (prompt: string, config: VoiceConfig, opts?: {
    onSpawn?: (kill: () => void) => void;
    timeoutMs?: number;
}) => Promise<VoiceRunResult>>;
interface ConsultOptions {
    adapters?: Adapters;
    critique?: boolean;
    fileContext?: string;
    onProgress?: (msg: string) => void;
    question: string;
    synthesizer?: VoiceId;
    timeoutMs?: number;
    voiceConfigs?: Record<VoiceId, VoiceConfig>;
    voices?: VoiceId[];
    voicesFile?: string;
}
declare function fallbackSynthesis(answers: VoiceAnswerResult[]): ConsultSynthesis;
declare function pickSynthesizer(roster: VoiceId[], requested: VoiceId | undefined, answers: VoiceAnswerResult[]): VoiceId | null;
declare function runConsultMode(opts: ConsultOptions): Promise<ConsultResult>;

type index_ConsultOptions = ConsultOptions;
declare const index_DEFAULT_VOICE_TIMEOUT_MS: typeof DEFAULT_VOICE_TIMEOUT_MS;
declare const index_fallbackSynthesis: typeof fallbackSynthesis;
declare const index_pickSynthesizer: typeof pickSynthesizer;
declare const index_runConsultMode: typeof runConsultMode;
declare namespace index {
  export { type index_ConsultOptions as ConsultOptions, index_DEFAULT_VOICE_TIMEOUT_MS as DEFAULT_VOICE_TIMEOUT_MS, index_fallbackSynthesis as fallbackSynthesis, index_pickSynthesizer as pickSynthesizer, index_runConsultMode as runConsultMode };
}

declare const MODES: readonly ["review", "brainstorm", "security", "consult"];
type ModeName = (typeof MODES)[number];
declare const IMPLEMENTED_MODES: readonly ModeName[];
declare const MODE_ALIASES: Record<string, ModeName>;
declare function resolveMode(v: string): string;
declare function isMode(v: string): v is ModeName;
declare function isImplemented(mode: ModeName): boolean;

export { type AcquireDiffOpts, type AcquiredDiff, type AgreementPoint, type BrainstormOptions, type BrainstormResult, type BuildReceiptResult, CRITIQUE_STANCES, type CodexReviewResult, type ConsultResult, type ConsultSynthesis, type Coverage, type CoverageFileEntry, type CoveragePolicy, type Critique, type CritiqueStance, DEFAULT_COVERAGE_CEILING, DEFAULT_OBJECTIVE, DEFAULT_VOICE_TIMEOUT_MS$1 as DEFAULT_VOICE_TIMEOUT_MS, type DepManifestHit, type DepSurfaceResult, type DiffMode, type DiffReviewReason, type DiffReviewReceipt, type DiffReviewState, type DivergencePoint, type FileDiff, type FileKind, IMPLEMENTED_MODES, type Idea, type InlineSecretHit, MODES, MODE_ALIASES, type ModeName, type OmitReason, type ParsedCritique, type ParsedIdeas, type ParsedSynthesis, type PersistReviewInput, REVIEWERS_FILE, REVIEWER_DEFAULTS, REVIEW_ADAPTERS, REVIEW_TIMEOUT_MS, type RankedIdea, type RawIdea, type ReceiptCoverage, type ReceiptKey, ReviewFinding, type ReviewModeOptions, type ReviewModeResult, ReviewPacket, ReviewProfile, ReviewerConfig, type ReviewerExecOpts, type ReviewerExecResult, ReviewerId, type RiskyImportHit, type RunReviewOpts, type SecretScanResult, type SensitivePathHit, StoredReview, type SynthesisResult, TerminalState, VOICES_FILE, VOICE_ADAPTERS, VOICE_DEFAULTS, VOICE_IDS, type VoiceAnswerResult, type VoiceConfig, type VoiceCritiqueResult$1 as VoiceCritiqueResult, type VoiceGenerateResult, type VoiceId, type VoiceRunResult, acquireDiff, buildClaudeVoiceArgs, buildCodexReviewArgs, buildDiffReceipt, buildGrokReviewArgs, canonicalizeDiff, classifyFileKind, computeCoverage, computePolicyHash, index as consult, coverageCounts, coverageShortfall, defaultReceiptStore, diffDigest, ensureSandboxProfile, extractGrokText, fallbackSynthesis$1 as fallbackSynthesis, hasDepSurface, isDiffReviewed, isImplemented, isMode, isVoiceId, keyOf, killTree, listReviewers, listVoices, loadReviewers, loadVoices, makeEscalatingKill, omittedLine, parseCritique, parseDiffFiles, parseIdeas, parseReviewers, parseSynthesis, parseVoiceIds, parseVoices, persistReview, pickSynthesizer$1 as pickSynthesizer, readReceipt, readReview, readReviewsForRun, receiptIdentityMatches, receiptKeyHash, receiptPath, renderCritiquePrompt, renderGeneratePrompt, renderSynthesisPrompt, resolveBase, resolveBin, resolveClaudeBin, resolveCodexBin, resolveGrokBin, resolveMode, resolveRepoId, resolveReviewSandbox, resolveReviewer, reviewDir, runBrainstormMode, runClaudeVoice, runCodexReview, runGrokReview, runReviewMode, runReviewerExec, sanitizePathSegment, scanDependencySurface, scanDiffForSecrets, sha256Hex, summarizeCoverage, validateReceiptShape, writeReceipt };
