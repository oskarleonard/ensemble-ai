import { STREAM_DELTAS_KEPT_EVENT } from './spawn';
import { parseSeatAdvisor } from './types';
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

// WHAT a completed error result is, apart from whether to retry it: a retryable status or a short
// API-error reply is a transient API death, anything else (auth, a permanent 4xx) a plain API
// error. The fast-fail window decides only whether the seat re-spawns — a 529 after a slow start
// is the same death as one on arrival, and codex's toCodexResult names it with no time gate too.
export function errorResultFailKind(result: Pick<StreamResultEvent, 'apiErrorStatus' | 'text'>): 'api-error' | 'transient-api' {
  return isRetryableApiStatus(result.apiErrorStatus) || isTransientApiErrorReply(result.text ?? '')
    ? 'transient-api'
    : 'api-error';
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

// STRIP THE PAYLOADS (2026-10-13 fresh-eyes review #3). A claude-shaped stream carries every tool
// RESULT in full — a 2000-line Read lands in a `user` event, and the CLI duplicates it as
// `tool_use_result`. On run d5a1f648 those were ~60% of a 1 MB tail, and the 1 MB cut (made only
// when building the trail copy — the whole stream was in memory) dropped the head with the init
// event and the early tool calls. Nothing reads the result bodies back off disk: the telemetry
// needs `tool_use_id` + `is_error` (seat-usage conventionsReadOf), the tokens come from the final
// `result` event, and the worktree the results came from is on disk anyway. So the persisted copy
// keeps every event and every tool CALL, and replaces each result body with its size. PURE.
export function stripStreamPayloads(stream: string): string {
  const out: string[] = [];
  for (const line of stream.split('\n')) {
    if (!line.startsWith('{') || !line.includes('"tool_result"') && !line.includes('"tool_use_result"')) {
      out.push(line);
      continue;
    }
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      out.push(line);
      continue;
    }
    if (!e || typeof e !== 'object') {
      out.push(line);
      continue;
    }
    const ev = e as Record<string, unknown>;
    if (ev.type !== 'user') {
      out.push(line);
      continue;
    }
    delete ev.tool_use_result;
    delete ev.tool_result_meta;
    const msg = ev.message;
    if (msg && typeof msg === 'object' && Array.isArray((msg as Record<string, unknown>).content)) {
      for (const c of (msg as { content: unknown[] }).content) {
        if (!c || typeof c !== 'object') continue;
        const block = c as Record<string, unknown>;
        if (block.type !== 'tool_result' || block.content === undefined) continue;
        const size = typeof block.content === 'string' ? block.content.length : JSON.stringify(block.content).length;
        block.content = `[stripped ${size} chars — the seat's tool result; the tree is on disk]`;
      }
    }
    out.push(JSON.stringify(ev));
  }
  return out.join('\n');
}

// DROP THE DELIVERED DELTAS (2026-11-04). A `--include-partial-messages` stream (grok's seat) is
// dominated by `content_block_delta` lines — one per token of thinking, text, signature and tool
// input: 2 967 of 2 977 persisted lines on run 2026-11-04-15-08-41-d8a5382a, whose raw stream was
// ≈4.5 M chars and lost 3.5 M of its middle to the 1 MB head+tail cut — and with them the read of
// the conventions file. A message's `assistant` line RESTATES its deltas (the full thinking, text,
// signature and tool_use inputs), and no reader parses a delta: the tool calls come off the
// assistant lines, the tokens off `message_delta` and `result`. So a message's deltas are dropped
// only once its assistant line is PROVED to restate them: the same message id on both, every block
// the deltas spelled — text, thinking, signature, the tool input's JSON (compared parsed, keys in
// any order) — equal to the assistant line's block at that index, every tool_use a
// `content_block_start` opened carried there under its id (on run 2026-11-05-02-40-09-a734f8d3's
// grok tail every block of all 13 messages matched). Every other line (`message_start`,
// `content_block_start` / `_stop`, `message_delta`, `message_stop`, `assistant`, `user`, `result`,
// anything unparseable) is kept byte-identical and in order. Decided on the PARSED line, never a
// string match.
//
// Every doubt KEEPS the message's deltas — no assistant line (the seat was killed mid-turn, or the
// next message started), a delta or tool_use start with no `message_start` id before it, an
// assistant line that does not restate a block, a delta this function cannot place — and appends
// ONE STREAM_DELTAS_KEPT_EVENT line naming those messages, so a reader can tell such a stream from
// a whole one. Each names `mayHoldCall`: whether its kept lines could carry a tool call (a tool_use
// start, an `input_json_delta`, a delta it could not place) — a thinking- or text-only message
// cannot hide a read. An assistant line for another message leaves the open one open. One message
// is open at a time (grok's fenced seat has no subagent to interleave one); a stream shaped
// otherwise (claude emits an assistant line per content block) only ever falls to keep-and-flag.
// PURE.
const DELTA_PAYLOAD = new Map([
  ['input_json_delta', 'partial_json'],
  ['signature_delta', 'signature'],
  ['text_delta', 'text'],
  ['thinking_delta', 'thinking'],
]);
// One content block of the open message: what its deltas spelled, keyed by the delta's payload
// field, and the id its tool_use start named ('' = none).
type DeltaBlock = { spelled: Map<string, string>; tool?: string };
type DeltaMessage = { blocks: Map<number, DeltaBlock>; deltas: number[]; doubt: string | null; id: string | null; mayHoldCall: boolean };

export function dropDeliveredDeltas(stream: string): string {
  const lines = stream.split('\n');
  const drop = new Set<number>();
  const kept: { deltas: number; id: string | null; mayHoldCall: boolean; why: string }[] = [];
  let open: DeltaMessage | null = null;
  const opened = (id: string | null): DeltaMessage => ({ blocks: new Map(), deltas: [], doubt: id === null ? 'no message_start named its message' : null, id, mayHoldCall: false });
  const blockAt = (m: DeltaMessage, index: number): DeltaBlock => {
    let b = m.blocks.get(index);
    if (!b) m.blocks.set(index, (b = { spelled: new Map() }));
    return b;
  };
  const keep = (m: DeltaMessage, why: string): void => {
    if (m.deltas.length > 0 || m.mayHoldCall) kept.push({ deltas: m.deltas.length, id: m.id, mayHoldCall: m.mayHoldCall, why });
  };
  for (const [i, line] of lines.entries()) {
    const ev = parseObject(line);
    if (!ev) continue;
    if (ev.type === 'stream_event' && isObject(ev.event)) {
      const inner = ev.event;
      if (inner.type === 'message_start') {
        if (open) keep(open, open.doubt ?? 'no assistant line before the next message');
        open = opened(isObject(inner.message) && typeof inner.message.id === 'string' ? inner.message.id : null);
        continue;
      }
      if (inner.type === 'content_block_delta') {
        open ??= opened(null);
        open.deltas.push(i);
        const d = inner.delta;
        const field = isObject(d) && typeof d.type === 'string' ? DELTA_PAYLOAD.get(d.type) : undefined;
        if (field === 'partial_json') open.mayHoldCall = true;
        if (field === undefined || typeof inner.index !== 'number' || !isObject(d) || typeof d[field] !== 'string') {
          open.doubt ??= 'a delta this reader cannot place';
          open.mayHoldCall = true;
          continue;
        }
        const b = blockAt(open, inner.index);
        b.spelled.set(field, (b.spelled.get(field) ?? '') + d[field]);
        continue;
      }
      const block = inner.content_block;
      if (inner.type === 'content_block_start' && isObject(block) && block.type === 'tool_use') {
        open ??= opened(null);
        open.mayHoldCall = true;
        if (typeof inner.index === 'number') blockAt(open, inner.index).tool = typeof block.id === 'string' ? block.id : '';
        else open.doubt ??= 'a content_block_start tool_use with no block index';
      }
      continue;
    }
    if (ev.type !== 'assistant' || !open || !isObject(ev.message)) continue;
    const id = typeof ev.message.id === 'string' ? ev.message.id : null;
    if (open.id !== null && id !== open.id) continue; // another message's line — this one stays open
    const content = Array.isArray(ev.message.content) ? ev.message.content : [];
    const why = open.doubt ?? unrestated(open.blocks, content);
    if (why) keep(open, why);
    else for (const d of open.deltas) drop.add(d);
    open = null;
  }
  if (open) keep(open, open.doubt ?? 'no assistant line (the stream ended mid-message)');
  if (drop.size === 0 && kept.length === 0) return stream;
  const out = lines.filter((_, i) => !drop.has(i));
  if (kept.length > 0) {
    const flag = JSON.stringify({ messages: kept, type: STREAM_DELTAS_KEPT_EVENT });
    // Before the trailing empty line a newline-terminated stream ends with, so it stays terminated.
    if (out[out.length - 1] === '') out.splice(out.length - 1, 0, flag);
    else out.push(flag);
  }
  return out.join('\n');
}

// Why the assistant line's `content` does not restate the blocks the deltas spelled — or null when
// it restates every one: each tool_use start's id at that index, each spelled field equal (the tool
// input's JSON compared parsed, key order free).
function unrestated(blocks: Map<number, DeltaBlock>, content: unknown[]): string | null {
  for (const [index, b] of blocks) {
    const c = content[index];
    if (b.tool !== undefined && (b.tool === '' || !isObject(c) || c.type !== 'tool_use' || c.id !== b.tool)) return 'a content_block_start tool_use its assistant line does not carry';
    for (const [field, spelled] of b.spelled) {
      const same = isObject(c) && (field === 'partial_json' ? c.type === 'tool_use' && sameJson(spelled, c.input) : c[field] === spelled);
      if (!same) return `its assistant line does not restate block ${index}'s ${field}`;
    }
  }
  return null;
}

function sameJson(spelled: string, value: unknown): boolean {
  try {
    return canonicalJson(JSON.parse(spelled)) === canonicalJson(value);
  } catch {
    return false; // deltas that do not spell one JSON value restate nothing
  }
}
const canonicalJson = (v: unknown): string | undefined =>
  JSON.stringify(v, (_key, x: unknown) => (isObject(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));

function parseObject(line: string): Record<string, unknown> | null {
  if (!line.startsWith('{')) return null;
  try {
    const v: unknown = JSON.parse(line);
    return isObject(v) ? v : null;
  } catch {
    return null; // a line cut mid-write, or noise — kept verbatim
  }
}
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// ── The advisor on a Claude seat's stream ────────────────────────────────────
// A Claude seat may carry the CLI's advisor tool (a second model it consults mid-task). It shows in
// stream-json as a `server_tool_use` content block named "advisor" on an assistant event (or, on a
// partial-message stream, as a content_block_start of that type). Counting them is the ONE way to
// know whether a seat ran with an advisor: the init event's `tools` never lists a server tool, and a
// configured "off" is a promise the env kill switch keeps — or does not. Pure; junk lines skipped.
export function advisorCallCount(stream: string | null | undefined): number {
  if (!stream) return 0;
  // One call, one count: a partial-message stream carries the same block twice (the
  // content_block_start and the completed assistant message), so blocks are keyed by their id —
  // a block without one counts per occurrence (review of #156, codex/grok/claude).
  const seen = new Set<string>();
  let n = 0;
  const count = (b: unknown): void => {
    if (!isAdvisorUse(b)) return;
    const id = (b as Record<string, unknown>).id;
    if (typeof id === 'string' && id) {
      if (seen.has(id)) return;
      seen.add(id);
    }
    n++;
  };
  for (const line of stream.split('\n')) {
    if (!line.includes('advisor')) continue; // cheap pre-filter: most lines carry no server tool
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    const ev = e as Record<string, unknown>;
    if (ev.type === 'assistant' && ev.message && typeof ev.message === 'object') {
      const content = (ev.message as Record<string, unknown>).content;
      if (Array.isArray(content)) for (const b of content) count(b);
      continue;
    }
    if (ev.type === 'stream_event' && ev.event && typeof ev.event === 'object') {
      const inner = ev.event as Record<string, unknown>;
      if (inner.type === 'content_block_start') count(inner.content_block);
    }
  }
  return n;
}
const isAdvisorUse = (b: unknown): boolean =>
  !!b &&
  typeof b === 'object' &&
  (b as Record<string, unknown>).type === 'server_tool_use' &&
  (b as Record<string, unknown>).name === 'advisor';

// What a Claude seat's spawn STATED about its advisor, for the trail: "off" or a model id when the
// config carries one, `inherit` when it left the key absent (the operator's own setting decided —
// the accident core/types `advisor` exists to end). The SAME parse the spawn applies
// (parseSeatAdvisor, behind claudeAdvisorArgs / claudeAdvisorEnv), so the record can never name a
// state the spawn did not apply; a value that parse refuses never spawned, so it is never recorded.
// Undefined for a seat that is not a Claude spawn (a codex or grok voice, a codex-vendor gate), so
// no field is written for it.
export function advisorStateOf(
  config: { advisor?: unknown; id?: unknown; vendor?: unknown } | null | undefined
): string | undefined {
  if (!config) return undefined;
  if (config.id === 'codex' || config.id === 'grok') return undefined;
  if (config.vendor !== undefined && config.vendor !== 'anthropic') return undefined;
  const stated = parseSeatAdvisor(config.advisor, typeof config.id === 'string' ? config.id : 'claude');
  return stated === undefined ? 'inherit' : stated;
}
