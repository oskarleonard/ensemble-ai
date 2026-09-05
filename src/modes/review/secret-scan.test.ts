import { describe, expect, it } from 'vitest';

import { parseDiffFiles } from './diff';
import { CI_OUTPUT_PATTERNS } from './ci-evidence';
import { scanDiffForSecrets, scanTextForSecrets } from './secret-scan';

function diffFor(path: string, addedLines: string[]): string {
  return `diff --git a/${path} b/${path}
index 111..222 100644
--- a/${path}
+++ b/${path}
@@ -0,0 +1,${addedLines.length} @@
${addedLines.map((l) => `+${l}`).join('\n')}
`;
}

const CLEAN = diffFor('src/a.ts', ['const a = 1;', 'export { a };']);

describe('scanDiffForSecrets — sensitive paths', () => {
  it('default-REJECTS a diff that touches a sensitive path (.env)', () => {
    const files = parseDiffFiles(diffFor('.env', ['API_KEY=abc']));
    const r = scanDiffForSecrets(files);
    expect(r.sensitivePaths.map((p) => p.label)).toContain('dotenv');
    expect(r.blocked).toBe(true);
    expect(r.overridden).toBe(false);
  });

  it('--allow-sensitive overrides the block but STILL records the path', () => {
    const files = parseDiffFiles(diffFor('config/.env.production', ['X=1']));
    const r = scanDiffForSecrets(files, { allowSensitive: true });
    expect(r.sensitivePaths).toHaveLength(1);
    expect(r.blocked).toBe(false);
    expect(r.overridden).toBe(true);
  });

  it('exempts committed dotenv TEMPLATES from the path rule (placeholders, not values)', () => {
    for (const path of [
      '.env.template',
      'apps/admin/.env.example',
      '.env.sample',
      'services/api/.env.production.example',
    ]) {
      const r = scanDiffForSecrets(parseDiffFiles(diffFor(path, ['# API_KEY=<your key>'])));
      expect(r.sensitivePaths, path).toHaveLength(0);
      expect(r.blocked, path).toBe(false);
    }
  });

  it('still blocks real dotenv files next to the exempt template shapes', () => {
    for (const path of ['.env', '.env.production', 'apps/admin/.env.local', '.env.template.bak']) {
      const r = scanDiffForSecrets(parseDiffFiles(diffFor(path, ['X=1'])));
      expect(r.sensitivePaths.map((p) => p.label), path).toContain('dotenv');
      expect(r.blocked, path).toBe(true);
    }
  });

  it('the template exemption is linear on a hostile dotted path (no catastrophic backtracking)', () => {
    // Regression guard for the first draft's `(\.[^/]+)*` (exponential: ~1 s at 28 segments).
    const hostile = '.env' + '.a'.repeat(60) + '!';
    const t0 = Date.now();
    const r = scanDiffForSecrets(parseDiffFiles(diffFor(hostile, ['X=1'])));
    expect(Date.now() - t0).toBeLessThan(200);
    expect(r.sensitivePaths.map((p) => p.label)).toContain('dotenv'); // not a template → still blocked
  });

  it('a template carrying a REAL credential is still caught by the inline scan', () => {
    const files = parseDiffFiles(diffFor('.env.example', ['AWS_KEY=AKIAIOSFODNN7EXAMPLE']));
    const r = scanDiffForSecrets(files);
    expect(r.sensitivePaths).toHaveLength(0);
    expect(r.inlineSecrets.map((s) => s.label)).toContain('aws-access-key');
    expect(r.blocked).toBe(true);
  });

  it('recognizes the secret-file shapes the sandbox deny-list covers', () => {
    for (const [path, label] of [
      ['id_rsa', 'ssh-key'],
      ['certs/server.pem', 'pem'],
      ['deploy.key', 'private-key'],
      ['.netrc', 'netrc'],
      ['project/.npmrc', 'npmrc'],
    ] as const) {
      const r = scanDiffForSecrets(parseDiffFiles(diffFor(path, ['x'])));
      expect(r.sensitivePaths.map((p) => p.label)).toContain(label);
    }
  });
});

describe('scanDiffForSecrets — inline secrets', () => {
  it('flags an inline AWS access key added in the diff', () => {
    const files = parseDiffFiles(
      diffFor('src/config.ts', ['const k = "AKIAIOSFODNN7EXAMPLE";'])
    );
    const r = scanDiffForSecrets(files);
    expect(r.inlineSecrets.map((s) => s.label)).toContain('aws-access-key');
    expect(r.blocked).toBe(true);
  });

  it('flags a secret on a REMOVED line, not just added lines (the whole diff is transmitted)', () => {
    // A secret being DELETED is still in the diff payload sent to the provider, so
    // the scan must catch it — it must not only look at '+' lines.
    const removed = `diff --git a/src/c.ts b/src/c.ts
index 111..222 100644
--- a/src/c.ts
+++ b/src/c.ts
@@ -1,3 +1,2 @@
 const ok = 1;
-const k = "AKIAIOSFODNN7EXAMPLE";
 export { ok };
`;
    const r = scanDiffForSecrets(parseDiffFiles(removed));
    expect(r.inlineSecrets.map((s) => s.label)).toContain('aws-access-key');
    expect(r.blocked).toBe(true);
  });

  it('flags a private-key block header', () => {
    const files = parseDiffFiles(
      diffFor('key.txt', ['-----BEGIN RSA PRIVATE KEY-----'])
    );
    const r = scanDiffForSecrets(files);
    expect(r.inlineSecrets.map((s) => s.label)).toContain('private-key-block');
  });

  it('does NOT record the secret VALUE — only its kind + file', () => {
    const r = scanDiffForSecrets(
      parseDiffFiles(diffFor('src/c.ts', ['const t = "ghp_abcdefghij0123456789";']))
    );
    expect(JSON.stringify(r)).not.toContain('ghp_abcdefghij0123456789');
    expect(r.inlineSecrets[0]).toMatchObject({ label: 'github-token', path: 'src/c.ts' });
  });
});

describe('scanDiffForSecrets — clean diff', () => {
  it('does not block ordinary code', () => {
    const r = scanDiffForSecrets(parseDiffFiles(CLEAN));
    expect(r.blocked).toBe(false);
    expect(r.sensitivePaths).toHaveLength(0);
    expect(r.inlineSecrets).toHaveLength(0);
  });
});

describe('scanTextForSecrets — the same inline patterns, over arbitrary text', () => {
  it('returns null for ordinary CI output', () => {
    expect(scanTextForSecrets('✓ 214 tests passed\nwarning: deprecated API used in src/a.ts')).toBeNull();
  });

  it('names the FIRST matching pattern and never the value', () => {
    const hit = scanTextForSecrets('token leaked: ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(hit).toEqual({ label: 'github-token' });
  });

  it('catches a private-key header on any line', () => {
    expect(scanTextForSecrets('line 1\n-----BEGIN RSA PRIVATE KEY-----\nline 3')?.label).toBe('private-key-block');
  });
});

// THE `extra` PARAMETER widens the list FOR ONE CALL. It exists because CI output is leakier than
// a diff — machine-printed, so it echoes request headers, exported tokens, credentialed URLs —
// while the DIFF scan's precision bar must not move: a false positive there blocks a review.
describe('scanTextForSecrets — the `extra` patterns are opt-in, and the DIFF scan never opts in', () => {
  // Only the patterns CI_OUTPUT_PATTERNS adds that the base list does not already carry: the
  // other two (aws-access-key, slack-token) are blocked on a diff too, so they prove nothing here.
  const CI_ONLY: [string, string][] = [
    ['bearer-token', 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345"'],
    [
      'jwt',
      'session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N-XgL0n3I9PlFUP0THsR8U',
    ],
    ['url-credentials', 'npm ERR! fetch https://ci:hunter2xyz@registry.example/pkg failed'],
  ];

  for (const [label, text] of CI_ONLY) {
    it(`matches ${label} WITH the extras and is invisible without them`, () => {
      expect(scanTextForSecrets(text, CI_OUTPUT_PATTERNS)).toEqual({ label });
      // The default parameter leaves the base list exactly as it was.
      expect(scanTextForSecrets(text)).toBeNull();
    });

    it(`does NOT block a diff carrying ${label} — the payload scan is untouched`, () => {
      const r = scanDiffForSecrets(parseDiffFiles(diffFor('src/app.ts', [text])));
      expect(r.blocked).toBe(false);
      expect(r.inlineSecrets).toHaveLength(0);
    });
  }

  // The extras WIDEN, never replace: a base pattern still fires when extras are passed.
  it('keeps the base patterns when extras are supplied', () => {
    expect(scanTextForSecrets('ghp_abcdefghijklmnopqrstuvwxyz0123', CI_OUTPUT_PATTERNS)).toEqual({
      label: 'github-token',
    });
  });
});
