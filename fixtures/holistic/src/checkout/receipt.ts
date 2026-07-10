// PLANTED POSITIVE #1 — `centsToDisplay` reinvents `formatCents` (src/util/money.ts), which
// AGENTS.md §Money mandates. The lens MUST catch this; nothing in the diff of this file points
// at the util, so only whole-tree context can see it.
export function centsToDisplay(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const fraction = Math.abs(cents % 100);
  return `${whole}.${String(fraction).padStart(2, '0')} USD`;
}

export interface ReceiptLine {
  amountCents: number;
  label: string;
}

export function renderReceipt(lines: ReceiptLine[]): string {
  return lines
    .map((line) => `${line.label}: ${centsToDisplay(line.amountCents)}`)
    .join('\n');
}
