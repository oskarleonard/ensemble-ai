// The deposit picker's DISPLAY order — a presentation concern. Deliberately NOT the money
// guard in src/util/usd.ts even though the values match today: the picker may reorder or
// add entries for presentation without ever widening what the guard accepts.
export const CURRENCY_PICKER_ORDER = ['usd', 'usdc', 'usdt'];
