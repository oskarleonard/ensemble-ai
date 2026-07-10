declare const CORE_REVIEWER_IDS: readonly ["codex", "grok"];
type CoreReviewerId = (typeof CORE_REVIEWER_IDS)[number];
declare const REVIEWER_IDS: readonly ["codex", "grok", "claude"];
type ReviewerId = (typeof REVIEWER_IDS)[number];
declare function isReviewerId(v: unknown): v is ReviewerId;
declare function isCoreReviewerId(v: unknown): v is CoreReviewerId;
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
interface ManifestEntry {
    included: boolean;
    note: string;
    title: string;
    truncated: boolean;
}
interface StoredReview {
    findings: ReviewFinding[];
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
declare function oneOf<T extends string>(set: readonly T[], v: unknown, fallback: T): T;
declare const SEVERITY_LABEL: Record<Severity, string>;
declare const SEVERITY_ORDER: Severity[];
declare function evidenceRef(file: string | undefined, line: number | null | undefined, scrub?: (s: string) => string): string;
declare function extractJsonBlock(raw: string): unknown;
declare function parseFindings(raw: string): ParsedReview;

declare const PACKET_BUDGETS: {
    readonly agents: 12000;
    readonly constraints: 4000;
    readonly diff: 200000;
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
declare const TRUNCATION_MARKER_RE: RegExp;
declare function segmentsWithoutTruncationSplices(body: string): string[];
declare function section(title: string, why: string, body: string, budget: number): PacketSection;
declare const DIFF_SECTION_TITLE = "The diff under review";
declare function reviewerVisibleDiff(packet: ReviewPacket): {
    text: string;
    truncated: boolean;
};
declare function assembleCodePacket(input: PacketInput): ReviewPacket;

declare const REVIEW_PROFILES: readonly ["code", "security"];
type ReviewProfile = (typeof REVIEW_PROFILES)[number];
declare function isReviewProfile(v: string): v is ReviewProfile;
declare const SECURITY_OBJECTIVE: string;
interface SecurityClass {
    id: string;
    keywords: string[];
    label: string;
}
declare const SECURITY_CLASSES: SecurityClass[];
declare function classifySecurityFinding(f: Pick<ReviewFinding, 'body' | 'title'>): string;
declare function stripSecurityTag(title: string): string;
declare function securityClassLabel(id: string): string;

declare function renderReviewPrompt(packet: ReviewPacket, profile?: ReviewProfile): string;

export { isCoreReviewerId as A, isReviewProfile as B, CONFIDENCES as C, DIFF_SECTION_TITLE as D, type Evidence as E, FINDINGS_INSTRUCTIONS as F, isReviewerId as G, oneOf as H, parseFindings as I, parseReviewerIds as J, renderReviewPrompt as K, reviewerVisibleDiff as L, type ManifestEntry as M, section as N, securityClassLabel as O, PACKET_BUDGETS as P, segmentsWithoutTruncationSplices as Q, type ReviewerId as R, type StoredReview as S, type TerminalState as T, stripSecurityTag as U, titleCase as V, type ReviewerConfig as a, type ReviewFinding as b, type ReviewPacket as c, type Severity as d, type ReviewProfile as e, CORE_REVIEWER_IDS as f, type Confidence as g, type CoreReviewerId as h, DIFF_USEFUL_FLOOR as i, type PacketInput as j, type PacketSection as k, type ParsedReview as l, REVIEWER_IDS as m, REVIEW_PROFILES as n, SECURITY_CLASSES as o, SECURITY_OBJECTIVE as p, SEVERITIES as q, SEVERITY_LABEL as r, SEVERITY_ORDER as s, type SecurityClass as t, TERMINAL_STATES as u, TRUNCATION_MARKER_RE as v, assembleCodePacket as w, classifySecurityFinding as x, evidenceRef as y, extractJsonBlock as z };
