import { ReviewerId, ReviewerConfig, ReviewFinding, ReviewPacket, TerminalState, StoredReview } from './contracts.js';
export { CONFIDENCES, Confidence, DIFF_USEFUL_FLOOR, Evidence, FINDINGS_INSTRUCTIONS, ManifestEntry, PACKET_BUDGETS, PacketInput, PacketSection, ParsedReview, REVIEWER_IDS, SEVERITIES, Severity, TERMINAL_STATES, assembleCodePacket, extractJsonBlock, isReviewerId, parseFindings, parseReviewerIds, renderReviewPrompt, section, titleCase } from './contracts.js';

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

type DiffMode = 'commit' | 'working-tree' | 'raw';
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
    diffText?: string;
    workingTree?: boolean;
}
declare function acquireDiff(opts: AcquireDiffOpts): AcquiredDiff;

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
declare function writeReceipt(storeDir: string, receipt: DiffReviewReceipt): string;
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
    diffText?: string;
    objective?: string;
    onProgress?: (msg: string) => void;
    out: string;
    receiptStore?: string;
    reviewers?: ReviewerId[];
    reviewersFile?: string;
    runId: string;
    sandbox?: string;
    workingTree?: boolean;
}
interface ReviewModeResult {
    acquired: AcquiredDiff;
    blocked: boolean;
    blockedReason?: string;
    receipt?: DiffReviewReceipt;
    receiptError?: string;
    receiptPath?: string;
    reviews: StoredReview[];
    secretScan: SecretScanResult;
}
declare function runReviewMode(opts: ReviewModeOptions): Promise<ReviewModeResult>;

declare const MODES: readonly ["review", "brainstorm", "security"];
type ModeName = (typeof MODES)[number];
declare const IMPLEMENTED_MODES: readonly ModeName[];
declare function isMode(v: string): v is ModeName;
declare function isImplemented(mode: ModeName): boolean;

export { type AcquireDiffOpts, type AcquiredDiff, type BuildReceiptResult, type CodexReviewResult, type Coverage, type CoverageFileEntry, type CoveragePolicy, DEFAULT_COVERAGE_CEILING, type DiffMode, type DiffReviewReason, type DiffReviewReceipt, type DiffReviewState, type FileDiff, type FileKind, IMPLEMENTED_MODES, type InlineSecretHit, MODES, type ModeName, type OmitReason, type PersistReviewInput, REVIEWERS_FILE, REVIEWER_DEFAULTS, REVIEW_ADAPTERS, REVIEW_TIMEOUT_MS, type ReceiptCoverage, type ReceiptKey, ReviewFinding, type ReviewModeOptions, type ReviewModeResult, ReviewPacket, ReviewerConfig, type ReviewerExecOpts, type ReviewerExecResult, ReviewerId, type RunReviewOpts, type SecretScanResult, type SensitivePathHit, StoredReview, TerminalState, acquireDiff, buildCodexReviewArgs, buildDiffReceipt, buildGrokReviewArgs, canonicalizeDiff, classifyFileKind, computeCoverage, computePolicyHash, coverageShortfall, defaultReceiptStore, diffDigest, ensureSandboxProfile, extractGrokText, isDiffReviewed, isImplemented, isMode, keyOf, killTree, listReviewers, loadReviewers, makeEscalatingKill, parseDiffFiles, parseReviewers, persistReview, readReceipt, readReview, readReviewsForRun, receiptKeyHash, receiptPath, resolveBase, resolveBin, resolveCodexBin, resolveGrokBin, resolveRepoId, resolveReviewSandbox, resolveReviewer, reviewDir, runCodexReview, runGrokReview, runReviewMode, runReviewerExec, sanitizePathSegment, scanDiffForSecrets, sha256Hex, summarizeCoverage, writeReceipt };
