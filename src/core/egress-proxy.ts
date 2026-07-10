import http from 'node:http';
import net from 'node:net';
import type { Socket } from 'node:net';

// THE EGRESS PROXY (codex-f3) — the per-host fence Seatbelt cannot express.
//
// WHY IT EXISTS: the codex worktree seat runs `--dangerously-bypass-approvals-and-sandbox`, i.e. a
// LIVE SHELL, inside untrusted PR content. Its Seatbelt profile could only scope egress by PORT
// (`(remote ip "*:443")`), never by host — `(remote tcp "api.openai.com:443")` is rejected outright
// ("host must be * or localhost"). The seat could also read its own credential (`~/.codex`), which
// it must, to call its API. Port-scoped egress + a readable credential + a prompt-injectable shell
// = credential exfil to any host on :443, and `:53` was a working DNS channel besides. The old
// profile said so in its own comment: "a real fence needs an egress proxy."
//
// This is that proxy. The vendor profile now denies ALL outbound except ONE loopback port — this
// server — and the seat is spawned with HTTPS_PROXY/HTTP_PROXY/ALL_PROXY pointed at it. Every
// outbound connection the seat opens therefore arrives here as a CONNECT, and a CONNECT to a host
// outside the vendor's allowlist is REFUSED and LOGGED.
//
// WHAT IT IS NOT: it never inspects, decrypts, or modifies a request body — a CONNECT tunnel is
// opaque TLS by construction, and it stays that way. It carries no proxy credential and forwards
// none. It holds no state across runs. It is a HOST allowlist and nothing more.
//
// IRREDUCIBLE RESIDUE, stated rather than glossed:
//   · The seat still reads its own credential in-process and still sends it to the ALLOWED vendor
//     host. Closing that needs a token broker (the seat never holds the credential), not a proxy.
//   · An allowed host is allowed for ANY bytes. A seat that can talk to `chatgpt.com` can encode
//     data in what it says to `chatgpt.com`. The fence bounds WHO the seat may talk to, never WHAT.
//   · Hostname RESOLUTION still works inside the profile (getaddrinfo goes to mDNSResponder over
//     mach-lookup, not a `:53` socket), so a resolver-based side channel survives. Verified
//     2026-07-10: denying `com.apple.dnssd.service`/`com.apple.mDNSResponder` by mach global-name
//     does NOT stop getaddrinfo, so no rule here would close it. The DNS *socket* channel — the one
//     that could carry a payload — IS closed: UDP and TCP `:53` both return EPERM (verified).

// One refused connection. Structured, never a log line to grep.
export interface EgressDenial {
  host: string;
  // 'CONNECT' for a tunnel attempt; the HTTP verb for a plaintext absolute-form request.
  method: string;
  port: number;
  reason: string;
}

export interface EgressProxy {
  // The allowlist this proxy was started with — echoed back so a caller can state the fence it got
  // rather than the fence it asked for.
  allowHosts: readonly string[];
  close: () => void;
  // Every refused connection, in arrival order. Read after the seat exits.
  denials: readonly EgressDenial[];
  port: number;
  // `http://127.0.0.1:<port>` — what the seat's proxy env vars are set to.
  url: string;
}

// Loopback only. Binding anything else would put the fence on the network.
const BIND_HOST = '127.0.0.1';

// The only port a seat may tunnel to. A vendor API is HTTPS; a CONNECT to any other port is refused
// even for an allowlisted host, so the allowlist cannot be turned into a general-purpose relay.
// Overridable ONLY so a test can dial a loopback canary on an ephemeral port; every production
// caller takes the default, and a test pins that default to exactly [443].
export const DEFAULT_CONNECT_PORTS: readonly number[] = [443];

// EXACT host match, case-insensitive. Deliberately NOT a suffix match: `*.chatgpt.com` would admit
// an attacker-registered `evil.chatgpt.com.attacker.tld` under a naive `endsWith`, and even a
// correct suffix rule widens the fence to every subdomain a vendor (or a subdomain takeover) can
// point anywhere. Every host a seat needs was observed empirically; a new one is a code change.
export function isHostAllowed(host: string, allowHosts: readonly string[]): boolean {
  const normalized = normalizeHost(host);
  if (!normalized) return false;
  return allowHosts.some((h) => normalizeHost(h) === normalized);
}

// `Host:` forms a CONNECT can legally carry: a trailing root dot (`chatgpt.com.`) and a bracketed
// IPv6 literal both denote the same authority as their bare form, so both must normalize or the
// allowlist is bypassable by spelling.
function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  const unbracketed = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
  return unbracketed.endsWith('.') ? unbracketed.slice(0, -1) : unbracketed;
}

// Split a CONNECT target (`host:port`) — IPv6 literals are bracketed, so rsplit on the LAST colon.
export function parseAuthority(authority: string): { host: string; port: number } | null {
  const idx = authority.lastIndexOf(':');
  if (idx <= 0) return null;
  const host = authority.slice(0, idx);
  const port = Number(authority.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

// The env a fenced seat is spawned with. NO_PROXY is set EMPTY on purpose: a value inherited from
// the operator's shell (`NO_PROXY=*`, or a vendor host listed there) would let the seat bypass the
// proxy for exactly the hosts it most wants to reach. Both cases are set — some clients read the
// lowercase form only, some the uppercase.
export function proxyEnv(url: string): Record<string, string> {
  return {
    ALL_PROXY: url,
    all_proxy: url,
    HTTP_PROXY: url,
    http_proxy: url,
    HTTPS_PROXY: url,
    https_proxy: url,
    NO_PROXY: '',
    no_proxy: '',
  };
}

export interface StartEgressProxyOpts {
  allowHosts: readonly string[];
  // Called the instant a connection is refused, so the denial reaches stderr DURING the review and
  // not only in the artifact written after it (§6: a denial is LOUD).
  onDenial?: (denial: EgressDenial) => void;
  // Ports a CONNECT may target. Defaults to DEFAULT_CONNECT_PORTS ([443]).
  allowPorts?: readonly number[];
  // The listen port. 0 (the default) takes an ephemeral one. A fixed port exists for the test that
  // proves the fail-closed path when the port is taken.
  port?: number;
}

// Start the proxy, or REJECT. A caller that cannot start it must fail the seat closed — never spawn
// it unfenced (§7). Rejecting (rather than falling back to an unbound port) is what makes that
// impossible to get wrong: there is no proxy object to spawn against.
export function startEgressProxy(opts: StartEgressProxyOpts): Promise<EgressProxy> {
  const denials: EgressDenial[] = [];
  const sockets = new Set<Socket>();
  const allowPorts = opts.allowPorts ?? DEFAULT_CONNECT_PORTS;

  const deny = (denial: EgressDenial): void => {
    denials.push(denial);
    opts.onDenial?.(denial);
  };

  const server = http.createServer((req, res) => {
    // A plaintext absolute-form request (`GET http://host/path`). Refused wholesale: the vendor APIs
    // are HTTPS, and forwarding cleartext would mean reading a request body — which this proxy does
    // not do. No allowlist consultation, because there is no allowed plaintext host.
    const host = normalizeHost((req.headers.host ?? '').split(':')[0] ?? '');
    deny({
      host: host || 'unknown',
      method: req.method ?? 'UNKNOWN',
      port: 0,
      reason: 'plaintext HTTP through the proxy is refused — the fence tunnels TLS only',
    });
    // `Connection: close` is load-bearing, not politeness: an HTTP/1.1 403 defaults to keep-alive,
    // and that socket belongs to the http server, not to the `sockets` set below — it would outlive
    // `close()` and keep the run's event loop alive.
    res.writeHead(403, { connection: 'close', 'content-type': 'text/plain' });
    res.end('ensemble-ai egress fence: plaintext HTTP is refused\n');
  });

  server.on('connect', (req, clientSocket: Socket, head: Buffer) => {
    sockets.add(clientSocket);
    clientSocket.on('close', () => sockets.delete(clientSocket));
    // A socket error after the peer vanishes must never take the engine down with an unhandled
    // 'error' event — the seat is untrusted and may hang up mid-handshake at any moment.
    clientSocket.on('error', () => clientSocket.destroy());

    const target = parseAuthority(req.url ?? '');
    if (!target) {
      deny({ host: req.url ?? 'unknown', method: 'CONNECT', port: 0, reason: 'unparseable CONNECT authority' });
      refuse(clientSocket);
      return;
    }
    if (!allowPorts.includes(target.port)) {
      deny({ ...target, method: 'CONNECT', reason: `port ${target.port} is not ${allowPorts.join('/')}` });
      refuse(clientSocket);
      return;
    }
    if (!isHostAllowed(target.host, opts.allowHosts)) {
      deny({ ...target, method: 'CONNECT', reason: 'host is not on this vendor\'s egress allowlist' });
      refuse(clientSocket);
      return;
    }
    tunnel(clientSocket, head, target, sockets);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject); // EADDRINUSE and friends → the caller fails the seat closed
    server.listen(opts.port ?? 0, BIND_HOST, () => {
      server.removeListener('error', reject);
      // With `reject` gone the server has NO 'error' listener, and an 'error' event without one
      // THROWS — an accept-time failure (EMFILE) would kill the whole review rather than this seat.
      // Own it: loud on stderr, never fatal.
      server.on('error', (e) =>
        process.stderr.write(`⚠ ensemble-ai egress fence: proxy server error — ${e.message}\n`)
      );
      // A listening server always has an AddressInfo here; the union is a `net` typing artifact.
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        allowHosts: opts.allowHosts,
        close: () => {
          for (const s of sockets) s.destroy();
          sockets.clear();
          // `sockets` holds only the CONNECT tunnels. Any socket the plaintext deny path opened is
          // the http server's own, so `server.close()` would wait on it forever; drop those too.
          server.closeAllConnections();
          server.close();
        },
        denials,
        port,
        url: `http://${BIND_HOST}:${port}`,
      });
    });
  });
}

// A refusal the client can READ — a bare destroy() RSTs the connection before the status line
// flushes, which a vendor CLI reads as a flaky network and answers with a retry storm. `end()`
// writes the 403 and half-closes gracefully, so the client sees a terminal, legible refusal.
function refuse(clientSocket: Socket): void {
  clientSocket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
}

// The opaque TLS tunnel. Nothing here reads the bytes.
function tunnel(
  clientSocket: Socket,
  head: Buffer,
  target: { host: string; port: number },
  sockets: Set<Socket>
): void {
  const upstream = net.connect(target.port, target.host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  sockets.add(upstream);
  upstream.on('close', () => sockets.delete(upstream));
  upstream.on('error', () => {
    upstream.destroy();
    clientSocket.destroy();
  });
  clientSocket.on('error', () => upstream.destroy());
}
