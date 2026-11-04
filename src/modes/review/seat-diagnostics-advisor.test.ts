import { describe, expect, it } from 'vitest';

import { STREAM_CUT_EVENT } from '../../core/spawn';
import type { CodexReviewResult } from '../../reviewers/codex';

import { advisorViolationLine, seatDiagnostics } from './seat-run';

const advisorLine = JSON.stringify({ message: { content: [{ id: 'srvtoolu_1', input: {}, name: 'advisor', type: 'server_tool_use' }], role: 'assistant' }, type: 'assistant' });
const result = (stream: string | null): CodexReviewResult => ({ raw: '{}', stderrTail: '', stream, timedOut: false }) as unknown as CodexReviewResult;
const timing = { endedAt: 2_000, startedAt: 1_000 };

describe('seatDiagnostics — the advisor half: stated vs observed', () => {
  it('a kept promise: configured off, no calls', () => {
    const d = seatDiagnostics(result(''), timing, { advisor: 'off' });
    expect(d.advisor).toEqual({ calls: 0, configured: 'off' });
    expect(advisorViolationLine('gate', d)).toBeNull();
  });
  it('a broken kill switch is a violation, said loudly', () => {
    const d = seatDiagnostics(result(advisorLine), timing, { advisor: 'off' });
    expect(d.advisor).toEqual({ calls: 1, configured: 'off', violation: true });
    expect(advisorViolationLine('claude', d)).toMatch(/^ {2}· claude: ⚠ advisor configured off, yet the stream shows 1 advisor call\(s\)/);
  });
  it('an inherited advisor that was called is recorded, not a violation — nobody promised off', () => {
    const d = seatDiagnostics(result(advisorLine), timing, { advisor: 'inherit' });
    expect(d.advisor).toEqual({ calls: 1, configured: 'inherit' });
    expect(advisorViolationLine('holistic', d)).toBeNull();
  });
  it('a cut stream makes zero calls a floor, never a kept promise', () => {
    const cut = JSON.stringify({ type: STREAM_CUT_EVENT });
    const d = seatDiagnostics(result(cut), timing, { advisor: 'off' });
    expect(d.advisor).toEqual({ calls: 0, configured: 'off', streamTruncated: true });
    const d2 = seatDiagnostics(result([advisorLine, cut].join('\n')), timing, { advisor: 'off' });
    expect(d2.advisor).toEqual({ calls: 1, configured: 'off', streamTruncated: true, violation: true });
  });
  it('a seat that is not a Claude spawn writes no field', () => {
    expect(seatDiagnostics(result(advisorLine), timing, {}).advisor).toBeUndefined();
  });
});
