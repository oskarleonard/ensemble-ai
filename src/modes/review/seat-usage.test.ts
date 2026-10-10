import { describe, expect, it } from 'vitest';

import { describeUsage, parseSeatUsage, readDepthOf } from './seat-usage';

const codexStream = [
  JSON.stringify({ type: 'thread.started', thread_id: 't' }),
  JSON.stringify({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'git diff' } }),
  JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'command_execution' } }),
  JSON.stringify({ type: 'item.started', item: { id: 'i2', type: 'agent_message' } }),
  JSON.stringify({ type: 'item.started', item: { id: 'i3', type: 'command_execution', command: 'rg foo' } }),
  'not json at all',
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4546368, cached_input_tokens: 4123520, output_tokens: 8813, reasoning_output_tokens: 3181 } }),
].join('\n');

const grokStream = [
  JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 2061, output_tokens: 4075, cache_read_input_tokens: 169600 } } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking' }, { type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Grep' }] } }),
  JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 1000 } } }),
  JSON.stringify({ type: 'result', subtype: 'success', num_turns: 96, duration_ms: 1152792 }),
].join('\n');

describe('parseSeatUsage — tokens, tool calls and turns off the persisted stream', () => {
  it('reads a codex --json stream', () => {
    expect(parseSeatUsage(codexStream)).toEqual({ cachedInputTokens: 4123520, inputTokens: 4546368, outputTokens: 8813, toolCalls: 2, turns: 1 });
  });
  it('reads a grok (claude-shaped) stream, summing per-message usage', () => {
    expect(parseSeatUsage(grokStream)).toEqual({ cachedInputTokens: 170600, inputTokens: 172761, outputTokens: 4100, toolCalls: 2, turns: 96 });
  });
  it('yields nothing for an absent or unreadable stream — never a guess', () => {
    expect(parseSeatUsage(undefined)).toEqual({});
    expect(parseSeatUsage('')).toEqual({});
    expect(parseSeatUsage('garbage\n{"type":"unknown"}')).toEqual({});
  });
});

describe('readDepthOf — a THIN read is named, an unmeasured one is not called thin', () => {
  it('names a skim of a large part thin, and a terse read of a small part ok', () => {
    expect(readDepthOf({ outputTokens: 1179, toolCalls: 3 }, 499_000, true)).toBe('thin'); // the 93-second part
    expect(readDepthOf({ outputTokens: 8813, toolCalls: 40 }, 499_000, true)).toBe('ok');
    expect(readDepthOf({ outputTokens: 200, toolCalls: 1 }, 20_000, true)).toBe('ok'); // under the min part size
  });
  it('a worktree seat that opened nothing on a large part is thin even with many tokens', () => {
    expect(readDepthOf({ outputTokens: 9000, toolCalls: 0 }, 300_000, true)).toBe('thin');
    expect(readDepthOf({ outputTokens: 9000, toolCalls: 0 }, 300_000, false)).toBe('ok'); // a packet seat has nothing to open
  });
  it('no usage ⇒ unmeasured', () => {
    expect(readDepthOf({}, 499_000, true)).toBe('unmeasured');
  });
  it('describeUsage reads like a line in a log', () => {
    expect(describeUsage({ cachedInputTokens: 4123520, inputTokens: 4546368, outputTokens: 8813, toolCalls: 2 })).toBe('8,813 out · 4,546,368 in (91% cached) · 2 tool calls');
    expect(describeUsage({})).toBe('no usage recorded');
  });
});
