// The `claude -p` STREAM CONTRACT shared by every headless Anthropic seat — the review voice,
// the gate, the holistic lens, the exec seats (modes/review) AND the brainstorm/consult voice
// (modes/brainstorm/claude.ts). Lifted out of modes/review/claude.ts on 2026-10-09 so the doc
// voice can adopt the same liveness contract without a module cycle (review/claude imports the
// brainstorm voice's advisor helpers). Every export here is PURE data or a pure predicate.

// Claude's `--effort` accepts these levels; anything else ('default' sentinel included)
// means "leave it to the CLI default", so the flag is omitted rather than passed invalid.
// Exported so the gate-seat resolver whitelist-checks a `--gate-effort` value against the
// SAME set (one source of truth for the review-side effort whitelist).
export const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// A reply that is an API-layer ERROR, not a review: the CLI prints the transport error
// ("API Error: 529 Overloaded", 429 rate limit, other 5xx) to stdout and exits within
// seconds, having consumed no tokens and produced no review. Observed verbatim on runs
// 2026-08-05-11-46-48 and 2026-08-05-13-09-19 (the raw reply was exactly the one 529
// line) — which the parser then honestly reported as "no parseable JSON block", masking
// the real cause. The predicate is deliberately narrow: SHORT replies only, so a real
// review that merely quotes an error string can never be classed as transient.
export function isTransientApiErrorReply(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 1500) return false;
  return /\bAPI Error:\s*(?:429|5\d\d)\b/i.test(trimmed) || /\boverloaded\b/i.test(trimmed);
}

// A reply that is the OPERATOR'S subscription usage limit, not a review: the CLI prints
// one short line ("You've hit your session limit · resets 5:10pm (Europe/Stockholm)")
// and exits. Observed verbatim on run 2026-08-07-14-53-49 (65 bytes), where it was
// mislabeled "no parseable JSON block". NOT retryable — a 5-hour window does not clear
// in 45 seconds — so it must be NAMED, never retried and never fed to the parser.
export function isUsageLimitReply(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 300) return false;
  return /\b(session|usage|weekly) limit\b/i.test(trimmed) && /\b(reset|hit|reached)\b/i.test(trimmed);
}

// Retryable transport statuses: rate limit + server-side (the CLI surfaces them on the
// result event's api_error_status when the stream completes with is_error).
export function isRetryableApiStatus(status: number | null): boolean {
  return status === 429 || (typeof status === 'number' && status >= 500 && status <= 599);
}

// The one seat failure a re-spawn can never fix: the operator's own subscription window is
// closed until the reset time the reply carries. Callers that retry an empty seat check this
// so they burn nothing against a window that is already spent.
export const USAGE_LIMIT_FAIL_PREFIX = 'operator usage limit reached';

export function isUsageLimitFailure(failWhy: string | undefined): boolean {
  return failWhy?.startsWith(USAGE_LIMIT_FAIL_PREFIX) ?? false;
}

// Fast-fail retry schedule for transient API errors: a 529/429 returns in seconds, so a
// couple of spaced retries are nearly free next to the review they rescue. An attempt
// that ran longer than TRANSIENT_FAST_FAIL_MS did real work and is never retried — the
// retry exists for the seat that died on arrival, not to double-spend a long run.
export const TRANSIENT_RETRY_DELAYS_MS = [15_000, 45_000] as const;
export const TRANSIENT_FAST_FAIL_MS = 120_000;

// The LIVENESS bar: with stream-json a working seat emits an event every few seconds
// (thinking heartbeats included), so ten silent minutes means a wedged seat, not slow
// honest work. This is what actually reclaims wedges now; the absolute per-seat budgets
// are pure runaway backstops sized far past any observed honest run. Proven on the review
// path's 75–85-minute honest producers (2026-08); the doc voices adopted it 2026-10-09.
export const CLAUDE_INACTIVITY_TIMEOUT_MS = 600_000; // 10 min of total silence

// The stream's final `type:"result"` event, when one exists. `found:false` means the
// stream never completed (killed mid-run) or the reply was not stream-json at all —
// callers fall back to treating the raw output as plain text, which keeps the old
// text-mode contract working end-to-end.
export interface StreamResultEvent {
  apiErrorStatus: number | null;
  found: boolean;
  isError: boolean;
  text: string | null;
}

// PURE: pull the last `type:"result"` event out of a stream-json stdout. Defensive per
// line — non-JSON lines (a stray warning, a truncated tail) are skipped, never fatal.
export function extractStreamResult(stdout: string): StreamResultEvent {
  let found: StreamResultEvent = { apiErrorStatus: null, found: false, isError: false, text: null };
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (!obj || typeof obj !== 'object') continue;
    const o = obj as Record<string, unknown>;
    if (o.type !== 'result') continue;
    found = {
      apiErrorStatus: typeof o.api_error_status === 'number' ? o.api_error_status : null,
      found: true,
      isError: o.is_error === true,
      text: typeof o.result === 'string' ? o.result : null,
    };
  }
  return found;
}

// PURE: what a killed stream-json seat was doing last — the tail of its event stream, bounded,
// for the trail. A `tool_use` event names the tool (WebSearch, Read…); a `thinking` heartbeat
// says it was mid-turn. Non-JSON lines pass through verbatim (a stray stderr-ish line is data).
export function streamActivityTail(stdout: string | null, limit = 600): string {
  if (!stdout) return '';
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  const summarized: string[] = [];
  for (const line of lines.slice(-12)) {
    if (!line.startsWith('{')) {
      summarized.push(line);
      continue;
    }
    try {
      const o = JSON.parse(line) as Record<string, unknown>;
      const type = typeof o.type === 'string' ? o.type : 'event';
      const msg = o.message as Record<string, unknown> | undefined;
      const content = Array.isArray(msg?.content) ? (msg!.content as Record<string, unknown>[]) : [];
      const tools = content.filter((c) => c?.type === 'tool_use').map((c) => String(c.name ?? 'tool'));
      summarized.push(tools.length ? `${type}: ${tools.join(',')}` : type);
    } catch {
      summarized.push(line.slice(0, 80));
    }
  }
  return summarized.join(' · ').slice(-limit);
}
