declare const REVIEWER_IDS: readonly ["codex", "grok"];
type ReviewerId = (typeof REVIEWER_IDS)[number];
declare function isReviewerId(v: unknown): v is ReviewerId;
declare function titleCase(id: string): string;
declare function parseReviewerIds(raw: unknown): ReviewerId[] | undefined;
interface ReviewerConfig {
    cmd: string;
    effort: string;
    id: ReviewerId;
    model: string;
    sandbox?: string;
    vendor: string;
}
declare const SEVERITIES: readonly ["high", "medium", "low"];
type Severity = (typeof SEVERITIES)[number];
declare const CONFIDENCES: readonly ["high", "medium", "low"];
type Confidence = (typeof CONFIDENCES)[number];
interface Evidence {
    detail?: string;
    file?: string;
    line?: number;
}
interface ReviewFinding {
    body: string;
    confidence: Confidence;
    evidence: Evidence;
    id: string;
    severity: Severity;
    title: string;
    uncited?: boolean;
}
declare const DISPOSITION_VERDICTS: readonly ["accepted", "partially-accepted", "dismissed"];
type DispositionVerdict = (typeof DISPOSITION_VERDICTS)[number];
declare const REASON_CATEGORIES: readonly ["factually-wrong", "out-of-scope", "already-handled", "tradeoff"];
type ReasonCategory = (typeof REASON_CATEGORIES)[number];
interface Disposition {
    findingId: string;
    reason: string;
    reasonCategory?: ReasonCategory;
    verdict: DispositionVerdict;
}
interface PacketSection {
    body: string;
    included: boolean;
    note: string;
    title: string;
    truncated: boolean;
}
interface ReviewPacket {
    complete: boolean;
    objective: string;
    pr: number;
    repo: string;
    sections: PacketSection[];
    subject?: string;
}
declare const TERMINAL_STATES: readonly ["reviewed", "failed-reviewer"];
type TerminalState = (typeof TERMINAL_STATES)[number];
interface ReviewGate {
    reasons: string[];
    surfaceToHuman: boolean;
}
interface ManifestEntry {
    included: boolean;
    note: string;
    title: string;
    truncated: boolean;
}
interface StoredReview {
    dispositions?: Disposition[];
    findings: ReviewFinding[];
    gate?: ReviewGate;
    packet: {
        complete: boolean;
        manifest: ManifestEntry[];
    };
    reviewer: {
        effort: string;
        model: string;
        vendor: string;
    };
    reviewerId?: ReviewerId;
    runId: string;
    summary: string;
    terminalState: TerminalState;
}

declare const FINDINGS_INSTRUCTIONS = "## Output format \u2014 STRICT\nRespond with ONE fenced ```json block and NOTHING else, matching:\n{\n  \"summary\": \"<one short paragraph: your overall read of the change>\",\n  \"findings\": [\n    {\n      \"title\": \"<short title>\",\n      \"body\": \"<the issue, why it matters, and the suggested fix>\",\n      \"severity\": \"high\" | \"medium\" | \"low\",\n      \"confidence\": \"high\" | \"medium\" | \"low\",\n      \"evidence\": { \"file\": \"<a path from the diff>\", \"line\": <number, or omit>, \"detail\": \"<optional>\" }\n    }\n  ]\n}\nRules: cite a concrete file in every finding's \"evidence\" (an uncited finding is\ndiscounted). \"severity\" = the impact IF the finding is real; \"confidence\" = how\nsure you are it is real. If the change looks correct, return an empty \"findings\"\narray with a \"summary\" that says so. Do not invent issues to fill the list.";
interface ParsedReview {
    findings: ReviewFinding[];
    parseError?: string;
    summary: string;
}
declare function extractJsonBlock(raw: string): unknown;
declare function parseFindings(raw: string): ParsedReview;

declare const PACKET_BUDGETS: {
    readonly agents: 12000;
    readonly constraints: 4000;
    readonly diff: 120000;
    readonly files: 40000;
    readonly history: 4000;
    readonly objective: 2000;
    readonly summary: 4000;
    readonly tests: 8000;
};
declare const DIFF_USEFUL_FLOOR = 200;
interface PacketInput {
    agentsMd?: string;
    authorSummary?: string;
    constraints?: string;
    diff: string;
    directive?: string;
    objective: string;
    pr: number;
    repo: string;
    runHistory?: string;
    surroundingFiles?: string;
    testOutput?: string;
}
declare function section(title: string, why: string, body: string, budget: number): PacketSection;
declare function assembleCodePacket(input: PacketInput): ReviewPacket;

declare function renderReviewPrompt(packet: ReviewPacket): string;

declare const REVIEWERS_FILE: string;
declare const REVIEWER_DEFAULTS: Record<ReviewerId, ReviewerConfig>;
declare function parseReviewers(raw: unknown): Record<ReviewerId, ReviewerConfig>;
declare function loadReviewers(file?: string): Record<ReviewerId, ReviewerConfig>;
declare function resolveReviewer(id: ReviewerId, file?: string): ReviewerConfig;
declare function listReviewers(file?: string): ReviewerConfig[];

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
declare function persistDispositions(baseDir: string, runId: string, reviewerId: ReviewerId, dispositions: Disposition[], gate: ReviewGate): StoredReview | null;
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
/** @deprecated use ReviewerExecOpts — kept for any external importer. */
type CodexExecOpts = ReviewerExecOpts;
interface CodexExecResult {
    /** The reply (the -o file, or accumulated stdout) — or null if none produced. */
    raw: string | null;
    stderrTail: string;
    timedOut: boolean;
}
declare function runReviewerExec(opts: ReviewerExecOpts): Promise<CodexExecResult>;
/** @deprecated use runReviewerExec — the spawn primitive is vendor-neutral now. */
declare const runCodexExec: typeof runReviewerExec;

declare function resolveBin(name: string, opts?: {
    candidates?: string[];
    envVar?: string;
}): string;

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
declare function asTrimmed(v: unknown): string | undefined;

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

export { type AcquireDiffOpts, type AcquiredDiff, type BuildReceiptResult, CONFIDENCES, type CodexExecOpts, type CodexExecResult, type CodexReviewResult, type Confidence, type Coverage, type CoverageFileEntry, type CoveragePolicy, DEFAULT_COVERAGE_CEILING, DIFF_USEFUL_FLOOR, DISPOSITION_VERDICTS, type DiffMode, type DiffReviewReason, type DiffReviewReceipt, type DiffReviewState, type Disposition, type DispositionVerdict, type Evidence, FINDINGS_INSTRUCTIONS, type FileDiff, type FileKind, IMPLEMENTED_MODES, type InlineSecretHit, MODES, type ManifestEntry, type ModeName, type OmitReason, PACKET_BUDGETS, type PacketInput, type PacketSection, type ParsedReview, type PersistReviewInput, REASON_CATEGORIES, REVIEWERS_FILE, REVIEWER_DEFAULTS, REVIEWER_IDS, REVIEW_ADAPTERS, REVIEW_TIMEOUT_MS, type ReasonCategory, type ReceiptCoverage, type ReceiptKey, type ReviewFinding, type ReviewGate, type ReviewModeOptions, type ReviewModeResult, type ReviewPacket, type ReviewerConfig, type ReviewerExecOpts, type ReviewerId, type RunReviewOpts, SEVERITIES, type SecretScanResult, type SensitivePathHit, type Severity, type StoredReview, TERMINAL_STATES, type TerminalState, acquireDiff, asTrimmed, assembleCodePacket, buildCodexReviewArgs, buildDiffReceipt, buildGrokReviewArgs, canonicalizeDiff, classifyFileKind, computeCoverage, computePolicyHash, coverageShortfall, defaultReceiptStore, diffDigest, ensureSandboxProfile, extractGrokText, extractJsonBlock, isDiffReviewed, isImplemented, isMode, isReviewerId, keyOf, killTree, listReviewers, loadReviewers, makeEscalatingKill, parseDiffFiles, parseFindings, parseReviewerIds, parseReviewers, persistDispositions, persistReview, readReceipt, readReview, readReviewsForRun, receiptKeyHash, receiptPath, renderReviewPrompt, resolveBase, resolveBin, resolveCodexBin, resolveGrokBin, resolveRepoId, resolveReviewSandbox, resolveReviewer, reviewDir, runCodexExec, runCodexReview, runGrokReview, runReviewMode, runReviewerExec, scanDiffForSecrets, section, summarizeCoverage, titleCase, writeReceipt };
