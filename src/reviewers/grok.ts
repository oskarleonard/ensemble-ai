import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveBin } from '../core/bin';
import { type EgressProxy, proxyEnv } from '../core/egress-proxy';
import { runReviewerExec } from '../core/spawn';
import type { ReviewerConfig } from '../core/types';
import type { SandboxProfileRef } from '../modes/review/evidence';

import {
  type CodexReviewResult,
  REVIEW_TIMEOUT_MS,
  type RunReviewOpts,
} from './codex';
import { egressStartFailure, startSeatEgressProxy } from './egress-seat';

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
    const content =
      updated ??
      (existing.trim()
        ? `${existing.trimEnd()}\n\n${REVIEW_PROFILE}`
        : REVIEW_PROFILE);
    // Atomic write (tmp + rename): a crash/SIGKILL mid-write must never leave the
    // user's sandbox.toml truncated — that would corrupt OTHER profiles in the file
    // or break ensemble-review so the next grok review fails closed. (Same rule as
    // writeAtomic for the run artifacts.)
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  } catch {
    // best-effort; grok fail-closes if the profile is still absent
  }
}

// The name grok's CLI knows the profile by (`--sandbox <name>`, resolved from ~/.grok/sandbox.toml).
// DISTINCT from the receipt's profile id below, which also names the egress fence — grok's sandbox
// schema has no concept of it, so the two identities are no longer the same string.
export const GROK_CLI_SANDBOX = REVIEW_PROFILE_NAME;

// The grok seat's sandbox identity, as a RECEIPT attests it. Two fences compose:
//
//   `ensemble-review`  — grok's own kernel profile: a `strict` (deny-by-default READS) base + a
//                        secret deny-list. Pointing it at the worktree root is config-only
//                        (`--cwd <worktree>`).
//   `+egress-proxy`    — the engine's per-host CONNECT fence (codex-f3). grok honors the standard
//                        proxy env vars (PROBED 2026-07-10: a logging proxy saw its
//                        `cli-chat-proxy.grok.com:443` CONNECT), so the seat is spawned pointed at
//                        the proxy and reaches that host and nothing else. Its `api.mixpanel.com`
//                        telemetry is denied, and grok completes anyway.
//
// WHAT WE COULD NOT DO, stated: grok's `sandbox.toml` profile schema is `extends` / `read_only` /
// `read_write` / `allow` / `deny` — FILES ONLY, no network keys. So unlike codex's Seatbelt profile
// there is no rule that denies grok's process direct outbound; the proxy env is the fence, and a
// grok that chose to ignore it could still reach any host. What bounds that is grok's own profile:
// `strict` is documented as "no child network", and the seat runs `--disallowed-tools bash` — so
// there is no shell inside the untrusted tree to prompt-inject in the first place. This is a WEAKER
// fence than codex's, and the id says only what it is.
//
// Bump `version` whenever REVIEW_PROFILE_BLOCK or the egress allowlist changes — a receipt minted
// under a weaker profile must never verify as equivalent to one minted under a tighter one.
export const GROK_SANDBOX_PROFILE: SandboxProfileRef = {
  id: `${REVIEW_PROFILE_NAME}+egress-proxy`,
  version: 1,
};

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
    // It parsed as grok's envelope — the review is `.text`. An empty/absent text
    // (a refusal or length-stop still emits a valid envelope with text: "") means
    // grok produced no usable reply: return null so the caller records
    // failed-reviewer, NOT the envelope JSON itself — which parseFindings would
    // otherwise read as an empty, falsely-"reviewed" findings object.
    return typeof env.text === 'string' && env.text.trim() ? env.text : null;
  } catch {
    // Not the JSON envelope (a plain-format surprise) — degrade to the raw stdout.
  }
  const trimmed = stdout.trim();
  return trimmed || null;
}

// Invoke Grok READ-ONLY with the embedded packet prompt over the shared
// runReviewerExec spawn contract (the same group-aware watchdog + backstop codex
// uses — grok forks a leader/subagents, so the group-kill is mandatory). Returns
// the same shape as runCodexReview so the caller treats both reviewers uniformly:
// `raw` is grok's `.text` (ready for parseFindings). On grok's separate xAI quota.
export async function runGrokReview(
  prompt: string,
  config: ReviewerConfig,
  opts: RunReviewOpts = {}
): Promise<CodexReviewResult> {
  const timeoutMs = opts.timeoutMs ?? REVIEW_TIMEOUT_MS;
  // Pin the boundary to a proven read-only profile (provisioning the resolved one,
  // which is exactly what buildGrokReviewArgs will pass to --sandbox).
  const sandbox = resolveReviewSandbox(config.sandbox);
  // WORKTREE EVIDENCE (§2): `--cwd <worktree>` roots the deny-by-default `strict` read base at
  // the PR head, so grok reads the whole project and nothing else. Without it, the historic
  // throwaway tmpdir (the diff lives in the prompt) — the packet path, unchanged.
  //
  // But the seat only QUALIFIES for the worktree under the profile whose identity the receipt
  // will attest. resolveReviewSandbox admits `strict` as well as `ensemble-review`, and `strict`
  // lacks the secret deny-list — so a `strict`-configured seat would be handed the whole project
  // while the receipt named a profile it never ran under. Compared against the CLI sandbox NAME,
  // not the receipt's profile id: since codex-f3 the id also names the egress fence, which grok's
  // sandbox schema knows nothing about. Fail closed rather than attest a fence that did not apply.
  const worktreeCwd = opts.worktree;
  if (worktreeCwd && sandbox !== GROK_CLI_SANDBOX) {
    return {
      ok: false,
      raw: null,
      stderrTail: `ensemble-ai: refusing worktree evidence for the grok seat — it resolved to the "${sandbox}" sandbox, but worktree access is only qualified under "${GROK_CLI_SANDBOX}" (the profile whose id+version the receipt attests). Configure that sandbox, or run this seat on the packet.`,
      timedOut: false,
    };
  }
  // THE EGRESS FENCE (codex-f3), on the worktree path only — a packet seat has no untrusted tree to
  // be injected from, and the receipt attests no fence for it. grok honors the proxy env vars
  // (probed), so this bounds which hosts it may reach. A proxy that cannot start refuses the seat
  // LOUDLY rather than running it unfenced (§7); grok does not retry on the packet, so that refusal
  // is a failed seat and no receipt — stricter than codex's fallback, never weaker.
  let proxy: EgressProxy | undefined;
  if (worktreeCwd) {
    try {
      proxy = await startSeatEgressProxy('grok');
    } catch (e) {
      return { ok: false, raw: null, stderrTail: egressStartFailure('grok', e), timedOut: false };
    }
  }
  ensureSandboxProfile(sandbox);
  const cwd = worktreeCwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'grok-review-'));
  return runReviewerExec({
    args: buildGrokReviewArgs({ ...config, sandbox }, prompt, cwd),
    bin: resolveGrokBin(),
    capture: 'stdout',
    ...(proxy ? { env: proxyEnv(proxy.url) } : {}),
    onSpawn: opts.onSpawn,
    stderrLimit: 2000,
    timeoutMs,
  }).then(({ raw, stderrTail, timedOut }) => {
    const egressDenials = proxy ? [...proxy.denials] : undefined;
    proxy?.close();
    try {
      // ONLY the throwaway tmpdir is ours to delete. The worktree is owned by the run's
      // materialization lifecycle (one per run, shared by every seat) and is reaped there —
      // rm'ing it here would destroy the other seats' evidence mid-review.
      if (!worktreeCwd) fs.rmSync(cwd, { force: true, recursive: true });
    } catch {
      // throwaway dir — best-effort cleanup
    }
    const text = raw ? extractGrokText(raw) : null;
    return {
      ...(egressDenials ? { egressDenials } : {}),
      ok: text !== null,
      raw: text,
      stderrTail,
      timedOut,
    };
  });
}
