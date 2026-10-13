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
    if (first === null) first = typeof ev.type === 'string' ? ev.type : '';
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
  // Tool calls are a COUNT over the whole stream; a tail that lost its head cannot give one.
  const headIntact = first === 'system' || first === 'thread.started';
  if (sawTool && headIntact) usage.toolCalls = toolCalls;
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
  if (worktreeSeat && usage.toolCalls !== undefined && usage.toolCalls === 0) return 'thin';
  return 'ok';
}

export function describeUsage(u: SeatUsage): string {
  const bits: string[] = [];
  if (u.outputTokens !== undefined) bits.push(`${u.outputTokens.toLocaleString('en-US')} out`);
  if (u.inputTokens !== undefined) bits.push(`${u.inputTokens.toLocaleString('en-US')} in${u.cachedInputTokens ? ` (${Math.round((u.cachedInputTokens / u.inputTokens) * 100)}% cached)` : ''}`);
  if (u.toolCalls !== undefined) bits.push(`${u.toolCalls} tool call${u.toolCalls === 1 ? '' : 's'}`);
  if (u.turns !== undefined && u.turns > 1) bits.push(`${u.turns} turns`);
  return bits.join(' · ') || 'no usage recorded';
}

// DID THE SEAT OPEN THE CONVENTIONS FILE? (2026-10-13 fresh-eyes review). Under conventions-as-a-
// file the only proof a seat read the rules is a tool call that touched the file; THIN never
// catches a skipped read on a small part (it fires above 50 KB only). Named off the stream, never
// guessed: `undefined` when the stream is absent or lost its head (the call may be in the cut
// part), `false` only when the whole stream is there and no call reached the directory.
export const CONVENTIONS_TOUCH_NEEDLE = '.ensemble-conventions';

export function conventionsTouched(stream: string | null | undefined, needle = CONVENTIONS_TOUCH_NEEDLE): boolean | undefined {
  if (!stream) return undefined;
  let first: string | null = null;
  let touched = false;
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
    if (first === null) first = typeof ev.type === 'string' ? ev.type : '';
    // Only the seat's OWN calls count — a tool RESULT (`user`) or a result event that happens to
    // mention the path is the engine or the tree talking, not the seat opening the file.
    const own = ev.type === 'item.started' || ev.type === 'item.completed' || ev.type === 'assistant' || ev.type === 'stream_event';
    if (own && line.includes(needle)) touched = true;
  }
  if (first === null) return undefined;
  const headIntact = first === 'system' || first === 'thread.started';
  if (touched) return true;
  return headIntact ? false : undefined;
}
