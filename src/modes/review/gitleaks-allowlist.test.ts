import { describe, expect, it } from 'vitest';

import type { ConventionReader } from '../../core/conventions';
import {
  gitleaksAllowlisted,
  gitleaksConfigCandidates,
  parseGitleaksAllowlistPaths,
  readTomlStringArray,
  resolveGitleaksExemptions,
} from './gitleaks-allowlist';

// The shape of lisk-app's backend/.gitleaks.toml at 16364a8a: comments inside the
// arrays (with quotes in them), regexes carrying `]`, `#` and quotes, a `regexes`
// array BEFORE `paths`, and a per-rule section that must be ignored.
const LISK_LIKE = `
title = "lisk-backend"

[extend]
useDefault = true
disabledRules = ["generic-api-key"]

[[rules]]
id = "lisk-secret-env-assignment"
regex = '''(?i)(lisk_[a-z0-9_]*(secret|token))\\s*[:=]\\s*['"]?([^\\s'"#]{8,})['"]?'''
keywords = ["lisk_"]

[rules.allowlist]
paths = [ '''(^|/)per-rule-only/''' ]

[allowlist]
description = "Committed dev placeholders"
regexTarget = "line"
regexes = [
  # The indexer CLI tests hand a stubbed binary the literal token 'test-token'.
  '''_TOKEN:\\s*'test-token'(\\s|,|}|$)''',
  '''=\\s*['"]?\\$\\{?[A-Za-z_]''',
]
paths = [
  # Any *.env file — mirrors .gitignore's \`*.env\`.
  '''\\.env$''',
  '''(^|/)\\.claude/''',
  # The rule self-test holds fake fixture secrets by design; it scans them from
  # a temp dir at runtime, so allowlisting the file here doesn't weaken the test.
  '''(^|/)scripts/gitleaks-selftest\\.sh$''',
  '''(^|/)scripts/tests/''',
  '''(^|/)gen/''',
  "(^|/)(bin|build|vendor)/",   # a basic string, trailing comment
  '''\\.gitleaks\\.toml$''',
]
`;

describe('readTomlStringArray', () => {
  it('reads literal, multi-line-literal and basic strings; skips comments, even ones with quotes', () => {
    const text = `[
  # it's a comment with 'quotes' and "more"
  '''a[b]c''', 'd', "e\\"f\\\\g", # trailing
  """h"""
]`;
    expect(readTomlStringArray(text, 1)).toEqual(['a[b]c', 'd', 'e"f\\g', 'h']);
  });

  it('a `#` or `]` inside a string does not end the array', () => {
    expect(readTomlStringArray(`['''[^\\s'"#]{8,}''', 'x#y' ]`, 1)).toEqual([`[^\\s'"#]{8,}`, 'x#y']);
  });
});

describe('parseGitleaksAllowlistPaths', () => {
  it('compiles the GLOBAL allowlist paths and ignores per-rule allowlists and regexes', () => {
    const { invalid, patterns } = parseGitleaksAllowlistPaths(LISK_LIKE);
    expect(invalid).toEqual([]);
    expect(patterns).toHaveLength(7);
    expect(patterns.some((re) => re.test('scripts/gitleaks-selftest.sh'))).toBe(true);
    expect(patterns.some((re) => re.test('per-rule-only/x'))).toBe(false);
    expect(patterns.some((re) => re.test("_TOKEN: 'test-token'"))).toBe(false);
  });

  it('honours the `[[allowlists]]` (gitleaks ≥ 8.21) form and a leading (?i)', () => {
    const { invalid, patterns } = parseGitleaksAllowlistPaths(`
[[allowlists]]
paths = ['''(?i)^Fixtures/''']
[[allowlists]]
paths = ['''^docs/''']
`);
    expect(invalid).toEqual([]);
    expect(patterns.map((re) => re.test('fixtures/a'))).toEqual([true, false]);
    expect(patterns[1].test('docs/a')).toBe(true);
  });

  it('names a pattern JS cannot compile instead of guessing', () => {
    const { invalid, patterns } = parseGitleaksAllowlistPaths(`
[allowlist]
paths = ['''(?s)dotall''', '''(?P<name>x)''', '''ok/''']
`);
    expect(patterns).toHaveLength(1);
    expect(invalid).toEqual(['(?s)dotall', '(?P<name>x)']);
  });

  it('a config without a global allowlist yields nothing', () => {
    expect(parseGitleaksAllowlistPaths('title = "x"\n[extend]\nuseDefault = true\n').patterns).toEqual([]);
  });
});

describe('gitleaksConfigCandidates + gitleaksAllowlisted', () => {
  it('lists the root config then one per ancestor dir', () => {
    expect(gitleaksConfigCandidates('backend/scripts/gitleaks-selftest.sh')).toEqual([
      { configPath: '.gitleaks.toml', dir: '' },
      { configPath: 'backend/.gitleaks.toml', dir: 'backend' },
      { configPath: 'backend/scripts/.gitleaks.toml', dir: 'backend/scripts' },
    ]);
  });

  it('matches against the path relative to the config dir AND the repo-relative path', () => {
    const a = { configPath: 'backend/.gitleaks.toml', dir: 'backend', invalid: [], patterns: [/^scripts\/x\.sh$/] };
    expect(gitleaksAllowlisted(a, 'backend/scripts/x.sh')).toBe(true);
    expect(gitleaksAllowlisted(a, 'web/scripts/x.sh')).toBe(false);
    const b = { ...a, patterns: [/^backend\/scripts\/x\.sh$/] };
    expect(gitleaksAllowlisted(b, 'backend/scripts/x.sh')).toBe(true);
  });
});

describe('resolveGitleaksExemptions', () => {
  function readerOf(files: Record<string, string>): ConventionReader & { reads: string[] } {
    const reads: string[] = [];
    return {
      reads,
      async list() {
        return [];
      },
      async read(rel) {
        reads.push(rel);
        return files[rel] ?? null;
      },
    };
  }

  it('exempts lisk-app’s self-test through backend/.gitleaks.toml, reading each config once', async () => {
    const reader = readerOf({ 'backend/.gitleaks.toml': LISK_LIKE });
    const ex = await resolveGitleaksExemptions(reader, [
      'backend/scripts/gitleaks-selftest.sh',
      'backend/pkg/handler/x.go',
      'web/src/a.ts',
    ]);
    expect([...ex.exempt]).toEqual([['backend/scripts/gitleaks-selftest.sh', 'backend/.gitleaks.toml']]);
    expect(ex.configs).toEqual(['backend/.gitleaks.toml']);
    expect(ex.invalid).toEqual([]);
    // '.gitleaks.toml' and 'backend/.gitleaks.toml' once each, not once per file.
    expect(reader.reads.filter((r) => r === 'backend/.gitleaks.toml')).toHaveLength(1);
    expect(reader.reads.filter((r) => r === '.gitleaks.toml')).toHaveLength(1);
  });

  it('no config anywhere → nothing exempt, nothing read twice', async () => {
    const reader = readerOf({});
    const ex = await resolveGitleaksExemptions(reader, ['a/b.ts', 'a/c.ts']);
    expect(ex.exempt.size).toBe(0);
    expect(ex.configs).toEqual([]);
    expect(new Set(reader.reads).size).toBe(reader.reads.length);
  });
});
