import { describe, expect, it } from 'vitest';

import { claudeAdvisorArgs, claudeAdvisorEnv } from '../modes/brainstorm/claude';

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
  it('reads the partial-message shape too, and one call seen in both shapes counts once', () => {
    const start = JSON.stringify({ event: { content_block: { id: 'srvtoolu_9', name: 'advisor', type: 'server_tool_use' }, index: 0, type: 'content_block_start' }, type: 'stream_event' });
    expect(advisorCallCount(start)).toBe(1);
    const both = [start, assistant([{ id: 'srvtoolu_9', input: {}, name: 'advisor', type: 'server_tool_use' }])].join('\n');
    expect(advisorCallCount(both)).toBe(1);
    // Blocks without an id cannot be matched up — each occurrence counts.
    const bare = JSON.stringify({ event: { content_block: { name: 'advisor', type: 'server_tool_use' }, index: 0, type: 'content_block_start' }, type: 'stream_event' });
    expect(advisorCallCount([bare, bare].join('\n'))).toBe(2);
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
    // "" is not inherit: the spawn refuses it (parseSeatAdvisor), so a seat with it never ran.
    expect(() => advisorStateOf({ advisor: '' })).toThrow(/advisor/);
  });
  it('a seat that is not a Claude spawn records nothing', () => {
    expect(advisorStateOf({ advisor: 'off', vendor: 'codex' })).toBeUndefined();
    expect(advisorStateOf({ advisor: 'off', id: 'codex' })).toBeUndefined();
    expect(advisorStateOf({ id: 'grok' })).toBeUndefined();
    expect(advisorStateOf(null)).toBeUndefined();
  });
  it('agrees with what the spawn applies — the same parse behind claudeAdvisorArgs / claudeAdvisorEnv', () => {
    for (const config of [{ advisor: 'off', id: 'claude' }, { advisor: 'sonnet', id: 'claude' }, { id: 'claude' }]) {
      const env = claudeAdvisorEnv(config);
      const args = claudeAdvisorArgs(config);
      const stated = advisorStateOf(config);
      if (stated === 'off') expect(env).toEqual({ CLAUDE_CODE_DISABLE_ADVISOR_TOOL: '1' });
      else expect(env).toEqual({});
      if (stated === 'inherit' || stated === 'off') expect(args).toEqual([]);
      else expect(args).toEqual(['--settings', JSON.stringify({ advisorModel: stated })]);
    }
    // A value the spawn refuses never spawns, so it is never recorded either.
    expect(() => advisorStateOf({ advisor: 'Not A Model!', id: 'claude' })).toThrow(/advisor/);
  });
});
