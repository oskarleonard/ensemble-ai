// PLANTED POSITIVE #2 — a hand-rolled retry loop reinventing `withRetry` (src/util/retry.ts),
// which AGENTS.md §Retries mandates. It also drops the jitter the util has.
const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function uploadWithRetries<T>(
  upload: () => Promise<T>,
  maxAttempts = 3
): Promise<T> {
  let failure: unknown;
  for (let tries = 0; tries < maxAttempts; tries++) {
    try {
      return await upload();
    } catch (error) {
      failure = error;
      await pause(200 * 2 ** tries);
    }
  }
  throw failure;
}
