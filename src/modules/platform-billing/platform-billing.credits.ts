/**
 * Goodwill credits (BR-06-31; 8.23), refunds (BR-06-32; 8.21, 8.22) and the credit ledger view (8.8).
 * Refunds come only from the credit balance: the request posts a REFUND row at once, rejection or failure reverses it.
 */
import { Op, UniqueConstraintError } from 'sequelize';
import { PlatformCredit, PlatformPayment, Society, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { addDaysYmd } from './pricing';
import { billingSettings } from './platform-billing.settings';
import {
  creditBalance,
  lastPostedCredit,
  lockSociety,
  nextPostedAt,
  postCredit,
  todayIst,
} from './platform-billing.settlement';
import { notifyPlatform, notifySubscriptionViewers } from './platform-billing.notify';
import {
  actorId,
  assertDecidable,
  invalidState,
  lockPayment,
  num,
  paymentDetail,
  paymentNotFound,
  settleAfterCredit,
  staleVersion,
} from './platform-billing.shared';
import { bankRefKeyOf } from './platform-billing.payments';

const creditNotFound = () => new NotFoundError('PLATFORM_CREDIT_NOT_FOUND', 'Credit not found');
const societyNotFound = () => new NotFoundError('NOT_FOUND', 'Society not found');

export const creditDto = (c: PlatformCredit) => ({
  id: c.id!,
  societyId: c.societyId,
  entryType: c.entryType,
  status: c.status,
  amountPaise: num(c.amountPaise),
  balanceAfterPaise: c.balanceAfterPaise === null ? null : num(c.balanceAfterPaise),
  invoiceId: c.invoiceId,
  reason: c.reason,
  postedAt: c.postedAt ? c.postedAt.toISOString() : null,
  createdAt: c.createdAt?.toISOString() ?? null,
  version: c.version,
});

// ------------------------------------------------------------------ 8.23 goodwill credits
export async function requestGoodwill(
  ctx: Ctx,
  societyId: number,
  input: { amountPaise: number; reason: string },
) {
  const settings = await billingSettings();
  if (input.amountPaise > settings['billing.maxGoodwillCreditPaise'])
    throw new UnprocessableError('GOODWILL_LIMIT_EXCEEDED', 'The credit is above the allowed limit', [
      { field: 'amountPaise', message: `At most ${settings['billing.maxGoodwillCreditPaise']} paise` },
    ]);
  return sequelize.transaction(async t => {
    const society = await Society.findByPk(societyId, { transaction: t });
    if (!society) throw societyNotFound();
    const c = await PlatformCredit.create(
      {
        societyId,
        entryType: 'GOODWILL',
        status: 'PENDING_APPROVAL',
        amountPaise: input.amountPaise,
        balanceAfterPaise: null,
        reason: input.reason,
        createdBy: actorId(ctx),
        updatedBy: actorId(ctx),
        version: 1,
      } as never,
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: 'platform_billing.credit.requested',
        entityType: 'platform_credit',
        entityId: c.id!,
        entityLabel: society.name,
        societyId,
        reason: input.reason,
        after: { amountPaise: input.amountPaise },
      },
      t,
    );
    notifyPlatform(
      t,
      'platform_billing.approval_pending',
      'platform.billing.approve',
      { what: 'Goodwill credit', amountPaise: input.amountPaise, societyName: society.name },
      actorId(ctx),
    );
    return creditDto(c);
  });
}

/** Society lock, then the credit row (BR-06-23). */
async function lockCredit(creditId: number, t: import('sequelize').Transaction) {
  const pre = await PlatformCredit.findByPk(creditId, { attributes: ['id', 'societyId'], transaction: t });
  if (!pre) throw creditNotFound();
  const society = await lockSociety(pre.societyId, t);
  const credit = await PlatformCredit.findByPk(creditId, { transaction: t, lock: t.LOCK.UPDATE });
  if (!credit) throw creditNotFound();
  return { society, credit };
}

export async function approveCredit(ctx: Ctx, creditId: number, input: { version: number }) {
  return sequelize.transaction(async t => {
    const { society, credit: c } = await lockCredit(creditId, t);
    assertDecidable(ctx, c, 'PENDING_APPROVAL', input.version, 'credit');
    const last = await lastPostedCredit(c.societyId, t);
    c.set({
      status: 'POSTED',
      balanceAfterPaise: num(last?.balanceAfterPaise) + num(c.amountPaise),
      postedAt: nextPostedAt(last, true),
      approvedBy: ctx.user!.id,
      approvedAt: now(),
      updatedBy: ctx.user!.id,
      version: c.version + 1,
    });
    await c.save({ transaction: t });
    await audit(
      ctx,
      {
        action: 'platform_billing.credit.approved',
        entityType: 'platform_credit',
        entityId: c.id!,
        entityLabel: society.name,
        societyId: c.societyId,
        after: { amountPaise: num(c.amountPaise), balanceAfterPaise: num(c.balanceAfterPaise) },
      },
      t,
    );
    await settleAfterCredit(ctx, c.societyId, t);
    notifySubscriptionViewers(t, 'platform_billing.credit_granted', c.societyId, {
      amountPaise: num(c.amountPaise),
      societyName: society.name,
    });
    return { ...creditDto(c), creditBalancePaise: await creditBalance(c.societyId, t) };
  });
}

export async function rejectCredit(ctx: Ctx, creditId: number, input: { version: number; reason: string }) {
  return sequelize.transaction(async t => {
    const { society, credit: c } = await lockCredit(creditId, t);
    assertDecidable(ctx, c, 'PENDING_APPROVAL', input.version, 'credit');
    c.set({
      status: 'REJECTED',
      rejectedReason: input.reason,
      approvedBy: ctx.user!.id,
      approvedAt: now(),
      updatedBy: ctx.user!.id,
      version: c.version + 1,
    });
    await c.save({ transaction: t });
    await audit(
      ctx,
      {
        action: 'platform_billing.credit.rejected',
        entityType: 'platform_credit',
        entityId: c.id!,
        entityLabel: society.name,
        societyId: c.societyId,
        reason: input.reason,
        after: { status: 'REJECTED' },
      },
      t,
    );
    return creditDto(c);
  });
}

// ------------------------------------------------------------------ 8.22 refund request
export interface RefundInput {
  amountPaise: number;
  mode: 'GATEWAY' | 'BANK_TRANSFER';
  sourcePaymentId?: number;
  payeeReference?: string;
  reason: string;
}

const REFUND_WINDOW_DAYS = 180;

export async function requestRefund(ctx: Ctx, societyId: number, input: RefundInput) {
  return sequelize.transaction(async t => {
    const society = await lockSociety(societyId, t);
    let source: PlatformPayment | null = null;
    if (input.mode === 'GATEWAY') {
      source = await PlatformPayment.findByPk(input.sourcePaymentId!, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!source || source.societyId !== societyId || source.kind !== 'PAYMENT') throw paymentNotFound();
    }
    const balance = await creditBalance(societyId, t);
    if (input.amountPaise > balance)
      throw new UnprocessableError('INSUFFICIENT_CREDIT_BALANCE', 'The credit balance is not enough');
    if (source) {
      const refunds = await PlatformPayment.findAll({
        where: {
          sourcePaymentId: source.id!,
          kind: 'REFUND',
          status: { [Op.notIn]: ['FAILED', 'REJECTED'] },
        },
        attributes: ['amountPaise'],
        transaction: t,
      });
      const refundable = num(source.amountPaise) - refunds.reduce((s, r) => s + num(r.amountPaise), 0);
      if (input.amountPaise > refundable)
        throw new UnprocessableError(
          'REFUND_EXCEEDS_SOURCE_PAYMENT',
          'The refund is more than what is left of the source payment',
          [{ field: 'amountPaise', message: `At most ${refundable} paise` }],
        );
      const tooOld =
        source.status !== 'CAPTURED' ||
        !source.gatewayPaymentId ||
        !source.capturedAt ||
        source.capturedAt.getTime() < now().getTime() - REFUND_WINDOW_DAYS * 86_400_000;
      if (tooOld)
        throw new UnprocessableError(
          'REFUND_SOURCE_TOO_OLD',
          'The source payment cannot be refunded through the gateway',
        );
    }
    const p = await PlatformPayment.create(
      {
        societyId,
        invoiceId: null,
        kind: 'REFUND',
        origin: 'PLATFORM',
        status: 'PENDING_APPROVAL',
        method: input.mode === 'GATEWAY' ? 'GATEWAY_REFUND' : 'BANK_TRANSFER',
        amountPaise: input.amountPaise,
        appliedPaise: 0,
        sourcePaymentId: source?.id ?? null,
        payeeReference: input.mode === 'BANK_TRANSFER' ? (input.payeeReference ?? null) : null,
        reason: input.reason,
        createdBy: actorId(ctx),
        updatedBy: actorId(ctx),
        version: 1,
      } as never,
      { transaction: t },
    );
    const row = await postCredit(
      ctx,
      {
        societyId,
        entryType: 'REFUND',
        amountPaise: -input.amountPaise,
        paymentId: p.id!,
        reason: input.reason,
      },
      t,
    );
    await audit(
      ctx,
      {
        action: 'platform_billing.refund.requested',
        entityType: 'platform_payment',
        entityId: p.id!,
        entityLabel: society.name,
        societyId,
        reason: input.reason,
        after: { amountPaise: input.amountPaise, mode: input.mode, sourcePaymentId: source?.id ?? null },
      },
      t,
    );
    notifyPlatform(
      t,
      'platform_billing.approval_pending',
      'platform.billing.approve',
      { what: 'Refund', amountPaise: input.amountPaise, societyName: society.name },
      actorId(ctx),
    );
    return { ...paymentDetail(p, null), creditBalancePaise: num(row.balanceAfterPaise) };
  });
}

// ------------------------------------------------------------------ 8.21 bank transfer refund done
export async function completeRefund(
  ctx: Ctx,
  paymentId: number,
  input: { bankReference: string; receivedOn: string; version: number },
) {
  const today = todayIst();
  if (input.receivedOn > today || input.receivedOn < addDaysYmd(today, -30))
    throw new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [
      { field: 'receivedOn', message: 'Between 30 days ago and today' },
    ]);
  return sequelize.transaction(async t => {
    const { society, payment: p } = await lockPayment(paymentId, t, { kind: 'REFUND' });
    if (p.method !== 'BANK_TRANSFER' || p.status !== 'PROCESSING')
      throw invalidState('Only an approved bank transfer refund can be completed');
    if (p.version !== input.version) throw staleVersion();
    const bankRefKey = bankRefKeyOf('BANK_TRANSFER', input.bankReference);
    const dup = () =>
      new ConflictError('DUPLICATE_BANK_REFERENCE', 'This bank reference is already recorded');
    if (await PlatformPayment.findOne({ where: { bankRefKey }, attributes: ['id'], transaction: t }))
      throw dup();
    p.set({
      status: 'REFUNDED',
      bankReference: input.bankReference.trim(),
      bankRefKey,
      receivedOn: input.receivedOn,
      completedAt: now(),
      updatedBy: actorId(ctx),
      version: p.version + 1,
    });
    try {
      await p.save({ transaction: t });
    } catch (err) {
      if (err instanceof UniqueConstraintError) throw dup();
      throw err;
    }
    await audit(
      ctx,
      {
        action: 'platform_billing.refund.completed',
        entityType: 'platform_payment',
        entityId: p.id!,
        entityLabel: society.name,
        societyId: p.societyId,
        after: { amountPaise: num(p.amountPaise), bankReference: p.bankReference },
      },
      t,
    );
    notifySubscriptionViewers(t, 'platform_billing.refund_processed', p.societyId, {
      amountPaise: num(p.amountPaise),
      societyName: society.name,
    });
    return paymentDetail(p, null);
  });
}

/** Webhook `refund.processed` / `refund.failed` for a GATEWAY refund (6.3). */
export async function settleGatewayRefund(
  ctx: Ctx,
  gatewayRefundId: string,
  processed: boolean,
): Promise<string> {
  const pre = await PlatformPayment.findOne({
    where: { gatewayRefundId, kind: 'REFUND' },
    attributes: ['id'],
  });
  if (!pre) return 'ignored: unknown refund';
  return sequelize.transaction(async t => {
    const { society, payment: p } = await lockPayment(pre.id!, t, { kind: 'REFUND' });
    if (p.status !== 'PROCESSING') return 'unchanged';
    if (processed) {
      p.set({ status: 'REFUNDED', completedAt: now(), updatedBy: actorId(ctx), version: p.version + 1 });
      await p.save({ transaction: t });
      await audit(
        ctx,
        {
          action: 'platform_billing.refund.completed',
          entityType: 'platform_payment',
          entityId: p.id!,
          entityLabel: society.name,
          societyId: p.societyId,
          after: { amountPaise: num(p.amountPaise), gatewayRefundId },
        },
        t,
      );
      notifySubscriptionViewers(t, 'platform_billing.refund_processed', p.societyId, {
        amountPaise: num(p.amountPaise),
        societyName: society.name,
      });
      return 'refunded';
    }
    p.set({
      status: 'FAILED',
      failureReason: 'The gateway could not process the refund',
      updatedBy: actorId(ctx),
      version: p.version + 1,
    });
    await p.save({ transaction: t });
    await postCredit(
      ctx,
      {
        societyId: p.societyId,
        entryType: 'REFUND_REVERSED',
        amountPaise: num(p.amountPaise),
        paymentId: p.id!,
      },
      t,
    );
    await settleAfterCredit(ctx, p.societyId, t);
    await audit(
      ctx,
      {
        action: 'platform_billing.refund.failed',
        entityType: 'platform_payment',
        entityId: p.id!,
        entityLabel: society.name,
        societyId: p.societyId,
        after: { amountPaise: num(p.amountPaise), gatewayRefundId },
      },
      t,
    );
    notifyPlatform(t, 'platform_billing.refund_failed', 'platform.billing.edit', {
      amountPaise: num(p.amountPaise),
      societyName: society.name,
    });
    return 'failed';
  });
}
