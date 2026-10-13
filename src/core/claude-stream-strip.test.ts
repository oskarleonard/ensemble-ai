import { describe, expect, it } from 'vitest';

import { stripStreamPayloads } from './claude-stream';
import { joinStreamHeadTail } from './spawn';

describe('stripStreamPayloads — the persisted transcript keeps every call and drops every result body', () => {
  const user = JSON.stringify({
    message: { content: [{ content: 'x'.repeat(5000), is_error: false, tool_use_id: 'toolu_1', type: 'tool_result' }], role: 'user' },
    tool_result_meta: [{ a: 1 }],
    tool_use_result: { file: { content: 'y'.repeat(5000) } },
    type: 'user',
  });
  const assistant = JSON.stringify({ message: { content: [{ id: 'toolu_1', input: { file_path: '/wt/a.ts' }, name: 'Read', type: 'tool_use' }] }, type: 'assistant' });
  const stream = [JSON.stringify({ subtype: 'init', type: 'system' }), assistant, user, 'not json', JSON.stringify({ subtype: 'success', type: 'result' })].join('\n');
  it('replaces the result body with its size, keeps id + is_error, drops the CLI duplicate, leaves every other line byte-identical', () => {
    const out = stripStreamPayloads(stream).split('\n');
    expect(out[0]).toBe(JSON.stringify({ subtype: 'init', type: 'system' }));
    expect(out[1]).toBe(assistant);
    const u = JSON.parse(out[2]);
    expect(u.tool_use_result).toBeUndefined();
    expect(u.tool_result_meta).toBeUndefined();
    expect(u.message.content[0]).toEqual({ content: '[stripped 5000 chars — the seat\'s tool result; the tree is on disk]', is_error: false, tool_use_id: 'toolu_1', type: 'tool_result' });
    expect(out[3]).toBe('not json');
    expect(out[4]).toBe(JSON.stringify({ subtype: 'success', type: 'result' }));
    expect(stripStreamPayloads(stream).length).toBeLessThan(stream.length / 5);
  });
});

describe('joinStreamHeadTail — head + cut marker + tail, or the whole stream when nothing was dropped', () => {
  it('keeps the head on whole lines, names the dropped bytes, and keeps the tail', () => {
    const head = 'A\nB\nC\n';
    const tail = 'Y\nZ\n';
    const out = joinStreamHeadTail(head + 'ignored-middle-'.repeat(10), tail, 200, 4);
    expect(out.startsWith('A\nB\n')).toBe(true);
    expect(out).toContain('"type":"ensemble.stream_cut"');
    expect(JSON.parse(out.split('\n')[2]).droppedChars).toBe(200 - 'A\nB\n'.length - tail.length);
    expect(out.endsWith(tail)).toBe(true);
  });
  it('a stream that fit is returned whole, with no marker', () => {
    expect(joinStreamHeadTail('A\nB\n', 'A\nB\n', 4)).toBe('A\nB\n');
  });
});
