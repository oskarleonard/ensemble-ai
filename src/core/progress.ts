// Every progress line a mode emits carries a wall-clock stamp and the time elapsed
// since the process started, so a run log answers "how long did each round take,
// and which seat was the long pole" on its own — without inferring phase times
// from result-file mtimes (hugin doc-review 2026-10-11: 46 vs 58 min, no way to
// see from the log that one seat's lower effort was the whole difference).
//
// The stamp is a SUFFIX. Consumers that anchor on the start of a line (the
// dashboard's `^Round 3 · synthesis` text fallback, `^===== `) keep matching.
export function stampProgress(
  write: (line: string) => void,
  now: () => number = Date.now
): (m: string) => void {
  const t0 = now();
  return (m) => write(`· ${m}  [${progressStamp(now(), t0)}]`);
}

/** `HH:MM:SSZ +Mm SSs` — UTC clock, then elapsed since `t0`. */
export function progressStamp(at: number, t0: number): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}Z +${formatElapsed(at - t0)}`;
}

/** `0m05s`, `12m17s`, `1h03m` — short enough to sit at the end of every line. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
  return `${m}m${String(s % 60).padStart(2, '0')}s`;
}
