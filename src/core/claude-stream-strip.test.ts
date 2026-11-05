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
    const spaced = '{ "type": "stream_event", "event": { "type": "content_block_delta", "index": 0, "delta": { "type": "text_delta", "text": "ab" } } }';
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
    const s = [init, start('m1'), delta('a'), start('m2'), delta('b'), assistant('m9'), assistant('m2', [{ text: 'b', type: 'text' }]), result].join('\n');
    const out = dropDeliveredDeltas(s).split('\n');
    expect(out).toContain(delta('a'));
    expect(out).not.toContain(delta('b')); // m2 was delivered
    expect(JSON.parse(out[out.length - 1])).toEqual({ messages: [{ deltas: 1, id: 'm1', mayHoldCall: false, why: 'no assistant line before the next message' }], type: STREAM_DELTAS_KEPT_EVENT });
  });

  const flagOf = (out: string) => (JSON.parse(out.split('\n').find((l) => l.includes(STREAM_DELTAS_KEPT_EVENT))!) as { messages: unknown[] }).messages;
  const toolStart = (id: string, index = 1) => se({ content_block: { id, input: {}, name: 'read_file', type: 'tool_use' }, index, type: 'content_block_start' });
  const json = (partial: string, index = 1) => se({ delta: { partial_json: partial, type: 'input_json_delta' }, index, type: 'content_block_delta' });
  const toolUse = (id: string, input: Record<string, unknown>) => ({ id, input, name: 'read_file', type: 'tool_use' });

  it('deltas no message_start named are never vouched for — before any message_start, under an id-less one, or after an assistant line closed theirs', () => {
    const before = dropDeliveredDeltas([init, delta('ab'), assistant('m1'), result].join('\n'));
    expect(before).toContain(delta('ab'));
    expect(flagOf(before)).toEqual([{ deltas: 1, id: null, mayHoldCall: false, why: 'no message_start named its message' }]);
    const idless = dropDeliveredDeltas([init, se({ message: { content: [] }, type: 'message_start' }), delta('ab'), assistant('m1'), result].join('\n'));
    expect(idless).toContain(delta('ab'));
    expect(flagOf(idless)).toEqual([{ deltas: 1, id: null, mayHoldCall: false, why: 'no message_start named its message' }]);
    // a snapshot closed m1, then a later block's tool input streamed: re-homed id-less, kept, may hold a call
    const read = '{"target_file":"/wt/head/CONVENTIONS.md"}';
    const late = dropDeliveredDeltas([init, start('m1'), delta('ab'), assistant('m1'), toolStart('c1'), json(read), assistant('m1', [{ text: 'ab', type: 'text' }, toolUse('c1', {})]), result].join('\n'));
    expect(late).not.toContain(delta('ab')); // m1's text was delivered
    expect(late).toContain(json(read));
    expect(flagOf(late)).toEqual([{ deltas: 1, id: null, mayHoldCall: true, why: 'no message_start named its message' }]);
  });

  it('drops only what the assistant line RESTATES: a tool input, text or thinking it states otherwise keeps the deltas', () => {
    const read = '{"target_file":"/wt/head/CONVENTIONS.md","limit":200}';
    const other = dropDeliveredDeltas([init, start('m1'), toolStart('c1'), json(read), assistant('m1', [{ text: '', type: 'text' }, toolUse('c1', {})]), result].join('\n'));
    expect(other).toContain(json(read));
    expect(flagOf(other)).toEqual([{ deltas: 1, id: 'm1', mayHoldCall: true, why: "its assistant line does not restate block 1's partial_json" }]);
    // the same input with its keys in another order IS a restatement
    const same = dropDeliveredDeltas([init, start('m1'), toolStart('c1'), json(read), assistant('m1', [{ text: '', type: 'text' }, toolUse('c1', { limit: 200, target_file: '/wt/head/CONVENTIONS.md' })]), result].join('\n'));
    expect(same).not.toContain('input_json_delta');
    expect(same).not.toContain(STREAM_DELTAS_KEPT_EVENT);
    const text = dropDeliveredDeltas([init, start('m1'), delta('a'), delta('b'), assistant('m1', [{ text: 'ax', type: 'text' }]), result].join('\n'));
    expect(flagOf(text)).toEqual([{ deltas: 2, id: 'm1', mayHoldCall: false, why: "its assistant line does not restate block 0's text" }]);
    const thinking = se({ delta: { thinking: 'hm', type: 'thinking_delta' }, index: 0, type: 'content_block_delta' });
    const noThinking = dropDeliveredDeltas([init, start('m1'), thinking, assistant('m1', []), result].join('\n'));
    expect(noThinking).toContain(thinking);
    // and a delta of a kind it cannot place is a doubt that may hold a call
    const odd = se({ delta: { citation: {}, type: 'citations_delta' }, index: 0, type: 'content_block_delta' });
    expect(flagOf(dropDeliveredDeltas([init, start('m1'), odd, assistant('m1'), result].join('\n')))).toEqual([{ deltas: 1, id: 'm1', mayHoldCall: true, why: 'a delta this reader cannot place' }]);
  });

  it('a tool_use block start without an id is never vouched for — its message keeps its deltas', () => {
    const tu = se({ content_block: { input: {}, name: 'read_file', type: 'tool_use' }, index: 1, type: 'content_block_start' });
    const out = dropDeliveredDeltas([init, start('m1'), tu, delta('a'), assistant('m1', [{ input: {}, name: 'read_file', type: 'tool_use' }]), result].join('\n'));
    expect(out).toContain(delta('a'));
    expect(out).toContain(STREAM_DELTAS_KEPT_EVENT);
  });
});
