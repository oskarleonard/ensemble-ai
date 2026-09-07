import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveBin } from '../core/bin';
import { type EgressProxy, proxyEnv } from '../core/egress-proxy';
import { boundedStreamTail, runReviewerExec } from '../core/spawn';
import type { ReviewerConfig } from '../core/types';
import type { SandboxProfileRef } from '../modes/review/evidence';

import { type CodexReviewResult, type RunReviewOpts } from './codex';
import { egressStartFailure, startSeatEgressProxy } from './egress-seat';

// GROK NOW HAS A LIVENESS SIGNAL, and these three numbers are what that bought.
//
// The old shape: `-p --output-format json` printed ONE envelope at the very end, so a wedged seat
// and a working one looked identical until the absolute watchdog fired. `inactivityTimeoutMs` had
// nothing to reset on, the absolute cap WAS the only watchdog, and a bigger budget was therefore
// also a bigger wedge cost — which is why the worktree seat was held at 30 min rather than codex's
// 60. The header said: "Raise it to codex's figure once grok exposes a progress stream to arm
// `inactivityTimeoutMs` on." `--output-format streaming-messages-json --include-partial-messages`
// is that stream (verified live 2026-09-07 on the pinned grok 1.0.5): NDJSON where even the model's
// REASONING arrives as `thinking_delta` events, so silence really does mean a wedge and never
// "it is thinking hard".
//
// So the roles swap, exactly as they did for codex. The LIVENESS watchdog is now the one doing the
// real work — it reclaims a wedge in 15 min of silence on BOTH paths — and the absolute caps
// degrade to pure runaway backstops, sized PAST honest work rather than at it. That matters:
// grok-4.6 at xhigh now takes 10–15 min per seat almost regardless of packet size (2026-09-05:
// 9.9–14.6 min finished, and two seats died at exactly 15.0 min — the right tail of honest work,
// killed by a cap that was never meant to police it). A killed honest seat loses everything already
// paid for; a wedge now dies in 15 either way.
export const GROK_PACKET_REVIEW_TIMEOUT_MS = 1_800_000; // 30 min runaway backstop
export const GROK_WORKTREE_REVIEW_TIMEOUT_MS = 3_600_000; // 60 min runaway backstop (codex's figure)

// The liveness watchdog: this long with NOTHING on stdout means a wedged seat, not a slow one.
// Sized at CODEX_INACTIVITY_TIMEOUT_MS for the same reason — it is the seat's OLD ENTIRE packet
// budget, so honest work is never worse off than it was before the watchdog existed, while a wedge
// dies in 15 min instead of 30/60. grok's stream is finer-grained than codex's (per-token deltas,
// not per-completed-item), so 15 min of true silence is an even stronger wedge signal here.
export const GROK_INACTIVITY_TIMEOUT_MS = 900_000; // 15 min of SILENCE

// The bounded NDJSON tail kept as a diagnostic when a seat is reclaimed — what it was doing last.
// Smaller than codex's 1 MB because grok streams per-TOKEN deltas: 100 KB is already thousands of
// events, and the tail is a post-mortem, not the reply.
const GROK_STREAM_TAIL_LIMIT = 100_000; // 100 KB

// The Grok (xAI) review adapter — the second cross-vendor lens beside Codex. It
// mirrors codex.ts but for the THREE ways grok's CLI differs (verified live
// 2026-06-29, grok v0.2.73):
//   1. The reply prints to STDOUT, not an `-o` file → runReviewerExec in stdout
//      mode (the codex path is outfile mode; the watchdog/group-kill are shared).
//   2. `--output-format streaming-messages-json --include-partial-messages`
//      prints NDJSON while it works and hands the WHOLE reply back on its final
//      `result` line; the actual review is that line's `.result` (which itself
//      carries the ```json findings block → parseFindings, the SAME path codex
//      uses; grok's `--json-schema` is unreliable so we never use it — symmetry
//      IS robustness here). See parseGrokStream.
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
//   `ensemble-review-grok` — grok's own kernel profile: a `strict` (deny-by-default READS) base + a
//                        secret deny-list. Pointing it at the worktree root is config-only
//                        (`--cwd <worktree>`).
//   `+proxy-env-noshell` — the engine's per-host CONNECT fence (codex-f3), reached by ENV not by
//                        kernel rule. grok honors the standard proxy env vars (PROBED 2026-07-10: a
//                        logging proxy saw its `cli-chat-proxy.grok.com:443` CONNECT), so the seat is
//                        spawned pointed at the proxy and reaches its two xAI hosts — that chat proxy
//                        and `auth.x.ai`, which mints the bearer token the chat proxy demands — and
//                        nothing else. Its `api.mixpanel.com` telemetry is denied, and grok completes
//                        anyway.
//
// WHY THE ID DOES NOT SAY `+egress-proxy` LIKE CODEX'S. It used to, and that was the defect: an id
// that reads like the codex one IMPLIES the codex one's guarantee (a kernel rule denying direct
// outbound), which grok does NOT have. grok's `sandbox.toml` profile schema is `extends` /
// `read_only` / `read_write` / `allow` / `deny` — FILES ONLY, no network keys — so no rule denies
// this process direct outbound, and a grok that chose to ignore `HTTPS_PROXY` could reach any host.
// What actually bounds it is the SEAT HAVING NO SHELL: `--disallowed-tools bash` means there is no
// interpreter inside the untrusted tree for a prompt-injected file to drive (and `strict` is
// documented as "no child network"). The id now names that: env-routed egress, no-shell containment.
// A receipt reader must be able to tell this seat from the kernel-fenced one WITHOUT reading a PR.
//
// Bump `version` whenever REVIEW_PROFILE_BLOCK, the egress allowlist, or this identity changes — a
// receipt minted under a weaker profile must never verify as equivalent to one minted under a
// tighter one. Versions advance across a rename and never reset (see CODEX_SANDBOX_PROFILE): this
// seat's lineage is `ensemble-review` v1 → `…+proxy-env-noshell` v2 → this, so no (id, version) pair
// is ever reused. v3 is the `auth.x.ai` allowlist entry (see egress-hosts.ts): a strictly WIDER
// egress fence than v2's, hence a distinct version, so a v2 receipt can never read as equivalent.
export const GROK_SANDBOX_PROFILE: SandboxProfileRef = {
  // Egress fenced by proxy ENV VARS ONLY (grok's sandbox schema has no network keys); what bounds a
  // prompt-injected tree is that the seat has NO SHELL (`--disallowed-tools bash`) to exercise it.
  id: 'ensemble-review-grok+proxy-env-noshell',
  version: 3,
};

// PURE: the exact grok CLI args for a review. Encodes every lived lesson as DATA
// so a unit test pins it: `-p <prompt>` (single-turn, prints to stdout) ·
// `--output-format streaming-messages-json` + `--include-partial-messages` (the
// NDJSON progress stream — it is what ARMS the liveness watchdog, and its final
// `result` line still carries a real `stop_reason` terminal signal; the pair is
// load-bearing, `--include-partial-messages` is what makes the deltas flow
// DURING work rather than only at each block's end)
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
    'streaming-messages-json',
    '--include-partial-messages',
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

// What one grok NDJSON stream says, reduced to the facts the seat acts on.
export interface GrokStreamSummary {
  // How many well-formed STREAM OBJECTS were seen (a line with a `type`). Zero means the stdout was
  // never grok's NDJSON at all — which is precisely the signal that licenses the legacy-envelope
  // fallback below. Non-zero with `sawResult: false` means a stream that was CUT: fail closed.
  events: number;
  isError: boolean;
  sawResult: boolean;
  stopReason: string | null;
  subtype: string | null;
  // The whole reply, or null. NEVER reassembled from deltas — see below.
  text: string | null;
}

// PURE: read grok's `--output-format streaming-messages-json` NDJSON.
//
// Line shapes (verified live 2026-09-07, grok 1.0.5 — fixtures/grok/streaming-messages.ndjson):
//   {"type":"system","subtype":"init",…}                       once, first
//   {"type":"stream_event","event":{…}}                        while working — message_start,
//     content_block_start/_delta/_stop (thinking_delta | text_delta), message_delta, message_stop
//   {"type":"assistant","message":{content:[…],"stop_reason":…}}
//   {"type":"result","subtype":"success","is_error":false,"result":"<the whole reply>",…}  LAST
//
// TWO RULES CARRY THE WHOLE DESIGN:
//
// 1. THE REPLY IS THE `result` LINE, never the deltas. grok hands the complete text back on that
//    one line, so there is nothing to reassemble — and reassembling would be actively WRONG: a
//    stream cut mid-answer would yield a plausible-looking HALF REVIEW that parseFindings would
//    happily read as a completed review with fewer findings. A partial review is not a review.
//    No `result` line ⇒ `text: null`, `sawResult: false` ⇒ the caller records failed-reviewer.
// 2. A BROKEN LINE IS SKIPPED, NEVER THROWN. The watchdog kills the process GROUP mid-write, so a
//    reclaimed seat's last line is routinely a partial object. Parsing must survive that: this is
//    the post-mortem path, and it must not itself explode.
//
// `text` is returned ONLY on an unambiguous success — `is_error === false`, `subtype === "success"`,
// and a non-empty string after trim. A refusal or a length-stop still emits a valid `result` line,
// and returning its (empty or error) payload would let parseFindings read an empty, falsely
// "reviewed" findings object — the same trap extractGrokText's empty-`.text` guard exists for.
export function parseGrokStream(stdout: string): GrokStreamSummary {
  const summary: GrokStreamSummary = {
    events: 0,
    isError: false,
    sawResult: false,
    stopReason: null,
    subtype: null,
    text: null,
  };
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== 'object' || parsed === null) continue;
      obj = parsed as Record<string, unknown>;
    } catch {
      continue; // a partial line (killed mid-write) or noise — never fatal (rule 2)
    }
    if (typeof obj.type !== 'string') continue; // not a stream object → not counted as an event
    summary.events++;
    if (obj.type !== 'result') continue;
    // The terminal line. Take the LAST one if grok ever emitted more than one.
    summary.sawResult = true;
    summary.isError = obj.is_error === true;
    summary.subtype = typeof obj.subtype === 'string' ? obj.subtype : null;
    summary.stopReason = typeof obj.stop_reason === 'string' ? obj.stop_reason : null;
    const reply = typeof obj.result === 'string' ? obj.result : '';
    summary.text =
      !summary.isError && summary.subtype === 'success' && reply.trim() ? reply : null;
  }
  return summary;
}

// THE LEGACY FALLBACK, kept deliberately. Pulls the review out of grok's OLD
// `--output-format json` envelope, where the reply was `.text`. Reached only when
// parseGrokStream saw NO stream objects at all (`events === 0`) AND the raw stdout does
// not itself look like a stream line — i.e. a future grok that ignores or drops
// `streaming-messages-json` and answers in the old shape, or in plain text. That drift
// then DEGRADES to a working review instead of crashing the seat.
//
// It is NOT reachable for a CUT stream, including one cut INSIDE its very first line. A
// stream cut after at least one full line already fails the `events === 0` gate. A stream
// cut inside its first line still has `events === 0` (the truncated line never parses),
// so runGrokReview also sniffs the raw stdout itself (`/^\s*\{\s*"type"\s*:/`) and skips
// this function whenever it looks stream-shaped — otherwise this function's raw-stdout
// degrade would hand parseFindings that partial line as if it were a review. Fail closed
// is the only correct answer in both cases.
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
// uses — grok forks a leader/subagents, so the group-kill is mandatory, PLUS the
// liveness watchdog its NDJSON stream now arms). Returns the same shape as
// runCodexReview so the caller treats both reviewers uniformly: `raw` is the
// stream's `result` reply (ready for parseFindings), `stream` its bounded NDJSON
// tail, `timedOutReason` which watchdog fired. On grok's separate xAI quota.
export async function runGrokReview(
  prompt: string,
  config: ReviewerConfig,
  opts: RunReviewOpts = {}
): Promise<CodexReviewResult> {
  const timeoutMs =
    opts.timeoutMs ??
    (opts.worktree ? GROK_WORKTREE_REVIEW_TIMEOUT_MS : GROK_PACKET_REVIEW_TIMEOUT_MS);
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
  // PACKET-MODE VERIFICATION (packet-f1, 2026-07-10) — the codex packet fence (buildCodexReviewArgs)
  // has NO grok counterpart, and this documents why, verified rather than assumed (the task: verify,
  // document, change nothing):
  //   · VERIFIED sandboxed on every path: buildGrokReviewArgs passes `--sandbox` unconditionally and
  //     resolveReviewSandbox floors it at a DENY-BY-DEFAULT profile (`strict` base — bare `strict` or
  //     `ensemble-review`), so a PACKET review runs deny-by-default reads: credentials in $HOME are
  //     kernel-unreadable to it. (The `ensemble-review` secret deny-list is belt-and-suspenders for
  //     secrets INSIDE the cwd; a packet cwd is a throwaway with the diff in the prompt, so a bare-
  //     `strict` resolution loses nothing that matters to the packet threat model.)
  //   · The codex hole has NO analog here: codex's packet seat loaded the operator's
  //     ~/.codex/config.toml `[mcp_servers]` (an OAuth-credentialed mcp.supabase.com) — the reason it
  //     now passes `--ignore-user-config`. grok loads no such server: `grok mcp list` is empty
  //     (verified live 2026-07-10). There is no operator-credentialed MCP egress channel to fence.
  //   · What the sandbox does NOT deny, stated plainly: grok's OWN first-party usage telemetry. Under
  //     `--sandbox strict` a grok process still ATTEMPTS `api.mixpanel.com` (observed live 2026-07-10
  //     through a logging proxy) — `strict` denies CHILD-process network, not the main agent's
  //     outbound. The worktree egress proxy below DENIES that host; a packet seat has no proxy, so its
  //     telemetry is not network-fenced. ACCEPTED, not a cred-exfil hole: the packet diff is prompt
  //     DATA (no untrusted tree to inject from), the seat has no shell (`--disallowed-tools bash`),
  //     and grok holds no operator credentials — so that channel can carry only grok's first-party
  //     usage stats, a privacy nit, never a diff/secret leak. The packet path is left byte-identical.
  //
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
  // ONCE THE FENCE IS UP IT COMES DOWN ON EVERY PATH. `ensureSandboxProfile` writes a file,
  // `resolveGrokBin` throws when grok is not installed, and `runReviewerExec` can reject — each of
  // those, on the old `.then()`-only teardown, left the proxy's listening server and its sockets
  // open. The CLI sets `process.exitCode` rather than calling `process.exit()`, so a leaked handle
  // keeps the event loop alive and the run never exits. `finally` is what makes that unreachable —
  // the same guarantee codex's `.finally(cleanup)` already had.
  let cwd: string | undefined;
  try {
    ensureSandboxProfile(sandbox);
    cwd = worktreeCwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'grok-review-'));
    const { raw, stderrTail, timedOut, timedOutReason } = await runReviewerExec({
      args: buildGrokReviewArgs({ ...config, sandbox }, prompt, cwd),
      bin: resolveGrokBin(),
      capture: 'stdout',
      ...(proxy ? { env: proxyEnv(proxy.url) } : {}),
      // THE LIVENESS WATCHDOG. Under `capture: 'stdout'` the accumulated stdout IS what resets it
      // (spawn.ts), and grok's NDJSON now flows throughout the work — so this reclaims a WEDGED
      // seat in 15 min while `timeoutMs` above stands back as a pure runaway backstop.
      inactivityTimeoutMs: GROK_INACTIVITY_TIMEOUT_MS,
      onSpawn: opts.onSpawn,
      stderrLimit: 2000,
      timeoutMs,
    });
    const stream = raw ? parseGrokStream(raw) : null;
    // The reply is the stream's `result` line. The legacy envelope is tried ONLY when the stdout was
    // never the NDJSON stream (`events === 0`) — a CUT stream fails closed rather than handing
    // parseFindings a pile of half-written events dressed as a review.
    const text = !raw || !stream
      ? null
      : stream.events === 0 && !/^\s*\{\s*"type"\s*:/.test(raw)
        ? extractGrokText(raw)
        : stream.text;
    const stalled = timedOut && timedOutReason === 'inactivity';
    return {
      // Snapshotted HERE, in the return expression — it is evaluated before the `finally` closes the
      // proxy, so the denial audit the footer and `egress-denials.json` depend on is never lost.
      ...(proxy ? { egressDenials: [...proxy.denials] } : {}),
      // A liveness reclaim NAMES ITSELF, the way codex's toCodexResult does: the trail must say "it
      // went silent" (a wedge — reclaim it, do not buy it more budget) and never the generic "timed
      // out" it shares with an honest seat the backstop cut.
      ...(stalled
        ? {
            failWhy: `the liveness watchdog cut it after ${Math.round(GROK_INACTIVITY_TIMEOUT_MS / 60_000)} min of silence`,
          }
        : {}),
      ok: text !== null,
      raw: text,
      stderrTail,
      // The bounded NDJSON tail: a reclaimed seat leaves a record of what it was doing, not just
      // "it timed out". Cut on a line boundary — the trail persists it as .jsonl.
      ...(raw ? { stream: boundedStreamTail(raw, GROK_STREAM_TAIL_LIMIT) } : {}),
      timedOut,
      ...(timedOutReason ? { timedOutReason } : {}),
    };
  } finally {
    proxy?.close();
    try {
      // ONLY the throwaway tmpdir is ours to delete. The worktree is owned by the run's
      // materialization lifecycle (one per run, shared by every seat) and is reaped there —
      // rm'ing it here would destroy the other seats' evidence mid-review.
      if (!worktreeCwd && cwd) fs.rmSync(cwd, { force: true, recursive: true });
    } catch {
      // throwaway dir — best-effort cleanup
    }
  }
}
