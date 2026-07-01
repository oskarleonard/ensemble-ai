import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { IMPLEMENTED_MODES, resolveMode } from '../modes';

import {
  findSkill,
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
      'brainstorm',
      'consult',
      'review',
      'security',
    ]);
  });

  it('every skill maps ONLY to an IMPLEMENTED mode (no pointing at a planned mode)', () => {
    for (const spec of SKILL_SPECS) {
      // the skill name is the CLI verb; it must resolve to the spec's mode …
      expect(resolveMode(spec.name)).toBe(spec.mode);
      // … and that mode must actually be built
      expect(IMPLEMENTED_MODES).toContain(spec.mode);
    }
  });
});

describe('skillInvocationLine', () => {
  it('is `ensemble-ai <mode> $ARGUMENTS`', () => {
    const spec = findSkill('consult')!;
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
