// TEST-ONLY: a synthetic grok review stream in the REAL shape (`--output-format
// streaming-messages-json --include-partial-messages`, grok-4.7, profiled off the persisted stream
// of run 2026-11-04-15-08-41-d8a5382a): per message a `message_start` with its id, a thinking block
// streamed as thousands of `thinking_delta`s + one `signature_delta`, each tool_use as a
// `content_block_start` (empty input) + one `input_json_delta` + `content_block_stop`, the
// `message_delta` usage, `message_stop`, then the `assistant` line RESTATING the whole message (the
// full thinking, the tool_use inputs) and one `user` tool_result per call; `result` last, with the
// run's usage. Every line carries the CLI's session_id / uuid envelope, as grok's do — which is why
// a one-token delta costs ~230 chars. No content of any real review is in here.

export const SESSION = '00000000-0000-4000-8000-000000000001';
export const CONVENTIONS_FILE = '/wt/head/.ensemble-conventions/CONVENTIONS.md';
// The usage the `result` line carries — what parseSeatUsage must report.
export const RESULT_USAGE = { cache_creation_input_tokens: 0, cache_read_input_tokens: 2_653_568, input_tokens: 181_801, output_tokens: 104_774 };

export interface ToolCall {
  id: string;
  input: Record<string, unknown>;
  name: 'grep' | 'list_dir' | 'read_file';
}

export interface StreamMessage {
  // `thinking_delta` lines this message streams before its tool calls.
  deltas: number;
  text?: string;
  tools: ToolCall[];
}

let uuidSeq = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`;
const envelope = { parent_tool_use_id: null, session_id: SESSION };
const streamEvent = (event: Record<string, unknown>): string => JSON.stringify({ event, type: 'stream_event', ...envelope, uuid: uuid() });

export const initLine = (): string =>
  JSON.stringify({ model: 'grok-4.7', permissionMode: 'bypassPermissions', session_id: SESSION, subtype: 'init', tools: ['read_file', 'list_dir', 'grep'], type: 'system', uuid: uuid() });

// One message's lines. `assistant: false` stops before the assistant line (and its tool results),
// the way a seat killed after the message's last delta leaves it.
export function messageLines(n: number, m: StreamMessage, opts: { assistant?: boolean; assistantTools?: ToolCall[] } = {}): string[] {
  const id = `msg_${n}`;
  const lines = [
    streamEvent({ message: { content: [], id, model: 'grok-4.7', role: 'assistant', stop_reason: null, type: 'message', usage: { input_tokens: 0, output_tokens: 0 } }, type: 'message_start' }),
    streamEvent({ content_block: { signature: '', thinking: '', type: 'thinking' }, index: 0, type: 'content_block_start' }),
  ];
  const words: string[] = [];
  for (let i = 0; i < m.deltas; i++) {
    const w = ` weighing ${n}.${i}`;
    words.push(w);
    lines.push(streamEvent({ delta: { thinking: w, type: 'thinking_delta' }, index: 0, type: 'content_block_delta' }));
  }
  lines.push(streamEvent({ delta: { signature: `SIG-${n}`, type: 'signature_delta' }, index: 0, type: 'content_block_delta' }));
  lines.push(streamEvent({ index: 0, type: 'content_block_stop' }));
  const content: Record<string, unknown>[] = [{ signature: `SIG-${n}`, thinking: words.join(''), type: 'thinking' }];
  m.tools.forEach((t, k) => {
    const index = k + 1;
    lines.push(streamEvent({ content_block: { id: t.id, input: {}, name: t.name, type: 'tool_use' }, index, type: 'content_block_start' }));
    lines.push(streamEvent({ delta: { partial_json: JSON.stringify(t.input), type: 'input_json_delta' }, index, type: 'content_block_delta' }));
    lines.push(streamEvent({ index, type: 'content_block_stop' }));
  });
  for (const t of opts.assistantTools ?? m.tools) content.push({ id: t.id, input: t.input, name: t.name, type: 'tool_use' });
  if (m.text !== undefined) {
    const index = m.tools.length + 1;
    lines.push(streamEvent({ content_block: { text: '', type: 'text' }, index, type: 'content_block_start' }));
    for (const piece of m.text.match(/.{1,6}/gs) ?? []) lines.push(streamEvent({ delta: { text: piece, type: 'text_delta' }, index, type: 'content_block_delta' }));
    lines.push(streamEvent({ index, type: 'content_block_stop' }));
    content.push({ text: m.text, type: 'text' });
  }
  const stop = m.tools.length > 0 ? 'tool_use' : 'end_turn';
  const usage = { cache_read_input_tokens: 158_720, input_tokens: 7_956, output_tokens: 8_112 };
  lines.push(streamEvent({ delta: { stop_reason: stop, stop_sequence: null }, type: 'message_delta', usage }));
  lines.push(streamEvent({ type: 'message_stop' }));
  if (opts.assistant === false) return lines;
  lines.push(JSON.stringify({ message: { content, id, model: 'grok-4.7', role: 'assistant', stop_reason: stop, type: 'message', usage }, type: 'assistant', ...envelope, uuid: uuid() }));
  for (const t of m.tools) {
    lines.push(JSON.stringify({ message: { content: [{ content: `{"type":"ReadFile","lines":"…"}`, tool_use_id: t.id, type: 'tool_result' }], role: 'user' }, type: 'user', ...envelope, uuid: uuid() }));
  }
  return lines;
}

export const resultLine = (reply: string): string =>
  JSON.stringify({ duration_ms: 1_747_759, is_error: false, num_turns: 23, result: reply, stop_reason: 'end_turn', subtype: 'success', type: 'result', usage: RESULT_USAGE, ...envelope, uuid: uuid() });

const call = (n: number, name: ToolCall['name'], input: Record<string, unknown>): ToolCall => ({ id: `call-${n}`, input, name });

// The review: three tool-calling messages of two calls each (six calls, like the measured run),
// the conventions read — when asked for — in the MIDDLE one, then the answer. `deltasPerMessage`
// sizes it: ~230 chars a delta, so 5 500 a message ≈ 5 M chars over four messages.
export function reviewMessages(opts: { conventionsRead: boolean; deltasPerMessage: number }): StreamMessage[] {
  const d = opts.deltasPerMessage;
  return [
    { deltas: d, tools: [call(1, 'grep', { glob: '**/*.ts', pattern: 'boundedStream' }), call(2, 'read_file', { limit: 80, offset: 1, target_file: '/wt/head/src/core/spawn.ts' })] },
    {
      deltas: d,
      tools: [
        call(3, 'read_file', opts.conventionsRead ? { limit: 200, offset: 1, target_file: CONVENTIONS_FILE } : { limit: 200, offset: 1, target_file: '/wt/head/README.md' }),
        call(4, 'list_dir', { target_directory: '/wt/head/src' }),
      ],
    },
    { deltas: d, tools: [call(5, 'grep', { path: '/wt/head/src', pattern: 'parseSeatUsage' }), call(6, 'read_file', { target_file: '/wt/head/src/modes/review/seat-usage.ts' })] },
    { deltas: d, text: '```json\n{"summary":"synthetic","findings":[]}\n```', tools: [] },
  ];
}

export function reviewStream(opts: { conventionsRead: boolean; deltasPerMessage: number }): string {
  return streamOf(reviewMessages(opts));
}

// The whole stream of these messages: init, each message's lines, the result with the last one's text.
export function streamOf(messages: StreamMessage[]): string {
  const reply = messages[messages.length - 1].text ?? '';
  return [initLine(), ...messages.flatMap((m, i) => messageLines(i, m)), resultLine(reply)].join('\n') + '\n';
}
