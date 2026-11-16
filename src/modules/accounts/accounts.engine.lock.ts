import type { Transaction } from 'sequelize';
import { SocietyBalance } from '../../models';
import { now } from '../../lib/clock';
import { financialYearOf } from '../../utils/numberSequences';
import { addDaysYmd, startOfYearAfter } from './accounts.shared';

/** The lock fields of `society_balances` (BR-13-8). */
export type LockState = Pick<
  SocietyBalance,
  'booksLockedThrough' | 'unlockFromDate' | 'unlockUntil' | 'lastClosedFinancialYear'
>;

const inClosedYear = (s: LockState, date: string): boolean =>
  Boolean(s.lastClosedFinancialYear && financialYearOf(date) <= s.lastClosedFinancialYear);

const inUnlockWindow = (s: LockState, date: string): boolean =>
  Boolean(s.unlockFromDate && s.unlockUntil && s.unlockFromDate <= date && now() < s.unlockUntil);

/** BR-13-8: locked when `date ≤ booksLockedThrough` and not inside an active unlock window; any date of a closed year is locked without exception. */
export function isLocked(s: LockState, date: string): boolean {
  if (inClosedYear(s, date)) return true;
  if (s.booksLockedThrough && date <= s.booksLockedThrough) return !inUnlockWindow(s, date);
  return false;
}

/** BR-13-9: where a SYSTEM posting dated in a locked period goes: the first open date (`booksLockedThrough + 1 day`, after any closed year). */
export function firstOpenDate(s: LockState, date: string): string {
  let d = date;
  for (let i = 0; i < 4 && isLocked(s, d); i++) {
    if (inClosedYear(s, d)) d = startOfYearAfter(s.lastClosedFinancialYear!);
    else if (s.booksLockedThrough) d = addDaysYmd(s.booksLockedThrough, 1);
  }
  return d;
}

/** Section 8.20 `accounts.isDateLocked`; reads the row without locking it (module 11 and 12 use it to block back-dated documents). */
export async function isDateLocked(societyId: number, date: string, t?: Transaction): Promise<boolean> {
  const s = await SocietyBalance.findOne({
    where: { societyId },
    attributes: ['booksLockedThrough', 'unlockFromDate', 'unlockUntil', 'lastClosedFinancialYear'],
    transaction: t,
  });
  return s ? isLocked(s, date) : false;
}
