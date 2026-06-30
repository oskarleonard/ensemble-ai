import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveBin } from '../core/bin';
import { runReviewerExec } from '../core/spawn';
import type { ReviewerConfig } from '../core/types';

import {
  type CodexReviewResult,
  REVIEW_TIMEOUT_MS,
  type RunReviewOpts,
} from './codex';

// The Grok (xAI) review adapter — the second cross-vendor lens beside Codex. It
// mirrors codex.ts but for the THREE ways grok's CLI differs (verified live
// 2026-06-29, grok v0.2.73):
//   1. The reply prints to STDOUT, not an `-o` file → runReviewerExec in stdout
//      mode (the codex path is outfile mode; the watchdog/group-kill are shared).
//   2. `--output-format json` wraps the reply in an envelope {text,stopReason,…};
//      the actual review is `.text` (which itself carries the ```json findings
//      block → parseFindings, the SAME path codex uses; grok's `--json-schema`
//      is unreliable so we never use it — symmetry IS robustness here).
//   3. Read-only is an OS-enforced `--sandbox` profile (Seatbelt/Landlock),
//      fail-closed — NOT codex's `-s read-only`. This is safety-critical: a
//      reviewer must provably never mutate the work (see ensureSandboxProfile).

const GROK_BIN_CANDIDATES = [path.join(os.homedir(), '.grok', 'bin', 'grok')];

export function resolveGrokBin(): string {
  return resolveBin('grok', {
    candidates: GROK_BIN_CANDIDATES,
    envVar: 'GROK_BIN',
  });
}

// grok's own built-in sandbox profiles — these need no provisioning (the CLI
// knows them). Anything else is a custom profile that must exist in a
// sandbox.toml or grok fail-closes (refuses to start), so we provision ours.
const BUILTIN_SANDBOXES = new Set([
  'off',
  'workspace',
  'devbox',
  'read-only',
  'strict',
]);

// The sandbox is the SECURITY BOUNDARY, not a model tunable. Reviewer prompts
// carry untrusted diff content, so the guarantee must not be weakenable through
// ordinary config (a `sandbox:"off"`/`"workspace"`/unverifiable-custom override
// would silently bypass it). Accept ONLY profiles that are DENY-BY-DEFAULT for
// READS (read just the throwaway cwd + system paths): grok's built-in `strict` +
// our `strict`-based `ensemble-review`. **`read-only` is NOT accepted** — it
// blocks writes but READS EVERYWHERE, so a prompt-injected diff could exfiltrate
// an unlisted credential (~/.aws/credentials, ~/.npmrc, …) into the findings.
// Anything else (a writable built-in, bare read-only, an unknown custom) falls
// back to the hardened default rather than running under a weaker boundary.
// (Model/effort stay swappable; only this is pinned.)
const DENY_BY_DEFAULT_SANDBOXES = new Set(['strict', 'ensemble-review']);
const DEFAULT_REVIEW_SANDBOX = 'ensemble-review';

export function resolveReviewSandbox(configured?: string): string {
  return configured && DENY_BY_DEFAULT_SANDBOXES.has(configured)
    ? configured
    : DEFAULT_REVIEW_SANDBOX;
}

// Our hardened review profile: a DENY-BY-DEFAULT base (`strict`: grok reads ONLY
// the throwaway cwd + essential system paths, so credentials anywhere else —
// ~/.aws/credentials, ~/.npmrc, gh/kube/docker creds, … — are kernel-unreadable)
// PLUS a secret deny-list (belt-and-suspenders for anything inside the cwd). A
// plain `read-only` base would read EVERYWHERE except listed secrets — a deny-list
// a prompt-injected diff could step around to exfiltrate an UNLISTED credential
// into the findings. The boundary is fail-closed on both platforms (grok refuses
// to start if it can't be applied); `strict` still lets grok run + review (the
// diff is in the prompt — verified live).
const REVIEW_PROFILE_NAME = 'ensemble-review';
const REVIEW_PROFILE_HEADER = `[profiles.${REVIEW_PROFILE_NAME}]`;
const REVIEW_PROFILE_BLOCK = `${REVIEW_PROFILE_HEADER}
extends = "strict"
deny = ["**/.env", "**/.env.*", "**/secrets.env", "**/*.pem", "**/*.key", "**/id_rsa", "**/id_ed25519", "**/auth.json", "**/.netrc"]`;
const REVIEW_PROFILE = `# ${REVIEW_PROFILE_NAME} — the cross-vendor reviewer's sandbox (ensemble-ai).
# deny-by-default reads (strict base) + kernel-deny secret reads. Safe to edit;
# auto-provisioned + kept current by ensemble-ai. Add deny globs as needed.
${REVIEW_PROFILE_BLOCK}
`;

// Replace JUST the [profiles.ensemble-review] section — its own leading comment +
// the header + body, up to the next [section] or EOF — with the current canonical
// profile, preserving every OTHER profile in the file. null if there is no
// ensemble-review section to replace.
function replaceReviewSection(content: string): string | null {
  const lines = content.split('\n');
  const header = lines.findIndex((l) => l.trim() === REVIEW_PROFILE_HEADER);
  if (header === -1) return null;
  let from = header; // consume the provisioning's own leading comment lines
  while (
    from > 0 &&
    lines[from - 1].trimStart().startsWith(`# ${REVIEW_PROFILE_NAME}`)
  ) {
    from--;
  }
  let to = header + 1; // body runs until the next [section] header or EOF
  while (to < lines.length && !lines[to].trimStart().startsWith('[')) to++;
  const before = lines.slice(0, from).join('\n').replace(/\n+$/, '');
  const after = lines.slice(to).join('\n').replace(/^\n+/, '');
  return (
    [before, REVIEW_PROFILE.trimEnd(), after]
      .filter((s) => s.length > 0)
      .join('\n\n') + '\n'
  );
}

// Make our custom `--sandbox` profile exist AND be CURRENT before we invoke grok.
// grok discovers profiles from ~/.grok/sandbox.toml; a missing custom profile makes
// grok fail-closed (SAFE but breaks the feature), so we self-provision idempotently.
// CRUCIALLY this also REPLACES a STALE block — idempotent by CONTENT, not just
// presence, so a profile change actually reaches an already-provisioned machine.
// Runs before every review (runGrokReview), so the first run after an update
// self-heals. Best-effort; grok fail-closes if the profile is still absent.
export function ensureSandboxProfile(
  profile: string,
  file = path.join(os.homedir(), '.grok', 'sandbox.toml')
): void {
  if (BUILTIN_SANDBOXES.has(profile) || profile !== REVIEW_PROFILE_NAME) return;
  try {
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (existing.includes(REVIEW_PROFILE_BLOCK)) return; // already current
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const updated = existing.includes(REVIEW_PROFILE_HEADER)
      ? replaceReviewSection(existing) // stale block → replace in place
      : null;
    fs.writeFileSync(
      file,
      updated ??
        (existing.trim()
          ? `${existing.trimEnd()}\n\n${REVIEW_PROFILE}`
          : REVIEW_PROFILE)
    );
  } catch {
    // best-effort; grok fail-closes if the profile is still absent
  }
}

// PURE: the exact grok CLI args for a review. Encodes every lived lesson as DATA
// so a unit test pins it: `-p <prompt>` (single-turn, prints to stdout) ·
// `--output-format json` (the envelope gives a real `stopReason` terminal signal)
// · `-m <model>` + `--effort <effort>` (the CONFIGURED strong model) ·
// `--sandbox <profile>` (THE boundary — an OS-enforced read-only sandbox, never
// tool-denial) · `--cwd <neutral>` (the diff is IN the prompt, not the cwd —
// stateless, like codex from tmpdir) · `--disable-web-search` +
// `--disallowed-tools bash,search_replace` (defense in depth, NOT the boundary) ·
// `--no-memory` (no cross-session state).
export function buildGrokReviewArgs(
  config: ReviewerConfig,
  prompt: string,
  cwd: string
): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'json',
    '-m',
    config.model,
    '--effort',
    config.effort,
    '--sandbox',
    resolveReviewSandbox(config.sandbox),
    '--cwd',
    cwd,
    '--disable-web-search',
    '--disallowed-tools',
    'bash,search_replace',
    '--no-memory',
  ];
}

// Pull the review text out of grok's `--output-format json` envelope. The reply
// is `.text` (it carries the ```json findings block, which parseFindings then
// reads). Falls back to the raw stdout if it isn't the expected envelope (e.g. a
// plain-format surprise) so a format drift degrades, not crashes.
export function extractGrokText(stdout: string): string | null {
  try {
    const env = JSON.parse(stdout) as { text?: unknown };
    if (typeof env.text === 'string' && env.text.trim()) return env.text;
  } catch {
    // not JSON — fall through to the raw stdout
  }
  const trimmed = stdout.trim();
  return trimmed || null;
}

// Invoke Grok READ-ONLY with the embedded packet prompt over the shared
// runReviewerExec spawn contract (the same group-aware watchdog + backstop codex
// uses — grok forks a leader/subagents, so the group-kill is mandatory). Returns
// the same shape as runCodexReview so the caller treats both reviewers uniformly:
// `raw` is grok's `.text` (ready for parseFindings). On grok's separate xAI quota.
export function runGrokReview(
  prompt: string,
  config: ReviewerConfig,
  opts: RunReviewOpts = {}
): Promise<CodexReviewResult> {
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
  // Pin the boundary to a proven read-only profile (provisioning the resolved one,
  // which is exactly what buildGrokReviewArgs will pass to --sandbox).
  const sandbox = resolveReviewSandbox(config.sandbox);
  ensureSandboxProfile(sandbox);
  // A unique, throwaway cwd for grok to operate in (the diff is in the prompt).
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-review-'));
  return runReviewerExec({
    args: buildGrokReviewArgs({ ...config, sandbox }, prompt, cwd),
    bin: resolveGrokBin(),
    capture: 'stdout',
    onSpawn: opts.onSpawn,
    stderrLimit: 2000,
    timeoutMs,
  }).then(({ raw, stderrTail, timedOut }) => {
    try {
      fs.rmSync(cwd, { force: true, recursive: true });
    } catch {
      // throwaway dir — best-effort cleanup
    }
    const text = raw ? extractGrokText(raw) : null;
    return { ok: text !== null, raw: text, stderrTail, timedOut };
  });
}
