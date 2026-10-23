import { describe, expect, it } from 'vitest';

import * as engine from '../../index';
import { isSettledApiFailure, packetRetryAfterWorktree, RETRIES_ON_PACKET } from './seat-run';

// The packet-retry rule runCoreSeat applies after a failed worktree attempt, exported for a
// consumer that composes its own seats (munin-dashboard#315): one rule, no host mirror.
describe('packetRetryAfterWorktree', () => {
  const failed = { timedOut: false };

  it('re-runs only a seat whose sandbox is the unproven mechanism (codex), after a plain failure', () => {
    expect(packetRetryAfterWorktree(failed, RETRIES_ON_PACKET.codex)).toBe(true);
    expect(packetRetryAfterWorktree(failed, RETRIES_ON_PACKET.grok)).toBe(false);
    expect(packetRetryAfterWorktree(failed, RETRIES_ON_PACKET.claude)).toBe(false);
    expect(packetRetryAfterWorktree({ ...failed, failKind: 'api-error' }, true)).toBe(true);
  });

  it('never after a timeout or a failure the adapter settled', () => {
    expect(packetRetryAfterWorktree({ timedOut: true }, true)).toBe(false);
    expect(packetRetryAfterWorktree({ ...failed, failKind: 'transient-api' }, true)).toBe(false);
    expect(packetRetryAfterWorktree({ ...failed, failKind: 'usage-limit' }, true)).toBe(false);
    expect(isSettledApiFailure({ failKind: 'transient-api' })).toBe(true);
    expect(isSettledApiFailure({ failKind: 'usage-limit' })).toBe(true);
    expect(isSettledApiFailure({ failKind: 'stalled' })).toBe(false);
    expect(isSettledApiFailure({})).toBe(false);
  });

  it('is reachable through the library entry, with the table', () => {
    expect(engine.packetRetryAfterWorktree).toBe(packetRetryAfterWorktree);
    expect(engine.isSettledApiFailure).toBe(isSettledApiFailure);
    expect(engine.RETRIES_ON_PACKET).toEqual({ claude: false, codex: true, grok: false });
  });
});
