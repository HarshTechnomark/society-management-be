import { Resident } from '../../models';
import { residents } from '../residents/residents.public';
import type { Invoice } from '../../models';
import { addDaysYmd, periodLabelOf } from './billing.calc.period';
import type { BillingCycle } from './billing.constants';

/** Small helpers shared by reminders, the resident routes and the late fee job (sub-module 11.5). */

/** `Nov 2026` for a regular invoice (the cycle follows from the length of the period), else the description. */
export function invoicePeriodLabel(
  inv: Pick<Invoice, 'periodStart' | 'periodEnd' | 'description' | 'invoiceType'>,
): string {
  if (!inv.periodStart || !inv.periodEnd)
    return inv.description ?? (inv.invoiceType === 'OPENING' ? 'Opening balance' : 'Charges');
  const next = addDaysYmd(inv.periodEnd, 1);
  const months =
    (Number(next.slice(0, 4)) - Number(inv.periodStart.slice(0, 4))) * 12 +
    (Number(next.slice(5, 7)) - Number(inv.periodStart.slice(5, 7)));
  const cycle: BillingCycle =
    months >= 12 ? 'ANNUAL' : months >= 6 ? 'HALF_YEARLY' : months >= 3 ? 'QUARTERLY' : 'MONTHLY';
  return periodLabelOf(cycle, inv.periodStart);
}

/** Section 10 recipients of a bill: the bill-to resident's user, plus the other owners with a login for an owner invoice. */
export async function billRecipients(
  societyId: number,
  inv: Pick<Invoice, 'unitId' | 'billToResidentId' | 'billToRelation'>,
  date: string,
): Promise<number[]> {
  const ids = new Set<number>();
  const r = await Resident.findOne({
    where: { id: inv.billToResidentId, societyId },
    attributes: ['userId'],
    paranoid: false,
  });
  if (r?.userId) ids.add(r.userId);
  if (inv.billToRelation !== 'TENANT') {
    const owners = await residents.listForUnit(societyId, inv.unitId, {
      relation: ['OWNER', 'CO_OWNER'],
      date,
    });
    for (const o of owners) if (o.userId) ids.add(o.userId);
  }
  return [...ids];
}
