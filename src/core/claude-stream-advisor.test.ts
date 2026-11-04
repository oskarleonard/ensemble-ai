import { describe, expect, it } from 'vitest';

import { advisorCallCount, advisorStateOf } from './claude-stream';

const assistant = (content: unknown[]) => JSON.stringify({ message: { content, model: 'claude-opus-5-5', role: 'assistant' }, type: 'assistant' });

describe('advisorCallCount — the advisor shows only as a server_tool_use on the stream', () => {
  it('counts every advisor block on assistant events and nothing else', () => {
    const stream = [
      JSON.stringify({ subtype: 'init', tools: ['Read', 'Grep'], type: 'system' }),
      assistant([{ id: 'srvtoolu_1', input: {}, name: 'advisor', type: 'server_tool_use' }]),
      assistant([{ text: 'reading advisor.md', type: 'text' }, { id: 'toolu_1', input: { file_path: 'advisor.md' }, name: 'Read', type: 'tool_use' }]),
      assistant([{ id: 'srvtoolu_2', input: {}, name: 'advisor', type: 'server_tool_use' }, { id: 'srvtoolu_3', input: {}, name: 'web_search', type: 'server_tool_use' }]),
      'not json at all — advisor',
      JSON.stringify({ result: 'done', type: 'result' }),
    ].join('\n');
    expect(advisorCallCount(stream)).toBe(2);
  });
  it('reads the partial-message shape too', () => {
    const line = JSON.stringify({ event: { content_block: { name: 'advisor', type: 'server_tool_use' }, index: 0, type: 'content_block_start' }, type: 'stream_event' });
    expect(advisorCallCount(line)).toBe(1);
  });
  it('is zero on nothing, on junk, and on a stream that only mentions the word', () => {
    expect(advisorCallCount(null)).toBe(0);
    expect(advisorCallCount('')).toBe(0);
    expect(advisorCallCount(assistant([{ text: 'no advisor here', type: 'text' }]))).toBe(0);
  });
});

describe('advisorStateOf — what the spawn stated', () => {
  it('off and a model id are stated; an absent key is inherit', () => {
    expect(advisorStateOf({ advisor: 'off' })).toBe('off');
    expect(advisorStateOf({ advisor: 'sonnet', vendor: 'anthropic' })).toBe('sonnet');
    expect(advisorStateOf({ model: 'opus' } as { advisor?: unknown })).toBe('inherit');
    expect(advisorStateOf({ advisor: '' })).toBe('inherit');
  });
  it('a seat that is not a Claude spawn records nothing', () => {
    expect(advisorStateOf({ advisor: 'off', vendor: 'codex' })).toBeUndefined();
    expect(advisorStateOf(null)).toBeUndefined();
  });
});
