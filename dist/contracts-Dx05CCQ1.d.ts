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

export { oneOf as A, parseFindings as B, CONFIDENCES as C, DIFF_SECTION_TITLE as D, type Evidence as E, FINDINGS_INSTRUCTIONS as F, parseReviewerIds as G, renderReviewPrompt as H, reviewerVisibleDiff as I, section as J, securityClassLabel as K, segmentsWithoutTruncationSplices as L, type ManifestEntry as M, stripSecurityTag as N, titleCase as O, PACKET_BUDGETS as P, type ReviewerId as R, type StoredReview as S, type TerminalState as T, type ReviewerConfig as a, type ReviewFinding as b, type ReviewPacket as c, type ReviewProfile as d, type Confidence as e, DIFF_USEFUL_FLOOR as f, type PacketInput as g, type PacketSection as h, type ParsedReview as i, REVIEWER_IDS as j, REVIEW_PROFILES as k, SECURITY_CLASSES as l, SECURITY_OBJECTIVE as m, SEVERITIES as n, SEVERITY_LABEL as o, SEVERITY_ORDER as p, type SecurityClass as q, type Severity as r, TERMINAL_STATES as s, TRUNCATION_MARKER_RE as t, assembleCodePacket as u, classifySecurityFinding as v, evidenceRef as w, extractJsonBlock as x, isReviewProfile as y, isReviewerId as z };
