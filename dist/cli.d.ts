#!/usr/bin/env node
import { R as ReviewerId } from './types-C3UqNOM8.js';
import { R as ResolvedVoiceConfig } from './types-DpTj1RQa.js';

type SeatSource = 'flag' | 'file' | 'default';
type GateVendor = 'anthropic' | 'codex';
interface GateSeat {
    config: ResolvedVoiceConfig;
    effortSource: SeatSource;
    modelSource: SeatSource;
    vendor: GateVendor;
    vendorSource: SeatSource;
}

interface CommentGateSeat {
    advisor?: string;
    effort: string;
    effortSource: string;
    model: string;
    modelSource: string;
}

declare function resolveTrailBase(gitRoot: string | null, localRepoTrail: boolean): string;
declare function toCommentGateSeat(seat: GateSeat): CommentGateSeat;
declare function resolveOptionalReviewers(raw: string | boolean | undefined, rosterCore: readonly ReviewerId[], cmd: string): ReviewerId[] | {
    code: number;
};
declare function parseRequiredReviewers(raw: string | undefined, cmd: string, defaultIds: readonly ReviewerId[]): ReviewerId[] | {
    code: number;
};
declare function main(argv: string[]): Promise<number>;

export { main, parseRequiredReviewers, resolveOptionalReviewers, resolveTrailBase, toCommentGateSeat };
