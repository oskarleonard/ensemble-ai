import { describe, expect, it } from 'vitest';

import { parseDiffFiles } from './diff';
import { scanDiffForSecrets } from './secret-scan';

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
