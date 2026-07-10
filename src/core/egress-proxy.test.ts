import http from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_CONNECT_PORTS,
  type EgressProxy,
  isHostAllowed,
  parseAuthority,
  proxyEnv,
  startEgressProxy,
} from './egress-proxy';

// THE EGRESS FENCE (codex-f3). These tests use a LOCAL LISTENER as the canary: a CONNECT to it
// either tunnels (host allowlisted) or is refused with 403. Nothing here touches the network.

const open: EgressProxy[] = [];
const servers: http.Server[] = [];

afterEach(() => {
  for (const p of open.splice(0)) p.close();
  for (const s of servers.splice(0)) s.close();
});

async function proxy(
  allowHosts: readonly string[],
  extra: { allowPorts?: readonly number[]; port?: number } = {}
): Promise<EgressProxy> {
  const p = await startEgressProxy({ allowHosts, ...extra });
  open.push(p);
  return p;
}

// Issue a raw CONNECT against the proxy and hand back the status line it answers with.
function connect(proxyPort: number, authority: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, '127.0.0.1', () => {
      s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
    });
    s.once('data', (b: Buffer) => {
      const status = b.toString('utf8').split('\r\n')[0];
      s.destroy();
      resolve(status);
    });
    // A post-resolve destroy can surface as ECONNRESET; only a PRE-response error is a failure.
    s.on('error', (e) => {
      if (!s.destroyed) reject(e);
    });
  });
}

describe('the proxy allows an allowlisted CONNECT and refuses everything else', () => {
  // A real loopback listener stands in for the vendor API host: `localhost` is a resolvable name
  // that we can allowlist, so an ALLOWED tunnel is provably established end-to-end.
  async function canary(): Promise<number> {
    const server = net.createServer((sock) => {
      // The test tears the tunnel down abruptly; without this the canary's ECONNRESET is uncaught.
      sock.on('error', () => sock.destroy());
      sock.end('canary');
    });
    servers.push(server as unknown as http.Server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return (server.address() as net.AddressInfo).port;
  }

  it('tunnels a CONNECT to an allowlisted host, end to end', async () => {
    const canaryPort = await canary();
    // The canary stands in for the vendor API host. `allowPorts` exists so it can live on an
    // ephemeral port; production takes the [443] default (pinned below).
    const p = await proxy(['localhost'], { allowPorts: [canaryPort] });
    expect(await connect(p.port, `localhost:${canaryPort}`)).toContain('200');
    expect(p.denials).toHaveLength(0);
  });

  // The port pin is half the fence: an allowlisted host reachable on ANY port is an SSH/SMTP relay.
  it('defaults the CONNECT port allowlist to exactly [443]', () => {
    expect(DEFAULT_CONNECT_PORTS).toEqual([443]);
  });

  it('refuses a CONNECT to a host that is not on the allowlist, with a logged structured denial', async () => {
    const p = await proxy(['chatgpt.com']);
    const status = await connect(p.port, 'evil.example:443');
    expect(status).toContain('403');
    expect(p.denials).toEqual([
      {
        host: 'evil.example',
        method: 'CONNECT',
        port: 443,
        reason: "host is not on this vendor's egress allowlist",
      },
    ]);
  });

  it('refuses an allowlisted host on a non-443 port — the allowlist is not a general relay', async () => {
    const p = await proxy(['chatgpt.com']);
    expect(await connect(p.port, 'chatgpt.com:22')).toContain('403');
    expect(p.denials[0]).toMatchObject({ host: 'chatgpt.com', port: 22, reason: 'port 22 is not 443' });
  });

  it('refuses plaintext HTTP through the proxy — the fence tunnels TLS only', async () => {
    const p = await proxy(['chatgpt.com']);
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { headers: { host: 'chatgpt.com' }, host: '127.0.0.1', method: 'GET', path: 'http://chatgpt.com/x', port: p.port },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
    expect(p.denials[0]).toMatchObject({ host: 'chatgpt.com', method: 'GET' });
  });

  it('calls onDenial the instant a connection is refused — a denial is LOUD, not a post-hoc read', async () => {
    const seen: string[] = [];
    const p = await startEgressProxy({ allowHosts: ['chatgpt.com'], onDenial: (d) => seen.push(d.host) });
    open.push(p);
    await connect(p.port, 'evil.example:443');
    expect(seen).toEqual(['evil.example']);
  });
});

describe('the allowlist cannot be bypassed by spelling', () => {
  it('matches hosts exactly, case-insensitively, ignoring a trailing root dot and IPv6 brackets', () => {
    expect(isHostAllowed('CHATGPT.COM', ['chatgpt.com'])).toBe(true);
    expect(isHostAllowed('chatgpt.com.', ['chatgpt.com'])).toBe(true);
    expect(isHostAllowed('[::1]', ['::1'])).toBe(true);
  });

  // The subdomain trap: a naive `endsWith` allowlist admits an attacker-registered lookalike.
  it('is NOT a suffix match — a lookalike subdomain of an allowed host is refused', () => {
    expect(isHostAllowed('evil-chatgpt.com', ['chatgpt.com'])).toBe(false);
    expect(isHostAllowed('chatgpt.com.attacker.tld', ['chatgpt.com'])).toBe(false);
    expect(isHostAllowed('sub.chatgpt.com', ['chatgpt.com'])).toBe(false);
    expect(isHostAllowed('', ['chatgpt.com'])).toBe(false);
  });

  it('parses an authority, including a bracketed IPv6 literal, and rejects a bad port', () => {
    expect(parseAuthority('chatgpt.com:443')).toEqual({ host: 'chatgpt.com', port: 443 });
    expect(parseAuthority('[::1]:443')).toEqual({ host: '[::1]', port: 443 });
    expect(parseAuthority('chatgpt.com')).toBeNull();
    expect(parseAuthority('chatgpt.com:0')).toBeNull();
    expect(parseAuthority('chatgpt.com:99999')).toBeNull();
  });
});

describe('the proxy env a fenced seat is spawned with', () => {
  it('sets every proxy var a vendor CLI might read, and forces NO_PROXY empty', () => {
    const env = proxyEnv('http://127.0.0.1:1234');
    for (const k of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) {
      expect(env[k]).toBe('http://127.0.0.1:1234');
    }
    // An inherited `NO_PROXY=*` would let the seat bypass the fence for exactly the hosts it wants.
    expect(env.NO_PROXY).toBe('');
    expect(env.no_proxy).toBe('');
  });
});

describe('fail closed', () => {
  it('binds loopback only, on an ephemeral port', async () => {
    const p = await proxy(['chatgpt.com']);
    expect(p.port).toBeGreaterThan(0);
    expect(p.url).toBe(`http://127.0.0.1:${p.port}`);
  });

  // §7: a proxy that cannot start must REJECT, so a caller physically has no proxy object to spawn
  // a seat against. Falling back to "no proxy" would run a live shell in untrusted PR content with
  // the old unrestricted :443.
  it('REJECTS when the port is already taken, rather than starting unfenced', async () => {
    const first = await proxy(['chatgpt.com']);
    await expect(startEgressProxy({ allowHosts: ['chatgpt.com'], port: first.port })).rejects.toThrow(
      /EADDRINUSE/
    );
    // …and the caller therefore has no proxy object to spawn an unfenced seat against.
  });
});
