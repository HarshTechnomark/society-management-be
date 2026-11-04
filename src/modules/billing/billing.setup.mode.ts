import type { Transaction } from 'sequelize';
import { BillingRun } from '../../models';

/**
 * BR-11-21 setup mode: until the first regular run of the society reaches `ISSUED`, new rule versions and late fee policies
 * are approved immediately on creation. `lastIssuedPeriodEnd` is the `periodEnd` of the latest `ISSUED` regular run (BR-11-20).
 */
export async function lastIssuedPeriodEnd(societyId: number, t?: Transaction): Promise<string | null> {
  const r = await BillingRun.findOne({
    where: { societyId, runType: 'REGULAR', status: 'ISSUED' },
    order: [['periodEnd', 'DESC']],
    attributes: ['periodEnd'],
    transaction: t,
  });
  return r ? r.periodEnd : null;
}
export async function isSetupMode(societyId: number, t?: Transaction): Promise<boolean> {
  return (await lastIssuedPeriodEnd(societyId, t)) === null;
}
