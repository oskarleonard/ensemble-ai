import { describe, expect, it } from 'vitest';

// Exercise the package consumers install (package.json main/exports → dist), not just the source:
// a stale or rebuilt-without-these-exports dist/ must fail here.
import * as built from '../dist/index.js';
import * as engine from './index';
import * as seatUsage from './modes/review/seat-usage';

// The library entry carries the seat telemetry a consumer composing its own seats needs
// (munin-dashboard spec 2026-10-23-review-gather-and-conventions, Phase 1): the same functions
// the review mode calls, reached through the package's public entry.
describe.each([
  ['source entry', engine],
  ['built dist entry', built],
])('the %s exports seat telemetry', (_label, entry) => {
  it('exposes the stream readers and the conventions-read fact', () => {
    expect(typeof entry.parseSeatUsage).toBe('function');
    expect(typeof entry.readDepthOf).toBe('function');
    expect(typeof entry.describeUsage).toBe('function');
    expect(typeof entry.conventionsReadOf).toBe('function');
    expect(entry.CONVENTIONS_TOUCH_NEEDLE).toBe(seatUsage.CONVENTIONS_TOUCH_NEEDLE);
    expect(entry.THIN_MIN_PART_BYTES).toBe(seatUsage.THIN_MIN_PART_BYTES);
    expect(entry.THIN_OUTPUT_TOKENS_PER_KB).toBe(seatUsage.THIN_OUTPUT_TOKENS_PER_KB);
  });

  it('answers no fact for an empty stream, through the entry', () => {
    expect(entry.conventionsReadOf('', null)).toBeUndefined();
    expect(entry.conventionsReadOf(undefined, null)).toBeUndefined();
    expect(entry.parseSeatUsage('')).toEqual({});
  });
});
