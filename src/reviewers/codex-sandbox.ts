import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { makeOwnerOnlyTempDir } from '../core/artifacts';
import type { SandboxProfileRef } from '../modes/review/evidence';

// THE CODEX WRAPPER PROFILE — an ensemble-OWNED external sandbox that gives the codex seat the
// worktree without giving it the disk (spec §2).
//
// WHY A WRAPPER: codex's own `-s read-only` restricts WRITES, not READS — a `read-only` codex
// still reads anything on disk (openai/codex#5237; no read-scoping option exists). Grok already
// solves this with a kernel profile (`ensemble-review`), so we do the same for codex from the
// outside: `sandbox-exec -f <profile> codex exec … --dangerously-bypass-approvals-and-sandbox`.
// The bypass flag disables codex's INTERNAL sandbox because nested Seatbelt does not compose —
// its own docs say the flag is "intended solely for running in environments that are externally
// sandboxed", which is exactly this. The EXTERNAL profile is the boundary.
//
// HONEST CONTAINMENT (gate-r3 pin 3) — verified empirically on macOS 15, 2026-07-09. State what
// the rules below ACTUALLY grant, never what we wish they granted:
//   · Exec of ANY path inside the worktree is DENIED by the kernel (a planted binary and a
//     planted `#!/bin/sh` script both fail EPERM; an identical script outside the worktree in a
//     read-allowed dir execs fine, so the denial is this rule and not codesigning).
//   · BUT a shell-capable agent can still INTERPRET an untrusted file as DATA: `sh
//     <worktree>/evil.sh` runs, because it execs /bin/sh and merely READS the script. No-exec
//     narrows the vector; it does not close it.
//   · READS: $HOME is NOT readable, so no vendor credential, ssh key, or other repo on disk is
//     reachable — EXCEPT `~/.codex`, which the seat must read to call its own API. The system
//     roots below ARE readable, and `/private/var` among them contains the per-user OS temp dir
//     (`$TMPDIR` realpaths to `/private/var/folders/…`). A secret another process parked in its
//     own $TMPDIR is therefore readable by this seat. That is a real, accepted gap: narrowing it
//     needs a runtime survey of what codex reads from /private/var. Do not read this profile as
//     "no credential anywhere but ~/.codex" — the true claim is "no credential in $HOME".
//   · WRITES: `~/.codex`, `/private/tmp` (the legacy world-shared /tmp, not the per-user
//     $TMPDIR), and `/dev`. `/private/tmp` is shared with every user on the box.
//   · NETWORK is now HOST-scoped, via the engine's egress proxy (codex-f3). This profile denies ALL
//     outbound except ONE loopback port — the in-process CONNECT proxy the engine starts for this
//     seat — plus local unix sockets. The seat is spawned with HTTPS_PROXY/HTTP_PROXY/ALL_PROXY
//     pointed at it, so its every connection arrives there as a CONNECT and is matched against the
//     vendor's host allowlist (see ./egress-hosts). Seatbelt still cannot express the host rule
//     itself — `(remote tcp "api.openai.com:443")` is rejected with "host must be * or localhost" —
//     which is why the fence is a proxy the profile pins the seat to, rather than an SBPL rule.
//     Verified 2026-07-10 under this exact rule set: TCP `*:443` EPERM · UDP and TCP `*:53` EPERM
//     (the old DNS-exfiltration channel is CLOSED) · the one allowed loopback port connects · a
//     DIFFERENT loopback port EPERM. Inbound stays any local port (codex binds loopback helpers).
//   · WHAT THE FENCE STILL DOES NOT STOP, stated rather than glossed: the seat reads its own
//     credential in-process and sends it to the ALLOWED vendor host — irreducible without a token
//     broker. An allowed host is allowed for arbitrary bytes. And hostname RESOLUTION survives
//     (getaddrinfo reaches mDNSResponder over mach-lookup, not a `:53` socket; denying the DNS mach
//     global-names was probed and does NOT stop it), so a low-bandwidth resolver side channel
//     remains. What is closed is the DNS *socket* channel and every direct connection to a host the
//     allowlist does not name.
//
// Any change to the rules below MUST bump `version` — a receipt minted under a weaker profile
// must never verify as equivalent to one minted under a tighter one (evidence.ts).
//
// The id NAMES THE MECHANISM, not just the fact of a fence. `+egress-proxy` alone was ambiguous:
// grok's seat carried a near-identical id while its egress was bounded only by proxy ENV VARS, so a
// receipt reader could not tell a kernel-denied seat from an env-routed one without reading the PR.
// An identity that does not encode what actually happened is the exact defect this evidence machinery
// exists to prevent, so the two ids now diverge on the mechanism: `-kernel` here, `-proxy-env-noshell`
// on grok (see GROK_SANDBOX_PROFILE).
//
// VERSIONS ADVANCE ACROSS A RENAME, never reset. The integer is monotonic over this seat's whole
// FENCE LINEAGE (`ensemble-review-codex` v1 → `…+egress-proxy` v2 → this), so no (id, version) pair
// is ever reused for two different fences, and a reader comparing versions alone still sees which is
// newer. Historical receipts are never rewritten: each stays readable under the id it was issued
// with. (Neither `…+egress-proxy` v2 nor grok's `ensemble-review+egress-proxy` v1 ever reached main —
// both were introduced by this same unmerged PR — so no released receipt is affected by the rename.)
export const CODEX_SANDBOX_PROFILE: SandboxProfileRef = {
  // KERNEL-denied outbound: Seatbelt refuses every direct connection except the one loopback port
  // where the engine's CONNECT proxy enforces the host allowlist (`*:443` and `*:53` verified EPERM).
  id: 'ensemble-review-codex+egress-proxy-kernel',
  // v2 (cross-vendor codex-f1): the network-outbound rule granted `(remote unix-socket)` for ANY
  // socket — a hole the CONNECT proxy never saw. A prompt-injected seat could reach a local agent
  // socket (an ssh-agent, a Docker-style API) under a readable root and exfiltrate off-proxy, while
  // `egress-denials.json` stayed empty and the receipt still claimed host-fenced egress. Verified
  // live 2026-07-10: under the old rule a sandboxed process wrote to an arbitrary unix socket; under
  // the narrowed rule that write is EPERM while DNS still resolves. A weaker fence must never verify
  // as equivalent to this one, so the version bumps.
  // v3: no RULE change — the id was renamed to name the mechanism (above), and the lineage advances.
  version: 3,
};

// The ONE directory a sandboxed codex seat may write to that is neither its own config nor /dev:
// the legacy world-shared `/tmp`, spelled as the path Seatbelt resolves (`/tmp` is a symlink to
// it). Exported because the seat must place its `-o` reply file under a root the profile below
// actually grants — the per-user `$TMPDIR` is READ-only here, and a reply written there fails with
// EPERM after a completed review. Two modules naming the same literal is how that regression gets
// reintroduced, so the profile owns the constant and codex.ts imports it.
export const SANDBOX_WRITABLE_TMP = '/private/tmp';

// The ONE unix-domain socket the seat may open: macOS routes `getaddrinfo` to mDNSResponder over
// this socket, so the seat cannot resolve its vendor host without it (verified 2026-07-10: with the
// socket denied, `dns.lookup` returns ENOTFOUND). A BLANKET `(remote unix-socket)` grant would also
// hand the seat every other local agent socket — an off-proxy exfil channel (codex-f1) — so the
// grant is path-scoped to exactly this. SBPL `path-literal` matches the RESOLVED path, so it is the
// `/private/var` form, not the `/var` symlink (the `/var` spelling was verified NOT to match).
export const MDNS_RESPONDER_SOCKET = '/private/var/run/mDNSResponder';

// Read-allowed system roots. Deny-by-default means everything absent from this list — every
// credential in $HOME, every other repo on disk — is kernel-unreadable to the seat.
const SYSTEM_READ_ROOTS = [
  '/usr',
  '/bin',
  '/sbin',
  '/System',
  '/Library',
  '/opt/homebrew',
  '/private/var',
  '/private/etc',
  '/private/tmp',
  '/dev',
];

function sbSubpaths(paths: string[]): string {
  return paths.map((p) => `(subpath ${JSON.stringify(p)})`).join(' ');
}

// A read root that IS the filesystem root, IS $HOME, or CONTAINS $HOME would hand the seat every
// credential on the machine — the exact fence this profile exists to be. `nodePrefix` is derived
// from wherever node happens to be installed, so it is NOT safe by construction: `/bin/node` ⇒
// `/`, `~/bin/node` ⇒ `$HOME`, `~/node` ⇒ `/Users` (every user's home). Verified 2026-07-10: a
// profile granting `(allow file-read* (subpath "$HOME"))` lets the sandboxed process read
// `~/.ssh/id_ed25519`. So every interpolated read root is checked before it reaches a rule.
export function isUnsafeReadRoot(root: string, home: string = os.homedir()): boolean {
  const r = path.resolve(root);
  if (r === path.parse(r).root) return true; // "/" — the whole disk
  const rel = path.relative(r, path.resolve(home));
  // rel === '' → r IS home; a rel that neither climbs out nor is absolute → r CONTAINS home.
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export interface CodexSandboxPaths {
  // The codex CLI's own auth/config — the seat must read its own credential to call its API.
  codexHome: string;
  // Where node + the codex install live (resolved from the running node, not guessed).
  nodePrefix: string;
  // The loopback port of THIS run's egress proxy — the seat's only route off the machine.
  proxyPort: number;
  // The worktree root, ALREADY REALPATH'd. Seatbelt matches resolved paths, so a
  // `/tmp/...` (symlink to `/private/tmp/...`) subpath rule silently matches nothing.
  worktree: string;
}

// PURE: the exact SBPL text. Encoded as data so a unit test pins every rule — a silent drop
// here is the difference between a sandbox and a costume.
//
// FAILS CLOSED on an unsafe read root (see isUnsafeReadRoot): we refuse to emit a profile that
// would grant the seat $HOME or the whole disk, rather than emit a costume that looks like a
// sandbox. The caller's contract (spec §2) is that a seat which cannot get a qualifying sandbox
// keeps the PACKET, loudly — so throwing here degrades the seat; it never widens the fence.
export function renderCodexSandboxProfile(p: CodexSandboxPaths): string {
  for (const [name, root] of [
    ['worktree', p.worktree],
    ['nodePrefix', p.nodePrefix],
    ['codexHome', p.codexHome],
  ] as const) {
    if (isUnsafeReadRoot(root)) {
      throw new Error(
        `ensemble-ai: refusing to build the codex sandbox profile — ${name} resolves to ${path.resolve(root)}, which is the filesystem root or contains your home directory. Granting it read access would expose every credential on this machine. The codex seat must fall back to the packet.`
      );
    }
  }
  // The egress rule is the whole fence: a port that is not a real port would either be dropped by
  // Seatbelt (leaving the seat with NO route, a silent 12-minute hang) or — spelled as `*` — grant
  // the very any-host egress this profile exists to deny. Refuse to emit either.
  if (!Number.isInteger(p.proxyPort) || p.proxyPort < 1 || p.proxyPort > 65535) {
    throw new Error(
      `ensemble-ai: refusing to build the codex sandbox profile — proxyPort ${String(p.proxyPort)} is not a valid TCP port. The seat's only egress route is that loopback port; without it the profile would fence nothing. The codex seat must fall back to the packet.`
    );
  }
  return `(version 1)
;; ${CODEX_SANDBOX_PROFILE.id} v${CODEX_SANDBOX_PROFILE.version} — generated by ensemble-ai. Do not hand-edit.
;; Deny-by-default. The codex seat may read the PR worktree, its own auth, and the system roots.
;; $HOME is NOT readable, so no ssh key / vendor credential / other repo is reachable.
;; Containment caveats, stated rather than glossed:
;;   · exec of worktree paths is denied, but a shell can still read an untrusted file as DATA
;;     ("sh <worktree>/x.sh"). The write/secret/network fences are the real boundary.
;;   · /private/var is readable and contains the per-user $TMPDIR, so a secret another process
;;     parked in its own temp dir IS readable here. The claim is "no credential in $HOME".
;;   · outbound network is DENIED except the one loopback port below — the engine's egress proxy,
;;     which allows CONNECT only to this vendor's host allowlist — plus the single mDNSResponder unix
;;     socket getaddrinfo needs (path-scoped, NOT a blanket unix-socket grant: codex-f1). Direct :443
;;     and :53 (the old DNS-exfiltration channel) are gone. The seat still sends its own credential
;;     to the ALLOWED vendor host, and hostname resolution still works — neither closable here.
(deny default)
(import "/System/Library/Sandbox/Profiles/bsd.sb")
(allow process-fork)
(allow process-exec)
;; Never EXECUTE untrusted PR content (gate-r3 pin 3). Last match wins in SBPL, so this
;; deny overrides the blanket process-exec above.
(deny process-exec (subpath ${JSON.stringify(p.worktree)}))
(allow process-info*)
(allow file-map-executable)
(allow ipc-posix-shm*)
(allow sysctl-read)
(allow mach-lookup)
(allow signal)
(allow file-read-metadata)
(allow file-read* ${sbSubpaths(SYSTEM_READ_ROOTS)})
(allow file-read* (subpath ${JSON.stringify(p.nodePrefix)}))
(allow file-read* (subpath ${JSON.stringify(p.worktree)}))
(allow file-read* (subpath ${JSON.stringify(p.codexHome)}))
(allow file-write* (subpath ${JSON.stringify(p.codexHome)}) (subpath ${JSON.stringify(SANDBOX_WRITABLE_TMP)}) (subpath "/dev"))
(allow network-outbound (remote ip "localhost:${p.proxyPort}") (remote unix-socket (path-literal ${JSON.stringify(MDNS_RESPONDER_SOCKET)})))
(allow network-inbound (local ip "*:*"))
`;
}

// The platform check. Seatbelt is macOS-only; Landlock (Linux) cannot express these read rules
// today. Anywhere else the seat FAILS CLOSED to the packet — never silently to a naked codex.
export function codexSandboxSupported(platform = process.platform): boolean {
  return platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
}

// The port used when the profile is RENDERED as a dry run (seat qualification), before this run's
// proxy has bound its ephemeral port. Qualification asks "would the read roots be safe here?"; the
// real port is interpolated at spawn, when it exists. 1 is a valid port, so the dry run exercises
// the same validation the real render does.
export const QUALIFY_PROBE_PORT = 1;

export function defaultCodexSandboxPaths(
  worktree: string,
  proxyPort: number
): CodexSandboxPaths {
  return {
    codexHome: path.join(os.homedir(), '.codex'),
    proxyPort,
    // process.execPath is <prefix>/bin/node → <prefix> covers node AND the codex install that
    // sits beside it in the same nvm/npm prefix. This is only as narrow as the user's install
    // layout: `/bin/node` ⇒ `/` and `~/bin/node` ⇒ `$HOME`. renderCodexSandboxProfile REJECTS
    // those rather than granting them — see isUnsafeReadRoot.
    nodePrefix: path.dirname(path.dirname(fs.realpathSync(process.execPath))),
    worktree: fs.realpathSync(worktree),
  };
}

// Write the profile 0600 into an owner-only temp dir. The dir is the CALLER's to reap: it lives
// only as long as the sandbox-exec that reads it, and nothing else can clean it up (mkdtemp names
// are random, so a leaked dir is unfindable). Returning a `cleanup` alongside the path makes the
// lifetime explicit rather than leaking one owner-only temp dir per worktree codex run.
export function writeCodexSandboxProfile(paths: CodexSandboxPaths): {
  cleanup: () => void;
  file: string;
} {
  // Render FIRST: an unsafe read root must throw before we create anything to clean up.
  const profile = renderCodexSandboxProfile(paths);
  const dir = makeOwnerOnlyTempDir('ensemble-sb-');
  const file = path.join(dir, 'ensemble-review-codex.sb');
  fs.writeFileSync(file, profile, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return {
    cleanup: () => {
      try {
        fs.rmSync(dir, { force: true, recursive: true });
      } catch {
        /* best-effort, like every other reap in this engine */
      }
    },
    file,
  };
}

// PURE: wrap a command in `sandbox-exec -f <profile>`. The wrapped argv is what actually runs.
export function wrapWithSandbox(
  profileFile: string,
  bin: string,
  args: string[]
): { args: string[]; bin: string } {
  return { args: ['-f', profileFile, bin, ...args], bin: '/usr/bin/sandbox-exec' };
}

// PURE: the codex argv for a WORKTREE-mode review. Differs from the packet argv: the internal
// sandbox is off (the external profile governs — nested Seatbelt does not compose), the cwd is the
// worktree (so codex's file tools reach the project), and it carries NONE of the packet FENCE flags
// (`--ignore-user-config` + `--strict-config` + the `otel.*` overrides) — on the worktree path the egress proxy + kernel
// sandbox already deny the same operator-MCP/telemetry hosts at the network layer, so the packet's
// source-level fence is that path's substitute for them, not a second copy. `-o <file>` still
// carries the reply, as in packet mode.
export function buildCodexWorktreeArgs(
  config: { effort: string; model: string },
  outFile: string,
  prompt: string
): string[] {
  return [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--color',
    'never',
    '--dangerously-bypass-approvals-and-sandbox',
    '-m',
    config.model,
    '-c',
    `model_reasoning_effort="${config.effort}"`,
    '-o',
    outFile,
    prompt,
  ];
}
