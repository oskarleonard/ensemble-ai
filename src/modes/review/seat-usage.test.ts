import { describe, expect, it } from 'vitest';

import { conventionsReadOf, describeUsage, parseSeatUsage, readDepthOf } from './seat-usage';

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
    // Tool calls survive as a FLOOR, flagged; tokens come from the result event regardless.
    expect(parseSeatUsage(grokTailOnly)).toEqual({ cachedInputTokens: 3160832, inputTokens: 3340216, outputTokens: 13591, streamTruncated: true, toolCalls: 2, turns: 45 });
    // The same totals with the head intact: a real count, no flag.
    expect(parseSeatUsage([grokInit, grokTailOnly].join('\n'))).toEqual({ cachedInputTokens: 3160832, inputTokens: 3340216, outputTokens: 13591, toolCalls: 2, turns: 45 });
  });
  it('a codex tail that lost thread.started reports its tool calls as a floor', () => {
    const headless = codexStream.split('\n').slice(1).join('\n');
    expect(parseSeatUsage(headless)).toEqual({ cachedInputTokens: 4123520, inputTokens: 4546368, outputTokens: 8813, streamTruncated: true, toolCalls: 2, turns: 1 });
  });
  it('a claude-shaped tail starting on a per-turn system event is NOT an intact head (run d5a1f648 part 1); a cut marker flags a head+tail stream', () => {
    const perTurn = [JSON.stringify({ subtype: 'thinking_tokens', type: 'system' }), ...grokBody, JSON.stringify({ subtype: 'success', type: 'result', num_turns: 3 })].join('\n');
    expect(parseSeatUsage(perTurn).streamTruncated).toBe(true);
    const cut = [grokInit, JSON.stringify({ droppedChars: 5000, type: 'ensemble.stream_cut' }), ...grokBody, JSON.stringify({ subtype: 'success', type: 'result', num_turns: 3 })].join('\n');
    expect(parseSeatUsage(cut)).toMatchObject({ streamTruncated: true, toolCalls: 2 });
  });
  it("a SessionStart hook's events before init are the head, not a lost one; a mid-session hook first still is (munin-dashboard#323, 2026-10-27)", () => {
    const hook = (subtype: string, hook_event: string) => JSON.stringify({ hook_event, hook_id: 'h', hook_name: `${hook_event}:x`, subtype, type: 'system' });
    const hooked = [hook('hook_started', 'SessionStart'), hook('hook_response', 'SessionStart'), grokInit, ...grokBody, JSON.stringify({ subtype: 'success', type: 'result', num_turns: 3 })].join('\n');
    expect(parseSeatUsage(hooked).streamTruncated).toBeUndefined();
    // a slow hook's `hook_progress` between started and response is the same hook (claude CLI 2.1.317)
    const slow = [hook('hook_started', 'SessionStart'), hook('hook_progress', 'SessionStart'), hook('hook_progress', 'SessionStart'), hook('hook_response', 'SessionStart'), grokInit, ...grokBody, JSON.stringify({ subtype: 'success', type: 'result', num_turns: 3 })].join('\n');
    expect(parseSeatUsage(slow).streamTruncated).toBeUndefined();
    const midSession = [hook('hook_started', 'PreToolUse'), ...grokBody, JSON.stringify({ subtype: 'success', type: 'result', num_turns: 3 })].join('\n');
    expect(parseSeatUsage(midSession).streamTruncated).toBe(true);
    const midProgress = [hook('hook_progress', 'PreToolUse'), ...grokBody, JSON.stringify({ subtype: 'success', type: 'result', num_turns: 3 })].join('\n');
    expect(parseSeatUsage(midProgress).streamTruncated).toBe(true);
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
  it('a worktree seat that opened nothing on a large part is thin even with many tokens — unless the zero is a truncated floor', () => {
    expect(readDepthOf({ outputTokens: 9000, toolCalls: 0 }, 300_000, true)).toBe('thin');
    expect(readDepthOf({ outputTokens: 9000, streamTruncated: true, toolCalls: 0 }, 300_000, true)).toBe('ok');
    expect(readDepthOf({ outputTokens: 9000, toolCalls: 0 }, 300_000, false)).toBe('ok'); // a packet seat has nothing to open
  });
  it('no usage ⇒ unmeasured', () => {
    expect(readDepthOf({}, 499_000, true)).toBe('unmeasured');
  });
  it('describeUsage reads like a line in a log', () => {
    expect(describeUsage({ cachedInputTokens: 4123520, inputTokens: 4546368, outputTokens: 8813, toolCalls: 2 })).toBe('8,813 out · 4,546,368 in (91% cached) · 2 tool calls');
    expect(describeUsage({})).toBe('no usage recorded');
    expect(describeUsage({ outputTokens: 10, streamTruncated: true, toolCalls: 3 })).toBe('10 out · 3 tool calls · stream truncated — tool-call counts are floors');
  });
});

describe('conventionsReadOf — how far a seat read into the conventions file (named, never guessed)', () => {
  const init = JSON.stringify({ subtype: 'init', type: 'system' });
  const layout = { indexEndLine: 33, spans: [{ endLine: 80, path: 'CLAUDE.md', startLine: 36 }, { endLine: 900, path: 'backend/CLAUDE.md', startLine: 83 }] };
  const F = '/wt/.ensemble-conventions/CONVENTIONS.md';
  // A codex command is two events: started, then completed with the exit code. `ran` is the
  // default; `exit` overrides it; `null` leaves the command never completed (seat reclaimed).
  const cmd = (command: string, i: number, exit: number | null = 0): string[] => {
    const id = `item_${i}`;
    const started = JSON.stringify({ item: { command, id, type: 'command_execution' }, type: 'item.started' });
    if (exit === null) return [started];
    return [started, JSON.stringify({ item: { aggregated_output: 'x', command, exit_code: exit, id, status: exit === 0 ? 'completed' : 'failed', type: 'command_execution' }, type: 'item.completed' })];
  };
  const codex = (...cmds: string[]) => [JSON.stringify({ type: 'thread.started' }), ...cmds.flatMap((c, i) => cmd(c, i))].join('\n');
  const claude = (...events: string[]) => [init, ...events].join('\n');
  const read = (id: string, input: Record<string, unknown>) => JSON.stringify({ message: { content: [{ id, input, name: 'Read', type: 'tool_use' }] }, type: 'assistant' });
  const result = (id: string, isError: boolean) => JSON.stringify({ message: { content: [{ content: isError ? 'File content (344.4KB) exceeds maximum allowed size' : 'ok', is_error: isError, tool_use_id: id, type: 'tool_result' }] }, type: 'user' });

  it('codex: the index alone is index-only; a range into a doc is read with that doc named; cat is everything', () => {
    expect(conventionsReadOf(codex("/bin/zsh -lc \"sed -n '1,30p' .ensemble-conventions/CONVENTIONS.md\""), layout)).toEqual({ docsRead: [], state: 'index-only' });
    expect(conventionsReadOf(codex("/bin/zsh -lc \"sed -n '1,180p' .ensemble-conventions/CONVENTIONS.md\"", "/bin/zsh -lc \"sed -n '570,1084p' .ensemble-conventions/CONVENTIONS.md\""), layout)).toEqual({ docsRead: ['CLAUDE.md', 'backend/CLAUDE.md'], state: 'read' });
    expect(conventionsReadOf(codex("/bin/zsh -lc 'cat .ensemble-conventions/CONVENTIONS.md'"), layout)).toEqual({ docsRead: ['CLAUDE.md', 'backend/CLAUDE.md'], state: 'read' });
    expect(conventionsReadOf(codex("/bin/zsh -lc 'rg -n \"bun\" .ensemble-conventions/CONVENTIONS.md'"), layout)).toEqual({ docsRead: [], state: 'read' });
  });
  it('codex: a read counts only when its item.completed says it RAN — a failed command read nothing, a never-completed one is attempted and bars "unread"', () => {
    const start = JSON.stringify({ type: 'thread.started' });
    const sed80 = "/bin/zsh -lc \"sed -n '1,80p' .ensemble-conventions/CONVENTIONS.md\"";
    // failed (exit 1): dropped — with nothing else on the file the whole stream says unread
    expect(conventionsReadOf([start, ...cmd(sed80, 1, 1)].join('\n'), layout)).toEqual({ docsRead: [], state: 'unread' });
    // never completed: attempted — proves nothing, and the stream can no longer claim unread or index-only
    expect(conventionsReadOf([start, ...cmd(sed80, 1, null)].join('\n'), layout)).toBeUndefined();
    expect(conventionsReadOf([start, ...cmd("sed -n '1,30p' .ensemble-conventions/CONVENTIONS.md", 1), ...cmd(sed80, 2, null)].join('\n'), layout)).toBeUndefined();
    // a proven read beside an attempted one is still a read (the proof survived)
    expect(conventionsReadOf([start, ...cmd(sed80, 1), ...cmd("cat .ensemble-conventions/CONVENTIONS.md", 2, null)].join('\n'), layout)).toEqual({ docsRead: ['CLAUDE.md'], state: 'read' });
    // a completed event whose started twin fell in a cut still proves the read
    const cut = JSON.stringify({ droppedChars: 9000, type: 'ensemble.stream_cut' });
    expect(conventionsReadOf([start, cut, cmd(sed80, 1)[1]].join('\n'), layout)).toEqual({ docsRead: ['CLAUDE.md'], state: 'read' });
  });
  it('claude-shaped: a bare Read that ERRORED on size is dropped; 80 lines reaches the root rules; a Grep of the file is a read', () => {
    expect(conventionsReadOf(claude(read('t1', { file_path: F }), result('t1', true)), layout)).toEqual({ docsRead: [], state: 'unread' });
    expect(conventionsReadOf(claude(read('t1', { file_path: F }), result('t1', true), read('t2', { file_path: F, limit: 80 }), result('t2', false)), layout)).toEqual({ docsRead: ['CLAUDE.md'], state: 'read' });
    expect(conventionsReadOf(claude(read('t1', { file_path: F, limit: 30 }), result('t1', false)), layout)).toEqual({ docsRead: [], state: 'index-only' });
    const grep = JSON.stringify({ message: { content: [{ id: 'g1', input: { path: F, pattern: 'bun' }, name: 'Grep', type: 'tool_use' }] }, type: 'assistant' });
    expect(conventionsReadOf(claude(grep), layout)).toEqual({ docsRead: [], state: 'read' });
  });
  it("a SessionStart hook before init keeps the head whole: no call on the file is unread, not a lost head (anthropic seats, munin-dashboard#323 rounds 3/4/8)", () => {
    const hook = (subtype: string) => JSON.stringify({ hook_event: 'SessionStart', hook_id: 'h', hook_name: 'SessionStart:startup', subtype, type: 'system' });
    const hooked = (...events: string[]) => [hook('hook_started'), hook('hook_response'), init, ...events].join('\n');
    expect(conventionsReadOf(hooked(read('t1', { file_path: '/wt/src/x.ts' })), layout)).toEqual({ docsRead: [], state: 'unread' });
    expect(conventionsReadOf(hooked(read('t1', { file_path: F, limit: 30 }), result('t1', false)), layout)).toEqual({ docsRead: [], state: 'index-only' });
    // a slow SessionStart hook prints `hook_progress` between started and response: still the head
    const slow = (...events: string[]) => [hook('hook_started'), hook('hook_progress'), hook('hook_response'), init, ...events].join('\n');
    expect(conventionsReadOf(slow(read('t1', { file_path: '/wt/src/x.ts' })), layout)).toEqual({ docsRead: [], state: 'unread' });
    // the hook alone, no init after it: still not a head
    expect(conventionsReadOf([hook('hook_started'), read('t1', { file_path: '/wt/src/x.ts' })].join('\n'), layout)).toBeUndefined();
  });
  it("grok-shaped: read_file's `target_file` is the read (the xai seat's every read, munin-dashboard#323); grep keeps `path`", () => {
    const readFile = (id: string, target_file: string) => JSON.stringify({ message: { content: [{ id, input: { target_file }, name: 'read_file', type: 'tool_use' }] }, type: 'assistant' });
    expect(conventionsReadOf(claude(readFile('r1', F)), layout)).toEqual({ docsRead: ['CLAUDE.md', 'backend/CLAUDE.md'], state: 'read' });
    expect(conventionsReadOf(claude(readFile('r1', '/wt/src/x.ts')), layout)).toEqual({ docsRead: [], state: 'unread' });
    const cut = JSON.stringify({ droppedChars: 2_885_307, type: 'ensemble.stream_cut' });
    expect(conventionsReadOf(claude(readFile('r1', F), cut), layout)).toEqual({ docsRead: ['CLAUDE.md', 'backend/CLAUDE.md'], state: 'read' });
  });
  it("grok's read_file returns at most 1000 lines — with no limit and with a larger one — so a doc past line 1000 is never credited to it; claude's Read keeps its 2000 (live, grok 1.0.70, 2026-11-03)", () => {
    const long = { indexEndLine: 33, spans: [...layout.spans, { endLine: 1200, path: 'web/AGENTS.md', startLine: 1001 }] };
    const grokRead = (id: string, input: Record<string, unknown>) => JSON.stringify({ message: { content: [{ id, input: { target_file: F, ...input }, name: 'read_file', type: 'tool_use' }] }, type: 'assistant' });
    const firstTwo = { docsRead: ['CLAUDE.md', 'backend/CLAUDE.md'], state: 'read' };
    expect(conventionsReadOf(claude(grokRead('r1', {})), long)).toEqual(firstTwo);
    expect(conventionsReadOf(claude(grokRead('r1', { limit: 1400, offset: 1 })), long)).toEqual(firstTwo);
    expect(conventionsReadOf(claude(grokRead('r1', { offset: 1001 })), long)).toEqual({ docsRead: ['web/AGENTS.md'], state: 'read' });
    expect(conventionsReadOf(claude(read('t1', { file_path: F }), result('t1', false)), long)).toEqual({ docsRead: ['CLAUDE.md', 'backend/CLAUDE.md', 'web/AGENTS.md'], state: 'read' });
    expect(conventionsReadOf(claude(read('t1', { file_path: F, limit: 1400 }), result('t1', false)), long)).toEqual({ docsRead: ['CLAUDE.md', 'backend/CLAUDE.md', 'web/AGENTS.md'], state: 'read' });
  });
  it('a whole stream with no call on the file is unread; a tool RESULT mentioning the path does not count', () => {
    expect(conventionsReadOf(claude(read('t1', { file_path: '/wt/src/x.ts' })), layout)).toEqual({ docsRead: [], state: 'unread' });
    expect(conventionsReadOf(claude(JSON.stringify({ message: { content: [{ content: `see ${F}`, tool_use_id: 'x', type: 'tool_result' }] }, type: 'user' })), layout)).toEqual({ docsRead: [], state: 'unread' });
  });
  it('a CUT stream (head + marker + tail) can prove a read, never an unread or an index-only — the call may be in the gap', () => {
    const cut = JSON.stringify({ droppedChars: 50_000, type: 'ensemble.stream_cut' });
    expect(conventionsReadOf(claude(cut, read('t1', { file_path: '/wt/src/x.ts' })), layout)).toBeUndefined();
    expect(conventionsReadOf(claude(cut, read('t1', { file_path: F, limit: 30 }), result('t1', false)), layout)).toBeUndefined();
    expect(conventionsReadOf(claude(cut, read('t1', { file_path: F, limit: 80 }), result('t1', false)), layout)).toEqual({ docsRead: ['CLAUDE.md'], state: 'read' });
    expect(conventionsReadOf([JSON.stringify({ type: 'thread.started' }), cut, JSON.stringify({ item: { command: "sed -n '1,30p' .ensemble-conventions/CONVENTIONS.md", type: 'command_execution' }, type: 'item.started' })].join('\n'), layout)).toBeUndefined();
  });
  it('no layout (file unreadable after the fact) ⇒ read vs unread only; a headless stream cannot say no', () => {
    expect(conventionsReadOf(claude(read('t1', { file_path: F, limit: 30 })), null)).toEqual({ docsRead: [], state: 'read' });
    expect(conventionsReadOf(read('t1', { file_path: '/wt/src/x.ts' }), layout)).toBeUndefined();
    expect(conventionsReadOf('', layout)).toBeUndefined();
  });
});
