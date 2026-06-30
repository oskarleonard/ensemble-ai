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
declare function section(title: string, why: string, body: string, budget: number): PacketSection;
declare function assembleCodePacket(input: PacketInput): ReviewPacket;

declare function renderReviewPrompt(packet: ReviewPacket): string;

export { CONFIDENCES, type Confidence, DIFF_USEFUL_FLOOR, type Evidence, FINDINGS_INSTRUCTIONS, type ManifestEntry, PACKET_BUDGETS, type PacketInput, type PacketSection, type ParsedReview, REVIEWER_IDS, type ReviewFinding, type ReviewPacket, type ReviewerConfig, type ReviewerId, SEVERITIES, type Severity, type StoredReview, TERMINAL_STATES, type TerminalState, assembleCodePacket, extractJsonBlock, isReviewerId, parseFindings, parseReviewerIds, renderReviewPrompt, section, titleCase };
