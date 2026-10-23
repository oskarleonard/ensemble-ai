import { describe, expect, it } from 'vitest';

import * as engine from './index';

// The library entry carries the seat telemetry a consumer composing its own seats needs
// (munin-dashboard spec 2026-10-23-review-gather-and-conventions, Phase 1): the same functions
// the review mode calls, reached through the package's public entry.
describe('the library entry exports seat telemetry', () => {
  it('exposes the stream readers and the conventions-read fact', () => {
    expect(typeof engine.parseSeatUsage).toBe('function');
    expect(typeof engine.readDepthOf).toBe('function');
    expect(typeof engine.describeUsage).toBe('function');
    expect(typeof engine.conventionsReadOf).toBe('function');
    expect(engine.CONVENTIONS_TOUCH_NEEDLE).toBe('.ensemble-conventions');
  });

  it('answers no fact for an empty stream, through the entry', () => {
    expect(engine.conventionsReadOf('', null)).toBeUndefined();
    expect(engine.conventionsReadOf(undefined, null)).toBeUndefined();
  });
});
