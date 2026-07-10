export interface RequestOptions {
  method: string;
  timeoutMs?: number;
  traceId: string;
}

export type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; method: string }
) => Promise<{ status: number }>;

// The ONE outbound-request helper: it attaches the auth header, the timeout, and the trace id.
export async function request(
  fetcher: Fetcher,
  url: string,
  options: RequestOptions
): Promise<{ status: number }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${process.env.API_TOKEN ?? ''}`,
    'x-timeout-ms': String(options.timeoutMs ?? 10_000),
    'x-trace-id': options.traceId,
  };
  return fetcher(url, { headers, method: options.method });
}
