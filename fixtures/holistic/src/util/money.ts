// The ONE currency formatter in this project. Every surface renders money through it.
export function formatCents(cents: number, currency = 'USD'): string {
  const sign = cents < 0 ? '-' : '';
  const whole = Math.trunc(Math.abs(cents) / 100);
  const fraction = Math.abs(cents % 100);
  return `${sign}${whole}.${String(fraction).padStart(2, '0')} ${currency}`;
}
