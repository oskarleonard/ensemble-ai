import { describe, expect, it } from 'vitest';

import * as engine from '../../index';
import { attemptFailureWhy, CODEX_STDIN_BANNER } from './seat-run';

// WHY a failed attempt produced no usable review — one derivation for the CLI's fallback reason,
// its failed-seat summary and a consumer composing its own seats (munin-dashboard#315 ruling
// 2214da65).
describe('attemptFailureWhy', () => {
  it('names the adapter failWhy first, and treats a blank one as absent', () => {
    expect(attemptFailureWhy({ failWhy: 'codex: API error 400', raw: null, stderrTail: 'x' })).toBe('codex: API error 400');
    expect(attemptFailureWhy({ failWhy: '   ', raw: null, stderrTail: 'grok sandbox refused' })).toBe('grok sandbox refused');
    expect(attemptFailureWhy({ failWhy: '', raw: null, stderrTail: '' })).toBe('no output');
  });

  it("never names codex's stdin banner as the cause, but keeps what follows it", () => {
    expect(attemptFailureWhy({ raw: 'not json', stderrTail: `${CODEX_STDIN_BANNER}\n` })).toBe(
      'the reply did not parse as a review'
    );
    expect(attemptFailureWhy({ raw: null, stderrTail: CODEX_STDIN_BANNER })).toBe('no output');
    expect(
      attemptFailureWhy({ raw: null, stderrTail: `${CODEX_STDIN_BANNER}\nERROR rmcp::transport: closed` })
    ).toBe('ERROR rmcp::transport: closed');
  });

  it('names a grok sandbox refusal from its stderr, and caps every reason at 300', () => {
    expect(attemptFailureWhy({ raw: null, stderrTail: 'grok sandbox refused: the profile is missing' })).toBe(
      'grok sandbox refused: the profile is missing'
    );
    expect(attemptFailureWhy({ failWhy: 'x'.repeat(900), raw: null, stderrTail: '' })).toHaveLength(300);
    expect(attemptFailureWhy({ raw: null, stderrTail: 'y'.repeat(900) })).toHaveLength(300);
  });

  it('is reachable through the library entry', () => {
    expect(engine.attemptFailureWhy).toBe(attemptFailureWhy);
    expect(engine.CODEX_STDIN_BANNER).toBe('Reading additional input from stdin...');
  });
});
