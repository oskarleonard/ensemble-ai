import { describe, expect, it } from 'vitest';

import { COLD_PEER_ROLE, renderCodeReviewSeatPrompt } from './code-review-seat';

const args = {
  baseSha: 'b'.repeat(40),
  headSha: 'h'.repeat(40),
  diff: 'DIFF BODY LINE',
  worktree: '/tmp/wt',
};

// Spec §3 + the build-time MUST-VERIFY (settled: headless `claude -p` DOES invoke the built-in
// skill). The prompt shape is the contract — a silent drop of the skill invocation would quietly
// downgrade this seat to a generic reviewer.
describe('the one Claude producer — /code-review methodology seat', () => {
  const prompt = renderCodeReviewSeatPrompt(args);

  it('LEADS with the cold-peer role and NEVER a slash command — a leading /skill would invoke the multi-agent pipeline and multiply subscription burn ~15x', () => {
    expect(prompt.startsWith(COLD_PEER_ROLE)).toBe(true);
    expect(prompt.startsWith('/')).toBe(false);
    expect(prompt).toContain('Do NOT delegate to subagents');
  });

  it('the native /code-review skill is BANNED from ensemble seats — the prompt never mentions it', () => {
    expect(prompt).not.toContain('/code-review');
  });

  it('carries the operator review method: functional bugs first, simplify lens, grounded self-check', () => {
    expect(prompt).toContain('Hunt FUNCTIONAL BUGS first');
    expect(prompt).toContain('the simplify lens');
    expect(prompt).toContain('SELF-CHECK every candidate finding');
  });

  it('runs the five miss-class hunts human reviewers proved seats skip (incidents 2026-08-10 + 2026-09-02)', () => {
    expect(prompt).toContain('NEW GUARD, EVERY ROUTE');
    expect(prompt).toContain('CALLER CENSUS');
    expect(prompt).toContain('TEST EFFECTIVENESS');
    expect(prompt).toContain('DECLARED-SET COMPLETENESS');
    // incident 2026-09-02: a numeric-input wrapper dropped its library's change-source metadata —
    // three seats flagged the rounding symptom, none read the wrapped source for the mechanism.
    expect(prompt).toContain('WRAPPER-BOUNDARY TRACE');
    expect(prompt).toMatch(/READ the wrapped source/);
  });

  it('grounds a claimed operational practice in scripts/runbooks, never in sibling comments (incident 2026-08-26)', () => {
    expect(prompt).toContain('CLAIM VS PRACTICE');
    expect(prompt).toMatch(/scripts, runbooks, CI\/deploy config/);
    expect(prompt).toMatch(/prove a convention was copied, not that anyone performs it/);
  });

  it('forbids arguing away execution-decidable findings — report them and name the settling command', () => {
    expect(prompt).toContain('execution-decidable');
    expect(prompt).toMatch(/name\s+the exact command that would settle it/);
  });

  it('names the worktree and the EXACT diff command — a detached HEAD has no diff of its own', () => {
    expect(prompt).toContain('/tmp/wt');
    expect(prompt).toContain(`git diff ${args.baseSha}...${args.headSha}`);
  });

  it('invites whole-project context — a finding may cite an UNCHANGED file', () => {
    expect(prompt).toMatch(/UNCHANGED file/);
  });

  it('anchors evidence at headSha (the generalized quoting rule)', () => {
    expect(prompt).toContain(`file:line as it exists at ${args.headSha}`);
  });

  it('calibrates the quality lens: structural only, NEVER style/naming nits', () => {
    expect(prompt).toMatch(/NEVER report style, naming, formatting/);
    expect(prompt).toMatch(/reinvented utilities/);
  });

  it('pins the ensemble schema so one parser serves every seat', () => {
    expect(prompt).toContain('"severity":"high|medium|low"');
    expect(prompt).toContain('exactly one fenced ```json block');
  });

  // The fence removed Bash, and with it `git log`/`git blame`. The engine computes them into the
  // seat's cwd instead (./history-packet); the clause is rendered only when a packet backs it.
  it('says nothing about `history/` when this run built no packet', () => {
    expect(prompt).not.toContain('history/');
  });

  it('points the seat at `history/` as DATA when a packet was built, never at `git`', () => {
    const withHistory = renderCodeReviewSeatPrompt({ ...args, history: true });
    expect(withHistory).toContain('history/log/<path>.log');
    expect(withHistory).toContain('history/blame/<path>.blame');
    expect(withHistory).toContain('history/pr-commits.log');
    expect(withHistory).toContain('file:line@<sha>');
    expect(withHistory).toContain('untrusted DATA');
    // Still no shell: the history is READ, never produced.
    expect(withHistory).toMatch(/do not try to run `git`/);
    expect(withHistory).not.toMatch(/\brun `?git log\b/i);
  });
});
