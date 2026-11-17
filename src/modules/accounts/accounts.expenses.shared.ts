import { Transaction as SequelizeTransaction } from 'sequelize';
import { Expense, LedgerAccount, sequelize } from '../../models';
import { emitToRoom } from '../../lib/realtime';
import { audit } from '../../utils/audit';
import { settings } from '../society-setup/society-setup.public';
import type { Ctx } from '../../types/context';
import { RT, SETTING_DEFAULTS, roomFinance } from './accounts.constants';
import { n } from './accounts.shared';
import type { Transaction } from './accounts.types';

/** A context that carries the society (the module 14 approver's context or a job's system context may not). */
export function withSociety(ctx: Ctx, societyId: number): Ctx {
  if (ctx.society?.id === societyId) return ctx;
  return {
    ...ctx,
    society: { id: societyId, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
  };
}

/** Money flows run at READ COMMITTED (README): the locking reads of the books then never take gap locks. */
export const moneyTx = <T>(fn: (t: Transaction) => Promise<T>): Promise<T> =>
  sequelize.transaction({ isolationLevel: SequelizeTransaction.ISOLATION_LEVELS.READ_COMMITTED }, fn);

type FinanceKey =
  'finance.expenseBackdateDays' | 'finance.billRequiredAbovePaise' | 'finance.gstInputClaimable';
/** Section 5 setting with the spec default when the registry has no value. */
export async function setting<K extends FinanceKey>(
  societyId: number,
  key: K,
): Promise<(typeof SETTING_DEFAULTS)[K]> {
  try {
    return (await settings.get(societyId, key as never)) as never;
  } catch {
    return SETTING_DEFAULTS[key];
  }
}

export const displayId = (id: number): string => `EXP-${id}`;

export const expenseToAudit = (e: Expense) => ({
  id: n(e.id),
  status: e.status,
  expenseType: e.expenseType,
  expenseDate: e.expenseDate,
  payee: e.payee,
  ledgerAccountId: n(e.ledgerAccountId),
  grossAmountPaise: n(e.grossAmountPaise),
  gstPaise: n(e.gstPaise),
  tdsPaise: n(e.tdsPaise),
  tdsSection: e.tdsSection,
  netPaidPaise: n(e.netPaidPaise),
  paidFromLedgerAccountId: n(e.paidFromLedgerAccountId),
  paymentMode: e.paymentMode,
  paymentReference: e.paymentReference,
  fundId: e.fundId ? n(e.fundId) : null,
  collectionId: e.collectionId ? n(e.collectionId) : null,
  vendorId: e.vendorId ? n(e.vendorId) : null,
  vendorBillId: e.vendorBillId ? n(e.vendorBillId) : null,
  billFileCount: n(e.billFileCount),
  voucherNo: e.voucherNo,
  version: n(e.version),
});

export const auditExpense = (
  ctx: Ctx,
  action: string,
  e: Expense,
  before: unknown,
  t: Transaction,
  reason?: string | null,
  extra: Record<string, unknown> = {},
) =>
  audit(
    ctx,
    {
      action,
      entityType: 'expense',
      entityId: n(e.id),
      entityLabel: displayId(n(e.id)),
      societyId: n(e.societyId),
      before,
      after: { ...expenseToAudit(e), ...extra },
      reason: reason ?? null,
    },
    t,
  );

/** `expense.updated` to the finance room after commit (section 9.4). */
export function emitExpense(
  t: Transaction,
  e: Pick<Expense, 'id' | 'societyId' | 'status' | 'version'>,
): void {
  const payload = { id: n(e.id), status: e.status, version: n(e.version) };
  const societyId = n(e.societyId);
  t.afterCommit(() => emitToRoom(roomFinance(societyId), RT.expenseUpdated, payload));
}

export async function ledgerLabels(
  ids: number[],
): Promise<Map<number, { id: number; code: string; name: string }>> {
  const rows = ids.length
    ? await LedgerAccount.findAll({ where: { id: [...new Set(ids)] }, attributes: ['id', 'code', 'name'] })
    : [];
  return new Map(rows.map(r => [n(r.id), { id: n(r.id), code: r.code, name: r.name }]));
}
