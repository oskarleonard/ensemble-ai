import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
//   · NETWORK is PORT-scoped, never per-HOST, and it is NOT 443-only. Outbound: TCP/UDP 443 AND
//     53 (DNS resolution) AND local unix sockets. Inbound: any local port (codex binds loopback
//     helpers). Port 53 to any IP is a working DNS-exfiltration channel, so combined with the
//     read-as-data vector above the seat has an egress path for whatever it can read.
//     Seatbelt cannot express a DNS-host allowlist: `(remote host …)` is an unbound variable and
//     `(remote tcp "api.openai.com:443")` is rejected with "host must be * or localhost". So the
//     spec's per-HOST vendor-API intent is NOT achievable in Seatbelt. A true per-host fence
//     needs an egress proxy — deliberately out of v1, and NOT claimed here.
//
// Any change to the rules below MUST bump `version` — a receipt minted under a weaker profile
// must never verify as equivalent to one minted under a tighter one (evidence.ts).
export const CODEX_SANDBOX_PROFILE: SandboxProfileRef = {
  id: 'ensemble-review-codex',
  version: 1,
};

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
  return `(version 1)
;; ensemble-review-codex v${CODEX_SANDBOX_PROFILE.version} — generated by ensemble-ai. Do not hand-edit.
;; Deny-by-default. The codex seat may read the PR worktree, its own auth, and the system roots.
;; $HOME is NOT readable, so no ssh key / vendor credential / other repo is reachable.
;; Containment caveats, stated rather than glossed:
;;   · exec of worktree paths is denied, but a shell can still read an untrusted file as DATA
;;     ("sh <worktree>/x.sh"). The write/secret/network fences are the real boundary.
;;   · /private/var is readable and contains the per-user $TMPDIR, so a secret another process
;;     parked in its own temp dir IS readable here. The claim is "no credential in $HOME".
;;   · network is PORT-scoped, not per-host, and not 443-only: outbound 443 AND 53 (DNS) AND
;;     unix sockets; inbound any local port. Port 53 is a usable exfiltration channel.
;;     Seatbelt cannot express a per-host DNS allowlist; a real fence needs an egress proxy.
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
(allow file-write* (subpath ${JSON.stringify(p.codexHome)}) (subpath "/private/tmp") (subpath "/dev"))
(allow network-outbound (remote ip "*:443") (remote ip "*:53") (remote unix-socket))
(allow network-inbound (local ip "*:*"))
`;
}

// The platform check. Seatbelt is macOS-only; Landlock (Linux) cannot express these read rules
// today. Anywhere else the seat FAILS CLOSED to the packet — never silently to a naked codex.
export function codexSandboxSupported(platform = process.platform): boolean {
  return platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
}

export function defaultCodexSandboxPaths(worktree: string): CodexSandboxPaths {
  return {
    codexHome: path.join(os.homedir(), '.codex'),
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ensemble-sb-'));
  fs.chmodSync(dir, 0o700);
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

// PURE: the codex argv for a WORKTREE-mode review. Differs from the packet argv in exactly two
// ways: the internal sandbox is off (the external profile governs — nested Seatbelt does not
// compose) and the cwd is the worktree (so codex's file tools reach the project). `-o <file>`
// still carries the reply, as in packet mode.
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
