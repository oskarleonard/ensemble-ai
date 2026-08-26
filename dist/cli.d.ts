#!/usr/bin/env node
import { R as ReviewerId } from './types-AjF_QubX.js';

declare function resolveTrailBase(gitRoot: string | null, localRepoTrail: boolean): string;
declare function parseRequiredReviewers(raw: string | undefined, cmd: string, defaultIds: readonly ReviewerId[]): ReviewerId[] | {
    code: number;
};
declare function main(argv: string[]): Promise<number>;

export { main, parseRequiredReviewers, resolveTrailBase };
