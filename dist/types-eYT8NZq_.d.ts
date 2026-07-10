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

export { CONFIDENCES as C, type Evidence as E, type ManifestEntry as M, type PacketSection as P, type ReviewerId as R, type StoredReview as S, type TerminalState as T, type ReviewerConfig as a, type ReviewFinding as b, type ReviewPacket as c, type Severity as d, CORE_REVIEWER_IDS as e, type Confidence as f, type CoreReviewerId as g, REVIEWER_IDS as h, SEVERITIES as i, TERMINAL_STATES as j, isCoreReviewerId as k, isReviewerId as l, parseReviewerIds as p, titleCase as t };
