#!/usr/bin/env node
import { R as ReviewerId } from './types-BgkvZyao.js';

declare function resolveTrailBase(gitRoot: string | null, localRepoTrail: boolean): string;
declare function resolveOptionalReviewers(raw: string | boolean | undefined, rosterCore: readonly ReviewerId[], cmd: string): ReviewerId[] | {
    code: number;
};
declare function parseRequiredReviewers(raw: string | undefined, cmd: string, defaultIds: readonly ReviewerId[]): ReviewerId[] | {
    code: number;
};
declare function main(argv: string[]): Promise<number>;

export { main, parseRequiredReviewers, resolveOptionalReviewers, resolveTrailBase };
