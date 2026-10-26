import { STREAM_CUT_EVENT } from '../../core/spawn';

// READ-DEPTH TELEMETRY (step 1 of the 2026-10-10 architecture review). The gate verifies the
// findings a seat returns; nothing verified that the seat READ. Run 2026-10-10-22-31-50-485c0df5
// had codex return one finding on a 499 KB part after 93 seconds and ~1,200 output tokens, and the
// trail called that part `reviewed`. The vendor CLIs' progress streams already carry the facts —
// tokens, turns, commands run — this module reads them off the persisted stream so chunks.json,
// the diagnostics and the coverage overview can say how deep each read was, and a THIN read is
// named rather than counted as a review.
//
// PURE: feed it the stream text, get numbers. Both stream shapes this engine persists are read:
//   · codex `--json`: `item.started`/`item.completed` (command_execution items are tool calls),
//     one `turn.completed` with `usage` {input_tokens, cached_input_tokens, output_tokens, …};
//   · grok (claude-shaped stream): `stream_event` deltas whose `message_delta` carries `usage`
//     per message (summed), and a final `result` with `num_turns` and `duration_api_ms`.
// A stream this module cannot read yields an empty record — never a guess.
//
// THE TAIL IS NOT THE STREAM (2026-10-11): the persisted stream is a BOUNDED TAIL (spawn.ts
// boundedStreamTail), so its head can be gone. Run 2026-10-11-14-26-29-57b963ab kept grok's last
// message only: summing the surviving `message_delta` usage said 914 output tokens where the
// final `result` event — which always survives, it is the last line — said 13,591 over 45 turns.
// So grok's token totals come from `result.usage` whenever it carries them, and TOOL CALLS are
// counted only when the stream still begins at its head (grok `system`/init, codex
// `thread.started`); a tail that lost its head reports tool calls as unmeasured, not as few.

export interface SeatUsage {
  // The persisted stream lost its head (no init / thread.started first) or carries a cut marker
  // (core/spawn STREAM_CUT_EVENT): `toolCalls` is then a FLOOR, not a count. Tokens are not
  // affected — they come from the final result event, which always survives.
  streamTruncated?: true;
  // Prompt tokens the vendor served from cache (codex `cached_input_tokens`, grok
  // `cache_read_input_tokens`).
  cachedInputTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  // Commands / tool invocations the seat made while reviewing (reads, greps, git).
  toolCalls?: number;
  // Model turns (grok `num_turns`; codex has one turn per review).
  turns?: number;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

// What the stream's FIRST event says about its head: `init` when it is the real start (codex
// `thread.started`; claude-shaped `system`/`init` — NOT any `system` event: a claude seat emits
// one `system`/`thinking_tokens` per turn, so a lost-head tail starts with one of those more
// often than not, which is how run d5a1f648's part 1 passed as intact), else what it was.
function streamHeadKind(ev: Record<string, unknown>): string {
  if (ev.type === 'thread.started') return 'init';
  if (ev.type === 'system' && ev.subtype === 'init') return 'init';
  return typeof ev.type === 'string' ? ev.type : '';
}

export function parseSeatUsage(stream: string | null | undefined): SeatUsage {
  if (!stream) return {};
  const usage: SeatUsage = {};
  let toolCalls = 0;
  let sawTool = false;
  let grokIn = 0;
  let grokOut = 0;
  let grokCached = 0;
  let sawGrokUsage = false;
  let resultUsage: { cached: number; input: number; output: number } | null = null;
  let first: string | null = null;
  let sawCut = false;
  for (const line of stream.split('\n')) {
    if (!line.trim()) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    const ev = e as Record<string, unknown>;
    if (first === null) first = streamHeadKind(ev);
    if (ev.type === STREAM_CUT_EVENT) sawCut = true;
    // codex
    if (ev.type === 'item.started' && ev.item && typeof ev.item === 'object') {
      const it = ev.item as Record<string, unknown>;
      if (it.type === 'command_execution' || it.type === 'tool_call' || it.type === 'mcp_tool_call') {
        toolCalls++;
        sawTool = true;
      }
      continue;
    }
    if (ev.type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
      const u = ev.usage as Record<string, unknown>;
      usage.inputTokens = num(u.input_tokens);
      usage.outputTokens = num(u.output_tokens);
      usage.cachedInputTokens = num(u.cached_input_tokens);
      usage.turns = 1;
      continue;
    }
    // grok (claude-shaped)
    if (ev.type === 'stream_event' && ev.event && typeof ev.event === 'object') {
      const inner = ev.event as Record<string, unknown>;
      if (inner.type === 'message_delta' && inner.usage && typeof inner.usage === 'object') {
        const u = inner.usage as Record<string, unknown>;
        grokIn += num(u.input_tokens) ?? 0;
        grokOut += num(u.output_tokens) ?? 0;
        grokCached += num(u.cache_read_input_tokens) ?? 0;
        sawGrokUsage = true;
      }
      if (inner.type === 'content_block_start' && inner.content_block && typeof inner.content_block === 'object') {
        const cb = inner.content_block as Record<string, unknown>;
        if (cb.type === 'tool_use') {
          toolCalls++;
          sawTool = true;
        }
      }
      continue;
    }
    if (ev.type === 'assistant' && ev.message && typeof ev.message === 'object') {
      const m = ev.message as Record<string, unknown>;
      if (Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c && typeof c === 'object' && (c as Record<string, unknown>).type === 'tool_use') {
            toolCalls++;
            sawTool = true;
          }
        }
      }
      continue;
    }
    if (ev.type === 'result') {
      const t = num(ev.num_turns);
      if (t !== undefined) usage.turns = t;
      if (ev.usage && typeof ev.usage === 'object') {
        const u = ev.usage as Record<string, unknown>;
        const output = num(u.output_tokens);
        if (output !== undefined) {
          resultUsage = { cached: num(u.cache_read_input_tokens) ?? 0, input: num(u.input_tokens) ?? 0, output };
        }
      }
    }
  }
  if (resultUsage) {
    // The run's totals, from the one event that survives any tail cut.
    usage.inputTokens = resultUsage.input + resultUsage.cached;
    usage.outputTokens = resultUsage.output;
    usage.cachedInputTokens = resultUsage.cached;
  } else if (sawGrokUsage) {
    usage.inputTokens = grokIn + grokCached;
    usage.outputTokens = grokOut;
    usage.cachedInputTokens = grokCached;
  }
  // Tool calls are a COUNT over the whole stream; a stream that lost its head, or carries a cut,
  // gives a FLOOR — reported as such, never dressed as the count.
  const truncated = first !== 'init' || sawCut;
  if (sawTool) usage.toolCalls = toolCalls;
  // A stream this module could not read at all stays an EMPTY record; the flag qualifies facts.
  if (truncated && Object.keys(usage).length > 0) usage.streamTruncated = true;
  return usage;
}

// A THIN read: the seat returned far too little work for the bytes it was handed. Named, never
// guessed — a seat whose stream carried no usage is not called thin (it is `unmeasured`). The
// floor is deliberately low (it catches a 93-second skim of 500 KB, not a terse honest review):
// under ~1 output token per 100 bytes of diff over a 50 KB part, or a worktree seat that opened
// nothing. Both numbers are published here so the dashboard and the overview quote one rule.
export const THIN_OUTPUT_TOKENS_PER_KB = 10;
export const THIN_MIN_PART_BYTES = 50_000;

export type ReadDepth = 'ok' | 'thin' | 'unmeasured';

export function readDepthOf(usage: SeatUsage, partBytes: number, worktreeSeat: boolean): ReadDepth {
  if (usage.outputTokens === undefined) return 'unmeasured';
  if (partBytes < THIN_MIN_PART_BYTES) return 'ok';
  const floor = (partBytes / 1024) * THIN_OUTPUT_TOKENS_PER_KB;
  if (usage.outputTokens < floor) return 'thin';
  // A zero on a truncated stream is a floor, not "opened nothing".
  if (worktreeSeat && usage.toolCalls !== undefined && usage.toolCalls === 0 && !usage.streamTruncated) return 'thin';
  return 'ok';
}

export function describeUsage(u: SeatUsage): string {
  const bits: string[] = [];
  if (u.outputTokens !== undefined) bits.push(`${u.outputTokens.toLocaleString('en-US')} out`);
  if (u.inputTokens !== undefined) bits.push(`${u.inputTokens.toLocaleString('en-US')} in${u.cachedInputTokens ? ` (${Math.round((u.cachedInputTokens / u.inputTokens) * 100)}% cached)` : ''}`);
  if (u.toolCalls !== undefined) bits.push(`${u.toolCalls} tool call${u.toolCalls === 1 ? '' : 's'}`);
  if (u.turns !== undefined && u.turns > 1) bits.push(`${u.turns} turns`);
  if (u.streamTruncated) bits.push('stream truncated — tool-call counts are floors');
  return bits.join(' · ') || 'no usage recorded';
}

// DID THE SEAT READ THE CONVENTIONS? (2026-10-13, twice.) Under conventions-as-a-file the only
// proof a seat read the rules is a tool call that reached them; THIN never catches a skipped read
// on a small part (it fires above 50 KB only). First cut counted any touch as "read" — and the
// first four runs showed the Claude producer opening the first 60–80 lines (the index) and
// nothing it points at, counted as read, plus a lens whose first bare Read of the 344 KB file
// ERRORED on size and was counted too. So this is three-valued and span-aware: every successful
// read of the file becomes a line range (codex `sed -n 'A,Bp'` / `head -n N` / `cat`; a claude-
// shaped Read's offset/limit; a grep of the file counts as reaching whatever it searched),
// errored results (`tool_result` with `is_error`) are dropped, and the ranges are laid over the
// file's own layout (core/conventions readConventionsLayout): `index-only` when every range ends
// inside the index, `read` with the docs the ranges reached otherwise, `unread` when nothing
// reached the file. `undefined` when the stream is absent or lost its head — never a guess.
export const CONVENTIONS_TOUCH_NEEDLE = '.ensemble-conventions';

export interface ConventionsLayout {
  indexEndLine: number;
  spans: readonly { endLine: number; path: string; startLine: number }[];
}

export interface ConventionsRead {
  // The gathered docs (by original path) at least one successful read or grep reached.
  docsRead: string[];
  state: 'read' | 'index-only' | 'unread';
}

// A claude-shaped Read with no limit returns up to this many lines (the CLI's default window).
const CLAUDE_READ_DEFAULT_LINES = 2000;

interface LineRange {
  end: number;
  grep: boolean;
  start: number;
}

function codexRanges(command: string, needle: string): LineRange[] {
  if (!command.includes(needle)) return [];
  const out: LineRange[] = [];
  // Every `sed -n 'A,Bp'` / `sed -n A,Bp` / `sed -n 'Ap'` in the command (chained commands count each).
  for (const m of command.matchAll(/sed\s+-n\s+['"]?(\d+)(?:,(\d+))?p['"]?/g)) {
    const a = Number(m[1]);
    out.push({ end: m[2] ? Number(m[2]) : a, grep: false, start: a });
  }
  for (const m of command.matchAll(/head\s+-n\s*(\d+)/g)) out.push({ end: Number(m[1]), grep: false, start: 1 });
  if (/\b(rg|grep|ag)\b/.test(command)) out.push({ end: Number.MAX_SAFE_INTEGER, grep: true, start: 1 });
  if (out.length === 0 && /\b(cat|less|more|bat)\b/.test(command)) out.push({ end: Number.MAX_SAFE_INTEGER, grep: false, start: 1 });
  return out;
}

export function conventionsReadOf(
  stream: string | null | undefined,
  layout: ConventionsLayout | null,
  needle = CONVENTIONS_TOUCH_NEEDLE
): ConventionsRead | undefined {
  if (!stream) return undefined;
  let first: string | null = null;
  let sawCut = false;
  const ranges: LineRange[] = [];
  // claude-shaped: a Read/Grep is recorded by tool_use id so an errored tool_result can drop it.
  const pending = new Map<string, LineRange>();
  // codex: a command is recorded at `item.started` and COUNTS only when its `item.completed`
  // says it ran (`status: completed`, exit 0) — a command that failed read nothing, and one that
  // never returned (the seat was reclaimed mid-command) is ATTEMPTED: it proves no read, and it
  // bars the "unread"/"index-only" claims the same way a cut does (Munin, engine ask 3,
  // 2026-10-23: the started-only count overstated codex's read tally). Codex-only on purpose:
  // grok's claude-shaped stream carries a `tool_result` for a fraction of its `tool_use`s (run
  // d3da5a17: 14 of 64), so a claude-shaped Read without a result stays counted, as before.
  const codexPending = new Map<string, LineRange[]>();
  let codexUnkeyed = 0;
  for (const line of stream.split('\n')) {
    if (!line.trim()) continue;
    let e: unknown;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    const ev = e as Record<string, unknown>;
    if (first === null) first = streamHeadKind(ev);
    if (ev.type === STREAM_CUT_EVENT) sawCut = true;
    if ((ev.type === 'item.started' || ev.type === 'item.completed') && ev.item && typeof ev.item === 'object') {
      const it = ev.item as Record<string, unknown>;
      if (it.type !== 'command_execution') continue;
      const id = typeof it.id === 'string' ? it.id : null;
      if (ev.type === 'item.started') {
        const rs = typeof it.command === 'string' ? codexRanges(it.command, needle) : [];
        if (rs.length === 0) continue;
        if (id === null) codexUnkeyed++;
        else codexPending.set(id, rs);
        continue;
      }
      // item.completed: the command either ran (exit 0, status completed) or it did not.
      const rs = id !== null ? codexPending.get(id) : undefined;
      if (id !== null) codexPending.delete(id);
      const ran = it.status === 'completed' && (it.exit_code === undefined || it.exit_code === 0);
      if (rs && ran) ranges.push(...rs);
      // A completed event with no started twin in the stream (the start fell in a cut) still
      // proves the read when it ran — the command text is on the completed item too.
      if (!rs && ran && typeof it.command === 'string') ranges.push(...codexRanges(it.command, needle));
      continue;
    }
    if (ev.type === 'assistant' && ev.message && typeof ev.message === 'object') {
      const content = (ev.message as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (!c || typeof c !== 'object' || (c as Record<string, unknown>).type !== 'tool_use') continue;
        const tu = c as Record<string, unknown>;
        const input = (tu.input && typeof tu.input === 'object' ? tu.input : {}) as Record<string, unknown>;
        const target = [input.file_path, input.path, input.command].find((v) => typeof v === 'string' && v.includes(needle));
        if (!target) continue;
        const id = typeof tu.id === 'string' ? tu.id : `${pending.size}`;
        if (typeof input.command === 'string') {
          for (const r of codexRanges(input.command, needle)) pending.set(`${id}:${pending.size}`, r);
          continue;
        }
        if (typeof input.pattern === 'string' || tu.name === 'Grep' || tu.name === 'grep') {
          pending.set(id, { end: Number.MAX_SAFE_INTEGER, grep: true, start: 1 });
          continue;
        }
        const offset = typeof input.offset === 'number' && input.offset > 0 ? input.offset : 1;
        const limit = typeof input.limit === 'number' && input.limit > 0 ? input.limit : CLAUDE_READ_DEFAULT_LINES;
        pending.set(id, { end: offset + limit - 1, grep: false, start: offset });
      }
      continue;
    }
    if (ev.type === 'user' && ev.message && typeof ev.message === 'object') {
      const content = (ev.message as Record<string, unknown>).content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        const tr = c as Record<string, unknown>;
        if (tr.type !== 'tool_result' || typeof tr.tool_use_id !== 'string') continue;
        if (tr.is_error === true) {
          for (const k of [...pending.keys()]) if (k === tr.tool_use_id || k.startsWith(`${tr.tool_use_id}:`)) pending.delete(k);
        }
      }
    }
  }
  ranges.push(...pending.values());
  if (first === null) return undefined;
  // A truncated stream — head gone, or a cut marker between head and tail — can still PROVE a
  // read (the call survived); it can never prove "unread" or "index-only", because the call that
  // reached a doc may be in the part that was dropped. Those two need the WHOLE stream.
  const attempted = codexPending.size > 0 || codexUnkeyed > 0;
  const whole = first === 'init' && !sawCut && !attempted;
  if (ranges.length === 0) return whole ? { docsRead: [], state: 'unread' } : undefined;
  if (!layout) return { docsRead: [], state: 'read' };
  const beyondIndex = ranges.some((r) => r.grep || r.end > layout.indexEndLine);
  if (!beyondIndex) return whole ? { docsRead: [], state: 'index-only' } : undefined;
  const docsRead = layout.spans
    .filter((sp) => ranges.some((r) => !r.grep && r.start <= sp.endLine && r.end >= sp.startLine))
    .map((sp) => sp.path);
  return { docsRead, state: 'read' };
}
