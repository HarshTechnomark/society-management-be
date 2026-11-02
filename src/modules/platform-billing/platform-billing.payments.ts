/**
 * Online payments (5.4 BR-06-27, BR-06-28; 6.3; 6.6; 8.5, 8.6, 8.28) and manual payments (BR-06-29, BR-06-30; 8.18,
 * 8.19). The settlement itself is `applyCapturedPayment` in the shared helpers, so verify, webhook and approval all
 * move money the same way and are idempotent on the payment row.
 */
import { Op, UniqueConstraintError } from 'sequelize';
import { PlatformInvoice, PlatformPayment, Society, sequelize } from '../../models';
import { paymentGateway } from '../../adapters';
import { env } from '../../lib/env';
import { addHours, addMinutes, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { emitAfterCommit, notifyAfterCommit } from '../societies/societies.notify';
import { addDaysYmd } from './pricing';
import { billingSettings } from './platform-billing.settings';
import { billingPorts } from './platform-billing.ports';
import { invoiceNotFound } from './platform-billing.service';
import { lockSociety, postCredit, todayIst } from './platform-billing.settlement';
import { notifyPlatform, notifySubscriptionViewers } from './platform-billing.notify';
import {
  actorId,
  applyCapturedPayment,
  assertDecidable,
  emitPaymentUpdated,
  gatewayMethod,
  invalidState,
  isOpenInvoice,
  lockPayment,
  num,
  paymentDetail,
  settleAfterCredit,
} from './platform-billing.shared';

const gatewayError = () => new AppError(502, 'GATEWAY_ERROR', 'The payment gateway could not be reached');
const mask = (mobile: string | null | undefined): string | undefined =>
  mobile && mobile.length >= 6 ? `${mobile.slice(0, 2)}XXXXX${mobile.slice(-3)}` : undefined;

/** The checkout object the client opens (the key id is public by design, section 13). */
function checkoutOf(
  orderId: string,
  invoiceNo: string,
  contact?: string,
  extra: Record<string, unknown> = {},
) {
  return {
    ...extra,
    key: env().PLATFORM_RAZORPAY_KEY_ID,
    order_id: orderId,
    name: 'SocietyApp',
    description: invoiceNo,
    prefill: contact ? { contact } : {},
  };
}

// ------------------------------------------------------------------ 8.5 payment order
export async function createPaymentOrder(
  ctx: Ctx,
  societyId: number,
  invoiceId: number,
  input: { amountPaise?: number },
) {
  const settings = await billingSettings();
  const prepared = await sequelize.transaction(async t => {
    const pre = await PlatformInvoice.findByPk(invoiceId, {
      attributes: ['id', 'societyId'],
      transaction: t,
    });
    if (!pre || pre.societyId !== societyId) throw invoiceNotFound();
    const society = await lockSociety(societyId, t);
    const inv = await PlatformInvoice.findByPk(invoiceId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!inv) throw invoiceNotFound();
    if (!isOpenInvoice(inv))
      throw new ConflictError('INVOICE_NOT_PAYABLE', 'This invoice cannot take a payment');
    const due = num(inv.amountDuePaise);
    const amount = input.amountPaise ?? due;
    if (amount > due)
      throw new UnprocessableError('AMOUNT_EXCEEDS_DUE', 'The amount is more than the amount due', [
        { field: 'amountPaise', message: `At most ${due} paise` },
      ]);
    if (amount < 100 && amount !== due)
      throw new UnprocessableError('AMOUNT_BELOW_MINIMUM', 'The amount is below ₹1', [
        { field: 'amountPaise', message: 'At least 100 paise' },
      ]);
    const since = addMinutes(now(), -settings['billing.pendingOrderMinutes']);
    const existing = await PlatformPayment.findOne({
      where: {
        invoiceId,
        kind: 'PAYMENT',
        status: 'CREATED',
        origin: 'SOCIETY',
        amountPaise: amount,
        gatewayOrderId: { [Op.ne]: null },
        createdAt: { [Op.gt]: since },
      },
      order: [['id', 'DESC']],
      transaction: t,
    });
    if (existing) return { payment: existing, invoiceNo: inv.invoiceNo!, society, reused: true };
    const payment = await PlatformPayment.create(
      {
        societyId,
        invoiceId,
        kind: 'PAYMENT',
        origin: 'SOCIETY',
        status: 'CREATED',
        amountPaise: amount,
        appliedPaise: 0,
        createdBy: actorId(ctx),
        updatedBy: actorId(ctx),
        version: 1,
      } as never,
      { transaction: t },
    );
    return { payment, invoiceNo: inv.invoiceNo!, society, reused: false };
  });
  const { payment, invoiceNo, society } = prepared;
  const contact = mask(ctx.user?.mobile);
  const expiresAt = addHours(payment.createdAt!, 24).toISOString();
  if (prepared.reused)
    return {
      paymentId: payment.id!,
      gatewayOrderId: payment.gatewayOrderId!,
      amountPaise: num(payment.amountPaise),
      checkout: checkoutOf(payment.gatewayOrderId!, invoiceNo, contact),
      expiresAt,
    };

  let order: { orderId: string; checkout: Record<string, unknown> };
  try {
    order = await paymentGateway().createOrder({
      societyGatewayAccountId: env().PLATFORM_GATEWAY_ACCOUNT_ID,
      amountPaise: num(payment.amountPaise),
      receipt: `PLTPAY-${payment.id}`,
      notes: { invoiceNo, societyId: String(societyId), platformPaymentId: String(payment.id) },
    });
  } catch (err) {
    logger.warn({ err, paymentId: payment.id }, 'platform gateway createOrder failed');
    await sequelize.transaction(async t => {
      const p = await PlatformPayment.findByPk(payment.id!, { transaction: t, lock: t.LOCK.UPDATE });
      if (p && p.status === 'CREATED' && !p.gatewayOrderId) {
        p.set({
          status: 'FAILED',
          failureReason: (err instanceof Error ? err.message : 'Gateway error').slice(0, 300),
          updatedBy: actorId(ctx),
          version: p.version + 1,
        });
        await p.save({ transaction: t });
        await audit(
          ctx,
          {
            action: 'platform_billing.payment.failed',
            entityType: 'platform_payment',
            entityId: p.id!,
            entityLabel: invoiceNo,
            societyId,
            after: { reason: 'order creation failed' },
          },
          t,
        );
      }
    });
    throw gatewayError();
  }
  await sequelize.transaction(async t => {
    const p = await PlatformPayment.findByPk(payment.id!, { transaction: t, lock: t.LOCK.UPDATE });
    p!.set({ gatewayOrderId: order.orderId, updatedBy: actorId(ctx), version: p!.version + 1 });
    await p!.save({ transaction: t });
    await audit(
      ctx,
      {
        action: 'platform_billing.payment.order_created',
        entityType: 'platform_payment',
        entityId: p!.id!,
        entityLabel: invoiceNo,
        societyId,
        after: { invoiceId, amountPaise: num(p!.amountPaise), gatewayOrderId: order.orderId },
      },
      t,
    );
  });
  void society;
  return {
    paymentId: payment.id!,
    gatewayOrderId: order.orderId,
    amountPaise: num(payment.amountPaise),
    checkout: checkoutOf(order.orderId, invoiceNo, contact, order.checkout),
    expiresAt,
  };
}

// ------------------------------------------------------------------ gateway settlement (6.6 step 4)
interface GatewayInfo {
  paymentId: string;
  orderId: string;
  amountPaise: number;
  method?: string | null;
}
type ConfirmOutcome = 'CAPTURED' | 'ALREADY_CAPTURED' | 'MISMATCH' | 'NOT_APPLICABLE';

/** BR-06-28 checks and, when they pass, the settlement. Idempotent: a CAPTURED payment returns at once. */
export async function confirmGatewayPayment(
  ctx: Ctx,
  paymentId: number,
  gw: GatewayInfo,
): Promise<ConfirmOutcome> {
  return sequelize.transaction(async t => {
    const { society, invoice, payment } = await lockPayment(paymentId, t, { kind: 'PAYMENT' });
    if (payment.status === 'CAPTURED') return 'ALREADY_CAPTURED';
    if (!['CREATED', 'FAILED', 'EXPIRED'].includes(payment.status) || payment.origin === 'PLATFORM')
      return 'NOT_APPLICABLE';
    if (gw.orderId !== payment.gatewayOrderId || gw.amountPaise !== num(payment.amountPaise)) {
      await audit(
        ctx,
        {
          action: 'platform_billing.payment.mismatch',
          entityType: 'platform_payment',
          entityId: payment.id!,
          entityLabel: invoice?.invoiceNo ?? null,
          societyId: payment.societyId,
          after: {
            expectedOrderId: payment.gatewayOrderId,
            gatewayOrderId: gw.orderId,
            expectedAmountPaise: num(payment.amountPaise),
            gatewayAmountPaise: gw.amountPaise,
          },
        },
        t,
      );
      notifyPlatform(t, 'platform_billing.payment_mismatch', 'platform.billing.edit', {
        orderId: gw.orderId,
        amountPaise: num(payment.amountPaise),
        gatewayAmountPaise: gw.amountPaise,
      });
      return 'MISMATCH';
    }
    payment.set({ gatewayPaymentId: gw.paymentId, method: gatewayMethod(gw.method), failureReason: null });
    const capturedAt = now();
    const { applied, excess } = await applyCapturedPayment(ctx, payment, invoice, capturedAt, t);
    await audit(
      ctx,
      {
        action: 'platform_billing.payment.captured',
        entityType: 'platform_payment',
        entityId: payment.id!,
        entityLabel: invoice?.invoiceNo ?? null,
        societyId: payment.societyId,
        after: { amountPaise: num(payment.amountPaise), appliedPaise: applied, excessPaise: excess },
      },
      t,
    );
    notifySubscriptionViewers(t, 'platform_billing.payment_received', payment.societyId, {
      amountPaise: num(payment.amountPaise),
      societyName: society.name,
      invoiceNo: invoice?.invoiceNo ?? null,
    });
    emitPaymentUpdated(t, payment);
    return 'CAPTURED';
  });
}

/** CREATED (or an order that never got an id) to FAILED; a captured or settled payment is left alone. */
export async function failGatewayPayment(
  ctx: Ctx,
  paymentId: number,
  reason: string,
  gatewayPaymentId?: string,
): Promise<boolean> {
  return sequelize.transaction(async t => {
    const { society, invoice, payment } = await lockPayment(paymentId, t, { kind: 'PAYMENT' });
    if (payment.status !== 'CREATED' || payment.origin === 'PLATFORM') return false;
    payment.set({
      status: 'FAILED',
      failureReason: reason.slice(0, 300),
      ...(gatewayPaymentId ? { gatewayPaymentId } : {}),
      updatedBy: actorId(ctx),
      version: payment.version + 1,
    });
    await payment.save({ transaction: t });
    await audit(
      ctx,
      {
        action: 'platform_billing.payment.failed',
        entityType: 'platform_payment',
        entityId: payment.id!,
        entityLabel: invoice?.invoiceNo ?? null,
        societyId: payment.societyId,
        after: { reason },
      },
      t,
    );
    if (payment.createdBy)
      notifyAfterCommit(t, 'platform_billing.payment_failed', [payment.createdBy], {
        amountPaise: num(payment.amountPaise),
        invoiceNo: invoice?.invoiceNo ?? null,
        societyName: society.name,
      });
    emitPaymentUpdated(t, payment);
    return true;
  });
}

// ------------------------------------------------------------------ 8.6 verify
async function invoiceSummary(invoiceId: number | null) {
  if (!invoiceId) return null;
  const inv = await PlatformInvoice.findByPk(invoiceId, { attributes: ['id', 'status', 'amountDuePaise'] });
  return inv ? { id: inv.id!, status: inv.status, amountDuePaise: num(inv.amountDuePaise) } : null;
}

export async function verifyPayment(
  ctx: Ctx,
  societyId: number,
  paymentId: number,
  gatewayPaymentId: string,
) {
  const p = await PlatformPayment.findOne({ where: { id: paymentId, societyId, kind: 'PAYMENT' } });
  if (!p) throw new NotFoundError('PLATFORM_PAYMENT_NOT_FOUND', 'Payment not found');
  if (p.status === 'REJECTED' || p.origin === 'PLATFORM' || p.status === 'PENDING_APPROVAL')
    throw invalidState('This payment cannot be verified');
  const done = async (status: string) => ({
    paymentId: p.id!,
    status,
    invoice: await invoiceSummary(p.invoiceId),
  });
  if (p.status === 'CAPTURED') return done('CAPTURED');
  if (!p.gatewayOrderId) throw invalidState('This payment has no gateway order');
  let info;
  try {
    info = await paymentGateway().fetchPayment(gatewayPaymentId);
  } catch (err) {
    logger.warn({ err, paymentId }, 'platform gateway fetchPayment failed');
    throw gatewayError();
  }
  const gw = {
    paymentId: gatewayPaymentId,
    orderId: info.orderId,
    amountPaise: info.amountPaise,
    method: info.method,
  };
  if (info.orderId !== p.gatewayOrderId || info.amountPaise !== num(p.amountPaise)) {
    await confirmGatewayPayment(ctx, p.id!, gw); // records the mismatch (audit, notification), settles nothing
    throw new UnprocessableError('PAYMENT_MISMATCH', 'The payment does not match the order');
  }
  if (info.status === 'captured') {
    await confirmGatewayPayment(ctx, p.id!, gw);
    return done('CAPTURED');
  }
  if (info.status === 'failed') {
    await failGatewayPayment(ctx, p.id!, 'Payment failed at the gateway', gatewayPaymentId);
    return done((await PlatformPayment.findByPk(p.id!))!.status);
  }
  return done('CREATED');
}

// ------------------------------------------------------------------ 8.18 manual payment
export interface ManualPaymentInput {
  societyId: number;
  invoiceId?: number;
  method: 'NEFT' | 'RTGS' | 'IMPS' | 'CHEQUE' | 'UPI' | 'DD';
  amountPaise: number;
  receivedOn: string;
  bankReference: string;
  payerBankName?: string;
  attachmentFileId?: number;
  notes?: string;
}

export const bankRefKeyOf = (method: string, reference: string): string =>
  `${method}:${reference.trim().toUpperCase()}`.slice(0, 64);

export async function recordManualPayment(ctx: Ctx, input: ManualPaymentInput) {
  const today = todayIst();
  if (input.receivedOn > today)
    throw new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [
      { field: 'receivedOn', message: 'The date cannot be in the future' },
    ]);
  if (input.receivedOn < addDaysYmd(today, -180))
    throw new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [
      { field: 'receivedOn', message: 'The date cannot be more than 180 days ago' },
    ]);
  return sequelize.transaction(async t => {
    const society = await Society.findByPk(input.societyId, { transaction: t });
    if (!society) throw new NotFoundError('NOT_FOUND', 'Society not found');
    await lockSociety(input.societyId, t);
    let invoice: PlatformInvoice | null = null;
    if (input.invoiceId) {
      invoice = await PlatformInvoice.findByPk(input.invoiceId, { transaction: t });
      if (!invoice || invoice.societyId !== input.societyId || invoice.documentType !== 'INVOICE')
        throw invoiceNotFound();
      if (['DRAFT', 'REJECTED', 'VOID', 'WRITTEN_OFF'].includes(invoice.status))
        throw new ConflictError('INVOICE_NOT_PAYABLE', 'This invoice cannot take a payment');
    }
    if (input.attachmentFileId)
      await billingPorts().files.link(
        ctx,
        { fileId: input.attachmentFileId, purpose: 'PLATFORM_ATTACHMENT', societyId: input.societyId },
        t,
      );
    const bankRefKey = bankRefKeyOf(input.method, input.bankReference);
    const dup = () =>
      new ConflictError('DUPLICATE_BANK_REFERENCE', 'This bank reference is already recorded');
    if (await PlatformPayment.findOne({ where: { bankRefKey }, attributes: ['id'], transaction: t }))
      throw dup();
    let p: PlatformPayment;
    try {
      p = await PlatformPayment.create(
        {
          societyId: input.societyId,
          invoiceId: invoice?.id ?? null,
          kind: 'PAYMENT',
          origin: 'PLATFORM',
          status: 'PENDING_APPROVAL',
          method: input.method,
          amountPaise: input.amountPaise,
          appliedPaise: 0,
          bankReference: input.bankReference.trim(),
          bankRefKey,
          payerBankName: input.payerBankName ?? null,
          receivedOn: input.receivedOn,
          attachmentFileId: input.attachmentFileId ?? null,
          notes: input.notes ?? null,
          createdBy: actorId(ctx),
          updatedBy: actorId(ctx),
          version: 1,
        } as never,
        { transaction: t },
      );
    } catch (err) {
      if (err instanceof UniqueConstraintError) throw dup();
      throw err;
    }
    await audit(
      ctx,
      {
        action: 'platform_billing.payment.recorded',
        entityType: 'platform_payment',
        entityId: p.id!,
        entityLabel: invoice?.invoiceNo ?? society.name,
        societyId: input.societyId,
        after: { method: input.method, amountPaise: input.amountPaise, invoiceId: invoice?.id ?? null },
      },
      t,
    );
    notifyPlatform(
      t,
      'platform_billing.approval_pending',
      'platform.billing.approve',
      { what: 'Manual payment', amountPaise: input.amountPaise, societyName: society.name },
      actorId(ctx),
    );
    return {
      id: p.id!,
      status: p.status,
      amountPaise: num(p.amountPaise),
      invoiceId: p.invoiceId,
      version: p.version,
    };
  });
}

// ------------------------------------------------------------------ 8.19 approve / reject (manual payment and refund)
const IST_NOON_UTC = 'T06:30:00.000Z';

export async function approvePayment(ctx: Ctx, paymentId: number, input: { version: number }) {
  return sequelize.transaction(async t => {
    const { society, invoice, payment: p } = await lockPayment(paymentId, t);
    if (p.kind === 'TDS') throw invalidState('A TDS claim is decided with tds-decision');
    assertDecidable(ctx, p, 'PENDING_APPROVAL', input.version, p.kind === 'REFUND' ? 'refund' : 'payment');
    if (p.kind === 'PAYMENT') {
      const capturedAt = new Date(`${p.receivedOn}${IST_NOON_UTC}`);
      p.set({ approvedBy: ctx.user!.id, approvedAt: now() });
      const { applied, excess } = await applyCapturedPayment(ctx, p, invoice, capturedAt, t);
      await audit(
        ctx,
        {
          action: 'platform_billing.payment.approved',
          entityType: 'platform_payment',
          entityId: p.id!,
          entityLabel: invoice?.invoiceNo ?? society.name,
          societyId: p.societyId,
          after: { amountPaise: num(p.amountPaise), appliedPaise: applied, excessPaise: excess },
        },
        t,
      );
      notifySubscriptionViewers(t, 'platform_billing.payment_received', p.societyId, {
        amountPaise: num(p.amountPaise),
        societyName: society.name,
        invoiceNo: invoice?.invoiceNo ?? null,
      });
      emitAfterCommit(t, [
        {
          room: `society:${p.societyId}:admin`,
          event: 'platform_billing.billing.changed',
          payload: { invoiceId: p.invoiceId },
        },
      ]);
    } else {
      let gatewayRefundId: string | null = null;
      if (p.method === 'GATEWAY_REFUND') {
        const src = p.sourcePaymentId
          ? await PlatformPayment.findByPk(p.sourcePaymentId, { transaction: t })
          : null;
        if (!src?.gatewayPaymentId) throw invalidState('The source payment has no gateway payment');
        try {
          gatewayRefundId = (
            await paymentGateway().refund(src.gatewayPaymentId, num(p.amountPaise), p.reason ?? 'Refund')
          ).refundId;
        } catch (err) {
          logger.warn({ err, paymentId }, 'platform gateway refund failed');
          throw gatewayError();
        }
      }
      p.set({
        status: 'PROCESSING',
        gatewayRefundId,
        approvedBy: ctx.user!.id,
        approvedAt: now(),
        updatedBy: ctx.user!.id,
        version: p.version + 1,
      });
      await p.save({ transaction: t });
      await audit(
        ctx,
        {
          action: 'platform_billing.refund.approved',
          entityType: 'platform_payment',
          entityId: p.id!,
          entityLabel: society.name,
          societyId: p.societyId,
          after: { amountPaise: num(p.amountPaise), method: p.method, gatewayRefundId },
        },
        t,
      );
    }
    return paymentDetail(p, invoice?.invoiceNo ?? null);
  });
}

export async function rejectPayment(ctx: Ctx, paymentId: number, input: { version: number; reason: string }) {
  return sequelize.transaction(async t => {
    const { society, invoice, payment: p } = await lockPayment(paymentId, t);
    if (p.kind === 'TDS') throw invalidState('A TDS claim is decided with tds-decision');
    assertDecidable(ctx, p, 'PENDING_APPROVAL', input.version, p.kind === 'REFUND' ? 'refund' : 'payment');
    p.set({
      status: 'REJECTED',
      bankRefKey: null,
      rejectedReason: input.reason,
      decidedBy: ctx.user!.id,
      decidedAt: now(),
      updatedBy: ctx.user!.id,
      version: p.version + 1,
    });
    await p.save({ transaction: t });
    if (p.kind === 'REFUND') {
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
    }
    await audit(
      ctx,
      {
        action:
          p.kind === 'REFUND' ? 'platform_billing.refund.rejected' : 'platform_billing.payment.rejected',
        entityType: 'platform_payment',
        entityId: p.id!,
        entityLabel: invoice?.invoiceNo ?? society.name,
        societyId: p.societyId,
        reason: input.reason,
        after: { status: 'REJECTED' },
      },
      t,
    );
    return paymentDetail(p, invoice?.invoiceNo ?? null);
  });
}
