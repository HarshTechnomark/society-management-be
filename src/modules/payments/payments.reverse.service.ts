import { Op } from 'sequelize';
import {
  Collection,
  CollectionRequest,
  Invoice,
  Payment,
  PaymentWebhookEvent,
  Refund,
  sequelize,
} from '../../models';
import type { Ctx } from '../../types/context';
import { AppError, NotFoundError, UnprocessableError } from '../../utils/errors';
import { logger } from '../../lib/logger';
import { assertMakerChecker } from '../access-control/access-control.public';
import {
  AUDIT,
  EFFECTIVE_STATUSES,
  ERR,
  NOTIFY,
  REALLOCATE_MAX_AGE_DAYS,
  type ReversalReasonCode,
} from './payments.constants';
import { postAdvance } from './payments.advances';
import { applyPlan } from './payments.alloc.apply';
import { requestOutstanding } from './payments.alloc.plan';
import { receiptCreditLines } from './payments.journal';
import { paymentsPorts } from './payments.ports';
import { bumpReceiptRevision } from './payments.receipts.core';
import { reverseLiveAllocations, reversePaymentCore } from './payments.reverse.core';
import { getPayment } from './payments.admin.queries';
import {
  auditPayment,
  invalidState,
  lockUnit,
  moneyTx,
  n,
  paymentToAudit,
  societyToday,
  unitLabelOf,
  withSociety,
} from './payments.shared';
import type { Transaction } from './payments.types';
import type { JournalLine } from '../billing/billing.ports';

/**
 * Reverse (8.14, BR-12-33), reallocate (8.15, BR-12-34) and the review flag (8.16). Money moves only through the core:
 * `reversePaymentCore` for the reversal; `reverseLiveAllocations` + `applyPlan` for the reallocation.
 */
const notFound = () => new NotFoundError(ERR.paymentNotFound, 'Payment not found');
const stale = () =>
  new AppError(409, ERR.staleVersion, 'This payment was changed by someone else. Reload and try again.');
const REVERSIBLE = ['CAPTURED', 'CONFIRMED', 'CLEARED'];
const OPEN_REFUND = ['PENDING_APPROVAL', 'PROCESSING'];

async function assertPeriodOpen(societyId: number, date: string): Promise<void> {
  if (await paymentsPorts().journal.isDateLocked(societyId, date))
    throw new UnprocessableError(ERR.periodLocked, 'The accounting period of today is locked');
}

/** Locks the unit (BR-12-19 step 3) and then the payment row; version checked. */
async function lockPayment(societyId: number, id: number, version: number, t: Transaction) {
  const pre = await Payment.findOne({ where: { id, societyId }, attributes: ['unitId'], transaction: t });
  if (!pre) throw notFound();
  await lockUnit(societyId, n(pre.unitId), t);
  const p = await Payment.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!p) throw notFound();
  if (n(p.version) !== version) throw stale();
  return p;
}

export async function reversePayment(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { reasonCode: ReversalReasonCode; reason: string; version: number },
) {
  const today = await societyToday(societyId);
  await assertPeriodOpen(societyId, today);
  await moneyTx(async t => {
    const p = await lockPayment(societyId, id, input.version, t);
    if (!REVERSIBLE.includes(p.status)) throw invalidState('Only an effective payment can be reversed');
    if (p.createdBy) assertMakerChecker(ctx, n(p.createdBy));
    if (
      n(p.refundedPaise) > 0 ||
      (await Refund.count({ where: { paymentId: id, status: { [Op.in]: OPEN_REFUND } }, transaction: t }))
    )
      throw invalidState('A payment with refunds cannot be reversed');
    if ((p.source === 'ONLINE' || p.source === 'AUTOPAY') && input.reasonCode !== 'CHARGEBACK_LOST')
      throw new UnprocessableError(
        ERR.businessRule,
        'An online payment is reversed only for a lost chargeback; return the money with a refund',
        [{ field: 'reasonCode', message: 'Use CHARGEBACK_LOST or request a refund' }],
      );
    const done = await reversePaymentCore(
      ctx,
      id,
      { newStatus: 'REVERSED', reversalReasonCode: input.reasonCode, reason: input.reason },
      t,
    );
    const payer = done.payerUserId ? n(done.payerUserId) : null;
    if (payer)
      t.afterCommit(async () => {
        try {
          await paymentsPorts().notifications.send(NOTIFY.paymentReversed, [payer], {
            societyId,
            paymentId: id,
            receiptNo: done.receiptNo,
            amountPaise: n(done.amountPaise),
            reason: input.reasonCode,
          });
        } catch (err) {
          logger.error({ err }, 'payment reversed notification failed');
        }
      });
  });
  return getPayment(societyId, id);
}

export interface ReallocateInput {
  targets: { type: 'INVOICE' | 'COLLECTION_REQUEST' | 'ADVANCE'; id?: number; amountPaise: number }[];
  reason: string;
  version: number;
}

const invalid = (message: string, field = 'targets') =>
  new UnprocessableError(ERR.reallocationInvalid, message, [{ field, message }]);

/** Net change per (account, fund) between two credit sides, as the balancing journal lines. */
export function balancingLines(before: JournalLine[], after: JournalLine[], unitId: number): JournalLine[] {
  const key = (l: JournalLine) => `${l.accountCode}|${l.fundId ?? ''}`;
  const net = new Map<string, { sample: JournalLine; delta: number }>();
  const add = (l: JournalLine, sign: 1 | -1) => {
    const cur = net.get(key(l)) ?? { sample: l, delta: 0 };
    cur.delta += sign * (l.creditPaise - l.debitPaise);
    net.set(key(l), cur);
  };
  after.forEach(l => add(l, 1));
  before.forEach(l => add(l, -1));
  const out: JournalLine[] = [];
  for (const { sample, delta } of net.values()) {
    if (delta === 0) continue;
    out.push({
      accountCode: sample.accountCode,
      debitPaise: delta < 0 ? -delta : 0,
      creditPaise: delta > 0 ? delta : 0,
      unitId,
      ...(sample.fundId !== undefined ? { fundId: sample.fundId } : {}),
    });
  }
  return out;
}

interface OpenItem {
  targetType: 'INVOICE' | 'COLLECTION_REQUEST';
  id: number;
  label: string;
  outstandingPaise: number;
}

/**
 * What the named items can take now, read inside the transaction after the payment's own allocations were reversed (an invoice
 * this payment had paid in full is open again only inside this transaction, so `loadOpenTargets`, which lists from committed
 * rows, cannot be used here). Rows are locked in id order (BR-12-19).
 */
async function openTargetsOf(
  societyId: number,
  unitId: number,
  invoiceIds: number[],
  requestIds: number[],
  t: Transaction,
): Promise<OpenItem[]> {
  const out: OpenItem[] = [];
  if (invoiceIds.length) {
    const rows = await Invoice.findAll({
      where: { id: { [Op.in]: invoiceIds }, societyId, unitId },
      order: [['id', 'ASC']],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    for (const i of rows)
      if ((i.status === 'ISSUED' || i.status === 'PARTIALLY_PAID') && !i.isDisputed)
        out.push({
          targetType: 'INVOICE',
          id: n(i.id),
          label: i.invoiceNo,
          outstandingPaise: n(i.outstandingPaise),
        });
  }
  if (requestIds.length) {
    const reqs = await CollectionRequest.findAll({
      where: { id: { [Op.in]: requestIds }, societyId, unitId },
      order: [['id', 'ASC']],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const cols = await Collection.findAll({
      where: { id: { [Op.in]: [...new Set(reqs.map(r => n(r.collectionId)))] }, societyId },
      transaction: t,
      paranoid: false,
    });
    for (const r of reqs) {
      const c = cols.find(x => n(x.id) === n(r.collectionId));
      if (!c) continue;
      const outstanding = requestOutstanding(
        { amountPaise: n(r.amountPaise), paidPaise: n(r.paidPaise), status: r.status },
        c.amountMode,
      );
      if (outstanding > 0)
        out.push({
          targetType: 'COLLECTION_REQUEST',
          id: n(r.id),
          label: c.title,
          outstandingPaise: outstanding,
        });
    }
  }
  return out;
}

export async function reallocatePayment(ctx: Ctx, societyId: number, id: number, input: ReallocateInput) {
  const today = await societyToday(societyId);
  await assertPeriodOpen(societyId, today);
  await moneyTx(async t => {
    const c = withSociety(ctx, societyId);
    const p = await lockPayment(societyId, id, input.version, t);
    if (!(EFFECTIVE_STATUSES as readonly string[]).includes(p.status))
      throw invalidState('Only an effective payment can be reallocated');
    const unitId = n(p.unitId);
    const ageDays = Math.floor(
      (Date.parse(today) - Date.parse(String(p.paymentDate).slice(0, 10))) / 86_400_000,
    );
    if (ageDays > REALLOCATE_MAX_AGE_DAYS)
      throw invalid(`A payment older than ${REALLOCATE_MAX_AGE_DAYS} days cannot be reallocated`, 'id');
    if (
      n(p.refundedPaise) > 0 ||
      (await Refund.count({ where: { paymentId: id, status: { [Op.in]: OPEN_REFUND } }, transaction: t }))
    )
      throw invalid('A payment with a refund cannot be reallocated', 'id');
    const total = n(p.toInvoicesPaise) + n(p.toCollectionsPaise) + n(p.toAdvancePaise);
    const asked = input.targets.reduce((a, x) => a + x.amountPaise, 0);
    if (asked !== total)
      throw invalid(`The targets must add up to ${total} paise (they add up to ${asked})`, 'targets');
    const seen = new Set<string>();
    for (const x of input.targets) {
      const k = `${x.type}:${x.id ?? ''}`;
      if (seen.has(k)) throw invalid('A target is listed twice', 'targets');
      seen.add(k);
    }
    // targets must be items of this unit (404 otherwise); the amounts are checked against what they can take after the reversal
    const invIds = input.targets.filter(x => x.type === 'INVOICE').map(x => x.id!);
    const reqIds = input.targets.filter(x => x.type === 'COLLECTION_REQUEST').map(x => x.id!);
    const foundInv = invIds.length
      ? await Invoice.findAll({
          where: { id: { [Op.in]: invIds }, societyId, unitId },
          attributes: ['id'],
          transaction: t,
        })
      : [];
    const foundReq = reqIds.length
      ? await CollectionRequest.findAll({
          where: { id: { [Op.in]: reqIds }, societyId, unitId },
          attributes: ['id'],
          transaction: t,
        })
      : [];
    if (foundInv.length !== invIds.length || foundReq.length !== reqIds.length)
      throw new NotFoundError(ERR.payableNotFound, 'A target is not an item of this flat');

    const before = paymentToAudit(p);
    const creditsBefore = await receiptCreditLines(p, t);
    const oldAdvance = n(p.toAdvancePaise);
    await reverseLiveAllocations(
      c,
      { societyId, unitId, paymentId: id, source: 'PAYMENT' },
      { reasonCode: 'REALLOCATED', releaseToAdvance: false },
      t,
    );
    const open = await openTargetsOf(societyId, unitId, invIds, reqIds, t);
    const lines: {
      targetType: 'INVOICE' | 'COLLECTION_REQUEST';
      id: number;
      label: string;
      amountPaise: number;
    }[] = [];
    for (const x of input.targets) {
      if (x.type === 'ADVANCE') continue;
      const o = open.find(z => z.targetType === x.type && z.id === x.id);
      if (!o || x.amountPaise > o.outstandingPaise)
        throw new UnprocessableError(ERR.amountExceedsDue, 'A target can take less than the amount given', [
          { field: 'targets', message: 'Above what the item can take', id: x.id },
        ]);
      lines.push({ targetType: x.type, id: x.id!, label: o.label, amountPaise: x.amountPaise });
    }
    await applyPlan(c, p, { lines, advancePaise: 0 }, t);
    const newAdvance = input.targets.find(x => x.type === 'ADVANCE')?.amountPaise ?? 0;
    const delta = newAdvance - oldAdvance;
    if (delta !== 0) {
      try {
        await postAdvance(
          c,
          societyId,
          unitId,
          {
            entryType: delta > 0 ? 'PAYMENT_EXCESS' : 'EXCESS_REVERSED',
            amountPaise: delta,
            paymentId: id,
            dedupeKey: `REALLOC:payment:${id}:${n(p.receiptRevision)}`,
            narration: `Advance changed by reallocation of ${p.receiptNo ?? `payment #${id}`}`,
          },
          t,
        );
      } catch (err) {
        if (err instanceof AppError && err.code === ERR.advanceInsufficient)
          throw invalid('The advance of this payment has already been used', 'targets');
        throw err;
      }
    }
    const sum = (type: string) =>
      lines.filter(l => l.targetType === type).reduce((a, l) => a + l.amountPaise, 0);
    await p.update(
      {
        toInvoicesPaise: sum('INVOICE'),
        toCollectionsPaise: sum('COLLECTION_REQUEST'),
        toAdvancePaise: newAdvance,
        updatedBy: ctx.user?.id ?? null,
        version: n(p.version) + 1,
      },
      { transaction: t },
    );
    const jl = balancingLines(creditsBefore, await receiptCreditLines(p, t), unitId);
    if (jl.length)
      await paymentsPorts().journal.post(
        c as never,
        {
          date: today,
          voucherType: 'JOURNAL',
          // one journal per reallocation: the payment's version after this change makes the source unique (module 13 dedupes on it)
          refType: 'payment_realloc',
          refId: `${id}:${n(p.version)}`,
          narration:
            `Reallocation of receipt ${p.receiptNo ?? ''} · ${await unitLabelOf(societyId, unitId, t)}`.trim(),
          lines: jl,
        },
        t,
      );
    if (p.receiptStatus !== 'NONE') await bumpReceiptRevision(p, t);
    await auditPayment(c, AUDIT.paymentReallocated, p, before, t, input.reason);
  });
  return getPayment(societyId, id);
}

/** 8.16 `POST /payments/:id/review-done`. */
export async function reviewDone(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: { note: string; version: number },
) {
  await sequelize.transaction(async t => {
    const p = await Payment.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!p) throw notFound();
    if (n(p.version) !== input.version) throw stale();
    if (!p.needsReview && !p.isDuplicateSuspect) throw invalidState('This payment has no review flag');
    const before = paymentToAudit(p);
    await p.update(
      {
        needsReview: false,
        isDuplicateSuspect: false,
        updatedBy: ctx.user?.id ?? null,
        version: n(p.version) + 1,
      },
      { transaction: t },
    );
    if (p.gatewayPaymentId)
      await PaymentWebhookEvent.update(
        { status: 'PROCESSED', reviewedBy: ctx.user?.id ?? null, updatedBy: ctx.user?.id ?? null },
        {
          where: { societyId, gatewayPaymentId: p.gatewayPaymentId, status: 'NEEDS_REVIEW' },
          transaction: t,
        },
      );
    await auditPayment(ctx, AUDIT.paymentReviewDone, p, before, t, input.note);
  });
  return getPayment(societyId, id);
}
