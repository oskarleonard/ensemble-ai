// Round half AWAY from zero — the project's display rounding.
export function roundHalfUp(value: number, decimals = 0): number {
  const factor = 10 ** decimals;
  const scaled = value * factor;
  const sign = scaled < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(scaled))) / factor;
}
