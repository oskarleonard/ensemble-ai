import { describe, expect, it } from 'vitest';

import { CODE_REVIEW_SKILL, renderCodeReviewSeatPrompt } from './code-review-seat';

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

  it('LEADS with the built-in skill so the CLI expands it (plan A, not a vendored prompt)', () => {
    expect(prompt.startsWith(CODE_REVIEW_SKILL)).toBe(true);
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
});
