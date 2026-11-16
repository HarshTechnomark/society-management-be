import { addDaysYmd } from '../billing/billing.calc.period';

/** First and last day of `YYYY-MM`. */
export function monthBoundsOf(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
  return { from: `${month}-01`, to: addDaysYmd(next, -1) };
}
