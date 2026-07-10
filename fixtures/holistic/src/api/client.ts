import type { Fetcher } from '../util/http';

// PLANTED POSITIVE #3 — `callApi` hand-builds the headers `request` (src/util/http.ts) already
// attaches, so it silently omits the trace id AGENTS.md §HTTP requires on every outbound call.
export async function callApi(
  fetcher: Fetcher,
  url: string
): Promise<{ status: number }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${process.env.API_TOKEN ?? ''}`,
    'x-timeout-ms': '10000',
  };
  return fetcher(url, { headers, method: 'GET' });
}
