import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { IMPLEMENTED_MODES, resolveMode } from '../modes';

import {
  findSkill,
  ORCHESTRATION_SKILL_SPECS,
  orchestrationEngineCommand,
  SKILL_ARGS_PLACEHOLDER,
  SKILL_SPECS,
  skillInvocationLine,
} from './skills';

// The shipped skill markdown lives at <repo>/entrypoints/skills/<name>/SKILL.md.
const SKILLS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../entrypoints/skills'
);

describe('SKILL_SPECS registry', () => {
  it('has the four entrypoint skills', () => {
    expect(SKILL_SPECS.map((s) => s.name).sort()).toEqual([
      'ensemble-ai-brainstorm',
      'ensemble-ai-consult',
      'ensemble-ai-review',
      'ensemble-ai-security',
    ]);
  });

  it('every skill maps ONLY to an IMPLEMENTED mode (no pointing at a planned mode)', () => {
    for (const spec of SKILL_SPECS) {
      // the skill's mode is the CLI verb; it must resolve to itself (an implemented mode) …
      expect(resolveMode(spec.mode)).toBe(spec.mode);
      // … and that mode must actually be built
      expect(IMPLEMENTED_MODES).toContain(spec.mode);
    }
  });
});

describe('skillInvocationLine', () => {
  it('is `ensemble-ai <mode> $ARGUMENTS`', () => {
    const spec = findSkill('ensemble-ai-consult')!;
    expect(skillInvocationLine(spec)).toBe(`ensemble-ai consult ${SKILL_ARGS_PLACEHOLDER}`);
  });
});

describe('shipped SKILL.md files (no drift from the registry)', () => {
  for (const spec of SKILL_SPECS) {
    it(`skills/${spec.name}/SKILL.md invokes the right CLI command`, () => {
      const file = path.join(SKILLS_DIR, spec.name, 'SKILL.md');
      const body = fs.readFileSync(file, 'utf8');
      // frontmatter name matches the registry (what Claude Code keys the skill on)
      expect(body).toContain(`name: ${spec.name}`);
      // the wrapper invokes EXACTLY the CLI command the registry says it does
      expect(body).toContain(skillInvocationLine(spec));
      // and forwards the user's arguments placeholder
      expect(body).toContain(SKILL_ARGS_PLACEHOLDER);
    });
  }
});

describe('ORCHESTRATION_SKILL_SPECS registry', () => {
  it('registers the review-fix orchestration skill (a multi-step ritual, not a thin wrapper)', () => {
    expect(ORCHESTRATION_SKILL_SPECS.map((s) => s.name)).toEqual([
      'ensemble-ai-review-fix',
    ]);
  });

  it('every orchestration skill drives an IMPLEMENTED engine mode', () => {
    for (const spec of ORCHESTRATION_SKILL_SPECS) {
      expect(resolveMode(spec.drives)).toBe(spec.drives);
      expect(IMPLEMENTED_MODES).toContain(spec.drives);
    }
  });

  it('an orchestration skill is NOT also a thin wrapper (kept out of SKILL_SPECS)', () => {
    const wrappers = new Set(SKILL_SPECS.map((s) => s.name));
    for (const spec of ORCHESTRATION_SKILL_SPECS) {
      expect(wrappers.has(spec.name)).toBe(false);
    }
  });
});

describe('shipped orchestration SKILL.md files (no drift from the registry)', () => {
  for (const spec of ORCHESTRATION_SKILL_SPECS) {
    it(`skills/${spec.name}/SKILL.md drives the engine + the fix-loop contract`, () => {
      const body = fs.readFileSync(
        path.join(SKILLS_DIR, spec.name, 'SKILL.md'),
        'utf8'
      );
      // frontmatter name matches the registry
      expect(body).toContain(`name: ${spec.name}`);
      // it drives the engine READ-ONLY (the session is the fixer) …
      expect(body).toContain(orchestrationEngineCommand(spec));
      // … reads the gate-verdicts.json fix-loop contract …
      expect(body).toContain('gate-verdicts.json');
      // … and forwards the user's arguments to the engine
      expect(body).toContain(SKILL_ARGS_PLACEHOLDER);
    });
  }
});
