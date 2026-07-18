import { R as ReviewerId, a as ReviewerConfig, b as ReviewFinding, c as ReviewPacket, T as TerminalState, S as StoredReview, d as Severity } from './types-eYT8NZq_.js';
export { C as CONFIDENCES, e as CORE_REVIEWER_IDS, f as Confidence, g as CoreReviewerId, E as Evidence, M as ManifestEntry, P as PacketSection, h as REVIEWER_IDS, i as SEVERITIES, j as TERMINAL_STATES, k as isCoreReviewerId, l as isReviewerId, p as parseReviewerIds, t as titleCase } from './types-eYT8NZq_.js';
import { R as ReviewProfile } from './contracts-s64OeJWb.js';
export { D as DIFF_SECTION_TITLE, a as DIFF_USEFUL_FLOOR, F as FINDINGS_INSTRUCTIONS, P as PACKET_BUDGETS, b as PacketInput, c as ParsedReview, d as REVIEW_PROFILES, S as SECURITY_CLASSES, e as SECURITY_OBJECTIVE, f as SEVERITY_LABEL, g as SEVERITY_ORDER, h as SecurityClass, T as TRUNCATION_MARKER_RE, i as assembleCodePacket, j as classifySecurityFinding, k as evidenceRef, l as extractJsonBlock, m as isReviewProfile, o as oneOf, p as parseFindings, r as renderReviewPrompt, n as reviewerVisibleDiff, s as section, q as securityClassLabel, t as segmentsWithoutTruncationSplices, u as stripSecurityTag } from './contracts-s64OeJWb.js';

interface ConventionReader {
    read(relPath: string, maxBytes?: number): Promise<string | null>;
    list(dirRelPath: string): Promise<string[]>;
}
interface GatherConfig {
    capBytes?: number;
    maxFiles?: number;
    conventions?: string[];
}
interface ConventionFileEntry {
    path: string;
    bytes: number;
    included: boolean;
    truncated: boolean;
    reason?: 'over-cap' | 'max-files';
}
interface ConventionManifest {
    capBytes: number;
    totalBytes: number;
    files: ConventionFileEntry[];
}
interface GatheredConventions {
    text: string;
    manifest: ConventionManifest;
}
declare function resolveInRepo(fromDir: string, ref: string): string | null;
declare function extractRefs(content: string): string[];
declare function gatherConventions(reader: ConventionReader, changedPaths: string[], config?: GatherConfig): Promise<GatheredConventions>;
declare function fsConventionReader(repoRoot: string): ConventionReader;
declare function memoryConventionReader(fileMap: Record<string, string>): ConventionReader;

declare const REVIEWERS_FILE: string;
declare const REVIEWER_DEFAULTS: Record<ReviewerId, ReviewerConfig>;
declare function parseReviewers(raw: unknown): Record<ReviewerId, ReviewerConfig>;
declare function loadReviewers(file?: string): Record<ReviewerId, ReviewerConfig>;
declare function resolveReviewer(id: ReviewerId, file?: string): ReviewerConfig;
declare function listReviewers(file?: string): ReviewerConfig[];

declare function sanitizePathSegment(s: string): string;
declare function reviewDir(baseDir: string, runId: string): string;
declare function escapesRoot(rel: string): boolean;
declare function makeOwnerOnlyTempDir(prefix: string, root?: string): string;
declare function writeTrailFile(baseDir: string, runId: string, name: string, content: string): string;
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
    /**
     * The spawn cwd. Defaults to a throwaway `os.tmpdir()` — the packet path, where a read tool has
     * nothing of the repo to reach. A WORKTREE seat passes the detached read-only worktree here:
     * for a harness-controlled CLI (claude), the cwd IS what grants whole-project read access. It is
     * BORROWED, never owned — one worktree per run, shared by every seat, reaped by the run.
     */
    cwd?: string;
    /**
     * Extra env for the child, merged OVER `process.env`. A fenced seat passes the egress proxy's
     * `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` (+ an empty `NO_PROXY`) here — merging over the parent
     * env is what lets `NO_PROXY: ''` OVERRIDE an operator's inherited `NO_PROXY=*`, which would
     * otherwise let the seat bypass the proxy for exactly the hosts it most wants to reach.
     */
    env?: Record<string, string>;
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

type GitRun = (args: string[], opts?: {
    cwd?: string;
    env?: Record<string, string>;
}) => {
    error: string;
    ok: false;
} | {
    ok: true;
    text: string;
};
type PreflightErrorKind = 'auth' | 'disallowed-root' | 'lock-contended' | 'materialize-failed' | 'network' | 'no-such-pr' | 'not-a-repo' | 'sha-mismatch' | 'wrong-repo';
declare const WORKTREE_LOCK_ERROR = "could not acquire the worktree lock";
interface PreflightError {
    kind: PreflightErrorKind;
    message: string;
}
interface RepoLocation {
    fetchUrl: string;
    repoRoot: string;
    slug: string;
}
declare function isPreflightError(v: unknown): v is PreflightError;
declare function remoteSlug(url: string): string | null;
declare function redactUrlCredentials(url: string): string;
declare function classifyGitError(stderr: string): PreflightErrorKind;
declare function allowedRootsFromConfig(configPath?: string): string[] | null;
declare function rootAllowed(repoRoot: string, allowed: string[] | null): boolean;
declare function resolveRepoLocation(args: {
    prSlug: string;
    repoPath: string;
}, deps: {
    allowedRoots?: string[] | null;
    git: GitRun;
}): PreflightError | RepoLocation;
interface Worktree {
    dir: string;
    headSha: string;
    strippedInstructionFiles: string[];
}
declare const AGENT_INSTRUCTION_NAMES: readonly ["CLAUDE.md", "AGENTS.md", ".claude"];
declare const UNTRUSTED_INSTRUCTIONS_CLAUSE: string;
declare function readOnlyWorktreeClause(args: {
    headSha: string;
    reach: string;
    worktree: string;
}): string;
declare function materializedDiffClause(args: {
    baseSha: string;
    diff: string;
    headSha: string;
}): string;
declare function stripAgentInstructions(dir: string): string[];
declare function isStrippedPath(p: string, stripped: readonly string[]): boolean;
declare function acquireRepoLock(gitCommonDir: string, opts?: {
    retries?: number;
    sleepMs?: number;
    staleMs?: number;
}): () => void;
declare function acquireRepoLockAsync(gitCommonDir: string, opts?: {
    retries?: number;
    sleepMs?: number;
    staleMs?: number;
}): Promise<() => void>;
declare function materializeWorktree(args: {
    headSha: string;
    location: RepoLocation;
    pr: number;
    worktreeRoot?: string;
}, deps: {
    git: GitRun;
    lock?: (gitCommonDir: string) => () => void;
}): PreflightError | Worktree;
declare function reapWorktree(repoRoot: string, dir: string, deps: {
    git: GitRun;
}): void;
type GitRunAsync = (args: string[], opts?: {
    cwd?: string;
    env?: Record<string, string>;
}) => Promise<{
    error: string;
    ok: false;
} | {
    ok: true;
    text: string;
}>;
declare function resolveRepoLocationAsync(args: {
    prSlug: string;
    repoPath: string;
}, deps: {
    allowedRoots?: string[] | null;
    git: GitRunAsync;
}): Promise<PreflightError | RepoLocation>;
declare function materializeWorktreeAsync(args: {
    headSha: string;
    location: RepoLocation;
    pr: number;
    worktreeRoot?: string;
}, deps: {
    git: GitRunAsync;
    lock?: (gitCommonDir: string) => Promise<() => void> | (() => void);
}): Promise<PreflightError | Worktree>;
declare function reapWorktreeAsync(repoRoot: string, dir: string, deps: {
    git: GitRunAsync;
}): Promise<void>;

interface HistoryPacketFile {
    contents: string;
    path: string;
}
interface HistoryPacket {
    bytes: number;
    files: HistoryPacketFile[];
    shallow: boolean;
    truncated: boolean;
}

interface EgressDenial {
    host: string;
    method: string;
    port: number;
    reason: string;
}

declare const REVIEW_TIMEOUT_MS = 720000;
interface CodexReviewResult {
    egressDenials?: readonly EgressDenial[];
    ok: boolean;
    raw: string | null;
    stderrTail: string;
    timedOut: boolean;
}
declare function buildCodexReviewArgs(config: ReviewerConfig, outFile: string, prompt: string): string[];
interface RunReviewOpts {
    historyPacket?: readonly HistoryPacketFile[];
    onSpawn?: (kill: () => void) => void;
    timeoutMs?: number;
    worktree?: string;
}
declare function runCodexReview(prompt: string, config: ReviewerConfig, opts?: RunReviewOpts): Promise<CodexReviewResult>;

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
    headShaOverride?: string;
    staged?: boolean;
    workingTree?: boolean;
}
declare function acquireDiff(opts: AcquireDiffOpts): AcquiredDiff;

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

interface ClusterInfo {
    clusterId: string;
    corroboration: number;
    corroborators: string[];
    primary: boolean;
}

type FixStatus = 'keep' | 'narrow' | 'strike';
type PostableStatus = 'postable' | 'escalated' | 'not-postable';
declare const POSTABLE_CLASSES: readonly ["bug", "quality"];
type PostableClass = (typeof POSTABLE_CLASSES)[number];
interface PostableSuggestion {
    replacement: string;
}

interface VoiceReview {
    findings: ReviewFinding[];
    ok: boolean;
    summary: string;
    voiceId: string;
}

declare const HOLISTIC_SEAT_ID = "holistic";
declare const HOLISTIC_SEVERITY_CAP: Severity;
declare const HOLISTIC_DEFAULTS: {
    readonly effort: "max";
    readonly model: "opus";
};
declare function resolveHolisticSeat(raw: unknown, warn?: (m: string) => void): VoiceConfig;
declare function loadHolisticSeat(file?: string, warn?: (m: string) => void): VoiceConfig;
type HolisticPlan = {
    run: false;
    skipReason: string | null;
} | {
    baseSha: string;
    diff: string;
    run: true;
    worktree: string;
};
declare function resolveHolisticPlan(input: {
    baseSha?: string | null;
    diff?: string;
    requested: boolean;
    worktree?: string;
}): HolisticPlan;
interface HolisticPromptArgs {
    baseSha: string;
    diff: string;
    headSha: string;
    history?: boolean;
    worktree: string;
}
declare function renderHolisticPrompt(args: HolisticPromptArgs): string;
type HolisticRunner = (prompt: string, config: VoiceConfig, opts?: RunReviewOpts) => Promise<VoiceRunResult>;
interface RunHolisticLensOptions {
    baseSha: string;
    config: VoiceConfig;
    diff: string;
    headSha: string;
    historyPacket?: HistoryPacket;
    log?: (m: string) => void;
    run: HolisticRunner;
    timeoutMs?: number;
    worktree: string;
}
declare function runHolisticLens(opts: RunHolisticLensOptions): Promise<{
    raw: string | null;
    review: VoiceReview;
}>;

declare const HOLISTIC_MIN_ANCHOR_NONWS = 16;
declare const HOLISTIC_SITE_ROLES: readonly ["diff", "pattern"];
type HolisticSiteRole = (typeof HOLISTIC_SITE_ROLES)[number];
interface HolisticSite {
    file: string;
    line: number;
    quote: string;
    role: HolisticSiteRole;
}
interface ConventionCitation {
    file: string;
    line: number;
    quote: string;
}
interface HolisticEntry {
    conventionCitation?: ConventionCitation;
    sites?: HolisticSite[];
}
interface HolisticProvenance {
    cappedFrom?: Severity;
    lens: typeof HOLISTIC_SEAT_ID;
    singleSeat: true;
    uncapCitation?: ConventionCitation;
    verifiedSites?: HolisticSite[];
}
declare function parseHolisticSites(v: unknown): HolisticSite[] | undefined;
declare function parseConventionCitation(v: unknown): ConventionCitation | undefined;
type SiteReader = (file: string) => string[] | null;
declare function worktreeReader(worktreeDir: string): SiteReader;
declare function findQuoteSpans(lines: string[], quote: string): {
    end: number;
    start: number;
}[];
declare function findQuoteSpan(lines: string[], quote: string): {
    end: number;
    start: number;
} | null;
type SiteCheck = {
    ok: true;
    span: {
        end: number;
        start: number;
    };
} | {
    ok: false;
    reason: string;
};
declare function verifySiteAtHead(site: {
    file: string;
    line: number;
    quote: string;
}, read: SiteReader): SiteCheck;
declare function isConventionsDoc(file: string, gathered?: readonly string[]): boolean;
interface HolisticPolicyDeps {
    conventionPaths?: readonly string[];
    diffFiles: ReadonlySet<string>;
    readAtHead: SiteReader;
}
declare function isHolisticRecord(r: {
    reviewer: string;
}): boolean;
declare function holisticCapWasLifted(r: GateVerdictRecord): boolean;
declare function capHolisticSeverity(r: GateVerdictRecord): GateVerdictRecord;
declare function applyHolisticPolicy(records: GateVerdictRecord[], entryById: ReadonlyMap<string, HolisticEntry | undefined>, deps: HolisticPolicyDeps | null): GateVerdictRecord[];

declare const GATE_VERDICTS: readonly ["agree", "partial", "false", "unverified"];
type GateVerdict = (typeof GATE_VERDICTS)[number];
declare const DOWNGRADE_REASONS: readonly ["truncated", "invalid-citation", "duplicate", "missing", "bad-enum", "packet-fail", "gate-failed", "unknown-schema", "trail-write-failed", "reference-not-found"];
type DowngradeReason = (typeof DOWNGRADE_REASONS)[number];
type AnchorSide = 'new' | 'old' | null;
interface GateVerdictRecord {
    anchorSide: AnchorSide;
    citation?: string;
    cluster?: ClusterInfo;
    downgradeReason: DowngradeReason | null;
    effectiveVerdict: GateVerdict;
    file: string;
    findingId: string;
    holistic?: HolisticProvenance;
    line: number | null;
    postableBody: string | null;
    postableClass: PostableClass | null;
    postableFix: FixStatus | null;
    postableNote?: string;
    postableStatus: PostableStatus;
    postableSuggestion: PostableSuggestion | null;
    rawVerdict: string | null;
    reason: string;
    rescoredSeverity: Severity | null;
    resolved: boolean;
    reviewer: string;
    severity: Severity;
    title: string;
}
interface GateDispositionSummary {
    dismissedHighIds: string[];
    trailWritten: boolean;
    verdictCounts: Record<string, number>;
}

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
interface PeerReviewerRecord {
    id: string;
    state: TerminalState;
    vendor: string;
}
interface DiffReviewReceipt {
    baseRef: string | null;
    baseSha: string | null;
    completed: ReviewerId[];
    coverage: ReceiptCoverage;
    peerReviewers?: PeerReviewerRecord[];
    gateDisposition?: GateDispositionSummary;
    diffDigest: string;
    diffMode: DiffMode;
    headSha: string;
    intendedEvidence?: EvidenceMap;
    policyHash: string;
    policyVersion?: number;
    realizedEvidence?: EvidenceMap;
    repo: string | null;
    reviewerPolicy: ReviewerId[];
    runId: string;
    sandboxProfiles?: SandboxProfileMap;
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
    intendedEvidence?: EvidenceMap;
    realizedEvidence?: EvidenceMap;
    repo: string | null;
    required: ReviewerId[];
    reviews: StoredReview[];
    runId: string;
    sandboxProfiles?: SandboxProfileMap;
}): BuildReceiptResult;
type DiffReviewReason = 'reviewed' | 'no-receipt' | 'stale' | 'incomplete-policy' | 'incomplete-coverage' | 'evidence-degraded' | 'artifact-missing';
interface DiffReviewState {
    evidenceGaps?: ReturnType<typeof evidenceShortfall>;
    reason: DiffReviewReason;
    receipt: DiffReviewReceipt | null;
    reviewed: boolean;
}
declare function resolveReceipt(readReceipt: (key: ReceiptKey) => DiffReviewReceipt | null, key: ReceiptKey, legacyKey?: ReceiptKey): DiffReviewReceipt | null;
declare function isDiffReviewed(live: {
    acceptDegraded?: boolean;
    coverage: Coverage;
    intendedEvidence?: EvidenceMap;
    key: ReceiptKey;
    legacyKey?: ReceiptKey;
    required: ReviewerId[];
}, deps: {
    readReceipt: (key: ReceiptKey) => DiffReviewReceipt | null;
    readReview: (runId: string, reviewerId: ReviewerId) => StoredReview | null;
}): DiffReviewState;

declare const EVIDENCE_CLASSES: readonly ["packet", "worktree"];
type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];
declare const HARNESS_SEATS: readonly ["claude", "gate"];
type HarnessSeat = (typeof HARNESS_SEATS)[number];
declare const EVIDENCE_SEATS_RAW: readonly ["codex", "grok", "claude", "claude", "gate"];
type EvidenceSeat = (typeof EVIDENCE_SEATS_RAW)[number];
declare const EVIDENCE_SEATS: readonly EvidenceSeat[];
declare function isEvidenceSeat(v: unknown): v is EvidenceSeat;
declare function isEvidenceClass(v: unknown): v is EvidenceClass;
type EvidenceMap = Partial<Record<EvidenceSeat, EvidenceClass>>;
interface SandboxProfileRef {
    id: string;
    version: number;
}
type SandboxProfileMap = Partial<Record<EvidenceSeat, SandboxProfileRef>>;
declare const POLICY_VERSION_LEGACY = 1;
declare const POLICY_VERSION_EVIDENCE = 2;
declare const POLICY_VERSIONS: readonly [1, 2];
declare function isPolicyVersion(v: unknown): v is (typeof POLICY_VERSIONS)[number];
declare function receiptPolicyVersion(v: unknown): number;
declare function resolvePolicyVersion(intended: EvidenceMap): number;
interface PolicyHashInputs {
    coveragePolicy: CoveragePolicy;
    diffMode: DiffMode;
    intendedEvidence?: EvidenceMap;
    reviewerPolicy: string[];
    sandboxProfiles?: SandboxProfileMap;
}
declare function computePolicyHashAt(inputs: PolicyHashInputs, version: number): string;
interface EvidenceGap {
    intended: EvidenceClass;
    realized: EvidenceClass | 'unknown';
    seat: EvidenceSeat;
}
declare function evidenceShortfall(intended: EvidenceMap, realized: EvidenceMap | undefined): EvidenceGap[];
declare function formatEvidenceShortfall(gaps: EvidenceGap[]): string;

declare function resolveGrokBin(): string;
declare function resolveReviewSandbox(configured?: string): string;
declare function ensureSandboxProfile(profile: string, file?: string): void;
declare const GROK_CLI_SANDBOX = "ensemble-review";
declare const GROK_SANDBOX_PROFILE: SandboxProfileRef;
declare function buildGrokReviewArgs(config: ReviewerConfig, prompt: string, cwd: string): string[];
declare function extractGrokText(stdout: string): string | null;
declare function runGrokReview(prompt: string, config: ReviewerConfig, opts?: RunReviewOpts): Promise<CodexReviewResult>;

declare function runClaudeReview(prompt: string, config: ReviewerConfig, opts?: RunReviewOpts): Promise<CodexReviewResult>;

declare const REVIEW_ADAPTERS: Record<ReviewerId, (prompt: string, config: ReviewerConfig, opts?: RunReviewOpts) => Promise<CodexReviewResult>>;

declare const CODEX_SANDBOX_PROFILE: SandboxProfileRef;
declare const SANDBOX_WRITABLE_TMP = "/private/tmp";
declare const MDNS_RESPONDER_SOCKET = "/private/var/run/mDNSResponder";
declare function isUnsafeReadRoot(root: string, home?: string): boolean;
interface CodexSandboxPaths {
    codexHome: string;
    nodePrefix: string;
    proxyPort: number;
    worktree: string;
}
declare function renderCodexSandboxProfile(p: CodexSandboxPaths): string;
declare function codexSandboxSupported(platform?: NodeJS.Platform): boolean;
declare const QUALIFY_PROBE_PORT = 1;
declare function defaultCodexSandboxPaths(worktree: string, proxyPort: number): CodexSandboxPaths;
declare function writeCodexSandboxProfile(paths: CodexSandboxPaths): {
    cleanup: () => void;
    file: string;
};
declare function wrapWithSandbox(profileFile: string, bin: string, args: string[]): {
    args: string[];
    bin: string;
};
declare function buildCodexWorktreeArgs(config: {
    effort: string;
    model: string;
}, outFile: string, prompt: string): string[];

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

type ReviewAdapter = (prompt: string, config: ReviewerConfig, opts?: RunReviewOpts) => Promise<CodexReviewResult>;

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

interface WorktreeEvidence {
    baseSha: string | null;
    dir: string;
    headSha: string;
}
interface ReviewEvidence {
    egressDenials: EgressDenial[];
    fallbacks: string[];
    intended: EvidenceMap;
    realized: EvidenceMap;
    sandboxProfiles: SandboxProfileMap;
}
interface ReviewModeOptions {
    adapters?: Record<ReviewerId, ReviewAdapter>;
    agentsMd?: string;
    allowSensitive?: boolean;
    authorSummary?: string;
    base?: string;
    ceilingBytes?: number;
    conventionCapBytes?: number;
    conventionPaths?: string[];
    conventionReader?: ConventionReader | null;
    cwd: string;
    diffMode?: DiffMode;
    diffText?: string;
    headShaOverride?: string;
    noConventions?: boolean;
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
    peerSeats?: readonly EvidenceSeat[];
    worktree?: WorktreeEvidence;
}
interface ReviewModeResult {
    acquired: AcquiredDiff;
    blocked: boolean;
    blockedReason?: string;
    conventionManifest?: ConventionManifest;
    depSurface?: DepSurfaceResult;
    evidence?: ReviewEvidence;
    pinnedDiff?: string;
    prompt?: string;
    receipt?: DiffReviewReceipt;
    receiptCandidate?: DiffReviewReceipt;
    receiptError?: string;
    receiptPath?: string;
    receiptStore?: string;
    reviews: StoredReview[];
    secretScan: SecretScanResult;
}
declare const DEFAULT_OBJECTIVE = "Adversarial cross-vendor review of a code diff \u2014 find correctness, security, and convention issues a same-vendor author might miss.";
declare function runReviewMode(opts: ReviewModeOptions): Promise<ReviewModeResult>;

declare const EVIDENCE_MANIFEST_SCHEMA_VERSION = 1;
declare const EVIDENCE_MANIFEST_FILE = "evidence-manifest.json";
interface ManifestBlob {
    blobSha: string;
    path: string;
}
interface EvidenceManifest {
    headSha: string;
    intendedEvidence: EvidenceMap;
    readableSurface: ManifestBlob[];
    realizedEvidence: EvidenceMap;
    sandboxProfiles: SandboxProfileMap;
    schemaVersion: number;
    scopeNote: string;
}
declare function parseLsTree(text: string): ManifestBlob[];
declare function readReadableSurface(worktree: string, headSha: string, deps: {
    git: GitRun;
}): ManifestBlob[];
declare function buildEvidenceManifest(args: {
    headSha: string;
    intendedEvidence: EvidenceMap;
    readableSurface: ManifestBlob[];
    realizedEvidence: EvidenceMap;
    sandboxProfiles: SandboxProfileMap;
}): EvidenceManifest;
declare function writeEvidenceManifest(baseDir: string, runId: string, manifest: EvidenceManifest): boolean;

declare const CODE_REVIEW_SKILL = "/code-review";
declare const QUALITY_LENS = "Report BUGS and STRUCTURAL quality only: correctness defects, scope-narrowing, simpler function shape, dead branches, and reinvented utilities. NEVER report style, naming, formatting, or import-ordering nits \u2014 they are noise on someone else's pull request.";
interface CodeReviewSeatPromptArgs {
    baseSha: string;
    diff: string;
    headSha: string;
    history?: boolean;
    worktree: string;
}
declare function renderCodeReviewSeatPrompt(args: CodeReviewSeatPromptArgs): string;

declare const CLAUDE_CAPABILITY_FENCE: SandboxProfileRef;
declare const CLAUDE_EFFORTS: Set<string>;
declare const CLAUDE_REVIEW_DENIED_TOOLS: readonly ["Bash", "WebFetch", "WebSearch", "Write", "Edit", "MultiEdit", "NotebookEdit"];
declare const CLAUDE_READ_TOOLS: readonly ["Read", "Grep", "Glob"];
declare function homeReadDenyRules(homeDir: string): string[];
interface ClaudeSeatFence {
    homeDir?: string;
    readRoot?: string;
}
declare function buildClaudeReviewArgs(prompt: string, config?: VoiceConfig, fence?: ClaudeSeatFence): string[];
declare function makeNeutralSeatCwd(): string;
declare function runClaudeReviewVoice(prompt: string, config: VoiceConfig, opts?: RunReviewOpts): Promise<VoiceRunResult>;
declare function claudeWorktreePromptSuffix(args: {
    headSha: string;
    history?: boolean;
    worktree: string;
}): string;

declare const ENSEMBLE_CONFIG_PATH: string;
declare function asRecord(v: unknown): Record<string, unknown> | null;
declare function readEnsembleConfig(configPath?: string): Record<string, unknown>;

interface PostingPosture {
    inlineSeverityFloor: Severity;
    maxSuggestionLines: number;
    suggestionCap: number;
}
declare const SUGGESTION_HARD_CAP = 3;
declare const DEFAULT_POSTURE: PostingPosture;
declare function resolvePosture(raw: unknown): PostingPosture;
declare function loadPostingPosture(profile: ReviewProfile, configPath?: string): PostingPosture;
declare function meetsInlineFloor(severity: Severity, floor: Severity): boolean;

interface PrPushContext {
    headRefName: string;
    headRepoOwner: string | null;
    isCrossRepository: boolean;
    viewerCanPushBase: boolean;
}
type PushFenceVerdict = {
    allowed: false;
    reason: string;
} | {
    allowed: true;
};
declare function evaluatePushFence(ctx: PrPushContext, prSlug: string): PushFenceVerdict;
declare function parsePushContext(prJson: unknown, viewerCanPushBase: unknown): PrPushContext;

declare const STAGE_MARKER = "<!-- ensemble-ai:staged-review v1 -->";
declare function defuseUntrusted(s: string): string;
declare function findingTrailer(r: GateVerdictRecord): string;
declare function parseTrailerIds(text: string): string[];
declare function isEnsembleStagedReview(body: string | null | undefined): boolean;
interface PlacedFinding {
    record: GateVerdictRecord;
    suggestion: PostableSuggestion | null;
}
interface StageCounts {
    inline: number;
    quality: number;
    reviewersRun: number;
    suggestions: number;
    unanchored: number;
}
interface StagePlan {
    counts: StageCounts;
    inline: PlacedFinding[];
    quality: GateVerdictRecord[];
    unanchored: GateVerdictRecord[];
}
declare function planPlacement(records: GateVerdictRecord[], opts: {
    posture: PostingPosture;
    reviewersRun: number;
}): StagePlan;
declare function renderInlineComment(placed: PlacedFinding, reviewersRun: number): string;
interface SummaryBodyInput {
    evidenceNote?: string;
    headSha: string;
    plan: StagePlan;
    reviewerIds: string[];
}
declare function renderSummaryBody(input: SummaryBodyInput): string;
interface StagedComment {
    body: string;
    line: number;
    path: string;
    side: 'RIGHT';
}
interface StagedReviewPayload {
    body: string;
    comments: StagedComment[];
    commit_id: string;
}
declare function buildStagedReviewPayload(input: SummaryBodyInput): StagedReviewPayload;

type GhResult = {
    error: string;
    ok: false;
} | {
    ok: true;
    text: string;
};
type GhRunner = (args: string[], input?: string) => GhResult;
interface StageTarget {
    owner: string;
    pr: number;
    repo: string;
}
interface StageSuccess {
    ok: true;
    replaced: boolean;
    url: string | null;
}
interface StageFailure {
    error: string;
    kind: 'foreign-pending' | 'gh-failed' | 'head-moved' | 'unbound-head' | 'unreadable';
    ok: false;
}
type StageResult = StageFailure | StageSuccess;
declare function isCommitSha(s: string): boolean;
declare function checkFreshness(reviewedHeadSha: string, liveHeadSha: string): {
    error: string;
    ok: false;
} | {
    ok: true;
};
interface ReviewSummary {
    body?: string | null;
    id?: number;
    state?: string;
}
type PendingState = {
    id: number;
    kind: 'foreign';
} | {
    id: number;
    kind: 'ours';
} | {
    kind: 'none';
};
declare function classifyPending(reviews: ReviewSummary[]): PendingState;
declare function parseReviewSummaries(text: string): ReviewSummary[];
declare function stageReview(payload: StagedReviewPayload, target: StageTarget, deps: {
    gh: GhRunner;
    log?: (m: string) => void;
    reviewedHeadSha: string;
}): StageResult;

interface FixtureAnchor {
    file: string;
    line: number;
    symbol: string;
}
interface PlantedPositive {
    conventionsAnchor: FixtureAnchor;
    diffSite: FixtureAnchor;
    id: string;
    patternSite: FixtureAnchor;
    why: string;
}
interface NearMiss {
    id: string;
    lookalike: FixtureAnchor;
    site: FixtureAnchor;
    why: string;
}
interface HolisticFixture {
    conventionsDoc: string;
    nearMisses: NearMiss[];
    plantedPositives: PlantedPositive[];
}
declare function loadHolisticFixture(dir: string): HolisticFixture;
declare function verifyFixtureAnchors(dir: string, fixture: HolisticFixture): string[];
interface ScoredFinding {
    file: string;
    line: number | null;
    postable: boolean;
}
interface FixtureScore {
    caught: string[];
    falseFlags: string[];
    missed: string[];
    passed: boolean;
}
declare function scoreHolisticFixture(findings: readonly ScoredFinding[], fixture: HolisticFixture): FixtureScore;

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

export { AGENT_INSTRUCTION_NAMES, type AcquireDiffOpts, type AcquiredDiff, type AgreementPoint, type BrainstormOptions, type BrainstormResult, type BuildReceiptResult, CLAUDE_CAPABILITY_FENCE, CLAUDE_EFFORTS, CLAUDE_READ_TOOLS, CLAUDE_REVIEW_DENIED_TOOLS, CODEX_SANDBOX_PROFILE, CODE_REVIEW_SKILL, CRITIQUE_STANCES, type ClaudeSeatFence, type CodeReviewSeatPromptArgs, type CodexReviewResult, type CodexSandboxPaths, type ConsultResult, type ConsultSynthesis, type ConventionCitation, type ConventionFileEntry, type ConventionManifest, type ConventionReader, type Coverage, type CoverageFileEntry, type CoveragePolicy, type Critique, type CritiqueStance, DEFAULT_COVERAGE_CEILING, DEFAULT_OBJECTIVE, DEFAULT_POSTURE, DEFAULT_VOICE_TIMEOUT_MS$1 as DEFAULT_VOICE_TIMEOUT_MS, type DepManifestHit, type DepSurfaceResult, type DiffMode, type DiffReviewReason, type DiffReviewReceipt, type DiffReviewState, type DivergencePoint, ENSEMBLE_CONFIG_PATH, EVIDENCE_CLASSES, EVIDENCE_MANIFEST_FILE, EVIDENCE_MANIFEST_SCHEMA_VERSION, EVIDENCE_SEATS, type EvidenceClass, type EvidenceGap, type EvidenceManifest, type EvidenceMap, type EvidenceSeat, type FileDiff, type FileKind, type FixtureAnchor, type FixtureScore, GROK_CLI_SANDBOX, GROK_SANDBOX_PROFILE, type GatherConfig, type GatheredConventions, type GhResult, type GhRunner, type GitRun, type GitRunAsync, HARNESS_SEATS, HOLISTIC_DEFAULTS, HOLISTIC_MIN_ANCHOR_NONWS, HOLISTIC_SEAT_ID, HOLISTIC_SEVERITY_CAP, type HarnessSeat, type HolisticEntry, type HolisticFixture, type HolisticPlan, type HolisticPolicyDeps, type HolisticPromptArgs, type HolisticProvenance, type HolisticRunner, type HolisticSite, type HolisticSiteRole, IMPLEMENTED_MODES, type Idea, type InlineSecretHit, MDNS_RESPONDER_SOCKET, MODES, MODE_ALIASES, type ManifestBlob, type ModeName, type NearMiss, type OmitReason, POLICY_VERSIONS, POLICY_VERSION_EVIDENCE, POLICY_VERSION_LEGACY, type ParsedCritique, type ParsedIdeas, type ParsedSynthesis, type PeerReviewerRecord, type PendingState, type PersistReviewInput, type PlacedFinding, type PlantedPositive, type PolicyHashInputs, type PostingPosture, type PrPushContext, type PreflightError, type PreflightErrorKind, type PushFenceVerdict, QUALIFY_PROBE_PORT, QUALITY_LENS, REVIEWERS_FILE, REVIEWER_DEFAULTS, REVIEW_ADAPTERS, REVIEW_TIMEOUT_MS, type RankedIdea, type RawIdea, type ReceiptCoverage, type ReceiptKey, type RepoLocation, type ReviewEvidence, ReviewFinding, type ReviewModeOptions, type ReviewModeResult, ReviewPacket, ReviewProfile, type ReviewSummary, ReviewerConfig, type ReviewerExecOpts, type ReviewerExecResult, ReviewerId, type RiskyImportHit, type RunHolisticLensOptions, type RunReviewOpts, SANDBOX_WRITABLE_TMP, STAGE_MARKER, SUGGESTION_HARD_CAP, type SandboxProfileMap, type SandboxProfileRef, type ScoredFinding, type SecretScanResult, type SensitivePathHit, Severity, type SiteCheck, type SiteReader, type StageCounts, type StageFailure, type StagePlan, type StageResult, type StageSuccess, type StageTarget, type StagedComment, type StagedReviewPayload, StoredReview, type SummaryBodyInput, type SynthesisResult, TerminalState, UNTRUSTED_INSTRUCTIONS_CLAUSE, VOICES_FILE, VOICE_ADAPTERS, VOICE_DEFAULTS, VOICE_IDS, type VoiceAnswerResult, type VoiceConfig, type VoiceCritiqueResult$1 as VoiceCritiqueResult, type VoiceGenerateResult, type VoiceId, type VoiceRunResult, WORKTREE_LOCK_ERROR, type Worktree, type WorktreeEvidence, acquireDiff, acquireRepoLock, acquireRepoLockAsync, allowedRootsFromConfig, applyHolisticPolicy, asRecord, buildClaudeReviewArgs, buildClaudeVoiceArgs, buildCodexReviewArgs, buildCodexWorktreeArgs, buildDiffReceipt, buildEvidenceManifest, buildGrokReviewArgs, buildStagedReviewPayload, canonicalizeDiff, capHolisticSeverity, checkFreshness, classifyFileKind, classifyGitError, classifyPending, claudeWorktreePromptSuffix, codexSandboxSupported, computeCoverage, computePolicyHash, computePolicyHashAt, index as consult, coverageCounts, coverageShortfall, defaultCodexSandboxPaths, defaultReceiptStore, defuseUntrusted, diffDigest, ensureSandboxProfile, escapesRoot, evaluatePushFence, evidenceShortfall, extractGrokText, extractRefs, fallbackSynthesis$1 as fallbackSynthesis, findQuoteSpan, findQuoteSpans, findingTrailer, formatEvidenceShortfall, fsConventionReader, gatherConventions, hasDepSurface, holisticCapWasLifted, homeReadDenyRules, isCommitSha, isConventionsDoc, isDiffReviewed, isEnsembleStagedReview, isEvidenceClass, isEvidenceSeat, isHolisticRecord, isImplemented, isMode, isPolicyVersion, isPreflightError, isStrippedPath, isUnsafeReadRoot, isVoiceId, keyOf, killTree, listReviewers, listVoices, loadHolisticFixture, loadHolisticSeat, loadPostingPosture, loadReviewers, loadVoices, makeEscalatingKill, makeNeutralSeatCwd, makeOwnerOnlyTempDir, materializeWorktree, materializeWorktreeAsync, materializedDiffClause, meetsInlineFloor, memoryConventionReader, omittedLine, parseConventionCitation, parseCritique, parseDiffFiles, parseHolisticSites, parseIdeas, parseLsTree, parsePushContext, parseReviewSummaries, parseReviewers, parseSynthesis, parseTrailerIds, parseVoiceIds, parseVoices, persistReview, pickSynthesizer$1 as pickSynthesizer, planPlacement, readEnsembleConfig, readOnlyWorktreeClause, readReadableSurface, readReceipt, readReview, readReviewsForRun, reapWorktree, reapWorktreeAsync, receiptIdentityMatches, receiptKeyHash, receiptPath, receiptPolicyVersion, redactUrlCredentials, remoteSlug, renderCodeReviewSeatPrompt, renderCodexSandboxProfile, renderCritiquePrompt, renderGeneratePrompt, renderHolisticPrompt, renderInlineComment, renderSummaryBody, renderSynthesisPrompt, resolveBase, resolveBin, resolveClaudeBin, resolveCodexBin, resolveGrokBin, resolveHolisticPlan, resolveHolisticSeat, resolveInRepo, resolveMode, resolvePolicyVersion, resolvePosture, resolveReceipt, resolveRepoId, resolveRepoLocation, resolveRepoLocationAsync, resolveReviewSandbox, resolveReviewer, reviewDir, rootAllowed, runBrainstormMode, runClaudeReview, runClaudeReviewVoice, runClaudeVoice, runCodexReview, runGrokReview, runHolisticLens, runReviewMode, runReviewerExec, sanitizePathSegment, scanDependencySurface, scanDiffForSecrets, scoreHolisticFixture, sha256Hex, stageReview, stripAgentInstructions, summarizeCoverage, validateReceiptShape, verifyFixtureAnchors, verifySiteAtHead, worktreeReader, wrapWithSandbox, writeCodexSandboxProfile, writeEvidenceManifest, writeReceipt, writeTrailFile };
