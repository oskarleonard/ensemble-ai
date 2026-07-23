import { describe, expect, it } from 'vitest';

import type { EgressDenial } from '../core/egress-proxy';

import { seatDenialPrinter } from './egress-seat';

const deny = (host: string, port = 443): EgressDenial => ({
  host,
  method: 'CONNECT',
  port,
  reason: "host is not on this vendor's egress allowlist",
});

// A refused CLI retries — the printer must turn a retry storm into ONE line per host while the
// proxy core still records every connection (the artifact is not this printer's job).
describe('seatDenialPrinter — one line per distinct host, not per connection', () => {
  it('prints the first denial for a host and swallows the retries', () => {
    const lines: string[] = [];
    const print = seatDenialPrinter('grok', (l) => lines.push(l));
    for (let i = 0; i < 200; i++) print(deny('api.mixpanel.com'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('DENIED grok → CONNECT api.mixpanel.com:443');
    // The line says repeats are counted elsewhere, so a reader knows one line ≠ one attempt.
    expect(lines[0]).toContain('counted, not printed');
  });

  it('distinct hosts — and distinct ports on one host — each get their own line', () => {
    const lines: string[] = [];
    const print = seatDenialPrinter('grok', (l) => lines.push(l));
    print(deny('grok.com'));
    print(deny('api.mixpanel.com'));
    print(deny('grok.com', 80));
    print(deny('grok.com'));
    expect(lines).toHaveLength(3);
  });

  it('dedup state is per-printer — a fresh seat prints its own first denial', () => {
    const a: string[] = [];
    const b: string[] = [];
    seatDenialPrinter('grok', (l) => a.push(l))(deny('grok.com'));
    seatDenialPrinter('codex', (l) => b.push(l))(deny('grok.com'));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(b[0]).toContain('DENIED codex');
  });
});
