import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isUnder } from '../core/artifacts';

import { setContextBudget as setBrainstormBudget } from './brainstorm/prompt';
import { setContextBudget as setConsultBudget } from './consult/prompt';

// THE EVIDENCE ROOT for brainstorm / consult (`--evidence-root <dir>`, 2026-10-09 — hugin spec
// doc-review-evidence §3). A directory of RAW evidence a caller sealed beside the document under
// review (its linked pages, the ticket, the discussion, prior reviews, the code pinned at a commit)
// that EVERY voice reads on EVERY call behind the review seats' fences: codex and grok through their
// worktree runners with the root as the read root, claude through the capability fence (neutral cwd,
// `--add-dir`, no MCP, no Bash, no WebFetch, the home-read deny). The prompt inlines the document in
// full plus the root's INDEX.md and the citation contract; the voices go read the rest.

export const EVIDENCE_CONTEXT_BUDGET = 120_000;
export const EVIDENCE_INDEX_BUDGET = 8_000;

export const EVIDENCE_CONTRACT = `The directory granted to you is the EVIDENCE for this review — read what you need from it
(its INDEX is below). START every point with the section (§n) it concerns AND cite the evidence
path(s) you checked (\`notion/…\`, \`linear/…\`, \`reviews/…\`, \`code/…\`, \`doc.md\`). If a thread, a
page or a prior ruling already settles the point, write \`settled: <path>\` and raise it only if
you disagree — then say what the evidence missed. A claim about code must name the file you read.`;

export interface EvidenceRootInfo {
  root: string;
  index: string | null;
}

// Validate and read the root: absolute, an existing directory, NOT under the home directory (the
// claude fence's home-read deny would deny the root itself — the same rule as a review worktree).
export function openEvidenceRoot(dir: string, home: string = os.homedir()): EvidenceRootInfo {
  if (!path.isAbsolute(dir)) throw new Error(`--evidence-root must be an absolute path (got ${dir})`);
  let root: string;
  try {
    root = fs.realpathSync(dir);
  } catch {
    throw new Error(`--evidence-root ${dir} does not exist`);
  }
  if (!fs.statSync(root).isDirectory()) throw new Error(`--evidence-root ${dir} is not a directory`);
  if (root === home || isUnder(root, home))
    throw new Error(
      `--evidence-root ${root} is inside the home directory — the claude seat's home-read deny would deny it; seal the evidence outside $HOME`
    );
  let index: string | null = null;
  try {
    index = fs.readFileSync(path.join(root, 'INDEX.md'), 'utf8').slice(0, EVIDENCE_INDEX_BUDGET);
  } catch {
    index = null;
  }
  return { root, index };
}

// The shared context every prompt carries behind an evidence root: the file (the document, in
// full) followed by the contract and the index. Raises both modes' context budget so the block is
// never truncated at the old 24,000-char cap.
export function composeEvidenceContext(fileContext: string | undefined, info: EvidenceRootInfo): string {
  setBrainstormBudget(EVIDENCE_CONTEXT_BUDGET);
  setConsultBudget(EVIDENCE_CONTEXT_BUDGET);
  const doc = fileContext?.trimEnd() ?? '';
  const index = info.index ? `\n### Evidence index (${path.basename(info.root)}/INDEX.md)\n${info.index.trimEnd()}\n` : '\n(the evidence root has no INDEX.md — list the directory)\n';
  return `${doc}\n\n## Evidence root\n${EVIDENCE_CONTRACT}\n${index}`;
}
