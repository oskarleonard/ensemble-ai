export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// The ONE retry helper: exponential backoff with jitter, for idempotent calls only.
export async function withRetry<T>(
  call: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < options.attempts; attempt++) {
    try {
      return await call();
    } catch (error) {
      lastError = error;
      const backoff = options.baseDelayMs * 2 ** attempt;
      await sleep(backoff + Math.floor(Math.random() * options.baseDelayMs));
    }
  }
  throw lastError;
}
