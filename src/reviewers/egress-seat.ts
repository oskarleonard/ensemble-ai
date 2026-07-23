import { type EgressDenial, type EgressProxy, startEgressProxy } from '../core/egress-proxy';
import type { ReviewerId } from '../core/types';

import { egressHostsFor } from './egress-hosts';

// PURE: the per-denial stderr printer, deduped by host:port. §6 says a denial is LOUD — but a
// refused CLI RETRIES: the first fenced grok review printed ~400 per-connection lines for two
// hosts (run 2026-07-23-15-36-50, grok.com ×195 + api.mixpanel.com ×198), a wall that reads as
// an outage when it is one policy decision per host. Loudness survives the dedup: the FIRST
// denial per host still hits stderr the instant it happens, the run summary carries per-host
// counts (formatEgressDenialCounts), and egress-denials.json keeps every connection — same
// footer philosophy as formatEgressDenials ("a retry storm against one host is one fact, not
// forty"). Exported for tests.
export function seatDenialPrinter(
  id: ReviewerId,
  write: (line: string) => void
): (d: EgressDenial) => void {
  const printed = new Set<string>();
  return (d) => {
    const key = `${d.host}:${d.port}`;
    if (printed.has(key)) return;
    printed.add(key);
    write(
      `⚠ ensemble-ai egress fence: DENIED ${id} → ${d.method} ${key} — ${d.reason} (repeat denials for this host are counted, not printed)\n`
    );
  };
}

// Start THIS run's egress proxy for one vendor seat, with that vendor's own host allowlist and a
// denial hook that writes to stderr the instant a NEW host is refused (§6: a denial during a
// review is LOUD — stderr, the run artifact, and the posted footer; never silent. Repeats per
// host are deduped by seatDenialPrinter above — counted, not printed).
//
// Throws when the proxy cannot bind. Callers MUST turn that into a per-seat refusal: a seat whose
// fence did not start never runs (§7). Returning a proxy-less "best effort" would spawn a live shell
// inside untrusted PR content with unrestricted :443 — the exact hole codex-f3 reported.
export function startSeatEgressProxy(id: ReviewerId): Promise<EgressProxy> {
  return startEgressProxy({
    allowHosts: egressHostsFor(id),
    onDenial: seatDenialPrinter(id, (line) => process.stderr.write(line)),
  });
}

// The named, loud reason a seat is refused its worktree because its fence would not start.
export function egressStartFailure(id: ReviewerId, err: unknown): string {
  return `ensemble-ai: the ${id} seat cannot take the worktree — its egress proxy failed to start (${(err as Error).message}). The seat is fenced by that proxy, so it must NOT run in the worktree without one.`;
}
