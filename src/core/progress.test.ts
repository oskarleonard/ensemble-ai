import { describe, expect, it } from 'vitest';

import { formatElapsed, progressStamp, stampProgress } from './progress';

describe('progress stamps', () => {
  it('formats elapsed time compactly, rolling to hours past 60 minutes', () => {
    expect(formatElapsed(0)).toBe('0m00s');
    expect(formatElapsed(5_400)).toBe('0m05s');
    expect(formatElapsed(12 * 60_000 + 17_000)).toBe('12m17s');
    expect(formatElapsed(63 * 60_000 + 10_000)).toBe('1h03m');
    expect(formatElapsed(-2_000)).toBe('0m00s');
  });

  it('stamps every line with the UTC clock and the elapsed time since the logger was made', () => {
    const t0 = Date.UTC(2026, 9, 11, 17, 58, 17);
    let now = t0;
    const lines: string[] = [];
    const log = stampProgress((l) => lines.push(l), () => now);
    log('Round 1 · independent ideation — 3 voice(s)');
    now = t0 + 12 * 60_000 + 40_000;
    log('  · grok: 5 idea(s)');
    expect(lines).toEqual([
      '· Round 1 · independent ideation — 3 voice(s)  [17:58:17Z +0m00s]',
      '·   · grok: 5 idea(s)  [18:10:57Z +12m40s]',
    ]);
  });

  it('keeps the stamp as a suffix so line-start anchors still match', () => {
    const line = `· Round 3 · synthesis  [${progressStamp(Date.UTC(2026, 9, 11, 18, 19, 49), Date.UTC(2026, 9, 11, 17, 58, 17))}]`;
    expect(line.replace(/^· /, '')).toMatch(/^Round 3 · synthesis/);
    expect(line).toContain('[18:19:49Z +21m32s]');
  });
});
