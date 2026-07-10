// NEAR-MISS #3 — looks like the backoff inside `withRetry` (src/util/retry.ts) and is not a
// retry at all: it PACES a rate-limited queue, so the delay must be deterministic (no jitter)
// and it never re-invokes anything. `withRetry` cannot express this. MUST NOT flag.
export function delayFor(position: number, ratePerSecond: number): number {
  if (ratePerSecond <= 0) return 0;
  return Math.ceil((position * 1000) / ratePerSecond);
}
