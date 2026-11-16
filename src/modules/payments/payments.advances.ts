import { Op, QueryTypes } from 'sequelize';
import { Invoice, PaymentAllocation, UnitAdvance, sequelize } from '../../models';
import { enqueue } from '../../lib/queue';
import { UnprocessableError } from '../../utils/errors';
import { invoices } from '../billing/billing.public';
import {
  ADVANCE_CREDIT_TYPES,
  AUDIT,
  ERR,
  JOBS,
  PAYMENTS_QUEUE,
  type AdvanceEntryType,
} from './payments.constants';
import { advanceAppliedJournal } from './payments.journal';
import { paymentsPorts } from './payments.ports';
import { audit } from '../../utils/audit';
import { lockUnit, n, setting, societyToday, unitLabelOf, withSociety } from './payments.shared';
import type { AdvanceEntryInput, AnyCtx, Transaction } from './payments.types';

/**
 * Unit advances (the unit wallet, BR-12-20): the append-only ledger `unit_advances`. Every write holds the unit row lock
 * (BR-12-19). The balance is the `balanceAfterPaise` of the unit's highest id.
 */

/** Current balance. Pass `t` to read inside a transaction (locking read, so a concurrent writer is seen). */
export async function advanceBalance(societyId: number, unitId: number, t?: Transaction): Promise<number> {
  const last = await UnitAdvance.findOne({
    where: { societyId, unitId },
    order: [['id', 'DESC']],
    attributes: ['balanceAfterPaise'],
    transaction: t,
    ...(t ? { lock: t.LOCK.UPDATE } : {}),
  });
  return last ? n(last.balanceAfterPaise) : 0;
}

/**
 * Appends one row. Idempotent by `(societyId, dedupeKey)`: the same key returns the existing row. The caller holds the unit
 * lock. A row that would take the balance below zero is `422 ADVANCE_INSUFFICIENT`.
 */
export async function postAdvance(
  ctx: AnyCtx,
  societyId: number,
  unitId: number,
  e: AdvanceEntryInput,
  t: Transaction,
): Promise<UnitAdvance> {
  const existing = await UnitAdvance.findOne({
    where: { societyId, dedupeKey: e.dedupeKey },
    transaction: t,
  });
  if (existing) return existing;
  const credit = ADVANCE_CREDIT_TYPES.includes(e.entryType as AdvanceEntryType);
  if (!Number.isSafeInteger(e.amountPaise) || e.amountPaise === 0 || credit !== e.amountPaise > 0)
    throw new UnprocessableError(ERR.businessRule, 'The advance entry amount does not match its type');
  const balance = await advanceBalance(societyId, unitId, t);
  if (balance + e.amountPaise < 0)
    throw new UnprocessableError(ERR.advanceInsufficient, 'The advance balance is not enough', [
      { field: 'amountPaise', message: 'More than the advance balance', balancePaise: balance },
    ]);
  return UnitAdvance.create(
    {
      societyId,
      unitId,
      entryType: e.entryType,
      amountPaise: e.amountPaise,
      balanceAfterPaise: balance + e.amountPaise,
      paymentId: e.paymentId ?? null,
      refundId: e.refundId ?? null,
      invoiceId: e.invoiceId ?? null,
      dedupeKey: e.dedupeKey,
      narration: e.narration.slice(0, 200),
      createdBy: ctx.user?.id ?? null,
      updatedBy: null,
    },
    { transaction: t },
  );
}

/** BR-12-54: only the `OPENING` row; no journal and no unit ledger entry (module 11's opening balance posts both). */
export async function creditOpeningAdvance(
  ctx: AnyCtx,
  unitId: number,
  amountPaise: number,
  t: Transaction,
): Promise<{ advanceId: number }> {
  const societyId = ctx.society?.id ?? (await societyOfUnit(unitId));
  await lockUnitRow(societyId, unitId, t);
  const row = await postAdvance(
    ctx,
    societyId,
    unitId,
    {
      entryType: 'OPENING',
      amountPaise,
      dedupeKey: `OPENING:unit:${unitId}`,
      narration: 'Opening advance',
    },
    t,
  );
  return { advanceId: n(row.id) };
}

async function societyOfUnit(unitId: number): Promise<number> {
  const [r] = await sequelize.query<{ societyId: number }>('SELECT societyId FROM units WHERE id = :unitId', {
    replacements: { unitId },
    type: QueryTypes.SELECT,
  });
  return n(r?.societyId);
}

/** Unit row lock for flows that must also work on an archived flat (invoice cancel, opening balance). */
export async function lockUnitRow(societyId: number, unitId: number, t: Transaction): Promise<void> {
  await sequelize.query('SELECT id FROM units WHERE id = :unitId AND societyId = :societyId FOR UPDATE', {
    replacements: { unitId, societyId },
    transaction: t,
  });
}

/** Applies up to `maxPaise` of the unit's advance to one invoice. Caller holds the unit lock. Returns the amount applied. */
async function applyToInvoice(
  ctx: AnyCtx,
  societyId: number,
  unit: { unitId: number; label: string },
  invoiceId: number,
  outstandingPaise: number,
  t: Transaction,
): Promise<number> {
  const balance = await advanceBalance(societyId, unit.unitId, t);
  const amount = Math.min(balance, outstandingPaise);
  if (amount <= 0) return 0;
  const prior = await UnitAdvance.count({
    where: { societyId, unitId: unit.unitId, invoiceId, entryType: 'APPLIED' },
    transaction: t,
  });
  const adv = await postAdvance(
    ctx,
    societyId,
    unit.unitId,
    {
      entryType: 'APPLIED',
      amountPaise: -amount,
      invoiceId,
      dedupeKey: `APPLY:inv:${invoiceId}:${prior + 1}`,
      narration: 'Advance applied to invoice',
    },
    t,
  );
  await invoices.applyAllocation(ctx, invoiceId, amount, t);
  const today = await societyToday(societyId);
  const alloc = await PaymentAllocation.create(
    {
      societyId,
      unitId: unit.unitId,
      source: 'ADVANCE',
      paymentId: null,
      unitAdvanceId: n(adv.id),
      targetType: 'INVOICE',
      invoiceId,
      collectionRequestId: null,
      amountPaise: amount,
      reversalOfId: null,
      reasonCode: 'ALLOCATED',
      allocatedOn: today,
      createdBy: ctx.user?.id ?? null,
      updatedBy: null,
    },
    { transaction: t },
  );
  await paymentsPorts().journal.post(
    ctx as never,
    advanceAppliedJournal(unit, n(alloc.id), amount, today),
    t,
  );
  await audit(
    ctx,
    {
      action: AUDIT.advanceApplied,
      entityType: 'invoice',
      entityId: invoiceId,
      societyId,
      after: { unitId: unit.unitId, invoiceId, amountPaise: amount },
    },
    t,
  );
  return amount;
}

/**
 * Body of the job `payments:apply-advances` (BR-12-20): locks the unit, re-reads the balance, applies it oldest first to the
 * unit's open invoices. No-op without balance or open invoice, or when `payments.autoApplyAdvance` is false. The unit ledger is
 * not touched (the payment already credited it).
 */
export async function applyAdvancesForUnit(
  baseCtx: AnyCtx,
  societyId: number,
  unitId: number,
  t: Transaction,
  opts: { force?: boolean } = {},
): Promise<{ appliedPaise: number }> {
  const ctx = withSociety(baseCtx, societyId);
  if (!opts.force && (await setting(societyId, 'payments.autoApplyAdvance')) === false)
    return { appliedPaise: 0 };
  await lockUnit(societyId, unitId, t);
  if ((await advanceBalance(societyId, unitId, t)) <= 0) return { appliedPaise: 0 };
  const open = await Invoice.findAll({
    where: {
      societyId,
      unitId,
      outstandingPaise: { [Op.gt]: 0 },
      status: { [Op.in]: ['ISSUED', 'PARTIALLY_PAID'] },
      isDisputed: false,
    },
    order: [
      ['dueDate', 'ASC'],
      ['invoiceDate', 'ASC'],
      ['id', 'ASC'],
    ],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  const unit = { unitId, label: await unitLabelOf(societyId, unitId, t) };
  let applied = 0;
  for (const inv of open) {
    const a = await applyToInvoice(ctx, societyId, unit, n(inv.id), n(inv.outstandingPaise), t);
    applied += a;
    if (a === 0) break;
  }
  return { appliedPaise: applied };
}

/** Module 11 port `applyAdvanceToInvoice`: apply the advance to one freshly issued invoice inside the caller's transaction. */
export async function applyAdvanceToInvoice(
  baseCtx: AnyCtx,
  input: { unitId: number; invoiceId: number; outstandingPaise: number },
  t: Transaction,
): Promise<{ appliedPaise: number }> {
  const inv = await Invoice.findByPk(input.invoiceId, { attributes: ['societyId'], transaction: t });
  if (!inv) return { appliedPaise: 0 };
  const societyId = n(inv.societyId);
  const ctx = withSociety(baseCtx, societyId);
  await lockUnitRow(societyId, input.unitId, t);
  const unit = { unitId: input.unitId, label: await unitLabelOf(societyId, input.unitId, t) };
  return {
    appliedPaise: await applyToInvoice(ctx, societyId, unit, input.invoiceId, input.outstandingPaise, t),
  };
}

/** After commit: job per unit (`payments:apply-advances`). Never throws. */
export async function queueAdvanceApply(societyId: number, unitIds: number[]): Promise<void> {
  for (const unitId of new Set(unitIds))
    await enqueue(PAYMENTS_QUEUE, JOBS.applyAdvances, { societyId, unitId });
}

/** Wallet history of a unit, newest first (used by the advance routes of 12.3). */
export async function listAdvanceEntries(
  societyId: number,
  unitId: number,
  limit = 100,
): Promise<UnitAdvance[]> {
  return UnitAdvance.findAll({ where: { societyId, unitId }, order: [['id', 'DESC']], limit });
}
