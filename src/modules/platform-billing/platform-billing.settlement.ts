/**
 * Settlement core shared by issuing (this task) and payments, TDS and write-offs (later tasks): society lock
 * (BR-06-23), credit ledger (BR-06-25, BR-06-26), status derivation after every change (BR-06-22) and the module 05
 * lifecycle calls (BR-06-40). Everything runs inside the caller's transaction.
 */
import { Op, type Transaction } from 'sequelize';
import { DunningEvent, PlatformCredit, PlatformInvoice, Society } from '../../models';
import type { CreditEntryType } from '../../models/platform-credit.model';
import { istDate, now } from '../../lib/clock';
import { emitToRoom } from '../../lib/realtime';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { societyLifecycle } from '../societies/societies.public';
import { subscriptions } from '../subscriptions/subscriptions.public';
import { addDaysYmd, amountDueOf, deriveInvoiceStatus, OPEN_STATUSES } from './pricing';
import { billingSettings } from './platform-billing.settings';

export const todayIst = (): string => istDate(now());
const num = (v: unknown): number => Number(v ?? 0);
const actorId = (ctx: Ctx): number | null => ctx.user?.id ?? null;

/** BR-06-23: the first lock of every money transaction (the same row module 05 locks). */
export async function lockSociety(societyId: number, t: Transaction): Promise<Society> {
  const s = await Society.findByPk(societyId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!s) throw new NotFoundError('NOT_FOUND', 'Society not found');
  return s;
}

/** After commit: clients with `settings.subscription.view` refetch the billing summary (9.4). Never throws. */
export function emitBillingChanged(t: Transaction, societyId: number, invoiceId: number): void {
  t.afterCommit(() => {
    try {
      emitToRoom(`society:${societyId}:admin`, 'platform_billing.billing.changed', { invoiceId });
    } catch (err) {
      logger.error({ err }, 'platform billing realtime emit failed');
    }
  });
}

// ------------------------------------------------------------------ credit ledger
/** The latest POSTED row of the ledger (`postedAt`, then `id`), or null. */
export async function lastPostedCredit(societyId: number, t?: Transaction): Promise<PlatformCredit | null> {
  return PlatformCredit.findOne({
    where: { societyId, status: 'POSTED' },
    order: [
      ['postedAt', 'DESC'],
      ['id', 'DESC'],
    ],
    transaction: t,
  });
}

/** BR-06-25: `balanceAfterPaise` of the latest POSTED row, 0 when none. */
export async function creditBalance(societyId: number, t?: Transaction): Promise<number> {
  return num((await lastPostedCredit(societyId, t))?.balanceAfterPaise);
}

/**
 * `postedAt` for the next ledger row: never before the latest row, so the order by `postedAt, id` is the order of
 * posting even when the clock is frozen or two rows share a millisecond. `strictlyAfter` is for a row with a lower id
 * than rows already posted (a goodwill credit approved later).
 */
export function nextPostedAt(last: PlatformCredit | null, strictlyAfter = false): Date {
  const t = now();
  const prev = last?.postedAt;
  if (!prev) return t;
  if (strictlyAfter) return t.getTime() > prev.getTime() ? t : new Date(prev.getTime() + 1);
  return t.getTime() >= prev.getTime() ? t : prev;
}

/** Posts a system credit row (6.4) and returns it; the balance never goes negative (BR-06-25). */
export async function postCredit(
  ctx: Ctx,
  input: {
    societyId: number;
    entryType: Exclude<CreditEntryType, 'GOODWILL'>;
    amountPaise: number;
    invoiceId?: number | null;
    paymentId?: number | null;
    reason?: string | null;
  },
  t: Transaction,
): Promise<PlatformCredit> {
  const last = await lastPostedCredit(input.societyId, t);
  const balance = num(last?.balanceAfterPaise);
  const after = balance + input.amountPaise;
  if (after < 0)
    throw new UnprocessableError('INSUFFICIENT_CREDIT_BALANCE', 'The credit balance is not enough');
  return PlatformCredit.create(
    {
      societyId: input.societyId,
      entryType: input.entryType,
      status: 'POSTED',
      amountPaise: input.amountPaise,
      balanceAfterPaise: after,
      invoiceId: input.invoiceId ?? null,
      paymentId: input.paymentId ?? null,
      reason: input.reason ?? null,
      postedAt: nextPostedAt(last),
      createdBy: actorId(ctx),
    } as never,
    { transaction: t },
  );
}

// ------------------------------------------------------------------ invoice settlement
export interface SettlementChange {
  creditAppliedPaise?: number;
  paidPaise?: number;
  tdsPaise?: number;
  creditNotedPaise?: number;
  writtenOffPaise?: number;
  excessToCreditPaise?: number;
}

export interface SettleResult {
  becamePaid: boolean;
}

/**
 * Adds the deltas to a locked, issued invoice, recomputes `amountDuePaise` (BR-06-21) and the status (BR-06-22), and
 * keeps `paidAt` / `voidedAt`. When it becomes PAID: audit `.invoice.paid` and module 04 `onPlatformInvoicePaid`.
 */
export async function settleInvoice(
  ctx: Ctx,
  inv: PlatformInvoice,
  delta: SettlementChange,
  t: Transaction,
): Promise<SettleResult> {
  const before = inv.status;
  const next = {
    totalPaise: num(inv.totalPaise),
    creditAppliedPaise: num(inv.creditAppliedPaise) + (delta.creditAppliedPaise ?? 0),
    paidPaise: num(inv.paidPaise) + (delta.paidPaise ?? 0),
    tdsPaise: num(inv.tdsPaise) + (delta.tdsPaise ?? 0),
    creditNotedPaise: num(inv.creditNotedPaise) + (delta.creditNotedPaise ?? 0),
    writtenOffPaise: num(inv.writtenOffPaise) + (delta.writtenOffPaise ?? 0),
    excessToCreditPaise: num(inv.excessToCreditPaise) + (delta.excessToCreditPaise ?? 0),
  };
  const due = amountDueOf(next);
  if (due < 0) throw new Error(`settlement of ${inv.invoiceNo} would make the amount due negative`);
  const status = deriveInvoiceStatus({ ...next, dueDate: inv.dueDate }, todayIst());
  inv.set({
    creditAppliedPaise: next.creditAppliedPaise,
    paidPaise: next.paidPaise,
    tdsPaise: next.tdsPaise,
    creditNotedPaise: next.creditNotedPaise,
    writtenOffPaise: next.writtenOffPaise,
    excessToCreditPaise: next.excessToCreditPaise,
    amountDuePaise: due,
    status,
    updatedBy: actorId(ctx),
    version: inv.version + 1,
  });
  if (status === 'PAID' && !inv.paidAt) inv.paidAt = now();
  if (status !== 'PAID' && status !== 'VOID' && inv.paidAt) inv.paidAt = null;
  if (status === 'VOID' && !inv.voidedAt) inv.voidedAt = now();
  await inv.save({ transaction: t });
  const becamePaid = status === 'PAID' && before !== 'PAID';
  if (becamePaid) {
    await audit(
      ctx,
      {
        action: 'platform_billing.invoice.paid',
        entityType: 'platform_invoice',
        entityId: inv.id!,
        entityLabel: inv.invoiceNo,
        societyId: inv.societyId,
        before: { status: before },
        after: { status, totalPaise: next.totalPaise },
      },
      t,
    );
    await subscriptions.onPlatformInvoicePaid(ctx, inv.id!, t);
  }
  emitBillingChanged(t, inv.societyId, inv.id!);
  return { becamePaid };
}

/**
 * BR-06-26: while the balance is positive, settle open invoices by `dueDate`, `id` with APPLIED rows. Returns the
 * amount applied and the invoices that became PAID. The caller holds the society lock.
 */
export async function applyCredits(
  ctx: Ctx,
  societyId: number,
  t: Transaction,
): Promise<{ applied: number; paid: PlatformInvoice[] }> {
  let balance = await creditBalance(societyId, t);
  if (balance <= 0) return { applied: 0, paid: [] };
  const open = await PlatformInvoice.findAll({
    where: {
      societyId,
      documentType: 'INVOICE',
      status: OPEN_STATUSES as unknown as string[],
      amountDuePaise: { [Op.gt]: 0 },
    },
    order: [['id', 'ASC']],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  open.sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.id! - b.id!);
  const paid: PlatformInvoice[] = [];
  let applied = 0;
  for (const inv of open) {
    if (balance <= 0) break;
    const x = Math.min(balance, num(inv.amountDuePaise));
    applied += x;
    const row = await postCredit(
      ctx,
      { societyId, entryType: 'APPLIED', amountPaise: -x, invoiceId: inv.id! },
      t,
    );
    balance = num(row.balanceAfterPaise);
    const r = await settleInvoice(ctx, inv, { creditAppliedPaise: x }, t);
    await audit(
      ctx,
      {
        action: 'platform_billing.credit.applied',
        entityType: 'platform_credit',
        entityId: row.id!,
        entityLabel: inv.invoiceNo,
        societyId,
        after: { invoiceId: inv.id, amountPaise: x, balanceAfterPaise: balance },
      },
      t,
    );
    if (r.becamePaid) paid.push(inv);
  }
  return { applied, paid };
}

// ------------------------------------------------------------------ overdue checks (module 05 port, 9.3)
/**
 * BR-05-17 / BR-06-38: an open invoice with at least `dunningMinDuePaise` due whose past-due day
 * (`dueDate + pastDueAfterDays`) has come.
 */
export async function hasOverdueInvoice(societyId: number, t?: Transaction): Promise<boolean> {
  const s = await billingSettings();
  const row = await PlatformInvoice.findOne({
    attributes: ['id'],
    where: {
      societyId,
      documentType: 'INVOICE',
      status: OPEN_STATUSES as unknown as string[],
      amountDuePaise: { [Op.gte]: Math.max(1, s['billing.dunningMinDuePaise']) },
      dueDate: { [Op.lte]: addDaysYmd(todayIst(), -s['billing.pastDueAfterDays']) },
    },
    transaction: t,
  });
  return Boolean(row);
}

/** Σ amount due of open invoices, and of those whose due date has passed. */
export async function getOutstanding(
  societyId: number,
  t?: Transaction,
): Promise<{ outstandingPaise: number; overduePaise: number }> {
  const rows = await PlatformInvoice.findAll({
    attributes: ['amountDuePaise', 'dueDate'],
    where: {
      societyId,
      documentType: 'INVOICE',
      status: OPEN_STATUSES as unknown as string[],
      amountDuePaise: { [Op.gt]: 0 },
    },
    transaction: t,
  });
  const today = todayIst();
  let outstandingPaise = 0;
  let overduePaise = 0;
  for (const r of rows) {
    outstandingPaise += num(r.amountDuePaise);
    if (r.dueDate && r.dueDate < today) overduePaise += num(r.amountDuePaise);
  }
  return { outstandingPaise, overduePaise };
}

/**
 * BR-06-40, after every settlement change in the same transaction: a PERIOD invoice that became PAID calls
 * `onFirstInvoicePaid`; then, when nothing is overdue, `onAccountCleared`, and a CLEARED dunning event when that moved
 * the society out of PAST_DUE or a non-payment suspension. Module 05 makes calls that do not apply no-ops.
 */
export async function afterSettlement(
  ctx: Ctx,
  societyId: number,
  becamePaid: PlatformInvoice[],
  t: Transaction,
): Promise<void> {
  if (becamePaid.some(i => i.invoiceKind === 'PERIOD'))
    await societyLifecycle.onFirstInvoicePaid(ctx, societyId, t);
  if (await hasOverdueInvoice(societyId, t)) return;
  const before = await Society.findByPk(societyId, { attributes: ['id', 'status'], transaction: t });
  await societyLifecycle.onAccountCleared(ctx, societyId, t);
  const after = await Society.findByPk(societyId, { attributes: ['id', 'status'], transaction: t });
  if (before && after && before.status !== after.status && after.status === 'ACTIVE') {
    await DunningEvent.create(
      {
        societyId,
        invoiceId: null,
        step: 'CLEARED',
        offsetDays: null,
        scheduledFor: todayIst(),
        dedupeKey: null,
        outcome: 'DONE',
        createdBy: actorId(ctx),
      } as never,
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: 'platform_billing.dunning.cleared',
        entityType: 'society',
        entityId: societyId,
        societyId,
        before: { status: before.status },
        after: { status: after.status },
      },
      t,
    );
  }
}
