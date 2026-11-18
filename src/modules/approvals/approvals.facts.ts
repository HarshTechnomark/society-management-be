import { formatRupees } from '../../lib/money';
import type { ApprovalDescription } from './approvals.types';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ISO_DATE = /\b(\d{4})-(\d{2})-(\d{2})\b(?:T[\d:.]+Z?)?/g;

/** "2026-11-05" becomes "05 Nov 2026". */
export const humanDates = (text: string): string =>
  text.replace(ISO_DATE, (m, y: string, mo: string, d: string) => {
    const name = MONTHS[Number(mo) - 1];
    return name ? `${d} ${name} ${y}` : m;
  });

/** "MUST_CLEAR" becomes "Must clear". Other text is kept. */
export const humanEnum = (text: string): string =>
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$|^[A-Z]{3,}$/.test(text)
    ? text.charAt(0) + text.slice(1).toLowerCase().replace(/_/g, ' ')
    : text;

const rupeesOf = (text: string): string | null => {
  const paise = /^(?:₹\s*)?(\d+) paise$/.exec(text);
  if (paise) return formatRupees(Number(paise[1]));
  const rupees = /^(\d+(?:\.\d+)?) rupees$/.exec(text) ?? /^Rs\.? ?(\d+(?:\.\d+)?)$/.exec(text);
  if (rupees) return formatRupees(Math.round(Number(rupees[1]) * 100));
  return null;
};

/** Facts of a request in the words of a person: Indian-format rupees, dd Mon yyyy dates and readable codes (8.6). */
export function humanFacts(facts: ApprovalDescription['facts']): ApprovalDescription['facts'] {
  return facts.map(f => {
    let value = String(f.value);
    if (f.kind === 'money' && /^-?\d+$/.test(value)) value = formatRupees(Number(value));
    else value = rupeesOf(value) ?? humanEnum(humanDates(value));
    return { ...f, value };
  });
}
