// NEAR-MISS #2 — the same SHAPE as `roundHalfUp` (src/util/round.ts) with a different rule:
// banker's rounding (half-to-even), which the financial report needs so accumulated rounding
// does not bias upward. Swapping in the util would change every reported total. MUST NOT flag.
export function roundHalfEven(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  if (diff !== 0.5) return Math.round(scaled) / factor;
  return (floor % 2 === 0 ? floor : floor + 1) / factor;
}
