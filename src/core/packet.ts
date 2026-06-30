import type { PacketSection, ReviewPacket } from './types';

// Per-section character budgets — bound the prompt BY CONSTRUCTION (the
// "prompt-too-big" risk). Windows are large now, so these are generous, but the
// diff is the signal: it gets the lion's share and surrounding context is capped
// so it can't drown it.
export const PACKET_BUDGETS = {
  agents: 12_000,
  constraints: 4_000,
  diff: 120_000,
  files: 40_000,
  history: 4_000,
  objective: 2_000,
  summary: 4_000,
  tests: 8_000,
} as const;

// Below this many diff chars after truncation the reviewer is too blind to
// trust → the packet is marked incomplete (a gate trigger).
export const DIFF_USEFUL_FLOOR = 200;

export interface PacketInput {
  agentsMd?: string; // the repo's AGENTS.md (conventions / footguns)
  authorSummary?: string; // the author's own summary of what the change does/why
  constraints?: string; // known constraints the change must respect
  diff: string; // git diff under review (REQUIRED — the change itself)
  directive?: string; // the original directive / PR description
  objective: string; // why this review was fired
  pr: number;
  repo: string;
  runHistory?: string; // recent run-log lines for this repo
  surroundingFiles?: string; // full content of the changed files, pre-joined
  testOutput?: string; // the author's test run output / result
}

// Keep the head + a tail so a budget cut never hides the end of a file/diff.
// Internal to section().
function truncate(
  text: string,
  budget: number
): { text: string; truncated: boolean } {
  if (text.length <= budget) return { text, truncated: false };
  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  return {
    text: `${text.slice(0, head)}\n\n…[${text.length - budget} chars truncated]…\n\n${text.slice(-tail)}`,
    truncated: true,
  };
}

// Exported so other review profiles reuse the SAME manifested-section +
// bounded-truncation rule — one truncation policy across every profile, not a
// re-derived copy that could drift.
export function section(
  title: string,
  why: string,
  body: string,
  budget: number
): PacketSection {
  const present = body.trim().length > 0;
  const cut = present ? truncate(body, budget) : { text: '', truncated: false };
  const note = !present
    ? `${why} — UNAVAILABLE`
    : cut.truncated
      ? `${why} (truncated to ${budget} chars)`
      : why;
  return {
    body: cut.text,
    included: present,
    note,
    title,
    truncated: cut.truncated,
  };
}

// PURE: assemble a bounded, manifested code-review packet from gathered inputs.
// Every section states WHY it's there + whether it was truncated (the manifest),
// so a UI can prove what the reviewer saw. `complete` is false when the diff —
// the one REQUIRED item — is absent or truncated below the usefulness floor; the
// host gate then surfaces it (a blind review isn't trustworthy). A pure function
// of its inputs precisely so it is exhaustively unit-testable — the single
// highest-leverage piece of the architecture.
export function assembleCodePacket(input: PacketInput): ReviewPacket {
  const sections: PacketSection[] = [
    section(
      'Objective',
      'why this review was fired',
      input.objective,
      PACKET_BUDGETS.objective
    ),
  ];
  // Supplementary context (directive, author summary) — only added when the
  // caller supplies it; its absence isn't notable, unlike the always-expected
  // diff/files/AGENTS below (whose absence IS recorded as UNAVAILABLE).
  if (input.directive) {
    sections.push(
      section(
        'Original directive / PR description',
        "the author's stated intent",
        input.directive,
        PACKET_BUDGETS.objective
      )
    );
  }
  if (input.authorSummary) {
    sections.push(
      section(
        'Author summary',
        'what the author says the change does + why — weigh, don’t trust',
        input.authorSummary,
        PACKET_BUDGETS.summary
      )
    );
  }
  const diff = section(
    'The diff under review',
    'the change itself — review THIS, not the whole repo',
    input.diff,
    PACKET_BUDGETS.diff
  );
  sections.push(
    diff,
    section(
      'Changed files (full content)',
      'surrounding context for the diff hunks',
      input.surroundingFiles ?? '',
      PACKET_BUDGETS.files
    ),
    section(
      'Repo conventions (AGENTS.md)',
      'house rules + known footguns the change must respect',
      input.agentsMd ?? '',
      PACKET_BUDGETS.agents
    )
  );
  if (input.constraints) {
    sections.push(
      section(
        'Known constraints',
        'constraints the change must respect',
        input.constraints,
        PACKET_BUDGETS.constraints
      )
    );
  }
  if (input.testOutput) {
    sections.push(
      section(
        'Test output',
        "the author's test run — does the change pass?",
        input.testOutput,
        PACKET_BUDGETS.tests
      )
    );
  }
  sections.push(
    section(
      'Recent run history',
      'what was fired against this repo lately',
      input.runHistory ?? '',
      PACKET_BUDGETS.history
    )
  );
  return {
    complete: diff.included && diff.body.length >= DIFF_USEFUL_FLOOR,
    objective: input.objective,
    pr: input.pr,
    repo: input.repo,
    sections,
  };
}
