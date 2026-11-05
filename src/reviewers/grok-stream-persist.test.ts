import { describe, expect, it } from 'vitest';

import { boundedStreamHeadTail, STREAM_CUT_EVENT, STREAM_DELTAS_KEPT_EVENT } from '../core/spawn';
import { conventionsReadOf, parseSeatUsage } from '../modes/review/seat-usage';

import { GROK_STREAM_LIMIT, persistedGrokStream } from './grok';
import { initLine, messageLines, RESULT_USAGE, resultLine, reviewMessages, reviewStream } from './grok-stream.fixture';

// THE INVARIANT (2026-11-04): a grok stream of today's size — ≈4.5 M raw chars on run
// 2026-11-04-15-08-41-d8a5382a, whose 1 MB head+tail cut dropped 3 509 057 of them — is persisted
// WITHOUT a cut marker, its init at the head, and the read fact proves `read` / `index-only` /
// `unread` on it; parseSeatUsage's usage is the `result` line's, and a call counts once. Stable at
// twice that size. The streams below are synthetic, in the real line shape (grok-stream.fixture).

const layout = { indexEndLine: 33, spans: [{ endLine: 80, path: 'CLAUDE.md', startLine: 36 }, { endLine: 900, path: 'backend/CLAUDE.md', startLine: 83 }] };
const cutMarker = `"type":"${STREAM_CUT_EVENT}"`;
const keptMarker = `"type":"${STREAM_DELTAS_KEPT_EVENT}"`;
// 5 500 deltas a message × four messages ≈ 5 M chars; twice that ≈ 10 M.
const TODAY = 5_500;
const usageOfResult = {
  cachedInputTokens: RESULT_USAGE.cache_read_input_tokens,
  inputTokens: RESULT_USAGE.input_tokens + RESULT_USAGE.cache_read_input_tokens,
  outputTokens: RESULT_USAGE.output_tokens,
  toolCalls: 6,
  turns: 23,
};
const lineTypes = (s: string): string[] =>
  s.split('\n').filter(Boolean).map((l) => {
    const e = JSON.parse(l) as { event?: { type: string }; type: string };
    return e.type === 'stream_event' ? `se:${e.event!.type}` : e.type;
  });

describe('persistedGrokStream — a review of today\'s size keeps its head AND its reads', () => {
  const raw = reviewStream({ conventionsRead: true, deltasPerMessage: TODAY });
  const persisted = persistedGrokStream(raw);

  it('the raw stream is past the old 1 M bound — and that cut lost the read fact (the measured failure)', () => {
    expect(raw.length).toBeGreaterThan(5_000_000);
    const old = boundedStreamHeadTail(raw, 1_000_000);
    expect(old).toContain(cutMarker);
    expect(conventionsReadOf(old, layout)).toBeUndefined(); // the middle message's read fell in the gap
  });

  it('is persisted without a cut marker or a kept-deltas flag, init first, every non-delta line kept in order', () => {
    expect(persisted).not.toContain(cutMarker);
    expect(persisted).not.toContain(keptMarker);
    expect(persisted.startsWith(initLine().slice(0, 20))).toBe(true);
    expect(lineTypes(persisted)[0]).toBe('system');
    expect(persisted.length).toBeLessThan(raw.length / 5);
    const rawNonDelta = raw.split('\n').filter((l) => !l.includes('"type":"content_block_delta"'));
    expect(persisted.split('\n')).toEqual(rawNonDelta);
    expect(persisted.endsWith('\n')).toBe(true);
  });

  it('the read fact proves `read` with the docs reached', () => {
    expect(conventionsReadOf(persisted, layout)).toEqual({ docsRead: ['CLAUDE.md', 'backend/CLAUDE.md'], state: 'read' });
  });

  it('the same review with no conventions read proves `unread`, and a read inside the index proves `index-only`', () => {
    expect(conventionsReadOf(persistedGrokStream(reviewStream({ conventionsRead: false, deltasPerMessage: TODAY })), layout)).toEqual({ docsRead: [], state: 'unread' });
    const indexOnly = reviewStream({ conventionsRead: true, deltasPerMessage: TODAY }).replace(/"limit":200,"offset":1,"target_file":"([^"]*CONVENTIONS\.md)"/g, '"limit":30,"offset":1,"target_file":"$1"');
    expect(conventionsReadOf(persistedGrokStream(indexOnly), layout)).toEqual({ docsRead: [], state: 'index-only' });
  });

  it("parseSeatUsage reports the result line's usage, and each of the six calls once (not 12) — raw or persisted", () => {
    expect(parseSeatUsage(persisted)).toEqual(usageOfResult);
    expect(parseSeatUsage(raw)).toEqual(usageOfResult);
  });

  it('is stable at twice today\'s size: still whole, still `read`, still the result\'s usage', () => {
    const big = reviewStream({ conventionsRead: true, deltasPerMessage: TODAY * 2 });
    expect(big.length).toBeGreaterThan(10_000_000);
    const out = persistedGrokStream(big);
    expect(out).not.toContain(cutMarker);
    expect(out.length).toBeLessThan(GROK_STREAM_LIMIT);
    expect(conventionsReadOf(out, layout)).toEqual({ docsRead: ['CLAUDE.md', 'backend/CLAUDE.md'], state: 'read' });
    expect(parseSeatUsage(out)).toEqual(usageOfResult);
  });
});

describe('persistedGrokStream — every doubt keeps the deltas and flags the stream', () => {
  it('a stream killed mid-turn keeps its unfinished message\'s deltas (and its partial last line), and stays factless', () => {
    const [m0, m1] = reviewMessages({ conventionsRead: false, deltasPerMessage: 400 });
    const unfinished = messageLines(1, m1, { assistant: false }).slice(0, 250); // cut mid-thinking
    const raw = [initLine(), ...messageLines(0, m0), ...unfinished, '{"type":"stream_event","event":{"type":"content_blo'].join('\n');
    const out = persistedGrokStream(raw);
    // message 0 was delivered: its deltas are gone; message 1's are all still there
    expect(out.split('\n').filter((l) => l.includes('weighing 0.')).length).toBe(1); // only its assistant line
    expect(out.split('\n').filter((l) => l.includes('"thinking_delta"') && l.includes('weighing 1.')).length).toBe(248);
    expect(out).toContain('"type":"stream_event","event":{"type":"content_blo'); // the partial line, verbatim
    const flag = JSON.parse(out.split('\n').find((l) => l.includes(keptMarker))!) as { messages: { deltas: number; id: string }[] };
    expect(flag.messages).toEqual([{ deltas: 248, id: 'msg_1', why: 'no assistant line (the stream ended mid-message)' }]);
    // Whole by every other measure (init first, no cut) — today's reader would have said `unread`.
    expect(out).not.toContain(cutMarker);
    expect(conventionsReadOf(out, layout)).toBeUndefined();
  });

  it('a killed stream still PROVES a read that was delivered before the kill', () => {
    const [m0, m1, m2] = reviewMessages({ conventionsRead: true, deltasPerMessage: 50 });
    const raw = [initLine(), ...messageLines(0, m0), ...messageLines(1, m1), ...messageLines(2, m2, { assistant: false }).slice(0, 20)].join('\n');
    expect(conventionsReadOf(persistedGrokStream(raw), layout)).toEqual({ docsRead: ['CLAUDE.md', 'backend/CLAUDE.md'], state: 'read' });
  });

  it('a content_block_start tool_use its assistant line does not carry keeps that message\'s deltas and flags', () => {
    const msgs = reviewMessages({ conventionsRead: false, deltasPerMessage: 30 });
    const lines = [initLine(), ...messageLines(0, msgs[0]), ...messageLines(1, msgs[1], { assistantTools: [msgs[1].tools[1]] }), ...messageLines(2, msgs[2]), ...messageLines(3, msgs[3]), resultLine('ok')];
    const out = persistedGrokStream(lines.join('\n'));
    const flag = JSON.parse(out.split('\n').find((l) => l.includes(keptMarker))!) as { messages: { id: string; why: string }[] };
    expect(flag.messages).toEqual([{ deltas: 33, id: 'msg_1', why: 'a content_block_start tool_use its assistant line does not carry' }]);
    expect(out.split('\n').filter((l) => l.includes('"input_json_delta"'))).toHaveLength(2); // msg_1's two, kept
    expect(out.split('\n').filter((l) => l.includes('"thinking_delta"') && !l.includes('weighing 1.'))).toHaveLength(0);
    // the call only its deltas carry may have been the read: no absence claim
    expect(conventionsReadOf(out, layout)).toBeUndefined();
    // and it is still counted once, off its content_block_start
    expect(parseSeatUsage(out).toolCalls).toBe(6);
  });
});
