import { QueryTypes, type Transaction } from 'sequelize';
import { ChargeHead, sequelize } from '../../models';
import { setResidentPorts } from '../residents/residents.public';
import { onboarding, units } from '../society-setup/society-setup.public';
import { unitLedger } from './billing.ledger.service';

/**
 * Registrations of sub-module 11.2 (section 5.13 and 9.2), called by `registerBilling()`: the real `unitLedger.balance`
 * for module 09's `duesPaise`, the module 08 `BILLING` onboarding check and the `UNIT_HAS_BALANCE` unit guard.
 */

/** Section 5.13: done when an `ACTIVE` charge head and an `ACTIVE` billing rule with an `APPROVED` version exist. */
export async function billingCheck(societyId: number): Promise<{ done: boolean; summary: string }> {
  const heads = await ChargeHead.count({ where: { societyId, status: 'ACTIVE' } });
  const [row] = await sequelize.query<{ n: number | string }>(
    `SELECT COUNT(*) AS n FROM billing_rules r
      WHERE r.societyId = :societyId AND r.status = 'ACTIVE'
        AND EXISTS (SELECT 1 FROM billing_rule_versions v WHERE v.billingRuleId = r.id AND v.status = 'APPROVED')`,
    { replacements: { societyId }, type: QueryTypes.SELECT },
  );
  const approved = Number(row?.n ?? 0);
  return {
    done: heads > 0 && approved > 0,
    summary:
      approved > 0
        ? `${approved} billing rule${approved === 1 ? '' : 's'} approved`
        : 'No approved billing rule yet',
  };
}

/** Section 5.13: the flat has a balance, or a `READY` item in a run that is not `ISSUED`, `CANCELLED` or `FAILED`. */
export async function billingUnitGuard(
  societyId: number,
  unitId: number,
  _action: 'ARCHIVE' | 'DELETE',
  t: Transaction,
): Promise<string | null> {
  if ((await unitLedger.balance(societyId, unitId, t)) !== 0) return 'UNIT_HAS_BALANCE';
  const [open] = await sequelize.query<{ id: number }>(
    `SELECT i.id FROM billing_run_items i JOIN billing_runs r ON r.id = i.billingRunId
      WHERE i.societyId = :societyId AND i.unitId = :unitId AND i.status = 'READY'
        AND r.status NOT IN ('ISSUED', 'CANCELLED', 'FAILED') LIMIT 1`,
    { replacements: { societyId, unitId }, type: QueryTypes.SELECT, transaction: t },
  );
  return open ? 'UNIT_HAS_BALANCE' : null;
}

export function registerLedgerHooks(): void {
  setResidentPorts({ unitLedger: { balance: (societyId, unitId) => unitLedger.balance(societyId, unitId) } });
  onboarding.registerCheck('BILLING', 'billing', billingCheck);
  units.registerUnitGuard({ module: 'billing', check: billingUnitGuard });
}
