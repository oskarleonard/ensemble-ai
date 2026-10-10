import { companionsClause } from './companions';
import { HISTORY_PACKET_CLAUSE } from './history-packet';
import {
  conventionsFileClause,
  readOnlyWorktreeClause,
  UNTRUSTED_INSTRUCTIONS_CLAUSE,
} from './worktree';

// THE INTEGRATION SEAT (2026-10-10 architecture review, item 5): the reviewer whose job is the
// seams. A review in parts hands every seat one part; the holistic lens asks "does this fit the
// codebase"; the probe runs it. Nobody asked "do the PARTS fit EACH OTHER, and what do they break
// elsewhere" — the contract changed in part 2 and its consumer in part 4, the guard added in one
// handler and missing in its sibling, the rename half done, the behavior changed with no test
// changed. This seat reads the whole change at signature resolution (the skeleton), the seam notes,
// and the tree at the head, and reports exactly that class of finding.
//
// ONE seat, Anthropic (the vendor seats' quota is the reading seats'); its findings go through the
// same gate as every other voice and are grounded against the union of the parts' hunks. Like the
// lens it never runs without a worktree: an integration claim from a seat that cannot open the
// files is the confidently-wrong comment this engine exists to prevent.

export const INTEGRATION_SEAT_ID = 'integration';

const SCHEMA_BLOCK = `{"summary":"<one sentence: what you checked across the parts and what you found>","findings":[{"title":"<short>","body":"<the two sides of the seam as path:line at the PR head, what disagrees, and what breaks>","severity":"high|medium|low","confidence":"high|medium|low","evidence":{"file":"<a file this PR changes>","line":<number>}}]}`;

export interface IntegrationPromptArgs {
  baseSha: string;
  conventionsPath?: string;
  headSha: string;
  history?: boolean;
  // The change listing: every part and its files, every omitted file (chunks.ts renderLensScope).
  scope: string;
  // The whole change at signature resolution (skeleton.ts renderSkeleton).
  skeleton: string;
  worktree: string;
}

export function renderIntegrationPrompt(args: IntegrationPromptArgs): string {
  const history = args.history ? `\n\n${HISTORY_PACKET_CLAUSE}` : '';
  return `You are the INTEGRATION seat of a multi-model code review, reviewing someone else's pull
request. Read-only: you may not edit, stage, or push anything. You have NO shell and NO network:
there is no Bash tool, so do not try to run \`git\` or any command.

${readOnlyWorktreeClause({ headSha: args.headSha, reach: 'read every file you need', worktree: args.worktree })}

The change is \`git diff ${args.baseSha}...${args.headSha}\`. It was too large for one reviewer prompt, so
the other reviewers each read ONE PART of it. You read the WHOLE change at signature resolution —
the skeleton below — plus the listing of every part, and you open the files at the PR head for
anything below that level. Your job is what no part-reader could see: whether the parts fit EACH
OTHER and what the change breaks elsewhere.

## The change, part by part

${args.scope}

## The whole change as a skeleton

${args.skeleton}

${UNTRUSTED_INSTRUCTIONS_CLAUSE}${companionsClause()}${args.conventionsPath ? conventionsFileClause(args.conventionsPath) : ''}${history}

## What to look for — ONLY these classes

1. CONTRACT DRIFT across parts: a request/response shape, schema, migration, enum, route, event or
   config changed in one place and a producer/consumer of it in another place (changed or NOT
   changed in this PR) that no longer agrees. Open both sides. Name both path:line.
2. HALF-DONE CHANGES: a rename, a new required field, a new variant, a new error code — applied in
   some sites and missing in others (switch/case sites, serializers, fixtures, docs the code cites,
   generated clients that were not regenerated).
3. GUARDS AND INVARIANTS applied unevenly: a check added in one handler/service/path and absent in
   a sibling that handles the same input.
4. BEHAVIOR CHANGED WITH NO TEST: a changed function whose tests were not touched, a fixture that
   never sets a newly added field, a test that pins the OLD behavior and still passes only because
   it no longer exercises the changed path.
5. REGRESSION RISK OUTSIDE THE DIFF: an unchanged caller/consumer in the tree that the change
   breaks (open it; cite its path:line at the head).

Never report style, naming, formatting, or a bug visible inside one part's hunks alone — the part
reviewers own those. Every finding MUST name at least two sites as \`path:line\` as they exist at
${args.headSha}, with the \`evidence\` object pointing at a file THIS PR changes. If the sites agree once you
read them, do not file it. Finding nothing is a legitimate outcome: say what seams you checked.

Your FINAL output must end with exactly one fenced \`\`\`json block, and no other json block, in this
schema:
${SCHEMA_BLOCK}`;
}
