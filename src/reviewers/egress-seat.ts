import { type EgressProxy, startEgressProxy } from '../core/egress-proxy';
import type { ReviewerId } from '../core/types';

import { egressHostsFor } from './egress-hosts';

// Start THIS run's egress proxy for one vendor seat, with that vendor's own host allowlist and a
// denial hook that writes to stderr the instant a connection is refused (§6: a denial during a
// review is LOUD — stderr, the run artifact, and the posted footer; never silent).
//
// Throws when the proxy cannot bind. Callers MUST turn that into a per-seat refusal: a seat whose
// fence did not start never runs (§7). Returning a proxy-less "best effort" would spawn a live shell
// inside untrusted PR content with unrestricted :443 — the exact hole codex-f3 reported.
export function startSeatEgressProxy(id: ReviewerId): Promise<EgressProxy> {
  return startEgressProxy({
    allowHosts: egressHostsFor(id),
    onDenial: (d) => {
      process.stderr.write(
        `⚠ ensemble-ai egress fence: DENIED ${id} → ${d.method} ${d.host}:${d.port} — ${d.reason}\n`
      );
    },
  });
}

// The named, loud reason a seat is refused its worktree because its fence would not start.
export function egressStartFailure(id: ReviewerId, err: unknown): string {
  return `ensemble-ai: the ${id} seat cannot take the worktree — its egress proxy failed to start (${(err as Error).message}). The seat is fenced by that proxy, so it must NOT run in the worktree without one.`;
}
