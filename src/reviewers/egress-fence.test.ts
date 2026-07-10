import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { codexSandboxSupported, renderCodexSandboxProfile } from './codex-sandbox';
import { egressHostsFor, VENDOR_EGRESS_HOSTS } from './egress-hosts';

// THE PROFILE HALF OF THE FENCE (codex-f3). The proxy is only a fence if the kernel forbids the seat
// from going around it. These tests drive `sandbox-exec` for real, with LOCAL LISTENERS as canaries:
// a seat process may reach the ONE loopback port its profile names, and nothing else.
//
// macOS-only (Seatbelt). Everywhere else the codex seat fails closed to the packet and never runs
// under this profile at all, so there is nothing to assert.
const darwin = codexSandboxSupported();

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

// A loopback listener whose port a canary can dial. Returns the port.
async function listener(): Promise<number> {
  const server = net.createServer((s) => s.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  cleanups.push(() => server.close());
  return (server.address() as net.AddressInfo).port;
}

function writeProfile(proxyPort: number): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egress-fence-'));
  cleanups.push(() => fs.rmSync(dir, { force: true, recursive: true }));
  const file = path.join(dir, 'p.sb');
  fs.writeFileSync(
    file,
    renderCodexSandboxProfile({
      codexHome: path.join(os.homedir(), '.codex'),
      nodePrefix: path.dirname(path.dirname(fs.realpathSync(process.execPath))),
      proxyPort,
      worktree: fs.realpathSync(os.tmpdir()),
    })
  );
  return file;
}

// `nc -z` under the profile: exit 0 = the kernel let the connection through.
function canReach(profileFile: string, host: string, port: number): boolean {
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-f', profileFile, '/usr/bin/nc', '-z', '-G', '2', host, String(port)], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

describe.runIf(darwin)('the Seatbelt profile denies every outbound except the proxy port', () => {
  it('lets a seat reach the proxy port, and NOTHING else on loopback', async () => {
    const proxyPort = await listener();
    const otherPort = await listener();
    const profileFile = writeProfile(proxyPort);

    expect(canReach(profileFile, '127.0.0.1', proxyPort)).toBe(true);
    // A second local listener the profile does not name: the seat cannot reach it. This is what
    // makes the proxy a fence and not a suggestion — the seat cannot open its own channel.
    expect(canReach(profileFile, '127.0.0.1', otherPort)).toBe(false);
  });

  // The exfil channel codex-f3 reported: `(remote ip "*:443")` let a prompt-injected shell POST the
  // seat's credential to any host on the internet. It is gone, and so is the `:53` DNS channel.
  it('a seat process cannot reach a non-proxy host on :443 or :53', async () => {
    const proxyPort = await listener();
    const profileFile = writeProfile(proxyPort);

    expect(canReach(profileFile, '1.1.1.1', 443)).toBe(false);
    expect(canReach(profileFile, '1.1.1.1', 53)).toBe(false);
  });
});

describe('the egress allowlist is per-vendor config, never a global constant', () => {
  it('gives each vendor its own hosts — one vendor\'s API is another vendor\'s exfil host', () => {
    expect(egressHostsFor('codex')).not.toEqual(egressHostsFor('grok'));
    // No host is shared between vendors: an intersection would let either seat reach the other's API.
    const shared = egressHostsFor('codex').filter((h) => egressHostsFor('grok').includes(h));
    expect(shared).toEqual([]);
  });

  it('names only the hosts each vendor was OBSERVED to need', () => {
    expect([...egressHostsFor('codex')].sort()).toEqual([
      'ab.chatgpt.com',
      'api.openai.com',
      'auth.openai.com',
      'chatgpt.com',
    ]);
    // grok needs BOTH, and a review fails without either: `cli-chat-proxy.grok.com` is the API base
    // the prompt and findings travel over, and `auth.x.ai` mints the bearer token that API demands.
    // Pinned as a PAIR because the one-host list was a live production defect — the worktree seat
    // could reach the chat proxy, could not reach its own auth host, and 401'd into a packet
    // fallback on every review (9 denied `auth.x.ai:443` CONNECTs, munin run
    // `2026-07-10-14-49-44-5f601154`). A future edit that drops either host reintroduces that bug.
    expect([...egressHostsFor('grok')].sort()).toEqual(['auth.x.ai', 'cli-chat-proxy.grok.com']);
  });

  // grok's auth host is grok's ALONE. The intersection test above forbids it appearing on codex's
  // list; this says why that is not pedantry — an xAI bearer-auth endpoint reachable from the codex
  // seat is a credentialed host codex has no reason to dial, i.e. an exfil channel.
  it('keeps grok\'s auth host off codex\'s list', () => {
    expect(egressHostsFor('codex')).not.toContain('auth.x.ai');
  });

  // The observed-but-unneeded hosts a review seat must NOT be able to reach: the operator's MCP
  // server (a live credentialed channel codex loads from ~/.codex/config.toml) and vendor telemetry.
  it('excludes the operator MCP server and vendor telemetry that the probe saw denied', () => {
    const all = Object.values(VENDOR_EGRESS_HOSTS).flat();
    for (const host of ['mcp.supabase.com', 'api.supabase.com', 'api.mixpanel.com', 'grok.com']) {
      expect(all).not.toContain(host);
    }
  });

  // EXHAUSTIVE over ReviewerId, like SEAT_QUALIFIERS: a new vendor cannot inherit another's hosts.
  it('covers every reviewer id', () => {
    expect(Object.keys(VENDOR_EGRESS_HOSTS).sort()).toEqual(['claude', 'codex', 'grok']);
  });
});
