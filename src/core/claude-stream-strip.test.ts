import { describe, expect, it } from 'vitest';

import { dropDeliveredDeltas, stripStreamPayloads } from './claude-stream';
import { joinStreamHeadTail, STREAM_DELTAS_KEPT_EVENT } from './spawn';

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

describe('dropDeliveredDeltas — a delivered message loses only its content_block_delta lines', () => {
  const se = (event: Record<string, unknown>, extra = ''): string => `{"type":"stream_event","event":${JSON.stringify(event)}${extra}}`;
  const start = (id: string) => se({ message: { content: [], id }, type: 'message_start' });
  const delta = (t: string) => se({ delta: { text: t, type: 'text_delta' }, index: 0, type: 'content_block_delta' });
  const assistant = (id: string, content: unknown[] = [{ text: 'ab', type: 'text' }]) => JSON.stringify({ message: { content, id }, type: 'assistant' });
  const init = JSON.stringify({ subtype: 'init', type: 'system' });
  const result = JSON.stringify({ subtype: 'success', type: 'result' });

  it('drops the deltas once the assistant line arrives; every other line byte-identical, in order, newline kept', () => {
    const lines = [init, start('m1'), se({ content_block: { text: '', type: 'text' }, index: 0, type: 'content_block_start' }), delta('a'), delta('b'), se({ index: 0, type: 'content_block_stop' }), se({ type: 'message_delta', usage: { output_tokens: 2 } }), se({ type: 'message_stop' }), assistant('m1'), result];
    expect(dropDeliveredDeltas(`${lines.join('\n')}\n`)).toBe(`${[lines[0], lines[1], lines[2], lines[5], lines[6], lines[7], lines[8], lines[9]].join('\n')}\n`);
  });

  it('decides on the PARSED line, never a string match: a delta in other spacing is dropped, a line that merely quotes one is kept', () => {
    const spaced = '{ "type": "stream_event", "event": { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "x" } } }';
    const quoting = JSON.stringify({ message: { content: [{ content: '{"type":"stream_event","event":{"type":"content_block_delta"}}', tool_use_id: 't', type: 'tool_result' }] }, type: 'user' });
    const notJson = '{"type":"stream_event","event":{"type":"content_block_delta"'; // cut mid-write
    const out = dropDeliveredDeltas([init, start('m1'), spaced, assistant('m1'), quoting, notJson, result].join('\n'));
    expect(out.split('\n')).toEqual([init, start('m1'), assistant('m1'), quoting, notJson, result]);
  });

  it('a stream with nothing to drop and nothing kept is returned as-is', () => {
    const s = [init, start('m1'), assistant('m1'), result].join('\n');
    expect(dropDeliveredDeltas(s)).toBe(s);
    expect(dropDeliveredDeltas('')).toBe('');
  });

  it("keeps a message's deltas and flags when the next message starts before its assistant line, or the assistant line is another message's", () => {
    const s = [init, start('m1'), delta('a'), start('m2'), delta('b'), assistant('m9'), assistant('m2'), result].join('\n');
    const out = dropDeliveredDeltas(s).split('\n');
    expect(out).toContain(delta('a'));
    expect(out).not.toContain(delta('b')); // m2 was delivered
    expect(JSON.parse(out[out.length - 1])).toEqual({ messages: [{ deltas: 1, id: 'm1', why: 'no assistant line before the next message' }], type: STREAM_DELTAS_KEPT_EVENT });
  });

  it('a tool_use block start without an id is never vouched for — its message keeps its deltas', () => {
    const tu = se({ content_block: { input: {}, name: 'read_file', type: 'tool_use' }, index: 1, type: 'content_block_start' });
    const out = dropDeliveredDeltas([init, start('m1'), tu, delta('a'), assistant('m1', [{ input: {}, name: 'read_file', type: 'tool_use' }]), result].join('\n'));
    expect(out).toContain(delta('a'));
    expect(out).toContain(STREAM_DELTAS_KEPT_EVENT);
  });
});
