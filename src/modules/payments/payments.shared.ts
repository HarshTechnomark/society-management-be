import { Transaction as SequelizeTransaction } from 'sequelize';
import { Society, Unit, User, sequelize } from '../../models';
import { emitToRoom } from '../../lib/realtime';
import { audit } from '../../utils/audit';
import { AppError, NotFoundError } from '../../utils/errors';
import { settings, units } from '../society-setup/society-setup.public';
import { societyToday } from '../billing/billing.runs.shared';
import { ERR, RT, SETTING_DEFAULTS, roomFinance } from './payments.constants';
import type { AnyCtx, Transaction, YmdString } from './payments.types';
import type { Payment } from '../../models';

export { societyToday };

/** A context that carries the society (jobs and other modules call with a bare system context). */
export function withSociety(ctx: AnyCtx, societyId: number): AnyCtx {
  if (ctx.society?.id === societyId) return ctx;
  return {
    ...ctx,
    society: { id: societyId, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
  };
}

/** Section 5.11 setting with the spec default when the registry has no stored value or key. */
export async function setting<K extends keyof typeof SETTING_DEFAULTS>(
  societyId: number,
  key: K,
): Promise<(typeof SETTING_DEFAULTS)[K] extends boolean ? boolean : unknown> {
  try {
    return (await settings.get(societyId, key as never)) as never;
  } catch {
    return SETTING_DEFAULTS[key] as never;
  }
}

/** Lock order step 3 (BR-12-19): the active unit row `FOR UPDATE`. */
export async function lockUnit(societyId: number, unitId: number, t: Transaction): Promise<void> {
  await units.lockActive(societyId, unitId, t);
}

export async function unitLabelOf(societyId: number, unitId: number, t?: Transaction): Promise<string> {
  const u = await Unit.findOne({ where: { id: unitId, societyId }, attributes: ['label'], transaction: t });
  if (!u) throw new NotFoundError(ERR.unitNotFound, 'Unit not found');
  return u.label;
}

export async function userName(userId: number | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const u = await User.findByPk(userId, { attributes: ['name'] });
  return u?.name ?? null;
}

export async function societyExists(societyId: number): Promise<boolean> {
  return Boolean(await Society.findByPk(societyId, { attributes: ['id'] }));
}

export const notImplemented = (what: string): AppError =>
  new AppError(501, ERR.notImplemented, `${what} is not implemented in the foundation (filled by its part)`);

export const invalidState = (message: string): AppError => new AppError(409, ERR.invalidState, message);

export const n = (v: unknown): number => Number(v ?? 0);

export const paymentToAudit = (p: Payment) => ({
  id: n(p.id),
  unitId: n(p.unitId),
  status: p.status,
  source: p.source,
  method: p.method,
  amountPaise: n(p.amountPaise),
  toInvoicesPaise: n(p.toInvoicesPaise),
  toCollectionsPaise: n(p.toCollectionsPaise),
  toAdvancePaise: n(p.toAdvancePaise),
  receiptNo: p.receiptNo,
  referenceNo: p.referenceNo,
});

/** `payment.received` / `payment.reversed` to the finance room, after commit (section 9.3). */
export function emitFinance(
  t: Transaction,
  societyId: number,
  event: (typeof RT)[keyof typeof RT],
  payload: Record<string, unknown>,
): void {
  t.afterCommit(() => emitToRoom(roomFinance(societyId), event, payload));
}

export const auditPayment = (
  ctx: AnyCtx,
  action: string,
  payment: Payment,
  before: unknown,
  t: Transaction,
  reason?: string | null,
) =>
  audit(
    ctx,
    {
      action,
      entityType: 'payment',
      entityId: n(payment.id),
      entityLabel: payment.receiptNo,
      societyId: n(payment.societyId),
      before,
      after: paymentToAudit(payment),
      reason: reason ?? null,
    },
    t,
  );

export const isYmd = (v: string): v is YmdString => /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Opens the transaction of a money flow. `READ COMMITTED` on purpose: the advance balance is read with a locking read
 * (`FOR UPDATE`) and under `REPEATABLE READ` its gap locks make two units' first advance rows deadlock; under `READ COMMITTED`
 * only the row locks of BR-12-19 remain and plain reads inside the flow always see the latest committed rows.
 * Every job and route of module 12 that calls the core opens its transaction with this helper.
 */
export const moneyTx = <T>(fn: (t: Transaction) => Promise<T>): Promise<T> =>
  sequelize.transaction({ isolationLevel: SequelizeTransaction.ISOLATION_LEVELS.READ_COMMITTED }, fn);
