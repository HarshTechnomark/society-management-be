import { Op, UniqueConstraintError, type WhereOptions } from 'sequelize';
import { Payment, Refund, Unit } from '../../models';
import { now } from '../../lib/clock';
import { formatRupees } from '../../lib/money';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import { nextNumber } from '../../utils/numberSequences';
import { usersWithPermission } from '../access-control/access-control.public';
import { systemCtx, type Ctx } from '../../types/context';
import {
  APPROVAL_TYPES,
  AUDIT,
  EFFECTIVE_STATUSES,
  ENTITY,
  ERR,
  GATEWAY_REFUND_MAX_DAYS,
  NOTIFY,
  PERM,
  ACCOUNT,
  type RefundMode,
} from './payments.constants';
import { advanceBalance, postAdvance, queueAdvanceApply } from './payments.advances';
import { paymentsPorts } from './payments.ports';
import { reverseLiveAllocations } from './payments.reverse.core';
import { bumpReceiptRevision } from './payments.receipts.core';
import { lockUnit, moneyTx, n, societyToday, unitLabelOf, withSociety } from './payments.shared';
import type { AnyCtx, SystemCtx, Transaction } from './payments.types';

/**
 * Refunds (sections 5.6, 6.3, 8.19; BR-12-35, BR-12-36). A refund holds its amount in the unit's advance at request time
 * (`REFUND_HOLD`), is approved through module 14 type `PAYMENT_REFUND`, and is paid out by the gateway or by the treasurer.
 * The hold is released by rejection, withdrawal, expiry or a failed refund (`REFUND_RELEASE`). Money moves only here and in the core
 * (`reverseLiveAllocations` frees allocations, `postAdvance` writes the wallet); `payments.refundedPaise` grows when PROCESSED.
 */
const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const OPEN = ['PENDING_APPROVAL', 'PROCESSING'] as const;
const OFFLINE_MODES: RefundMode[] = ['BANK_TRANSFER', 'CHEQUE', 'CASH'];

const refundNotFound = () => new NotFoundError(ERR.refundNotFound, 'Refund not found');
const staleVersion = () =>
  new ConflictError(ERR.staleVersion, 'Someone else changed this refund. Reload to see the change.');
const invalidState = (message: string) => new ConflictError(ERR.invalidState, message);

export interface RefundDto {
  id: number;
  refundNo: string | null;
  unitId: number;
  unitLabel: string;
  paymentId: number;
  amountPaise: number;
  freedFromAllocationsPaise: number;
  mode: RefundMode;
  status: string;
  reason: string;
  payeeName: string | null;
  payeeAccountMasked: string | null;
  gatewayRefundId: string | null;
  bankReference: string | null;
  paidOutOn: string | null;
  failureReason: string | null;
  approvalRequestId: number | null;
  approvedAt: string | null;
  rejectedReason: string | null;
  processedAt: string | null;
  createdBy: number | null;
  createdAt: string;
  version: number;
  payment?: {
    id: number;
    receiptNo: string | null;
    payerName: string;
    method: string;
    source: string;
    status: string;
    amountPaise: number;
    refundedPaise: number;
    paymentDate: string;
  };
  approval?: { requestId: number | null; status: string };
}

export function refundDto(r: Refund, unitLabel: string, p?: Payment): RefundDto {
  const approvalStatus =
    r.status === 'PENDING_APPROVAL'
      ? 'PENDING'
      : r.status === 'REJECTED'
        ? 'REJECTED'
        : r.status === 'CANCELLED'
          ? 'CANCELLED'
          : 'APPROVED';
  return {
    id: n(r.id),
    refundNo: r.refundNo,
    unitId: n(r.unitId),
    unitLabel,
    paymentId: n(r.paymentId),
    amountPaise: n(r.amountPaise),
    freedFromAllocationsPaise: n(r.freedFromAllocationsPaise),
    mode: r.mode,
    status: r.status,
    reason: r.reason,
    payeeName: r.payeeName,
    payeeAccountMasked: r.payeeAccountMasked,
    gatewayRefundId: r.gatewayRefundId,
    bankReference: r.bankReference,
    paidOutOn: r.paidOutOn,
    failureReason: r.failureReason,
    approvalRequestId: r.approvalRequestId === null ? null : n(r.approvalRequestId),
    approvedAt: iso(r.approvedAt),
    rejectedReason: r.rejectedReason,
    processedAt: iso(r.processedAt),
    createdBy: r.createdBy === null ? null : n(r.createdBy),
    createdAt: iso(r.createdAt)!,
    version: n(r.version),
    ...(p
      ? {
          payment: {
            id: n(p.id),
            receiptNo: p.receiptNo,
            payerName: p.payerName,
            method: p.method,
            source: p.source,
            status: p.status,
            amountPaise: n(p.amountPaise),
            refundedPaise: n(p.refundedPaise),
            paymentDate: p.paymentDate,
          },
          approval: {
            requestId: r.approvalRequestId === null ? null : n(r.approvalRequestId),
            status: approvalStatus,
          },
        }
      : {}),
  };
}

// ------------------------------------------------------------------ reads (8.19)
export interface RefundListQuery {
  status?: string;
  mode?: string;
  unitId?: number;
  from?: string;
  to?: string;
  page: number;
  limit: number;
  sortBy: 'createdAt' | 'amountPaise';
}

export async function listRefunds(societyId: number, q: RefundListQuery) {
  const where: WhereOptions[] = [{ societyId }];
  if (q.status) where.push({ status: q.status });
  if (q.mode) where.push({ mode: q.mode });
  if (q.unitId) where.push({ unitId: q.unitId });
  // dates are Asia/Kolkata days
  if (q.from) where.push({ createdAt: { [Op.gte]: new Date(`${q.from}T00:00:00+05:30`) } });
  if (q.to)
    where.push({
      createdAt: { [Op.lt]: new Date(new Date(`${q.to}T00:00:00+05:30`).getTime() + 86_400_000) },
    });
  const { rows, count } = await Refund.findAndCountAll({
    where: { [Op.and]: where },
    order: [
      [q.sortBy, 'DESC'],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const units = await Unit.findAll({
    where: { id: { [Op.in]: [...new Set(rows.map(r => n(r.unitId)))] } },
    attributes: ['id', 'label'],
  });
  const label = new Map(units.map(u => [n(u.id), u.label]));
  return {
    items: rows.map(r => refundDto(r, label.get(n(r.unitId)) ?? '')),
    pagination: {
      page: q.page,
      limit: q.limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / q.limit)),
    },
  };
}

export async function getRefund(societyId: number, id: number): Promise<RefundDto> {
  const r = await Refund.findOne({ where: { id, societyId } });
  if (!r) throw refundNotFound();
  const p = await Payment.findByPk(r.paymentId);
  return refundDto(r, await unitLabelOf(societyId, n(r.unitId)), p ?? undefined);
}

// ------------------------------------------------------------------ request (BR-12-35, BR-12-36)
export interface RefundRequestInput {
  paymentId: number;
  amountPaise: number;
  mode: RefundMode;
  reason: string;
  reallocate: boolean;
  payeeName?: string;
  payeeAccountMasked?: string;
}

const daysBetween = (from: Date, to: Date) => (to.getTime() - from.getTime()) / 86_400_000;

function assertModeAllowed(p: Payment, mode: RefundMode): void {
  if (mode !== 'GATEWAY') return;
  const captured = p.capturedAt ? new Date(p.capturedAt) : null;
  const ok =
    (p.source === 'ONLINE' || p.source === 'AUTOPAY') &&
    Boolean(p.gatewayPaymentId) &&
    captured !== null &&
    daysBetween(captured, now()) <= GATEWAY_REFUND_MAX_DAYS;
  if (!ok)
    throw new UnprocessableError(
      ERR.refundModeNotAllowed,
      `A gateway refund is only possible for an online or AutoPay payment captured in the last ${GATEWAY_REFUND_MAX_DAYS} days`,
    );
}

export async function requestRefund(ctx: Ctx, input: RefundRequestInput): Promise<RefundDto> {
  const societyId = ctx.society!.id;
  return moneyTx(async t => {
    const pre = await Payment.findOne({
      where: { id: input.paymentId, societyId },
      attributes: ['id', 'unitId'],
      transaction: t,
    });
    if (!pre) throw new NotFoundError(ERR.paymentNotFound, 'Payment not found');
    const unitId = n(pre.unitId);
    await lockUnit(societyId, unitId, t);
    const p = await Payment.findOne({
      where: { id: input.paymentId, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!p) throw new NotFoundError(ERR.paymentNotFound, 'Payment not found');
    if (!EFFECTIVE_STATUSES.includes(p.status))
      throw new ConflictError(ERR.paymentNotEffective, 'Only an effective payment can be refunded');
    const open = await Refund.findOne({
      where: { paymentId: n(p.id), status: { [Op.in]: [...OPEN] } },
      attributes: ['id'],
      transaction: t,
    });
    if (open)
      throw new AppError(409, ERR.refundInProgress, 'This payment already has a refund in progress', [
        { field: 'refundId', message: 'Open refund', refundId: n(open.id) },
      ]);
    assertModeAllowed(p, input.mode);
    const refundable = n(p.amountPaise) - n(p.refundedPaise);
    if (input.amountPaise > refundable)
      throw new UnprocessableError(
        ERR.refundExceedsRefundable,
        'The amount is more than can still be refunded',
        [{ field: 'amountPaise', message: 'More than refundable', refundablePaise: refundable }],
      );

    // the money must sit in the unit's advance (BR-12-35)
    let freed = 0;
    let balance = await advanceBalance(societyId, unitId, t);
    if (balance < input.amountPaise) {
      if (!input.reallocate)
        throw new UnprocessableError(
          ERR.refundNeedsReallocation,
          'The money is already used for dues. Send reallocate: true to reopen the newest dues.',
          [
            {
              field: 'reallocate',
              message: 'Needed',
              advancePaise: balance,
              requiredPaise: input.amountPaise,
            },
          ],
        );
      const today = await societyToday(societyId);
      if (await paymentsPorts().journal.isDateLocked(societyId, today))
        throw new UnprocessableError(ERR.periodLocked, 'The accounting period of today is locked');
      const res = await reverseLiveAllocations(
        ctx,
        { societyId, unitId, paymentId: n(p.id), source: 'PAYMENT' },
        {
          reasonCode: 'REFUND_FREED',
          limitPaise: input.amountPaise - balance,
          newestFirst: true,
          releaseToAdvance: true,
        },
        t,
      );
      freed = res.freedPaise;
      balance = await advanceBalance(societyId, unitId, t);
      if (balance < input.amountPaise)
        throw new UnprocessableError(
          ERR.refundNeedsReallocation,
          'The unit advance is still short after reopening the dues of this payment',
          [
            {
              field: 'amountPaise',
              message: 'Short',
              advancePaise: balance,
              requiredPaise: input.amountPaise,
            },
          ],
        );
      const fresh = await Payment.findByPk(n(p.id), { transaction: t });
      if (fresh && fresh.receiptStatus === 'ISSUED') await bumpReceiptRevision(fresh, t);
    }

    let refund: Refund;
    try {
      refund = await Refund.create(
        {
          societyId,
          refundNo: null,
          unitId,
          paymentId: n(p.id),
          amountPaise: input.amountPaise,
          freedFromAllocationsPaise: freed,
          mode: input.mode,
          status: 'PENDING_APPROVAL',
          reason: input.reason,
          payeeName: OFFLINE_MODES.includes(input.mode) ? (input.payeeName ?? null) : null,
          payeeAccountMasked: input.mode === 'BANK_TRANSFER' ? (input.payeeAccountMasked ?? null) : null,
          gatewayRefundId: null,
          bankReference: null,
          paidOutOn: null,
          failureReason: null,
          approvalRequestId: null,
          approvedBy: null,
          approvedAt: null,
          rejectedReason: null,
          processedAt: null,
          lastCheckedAt: null,
          createdBy: ctx.user?.id ?? null,
          updatedBy: null,
          version: 1,
        },
        { transaction: t },
      );
    } catch (err) {
      if (err instanceof UniqueConstraintError)
        throw new ConflictError(ERR.refundInProgress, 'This payment already has a refund in progress');
      throw err;
    }
    const label = await unitLabelOf(societyId, unitId, t);
    await postAdvance(
      ctx,
      societyId,
      unitId,
      {
        entryType: 'REFUND_HOLD',
        amountPaise: -input.amountPaise,
        paymentId: n(p.id),
        refundId: n(refund.id),
        dedupeKey: `HOLD:refund:${refund.id}`,
        narration: `Held for refund of receipt ${p.receiptNo ?? `#${p.id}`}`,
      },
      t,
    );
    const approval = await paymentsPorts().approvals.request(
      ctx,
      {
        type: APPROVAL_TYPES.paymentRefund,
        entityType: ENTITY.refund,
        entityId: n(refund.id),
        title: `Refund ${formatRupees(input.amountPaise)} to ${label}`,
        amountPaise: input.amountPaise,
        summary: input.reason,
        payload: { paymentId: n(p.id), mode: input.mode, categoryKey: input.mode, unitId },
      },
      t,
    );
    await refund.update({ approvalRequestId: approval.id }, { transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.refundRequested,
        entityType: 'refund',
        entityId: n(refund.id),
        entityLabel: label,
        societyId,
        after: {
          paymentId: n(p.id),
          amountPaise: input.amountPaise,
          mode: input.mode,
          freedFromAllocationsPaise: freed,
          approvalRequestId: approval.id,
        },
        reason: input.reason,
      },
      t,
    );
    if (freed > 0) t.afterCommit(() => void queueAdvanceApply(societyId, [unitId]));
    // an auto-approved request ran `onRefundApproved` inside `request` (BR-14-4)
    await refund.reload({ transaction: t });
    return refundDto(refund, label, p);
  });
}

// ------------------------------------------------------------------ module 14 callbacks (6.3)
const lockRefund = (refundId: number, t: Transaction) =>
  Refund.findOne({ where: { id: refundId }, transaction: t, lock: t.LOCK.UPDATE });

async function notifyAfterCommit(
  t: Transaction,
  template: string,
  recipients: () => Promise<number[]>,
  data: Record<string, unknown>,
): Promise<void> {
  t.afterCommit(() => {
    void (async () => {
      try {
        const ids = [...new Set((await recipients()).filter(Boolean))];
        if (ids.length) await paymentsPorts().notifications.send(template, ids, data);
      } catch (err) {
        logger.error({ err, template }, 'refund notification failed');
      }
    })();
  });
}

/** Releases the hold (`REFUND_RELEASE`) and wakes the advance applier, so freed dues are paid again from the advance. */
async function releaseHold(ctx: AnyCtx, r: Refund, t: Transaction): Promise<void> {
  const societyId = n(r.societyId);
  const unitId = n(r.unitId);
  await lockUnit(societyId, unitId, t);
  await postAdvance(
    ctx,
    societyId,
    unitId,
    {
      entryType: 'REFUND_RELEASE',
      amountPaise: n(r.amountPaise),
      paymentId: n(r.paymentId),
      refundId: n(r.id),
      dedupeKey: `RELEASE:refund:${r.id}`,
      narration: `Refund ${r.refundNo ?? `#${r.id}`} not paid: amount back in the advance`,
    },
    t,
  );
  t.afterCommit(() => void queueAdvanceApply(societyId, [unitId]));
}

async function failRefund(
  ctx: AnyCtx,
  r: Refund,
  reason: string,
  t: Transaction,
  action = AUDIT.refundFailed,
) {
  const societyId = n(r.societyId);
  const before = { status: r.status };
  await releaseHold(ctx, r, t);
  await r.update(
    {
      status: 'FAILED',
      failureReason: reason.slice(0, 300),
      updatedBy: ctx.user?.id ?? null,
      version: n(r.version) + 1,
    },
    { transaction: t },
  );
  await audit(
    withSociety(ctx, societyId) as Ctx,
    {
      action,
      entityType: 'refund',
      entityId: n(r.id),
      societyId,
      before,
      after: { status: 'FAILED', failureReason: r.failureReason },
      reason: r.failureReason,
    },
    t,
  );
  await notifyAfterCommit(
    t,
    NOTIFY.refundFailed,
    async () => [
      ...(r.createdBy ? [n(r.createdBy)] : []),
      ...(await usersWithPermission(societyId, PERM.paymentsApprove)),
    ],
    { refundId: n(r.id), amountPaise: n(r.amountPaise), reason: r.failureReason },
  );
}

/** `onApproved` of `PAYMENT_REFUND`: GATEWAY calls `PaymentGateway.refund` (failure is FAILED at once); other modes become PROCESSING. */
export async function onRefundApproved(baseCtx: AnyCtx, refundId: number, t: Transaction): Promise<void> {
  const r = await lockRefund(refundId, t);
  if (!r || r.status !== 'PENDING_APPROVAL') return;
  const societyId = n(r.societyId);
  const ctx = withSociety(baseCtx, societyId);
  const before = { status: r.status };
  const approvedBy = ctx.user?.id ?? null;
  const base = { approvedBy, approvedAt: now(), updatedBy: approvedBy, version: n(r.version) + 1 };
  if (r.mode !== 'GATEWAY') {
    await r.update({ ...base, status: 'PROCESSING' }, { transaction: t });
    await audit(
      ctx as Ctx,
      {
        action: AUDIT.refundApproved,
        entityType: 'refund',
        entityId: n(r.id),
        societyId,
        before,
        after: { status: 'PROCESSING' },
      },
      t,
    );
    return;
  }
  const p = await Payment.findByPk(n(r.paymentId), { transaction: t });
  let gatewayRefundId: string | null = null;
  let failure: string | null = null;
  try {
    const ports = paymentsPorts().gateways;
    const account = p?.gatewayAccountId ? await ports.getAccount(n(p.gatewayAccountId)) : null;
    if (!p?.gatewayPaymentId || !account) failure = 'The payment has no gateway reference';
    else {
      const res = await ports.clientFor(account).refund(p.gatewayPaymentId, n(r.amountPaise), r.reason);
      gatewayRefundId = res.refundId;
    }
  } catch (err) {
    logger.error({ err, refundId }, 'gateway refund failed');
    failure = 'The gateway refused the refund';
  }
  if (gatewayRefundId) {
    await r.update({ ...base, status: 'PROCESSING', gatewayRefundId }, { transaction: t });
    await audit(
      ctx as Ctx,
      {
        action: AUDIT.refundApproved,
        entityType: 'refund',
        entityId: n(r.id),
        societyId,
        before,
        after: { status: 'PROCESSING', gatewayRefundId },
      },
      t,
    );
    return;
  }
  await r.update(base, { transaction: t });
  await failRefund(ctx, r, failure ?? 'Refund failed', t);
}

/** `onRejected`: REJECTED, hold released. */
export async function onRefundRejected(baseCtx: AnyCtx, refundId: number, reason: string, t: Transaction) {
  const r = await lockRefund(refundId, t);
  if (!r || r.status !== 'PENDING_APPROVAL') return;
  const societyId = n(r.societyId);
  const ctx = withSociety(baseCtx, societyId);
  await releaseHold(ctx, r, t);
  await r.update(
    {
      status: 'REJECTED',
      rejectedReason: reason.slice(0, 500),
      updatedBy: ctx.user?.id ?? null,
      version: n(r.version) + 1,
    },
    { transaction: t },
  );
  await audit(
    ctx as Ctx,
    {
      action: AUDIT.refundRejected,
      entityType: 'refund',
      entityId: n(r.id),
      societyId,
      before: { status: 'PENDING_APPROVAL' },
      after: { status: 'REJECTED' },
      reason,
    },
    t,
  );
}

/** `onCancelled` (requester withdraws) and `onExpired`: CANCELLED, hold released. */
export async function onRefundCancelled(baseCtx: AnyCtx, refundId: number, t: Transaction) {
  const r = await lockRefund(refundId, t);
  if (!r || r.status !== 'PENDING_APPROVAL') return;
  const societyId = n(r.societyId);
  const ctx = withSociety(baseCtx, societyId);
  await releaseHold(ctx, r, t);
  await r.update(
    { status: 'CANCELLED', updatedBy: ctx.user?.id ?? null, version: n(r.version) + 1 },
    { transaction: t },
  );
  await audit(
    ctx as Ctx,
    {
      action: AUDIT.refundRejected,
      entityType: 'refund',
      entityId: n(r.id),
      societyId,
      before: { status: 'PENDING_APPROVAL' },
      after: { status: 'CANCELLED' },
      reason: 'Withdrawn or expired',
    },
    t,
  );
}

async function describeRefund(refundId: number) {
  const r = await Refund.findByPk(refundId);
  if (!r) return [];
  const label = await Unit.findByPk(r.unitId, { attributes: ['label'] });
  return [
    { label: 'Flat', value: label?.label ?? '', kind: 'text' as const },
    { label: 'Amount', value: formatRupees(n(r.amountPaise)), kind: 'money' as const },
    { label: 'Mode', value: r.mode, kind: 'text' as const },
    { label: 'Reason', value: r.reason, kind: 'text' as const },
  ];
}

/** Registers `PAYMENT_REFUND` with module 14 (through the approvals port). Idempotent. */
export function registerRefundApprovalType(): void {
  paymentsPorts().approvals.registerType({
    type: APPROVAL_TYPES.paymentRefund,
    onApproved: onRefundApproved,
    onRejected: onRefundRejected,
    onCancelled: (ctx, id, t) => onRefundCancelled(ctx, id, t),
    describe: describeRefund,
  });
}

// ------------------------------------------------------------------ PROCESSED (webhook, status job, offline complete)
/** The common PROCESSED step: refund number, `refundedPaise`, journal, audit, notice. The caller holds the refund row lock. */
async function markProcessed(
  baseCtx: AnyCtx,
  r: Refund,
  o: { date: string; bankReference?: string | null; paidOutOn?: string | null },
  t: Transaction,
): Promise<void> {
  const societyId = n(r.societyId);
  const ctx = withSociety(baseCtx, societyId);
  const unitId = n(r.unitId);
  await lockUnit(societyId, unitId, t);
  const p = await Payment.findOne({ where: { id: n(r.paymentId) }, transaction: t, lock: t.LOCK.UPDATE });
  if (!p) throw new AppError(500, 'INTERNAL_ERROR', 'Refund payment missing');
  const refundNo = await nextNumber(societyId, 'REFUND', { date: o.date, transaction: t });
  await r.update(
    {
      status: 'PROCESSED',
      refundNo,
      processedAt: now(),
      bankReference: o.bankReference ?? r.bankReference,
      paidOutOn: o.paidOutOn ?? r.paidOutOn,
      updatedBy: ctx.user?.id ?? null,
      version: n(r.version) + 1,
    },
    { transaction: t },
  );
  await p.update(
    { refundedPaise: n(p.refundedPaise) + n(r.amountPaise), version: n(p.version) + 1 },
    { transaction: t },
  );
  const label = await unitLabelOf(societyId, unitId, t);
  const credit =
    r.mode === 'GATEWAY' ? ACCOUNT.gatewayClearing : r.mode === 'CASH' ? ACCOUNT.cashInHand : ACCOUNT.bank;
  await paymentsPorts().journal.post(
    ctx as Ctx,
    {
      date: o.date,
      voucherType: 'PAYMENT',
      refType: 'refund',
      refId: n(r.id),
      narration: `Refund ${refundNo} of receipt ${p.receiptNo ?? `#${p.id}`} · ${label}`,
      lines: [
        { accountCode: ACCOUNT.memberAdvances, debitPaise: n(r.amountPaise), creditPaise: 0, unitId },
        { accountCode: credit, debitPaise: 0, creditPaise: n(r.amountPaise), unitId },
      ],
    },
    t,
  );
  await audit(
    ctx as Ctx,
    {
      action: AUDIT.refundProcessed,
      entityType: 'refund',
      entityId: n(r.id),
      entityLabel: refundNo,
      societyId,
      before: { status: 'PROCESSING' },
      after: { status: 'PROCESSED', refundNo, amountPaise: n(r.amountPaise), bankReference: r.bankReference },
    },
    t,
  );
  await notifyAfterCommit(t, NOTIFY.refundProcessed, async () => [n(p.payerUserId) || n(r.createdBy)], {
    refundId: n(r.id),
    refundNo,
    amountPaise: n(r.amountPaise),
    unitLabel: label,
    mode: r.mode,
  });
}

/** `POST /refunds/:id/complete` (offline modes): records the payout. */
export async function completeRefund(
  ctx: Ctx,
  id: number,
  input: { paidOutOn: string; bankReference?: string; version: number },
): Promise<RefundDto> {
  const societyId = ctx.society!.id;
  return moneyTx(async t => {
    const r = await Refund.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!r) throw refundNotFound();
    if (n(r.version) !== input.version) throw staleVersion();
    if (r.status !== 'PROCESSING' || r.mode === 'GATEWAY')
      throw invalidState('Only an offline refund that is being processed can be completed');
    const today = await societyToday(societyId);
    if (input.paidOutOn > today)
      throw new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [
        { field: 'paidOutOn', message: 'Cannot be in the future' },
      ]);
    if ((r.mode === 'BANK_TRANSFER' || r.mode === 'CHEQUE') && !input.bankReference)
      throw new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [
        { field: 'bankReference', message: 'Required for a bank transfer or cheque' },
      ]);
    if (await paymentsPorts().journal.isDateLocked(societyId, input.paidOutOn))
      throw new UnprocessableError(ERR.periodLocked, 'The accounting period of that date is locked');
    await markProcessed(
      ctx,
      r,
      { date: input.paidOutOn, bankReference: input.bankReference ?? null, paidOutOn: input.paidOutOn },
      t,
    );
    return refundDto(
      r,
      await unitLabelOf(societyId, n(r.unitId), t),
      (await Payment.findByPk(r.paymentId, { transaction: t })) ?? undefined,
    );
  });
}

// ------------------------------------------------------------------ gateway results (webhook, status job)
export interface RefundEvent {
  societyId: number;
  /** `refund.processed` or `refund.failed` (Razorpay names); anything else is IGNORED. */
  type: string;
  gatewayRefundId: string;
  /** The gateway event id: goes to the audit `reason` (section 9.2). */
  eventId?: string;
  failureReason?: string;
}
export type RefundEventOutcome = 'PROCESSED' | 'FAILED' | 'IGNORED' | 'NOT_FOUND';

/**
 * The refund part of the webhook (6.3, 9.1 `process-webhook`): 12.1's job calls it for `refund.*` events. Idempotent (a refund that
 * is no longer PROCESSING is IGNORED). `NOT_FOUND` means no refund has this gateway id yet: the approval may still be committing, so
 * the caller should retry the event later (FAILED_RETRYABLE).
 */
export async function handleRefundEvent(
  baseCtx: SystemCtx | Ctx,
  ev: RefundEvent,
  outerTx?: Transaction,
): Promise<RefundEventOutcome> {
  if (ev.type !== 'refund.processed' && ev.type !== 'refund.failed') return 'IGNORED';
  const run = async (t: Transaction): Promise<RefundEventOutcome> => {
    const r = await Refund.findOne({
      where: { societyId: ev.societyId, gatewayRefundId: ev.gatewayRefundId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!r) return 'NOT_FOUND';
    if (r.status !== 'PROCESSING') return 'IGNORED';
    const ctx = withSociety(baseCtx, ev.societyId);
    if (ev.type === 'refund.processed') {
      await markProcessed(ctx, r, { date: await societyToday(ev.societyId) }, t);
      return 'PROCESSED';
    }
    await failRefund(
      ctx,
      r,
      ev.failureReason ?? `Gateway refund failed (event ${ev.eventId ?? ''})`.trim(),
      t,
    );
    return 'FAILED';
  };
  return outerTx ? run(outerTx) : moneyTx(run);
}

// ------------------------------------------------------------------ job `payments:refund-status` (9.1)
const REFUND_POLL_AFTER_MS = 2 * 3_600_000;

/** Hourly: PROCESSING GATEWAY refunds older than 2 hours are asked from the gateway. Returns how many changed. */
export async function pollGatewayRefunds(): Promise<number> {
  const cutoff = new Date(now().getTime() - REFUND_POLL_AFTER_MS);
  const rows = await Refund.findAll({
    where: {
      status: 'PROCESSING',
      mode: 'GATEWAY',
      gatewayRefundId: { [Op.ne]: null },
      updatedAt: { [Op.lte]: cutoff },
      [Op.or]: [
        { lastCheckedAt: null },
        { lastCheckedAt: { [Op.lte]: new Date(now().getTime() - 3_300_000) } },
      ],
    },
    order: [['id', 'ASC']],
    limit: 200,
  });
  let changed = 0;
  for (const row of rows) {
    try {
      const societyId = n(row.societyId);
      const p = await Payment.findByPk(n(row.paymentId), { attributes: ['gatewayAccountId'] });
      const ports = paymentsPorts().gateways;
      const account = p?.gatewayAccountId ? await ports.getAccount(n(p.gatewayAccountId)) : null;
      if (!account) continue;
      const res = await ports.clientFor(account).fetchRefund(row.gatewayRefundId!);
      if (res.status === 'pending') {
        await Refund.update({ lastCheckedAt: now() }, { where: { id: row.id } });
        continue;
      }
      const outcome = await handleRefundEvent(withSociety(systemCtx('job'), societyId) as SystemCtx, {
        societyId,
        type: res.status === 'processed' ? 'refund.processed' : 'refund.failed',
        gatewayRefundId: row.gatewayRefundId!,
        failureReason: 'The gateway reported the refund as failed',
      });
      await Refund.update({ lastCheckedAt: now() }, { where: { id: row.id } });
      if (outcome === 'PROCESSED' || outcome === 'FAILED') changed += 1;
    } catch (err) {
      logger.error({ err, refundId: n(row.id) }, 'refund status check failed');
    }
  }
  return changed;
}
