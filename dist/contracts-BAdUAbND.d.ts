import { b as ReviewFinding, c as Severity, e as ReviewPacket, P as PacketSection } from './types-aXkKFhdq.js';

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

declare const FINDINGS_INSTRUCTIONS = "## Output format \u2014 STRICT\nRespond with ONE fenced ```json block and NOTHING else, matching:\n{\n  \"summary\": \"<one short paragraph: your overall read of the change>\",\n  \"findings\": [\n    {\n      \"title\": \"<short title>\",\n      \"body\": \"<the issue, why it matters, and the suggested fix>\",\n      \"severity\": \"high\" | \"medium\" | \"low\",\n      \"confidence\": \"high\" | \"medium\" | \"low\",\n      \"evidence\": { \"file\": \"<a path from the diff>\", \"line\": <number, or omit>, \"detail\": \"<optional>\" }\n    }\n  ]\n}\nRules: cite a concrete file in every finding's \"evidence\" (an uncited finding is\ndiscounted). \"severity\" = the impact IF the finding is real; \"confidence\" = how\nsure you are it is real. If the change looks correct, return an empty \"findings\"\narray with a \"summary\" that says so. Do not invent issues to fill the list. You\nsee one diff, not the project's tracker: never assert a change is out-of-scope or\nunsanctioned \u2014 state the code-level consequence and, at most, note the commit\nboundary.";
interface ParsedReview {
    findings: ReviewFinding[];
    parseError?: string;
    summary: string;
}
declare function oneOf<T extends string>(set: readonly T[], v: unknown, fallback: T): T;
declare const SEVERITY_LABEL: Record<Severity, string>;
declare const SEVERITY_ORDER: Severity[];
declare function evidenceRef(file: string | undefined, line: number | null | undefined, scrub?: (s: string) => string): string;
declare function stripTrailingCommas(s: string): string;
declare function escapeRawNewlinesInStrings(s: string): string;
declare function extractJsonBlock(raw: string): unknown;
declare function parseFindings(raw: string): ParsedReview;

declare const PACKET_BUDGETS: {
    readonly agents: 12000;
    readonly ci: 16000;
    readonly constraints: 4000;
    readonly diff: 200000;
    readonly files: 40000;
    readonly history: 4000;
    readonly objective: 2000;
    readonly scope: 64000;
    readonly summary: 4000;
    readonly tests: 8000;
};
declare const DIFF_USEFUL_FLOOR = 200;
interface PacketInput {
    agentsBudget?: number;
    agentsMd?: string;
    authorSummary?: string;
    ciEvidence?: string;
    ciEvidenceUnavailable?: string;
    constraints?: string;
    diff: string;
    diffBudget?: number;
    directive?: string;
    objective: string;
    pr: number;
    repo: string;
    runHistory?: string;
    scope?: string;
    surroundingFiles?: string;
    testOutput?: string;
}
declare const TRUNCATION_MARKER_RE: RegExp;
declare function segmentsWithoutTruncationSplices(body: string): string[];
declare function section(title: string, why: string, body: string, budget: number): PacketSection;
declare const DIFF_SECTION_TITLE = "The diff under review";
declare const SCOPE_SECTION_TITLE = "Change scope (this review runs in parts)";
declare const CI_EVIDENCE_SECTION_TITLE = "CI evidence (checks + annotations at the PR head)";
declare function reviewerVisibleDiff(packet: ReviewPacket): {
    text: string;
    truncated: boolean;
};
declare function assembleCodePacket(input: PacketInput): ReviewPacket;

declare function renderReviewPrompt(packet: ReviewPacket, profile?: ReviewProfile): string;

export { CI_EVIDENCE_SECTION_TITLE as C, DIFF_SECTION_TITLE as D, FINDINGS_INSTRUCTIONS as F, PACKET_BUDGETS as P, type ReviewProfile as R, SCOPE_SECTION_TITLE as S, TRUNCATION_MARKER_RE as T, DIFF_USEFUL_FLOOR as a, type PacketInput as b, type ParsedReview as c, REVIEW_PROFILES as d, SECURITY_CLASSES as e, SECURITY_OBJECTIVE as f, SEVERITY_LABEL as g, SEVERITY_ORDER as h, type SecurityClass as i, assembleCodePacket as j, classifySecurityFinding as k, escapeRawNewlinesInStrings as l, evidenceRef as m, extractJsonBlock as n, isReviewProfile as o, oneOf as p, parseFindings as q, renderReviewPrompt as r, reviewerVisibleDiff as s, section as t, securityClassLabel as u, segmentsWithoutTruncationSplices as v, stripSecurityTag as w, stripTrailingCommas as x };
