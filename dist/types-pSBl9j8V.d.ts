declare const CORE_REVIEWER_IDS: readonly ["codex", "grok"];
type CoreReviewerId = (typeof CORE_REVIEWER_IDS)[number];
declare const REVIEWER_IDS: readonly ["codex", "grok", "claude"];
type ReviewerId = (typeof REVIEWER_IDS)[number];
declare function isReviewerId(v: unknown): v is ReviewerId;
declare function isCoreReviewerId(v: unknown): v is CoreReviewerId;
declare function titleCase(id: string): string;
declare function parseReviewerIds(raw: unknown): ReviewerId[] | undefined;
interface ReviewerConfig {
    advisor?: string;
    cmd: string;
    disabledUntil?: string;
    effort: string;
    enabled?: boolean;
    id: ReviewerId;
    model: string;
    sandbox?: string;
    vendor: string;
}
declare function parseSeatWindow(v: unknown): string | undefined;
declare const ADVISOR_OFF = "off";
declare const ADVISOR_MODEL_RE: RegExp;
declare function isSeatAdvisor(v: unknown): v is string;
declare function parseSeatAdvisor(v: unknown, seat: string): string | undefined;
declare function enabledReviewerIds(config: Record<ReviewerId, ReviewerConfig>, now?: Date): ReviewerId[];
declare const SEVERITIES: readonly ["high", "medium", "low"];
type Severity = (typeof SEVERITIES)[number];
declare function severityAtLeast(severity: Severity, floor: Severity): boolean;
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
    diagnostics?: SeatDiagnostics;
    findings: ReviewFinding[];
    packet: {
        complete: boolean;
        manifest: ManifestEntry[];
    };
    reviewer: {
        advisor?: string;
        effort: string;
        model: string;
        vendor: string;
    };
    reviewerId?: ReviewerId;
    runId: string;
    summary: string;
    terminalState: TerminalState;
}
interface SeatDiagnostics {
    elapsedMs: number;
    endedAt: string;
    failWhy?: string;
    startedAt: string;
    stderrTail: string;
    timedOutReason?: 'absolute' | 'inactivity';
}

export { ADVISOR_MODEL_RE as A, CONFIDENCES as C, type Evidence as E, type ManifestEntry as M, type PacketSection as P, type ReviewerId as R, type StoredReview as S, type TerminalState as T, type ReviewerConfig as a, type ReviewFinding as b, type Severity as c, type SeatDiagnostics as d, type ReviewPacket as e, ADVISOR_OFF as f, CORE_REVIEWER_IDS as g, type Confidence as h, type CoreReviewerId as i, REVIEWER_IDS as j, SEVERITIES as k, TERMINAL_STATES as l, enabledReviewerIds as m, isCoreReviewerId as n, isReviewerId as o, parseSeatAdvisor as p, isSeatAdvisor as q, parseReviewerIds as r, parseSeatWindow as s, severityAtLeast as t, titleCase as u };
