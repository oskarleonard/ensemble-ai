#!/usr/bin/env node
declare function resolveTrailBase(gitRoot: string | null, localRepoTrail: boolean): string;
declare function main(argv: string[]): Promise<number>;

export { main, resolveTrailBase };
