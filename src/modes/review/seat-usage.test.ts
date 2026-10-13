import { describe, expect, it } from 'vitest';

import { conventionsTouched, describeUsage, parseSeatUsage, readDepthOf } from './seat-usage';

const codexStream = [
  JSON.stringify({ type: 'thread.started', thread_id: 't' }),
  JSON.stringify({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'git diff' } }),
  JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'command_execution' } }),
  JSON.stringify({ type: 'item.started', item: { id: 'i2', type: 'agent_message' } }),
  JSON.stringify({ type: 'item.started', item: { id: 'i3', type: 'command_execution', command: 'rg foo' } }),
  'not json at all',
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 4546368, cached_input_tokens: 4123520, output_tokens: 8813, reasoning_output_tokens: 3181 } }),
].join('\n');

const grokBody = [
  JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 2061, output_tokens: 4075, cache_read_input_tokens: 169600 } } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking' }, { type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Grep' }] } }),
  JSON.stringify({ type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 1000 } } }),
];
const grokInit = JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' });
const grokStream = [grokInit, ...grokBody, JSON.stringify({ type: 'result', subtype: 'success', num_turns: 96, duration_ms: 1152792 })].join('\n');
// What run 2026-10-11-14-26-29-57b963ab persisted: the head cut off by the tail cap, and a final
// `result` whose totals dwarf the one surviving message's delta.
const grokTailOnly = [...grokBody, JSON.stringify({ type: 'result', subtype: 'success', num_turns: 45, usage: { input_tokens: 179384, output_tokens: 13591, cache_read_input_tokens: 3160832 } })].join('\n');

describe('parseSeatUsage — tokens, tool calls and turns off the persisted stream', () => {
  it('reads a codex --json stream', () => {
    expect(parseSeatUsage(codexStream)).toEqual({ cachedInputTokens: 4123520, inputTokens: 4546368, outputTokens: 8813, toolCalls: 2, turns: 1 });
  });
  it('reads a grok (claude-shaped) stream, summing per-message usage when the result carries none', () => {
    expect(parseSeatUsage(grokStream)).toEqual({ cachedInputTokens: 170600, inputTokens: 172761, outputTokens: 4100, toolCalls: 2, turns: 96 });
  });
  it("takes grok's totals from the result event, and leaves tool calls unmeasured when the head is gone", () => {
    expect(parseSeatUsage(grokTailOnly)).toEqual({ cachedInputTokens: 3160832, inputTokens: 3340216, outputTokens: 13591, turns: 45 });
    // The same totals with the head intact: tool calls are a real count again.
    expect(parseSeatUsage([grokInit, grokTailOnly].join('\n')).toolCalls).toBe(2);
  });
  it('a codex tail that lost thread.started reports no tool-call count', () => {
    const headless = codexStream.split('\n').slice(1).join('\n');
    expect(parseSeatUsage(headless)).toEqual({ cachedInputTokens: 4123520, inputTokens: 4546368, outputTokens: 8813, turns: 1 });
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

describe('conventionsTouched — did the seat open the conventions file (named, never guessed)', () => {
  const init = JSON.stringify({ subtype: 'init', type: 'system' });
  it('a codex command that reads the file, or a claude-shaped tool call with its path', () => {
    const codex = [JSON.stringify({ type: 'thread.started' }), JSON.stringify({ item: { command: "/bin/zsh -lc 'cat .ensemble-conventions/CONVENTIONS.md'", type: 'command_execution' }, type: 'item.started' })].join('\n');
    const claude = [init, JSON.stringify({ message: { content: [{ input: { file_path: '/wt/.ensemble-conventions/CONVENTIONS.md' }, name: 'Read', type: 'tool_use' }] }, type: 'assistant' })].join('\n');
    expect(conventionsTouched(codex)).toBe(true);
    expect(conventionsTouched(claude)).toBe(true);
  });
  it('a whole stream with no such call is false; a tool RESULT mentioning the path does not count', () => {
    const none = [init, JSON.stringify({ message: { content: [{ input: { file_path: '/wt/src/x.ts' }, name: 'Read', type: 'tool_use' }] }, type: 'assistant' })].join('\n');
    const resultOnly = [init, JSON.stringify({ message: { content: [{ content: 'see .ensemble-conventions/CONVENTIONS.md', type: 'tool_result' }] }, type: 'user' })].join('\n');
    expect(conventionsTouched(none)).toBe(false);
    expect(conventionsTouched(resultOnly)).toBe(false);
  });
  it('a stream that lost its head cannot say no — unmeasured', () => {
    const headless = JSON.stringify({ message: { content: [{ input: { file_path: '/wt/src/x.ts' }, name: 'Read', type: 'tool_use' }] }, type: 'assistant' });
    expect(conventionsTouched(headless)).toBeUndefined();
    expect(conventionsTouched('')).toBeUndefined();
  });
});
