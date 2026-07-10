import { b as ReviewFinding, d as Severity, c as ReviewPacket, P as PacketSection } from './types-eYT8NZq_.js';

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

export { DIFF_SECTION_TITLE as D, FINDINGS_INSTRUCTIONS as F, PACKET_BUDGETS as P, type ReviewProfile as R, SECURITY_CLASSES as S, TRUNCATION_MARKER_RE as T, DIFF_USEFUL_FLOOR as a, type PacketInput as b, type ParsedReview as c, REVIEW_PROFILES as d, SECURITY_OBJECTIVE as e, SEVERITY_LABEL as f, SEVERITY_ORDER as g, type SecurityClass as h, assembleCodePacket as i, classifySecurityFinding as j, evidenceRef as k, extractJsonBlock as l, isReviewProfile as m, reviewerVisibleDiff as n, oneOf as o, parseFindings as p, securityClassLabel as q, renderReviewPrompt as r, section as s, segmentsWithoutTruncationSplices as t, stripSecurityTag as u };
