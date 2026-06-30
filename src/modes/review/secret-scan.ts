import type { FileDiff } from './diff';

// Preflight secret-scan of the DIFF PAYLOAD itself. The OS-enforced sandbox stops
// a reviewer READING secrets outside the packet — but the diff IS the payload sent
// to the reviewer's provider, and a diff can itself stage a `.env` / a credential.
// Read-confinement can't protect a secret already INSIDE the diff; this does.
// Default-REJECT high-risk paths + inline credential patterns; `--allow-sensitive`
// is the explicit, recorded override. Every match is NAMED in the manifest.

// High-risk PATHS — mirrors the reviewer sandbox's deny-list globs (the same
// secret surfaces), as path regexes. A changed file matching one is sensitive.
const SENSITIVE_PATH_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'dotenv', re: /(^|\/)\.env(\.[^/]+)?$/ },
  { label: 'secrets-env', re: /(^|\/)secrets\.env$/ },
  { label: 'pem', re: /\.pem$/ },
  { label: 'private-key', re: /\.key$/ },
  { label: 'ssh-key', re: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)$/ },
  { label: 'auth-json', re: /(^|\/)auth\.json$/ },
  { label: 'netrc', re: /(^|\/)\.netrc$/ },
  { label: 'aws-credentials', re: /(^|\/)\.aws\/credentials$/ },
  { label: 'npmrc', re: /(^|\/)\.npmrc$/ },
  { label: 'pypirc', re: /(^|\/)\.pypirc$/ },
  { label: 'git-credentials', re: /(^|\/)\.git-credentials$/ },
  { label: 'pkcs12', re: /\.(p12|pfx)$/ },
];

// Inline credential patterns — high-precision only (to avoid false-positive
// noise): private-key headers + a few well-shaped provider tokens. Matched on
// EVERY transmitted diff line (added, removed, AND context) — see payloadLines:
// the whole diff section is sent to the provider, so a secret on a deleted or
// unchanged-context line leaks just as readily as one on an added line.
const INLINE_SECRET_PATTERNS: { label: string; re: RegExp }[] = [
  { label: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { label: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { label: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { label: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { label: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
];

export interface SensitivePathHit {
  label: string;
  path: string;
}

export interface InlineSecretHit {
  // The matched value is NOT recorded (it's a secret) — only its kind + file.
  label: string;
  path: string;
}

export interface SecretScanResult {
  // Whether the review should be blocked. true when any sensitive path or inline
  // secret is present AND the caller did not pass allowSensitive.
  blocked: boolean;
  inlineSecrets: InlineSecretHit[];
  // The caller's explicit acknowledgement (recorded for the manifest).
  overridden: boolean;
  sensitivePaths: SensitivePathHit[];
}

// Every CONTENT line of the diff section actually transmitted to the reviewer:
// added (+), removed (-), AND context ( ) lines, minus the +++/--- file headers
// (the @@/diff --git/index metadata lines start with none of +/-/space). The
// leading +/-/space marker is stripped so a pattern matches the bare content.
function payloadLines(section: string): string[] {
  return section
    .split('\n')
    .filter(
      (l) =>
        (l.startsWith('+') && !l.startsWith('+++')) ||
        (l.startsWith('-') && !l.startsWith('---')) ||
        l.startsWith(' ')
    )
    .map((l) => l.slice(1));
}

// Scan the parsed file diffs for sensitive paths + inline secrets. PURE.
export function scanDiffForSecrets(
  files: FileDiff[],
  opts: { allowSensitive?: boolean } = {}
): SecretScanResult {
  const sensitivePaths: SensitivePathHit[] = [];
  const inlineSecrets: InlineSecretHit[] = [];
  for (const f of files) {
    for (const { label, re } of SENSITIVE_PATH_PATTERNS) {
      if (re.test(f.path)) sensitivePaths.push({ label, path: f.path });
    }
    if (f.isBinary) continue;
    const lines = payloadLines(f.raw);
    for (const { label, re } of INLINE_SECRET_PATTERNS) {
      if (lines.some((line) => re.test(line))) {
        inlineSecrets.push({ label, path: f.path });
      }
    }
  }
  const hasRisk = sensitivePaths.length > 0 || inlineSecrets.length > 0;
  const overridden = Boolean(opts.allowSensitive);
  return {
    blocked: hasRisk && !overridden,
    inlineSecrets,
    overridden,
    sensitivePaths,
  };
}
