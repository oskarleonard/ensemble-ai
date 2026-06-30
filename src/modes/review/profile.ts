// Review PROFILES — a profile is a thin variation of the SAME review engine, NOT
// a parallel one. `code` (the default) is the general adversarial review; `security`
// swaps the reviewer FRAMING (objective + prompt ask) and adds a couple of LOCAL
// checks (the existing secret-scan + a dependency-surface flag, see dep-surface.ts).
// Diff acquisition, coverage, the watchdog'd reviewer spawn, parseFindings, and the
// content-tied receipt are all shared unchanged — a profile is "a prompt + a couple
// of extra local checks", per the spec.

import type { ReviewFinding } from '../../core/types';

export const REVIEW_PROFILES = ['code', 'security'] as const;
export type ReviewProfile = (typeof REVIEW_PROFILES)[number];

export function isReviewProfile(v: string): v is ReviewProfile {
  return (REVIEW_PROFILES as readonly string[]).includes(v);
}

// The security-auditor objective handed to the reviewers (replaces the general
// review objective) — it sets the adversarial security frame for the whole packet.
export const SECURITY_OBJECTIVE =
  'Adversarial cross-vendor SECURITY audit of a code diff — hunt for exploitable ' +
  'vulnerabilities a same-vendor author might miss: injection, XSS, broken ' +
  'authn/authz, secret leakage, supply-chain risk, unsafe deserialization/eval, ' +
  'SSRF, path traversal, and crypto misuse.';

// The security classes a finding is tagged with in the grouped output (roughly
// worst-first). `keywords` drive the heuristic fallback classifier when a reviewer
// does not lead its title with an explicit [tag]. `other` is the catch-all.
export interface SecurityClass {
  id: string;
  keywords: string[];
  label: string;
}

export const SECURITY_CLASSES: SecurityClass[] = [
  {
    id: 'injection',
    label: 'Injection',
    keywords: ['sql', 'sqli', 'injection', 'command inject', 'shell inject', 'os command', 'unsanitiz', 'parameteriz', 'prepared statement'],
  },
  {
    id: 'xss',
    label: 'XSS',
    keywords: ['xss', 'cross-site script', 'innerhtml', 'dangerouslysetinnerhtml', 'unescaped', 'html escap'],
  },
  {
    id: 'authz',
    label: 'AuthN/AuthZ',
    keywords: ['authoriz', 'authentic', 'permission', 'access control', 'privilege', 'idor', 'rbac', 'session fixation', 'jwt', 'auth bypass', 'unauthenticated'],
  },
  {
    id: 'secret-leak',
    label: 'Secret leak',
    keywords: ['secret', 'credential', 'api key', 'apikey', 'hardcoded password', 'hardcoded', 'token leak', 'private key', 'leaked'],
  },
  {
    id: 'supply-chain',
    label: 'Supply chain',
    keywords: ['supply chain', 'dependency', 'transitive', 'malicious package', 'typosquat', 'postinstall', 'lockfile', 'unpinned'],
  },
  {
    id: 'deserialization',
    label: 'Unsafe deserialization/eval',
    keywords: ['deserializ', 'eval(', 'new function', 'pickle', 'yaml.load', 'unserialize', 'unmarshal', 'vm.runin', 'arbitrary code', 'rce', 'code execution'],
  },
  {
    id: 'ssrf',
    label: 'SSRF',
    keywords: ['ssrf', 'server-side request', 'request forgery', 'open redirect', 'url allowlist', 'url validation'],
  },
  {
    id: 'path-traversal',
    label: 'Path traversal',
    keywords: ['path traversal', 'directory traversal', 'zip slip', 'arbitrary file read', 'arbitrary file write', '../'],
  },
  {
    id: 'crypto',
    label: 'Crypto misuse',
    keywords: ['crypto', 'cipher', 'md5', 'sha1', 'insecure random', 'weak hash', 'weak algorithm', 'ecb mode', 'hardcoded iv', 'static iv', 'nonce reuse', 'certificate valid'],
  },
  { id: 'other', label: 'Other', keywords: [] },
];

const KNOWN_CLASS_IDS = new Set(SECURITY_CLASSES.map((c) => c.id));

// A leading `[tag]` the security prompt asks the reviewer to prefix its title with.
const LEADING_TAG = /^\s*\[([a-z-]+)\]\s*/i;

// Classify a finding into a security class. Prefers an explicit [tag] the security
// prompt asked the reviewer to lead its title with (deterministic); else a keyword
// scan over title+body; else 'other'. PURE.
export function classifySecurityFinding(
  f: Pick<ReviewFinding, 'body' | 'title'>
): string {
  const tag = f.title.match(LEADING_TAG)?.[1]?.toLowerCase();
  if (tag && KNOWN_CLASS_IDS.has(tag)) return tag;
  const hay = `${f.title} ${f.body}`.toLowerCase();
  for (const c of SECURITY_CLASSES) {
    if (c.keywords.some((k) => hay.includes(k))) return c.id;
  }
  return 'other';
}

// Strip a leading recognized `[class]` tag from a title for display, so the grouped
// output doesn't show `[authz] [authz] …` (the class is rendered separately).
export function stripSecurityTag(title: string): string {
  const tag = title.match(LEADING_TAG)?.[1]?.toLowerCase();
  return tag && KNOWN_CLASS_IDS.has(tag) ? title.replace(LEADING_TAG, '') : title;
}

export function securityClassLabel(id: string): string {
  return SECURITY_CLASSES.find((c) => c.id === id)?.label ?? id;
}
