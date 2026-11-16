import { createHash } from 'node:crypto';
import { UniqueConstraintError } from 'sequelize';
import { logger } from '../../lib/logger';
import { enqueue } from '../../lib/queue';
import { now } from '../../lib/clock';
import { Payment, PaymentOrder, PaymentWebhookEvent } from '../../models';
import { AppError, NotFoundError } from '../../utils/errors';
import { systemCtx } from '../../types/context';
import { ERR, JOBS, NOTIFY, PAYMENTS_QUEUE, type WebhookStatus } from './payments.constants';
import {
  accountOf,
  fetchGatewayPayment,
  settleFetched,
  treasurerIds,
  webhookSecretsOf,
} from './payments.orders.gateway';
import { pullFromGateway } from './payments.orders.service';
import { paymentsPorts, type GatewayAccountDto } from './payments.ports';
import { handleMandateEvent } from './payments.autopay.service';
import { handleRefundEvent } from './payments.refunds.service';
import { reversePaymentCore } from './payments.reverse.core';
import { moneyTx, n } from './payments.shared';
import type { AnyCtx } from './payments.types';

/**
 * The webhook inbox (8.25, BR-12-9, BR-12-10, 6.6). The route verifies the signature on the raw bytes, stores the event once
 * (unique `gatewayAccountId + providerEventId`), enqueues `payments:process-webhook` and answers. The job re-reads the
 * payment from the gateway (the payload is never trusted for money) and calls the core `settleCapture`.
 */
export const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_ATTEMPTS = 5;
const REDACT = new Set(['contact', 'email', 'vpa', 'card', 'bank_account']);

/** Removes card, VPA and contact fields at any depth (section 13). */
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .filter(([k]) => !REDACT.has(k))
        .map(([k, x]) => [k, redact(x)]),
    );
  return v;
}

export interface IngestResult {
  received: true;
  duplicate?: true;
  eventId?: number;
}

/** Steps 1 to 4 of 8.25. Unknown account is `404 NOT_FOUND`; a wrong signature is `400 WEBHOOK_SIGNATURE_INVALID` and stores nothing. */
export async function ingestWebhook(
  gatewayAccountId: number,
  raw: Buffer | undefined,
  signature: string,
  account?: GatewayAccountDto | null,
): Promise<IngestResult> {
  const acct = account ?? (await paymentsPorts().gateways.getAccount(gatewayAccountId));
  if (!acct) {
    logger.warn({ gatewayAccountId }, 'webhook for an unknown gateway account');
    throw new NotFoundError('NOT_FOUND', 'Not found');
  }
  if (!raw) throw new AppError(400, 'VALIDATION_FAILED', 'The webhook body is missing');
  if (raw.length > MAX_WEBHOOK_BYTES)
    throw new AppError(413, 'VALIDATION_FAILED', 'The webhook body is too large');
  const client = paymentsPorts().gateways.clientFor(acct);
  const valid = webhookSecretsOf(acct).some(secret => client.verifyWebhook(raw, signature, secret));
  if (!valid) {
    logger.warn({ gatewayAccountId }, 'webhook signature invalid');
    throw new AppError(400, ERR.webhookSignatureInvalid, 'The webhook signature is not valid');
  }
  let parsed;
  let body: unknown;
  try {
    parsed = client.parseWebhook(raw);
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new AppError(400, 'VALIDATION_FAILED', 'The webhook body could not be read');
  }
  const providerEventId = parsed.eventId || createHash('sha256').update(raw).digest('hex');
  let payload = redact(body) as Record<string, unknown>;
  if (JSON.stringify(payload).length > 64 * 1024) payload = { truncated: true };
  let ev: PaymentWebhookEvent;
  try {
    ev = await PaymentWebhookEvent.create({
      societyId: acct.societyId,
      gatewayAccountId: acct.id,
      provider: acct.provider,
      providerEventId: providerEventId.slice(0, 120),
      eventType: (parsed.type || 'unknown').slice(0, 60),
      gatewayOrderId: parsed.orderId ?? null,
      gatewayPaymentId: parsed.paymentId ?? null,
      gatewayRefundId: parsed.refundId ?? null,
      gatewayMandateId: parsed.mandateId ?? null,
      amountPaise: parsed.amountPaise ?? null,
      payload,
      status: 'RECEIVED',
      attempts: 0,
      lastError: null,
      processedAt: null,
      reviewedBy: null,
      createdBy: null,
      updatedBy: null,
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError) return { received: true, duplicate: true };
    throw err;
  }
  await enqueue(PAYMENTS_QUEUE, JOBS.processWebhook, { eventId: n(ev.id) }, { jobId: `pwe:${ev.id}` }).catch(
    err =>
      logger.error(
        { err, eventId: ev.id },
        'could not enqueue process-webhook (the reconcile job will settle)',
      ),
  );
  return { received: true, eventId: n(ev.id) };
}

// ---------------------------------------------------------------- processing
export type HandlerResult = 'PROCESSED' | 'IGNORED' | { status: 'NEEDS_REVIEW'; reason: string };
export type WebhookHandler = (
  ev: PaymentWebhookEvent,
  account: GatewayAccountDto,
  ctx: AnyCtx,
) => Promise<HandlerResult>;
const handlers = new Map<string, WebhookHandler>();
/** Parts that own other event types (12.4: `refund.processed`, `refund.failed`, `mandate.*`) register here; unhandled types are `IGNORED`. */
export const registerWebhookHandler = (types: string[], h: WebhookHandler): void => {
  for (const t of types) handlers.set(t, h);
};
export const clearWebhookHandlers = (): void => handlers.clear();

const notifyTreasurers = async (societyId: number, data: Record<string, unknown>) => {
  const ids = await treasurerIds(societyId);
  if (ids.length)
    await paymentsPorts()
      .notifications.send(NOTIFY.needsReview, ids, { societyId, ...data })
      .catch(err => logger.error({ err }, 'needs_review notification failed'));
};

async function handleCapture(
  ev: PaymentWebhookEvent,
  account: GatewayAccountDto,
  ctx: AnyCtx,
): Promise<HandlerResult> {
  if (!ev.gatewayPaymentId) {
    // `order.paid` without a payment id: read the order's payments from the gateway
    const o = ev.gatewayOrderId
      ? await PaymentOrder.findOne({
          where: { gatewayAccountId: account.id, gatewayOrderId: ev.gatewayOrderId },
        })
      : null;
    if (!o) return { status: 'NEEDS_REVIEW', reason: 'UNKNOWN_ORDER' };
    await pullFromGateway(o, ctx);
    return 'PROCESSED';
  }
  const gp = await fetchGatewayPayment(account, ev.gatewayPaymentId);
  let out;
  try {
    out = await settleFetched(account.id, gp, ctx);
  } catch (err) {
    // the unit was archived meanwhile: keep the event for the treasurer instead of retrying (BR-12-19)
    if (err instanceof AppError && err.code === ERR.unitNotFound)
      return { status: 'NEEDS_REVIEW', reason: 'UNIT_ARCHIVED' };
    throw err;
  }
  if (out.outcome === 'UNKNOWN_ORDER') return { status: 'NEEDS_REVIEW', reason: 'UNKNOWN_ORDER' };
  if (out.outcome === 'SETTLED' && out.needsReview)
    return { status: 'NEEDS_REVIEW', reason: 'AMOUNT_MISMATCH_OR_CANCELLED_ORDER' };
  if (out.outcome === 'SETTLED' && out.duplicate)
    return { status: 'NEEDS_REVIEW', reason: 'DUPLICATE_PAYMENT' };
  return 'PROCESSED';
}

async function handleDispute(
  ev: PaymentWebhookEvent,
  account: GatewayAccountDto,
  ctx: AnyCtx,
): Promise<HandlerResult> {
  const p = ev.gatewayPaymentId
    ? await Payment.findOne({
        where: { societyId: account.societyId, gatewayPaymentId: ev.gatewayPaymentId },
      })
    : null;
  if (!p) return { status: 'NEEDS_REVIEW', reason: 'UNKNOWN_PAYMENT' };
  if (ev.eventType === 'payment.dispute.created') {
    await p.update({ needsReview: true, version: n(p.version) + 1 });
    await notifyTreasurers(account.societyId, { paymentId: n(p.id), reason: 'DISPUTE' });
    return 'PROCESSED';
  }
  if (['CAPTURED', 'CONFIRMED', 'RECEIVED', 'DEPOSITED', 'CLEARED'].includes(p.status))
    await moneyTx(t =>
      reversePaymentCore(
        ctx,
        n(p.id),
        { newStatus: 'REVERSED', reversalReasonCode: 'CHARGEBACK_LOST', reason: 'The card dispute was lost' },
        t,
      ),
    );
  return 'PROCESSED';
}

/** 12.4 refund results; `NOT_FOUND` retries (the approval that created the refund may still be committing). */
async function handleRefund(
  ev: PaymentWebhookEvent,
  account: GatewayAccountDto,
  ctx: AnyCtx,
): Promise<HandlerResult> {
  if (!ev.gatewayRefundId) return 'IGNORED';
  const r = await handleRefundEvent(ctx, {
    societyId: account.societyId,
    type: ev.eventType as 'refund.processed' | 'refund.failed',
    gatewayRefundId: ev.gatewayRefundId,
    eventId: ev.providerEventId,
  });
  if (r === 'NOT_FOUND') throw new Error('Refund not found yet');
  return r === 'IGNORED' ? 'IGNORED' : 'PROCESSED';
}

/** 12.4 mandate results (nothing else activates a mandate); `NOT_FOUND` retries. */
async function handleMandate(
  ev: PaymentWebhookEvent,
  account: GatewayAccountDto,
  ctx: AnyCtx,
): Promise<HandlerResult> {
  if (!ev.gatewayMandateId) return 'IGNORED';
  const r = await handleMandateEvent(ctx, {
    societyId: account.societyId,
    type: ev.eventType as 'mandate.activated' | 'mandate.rejected' | 'mandate.cancelled',
    gatewayMandateId: ev.gatewayMandateId,
    eventId: ev.providerEventId,
  });
  if (r === 'NOT_FOUND') throw new Error('Mandate not found yet');
  return r === 'IGNORED' ? 'IGNORED' : 'PROCESSED';
}

registerWebhookHandler(['refund.processed', 'refund.failed'], handleRefund);
registerWebhookHandler(['mandate.activated', 'mandate.rejected', 'mandate.cancelled'], handleMandate);
registerWebhookHandler(['payment.captured', 'order.paid', 'payment.failed'], handleCapture);
registerWebhookHandler(['payment.dispute.created', 'payment.dispute.lost'], handleDispute);

/** `payments:process-webhook` body. Skips unless `RECEIVED` or `FAILED_RETRYABLE`; transient errors retry, 5 failures need review. */
export async function processWebhookEvent(
  eventId: number,
  ctx: AnyCtx = systemCtx('webhook'),
): Promise<WebhookStatus | null> {
  const ev = await PaymentWebhookEvent.findByPk(eventId);
  if (!ev) return null;
  if (ev.status !== 'RECEIVED' && ev.status !== 'FAILED_RETRYABLE') return ev.status;
  const handler = handlers.get(ev.eventType);
  const attempts = n(ev.attempts) + 1;
  if (!handler) {
    await ev.update({ status: 'IGNORED', attempts, processedAt: now() });
    return 'IGNORED';
  }
  try {
    const account = await accountOf(n(ev.gatewayAccountId));
    const r = await handler(ev, account, ctx);
    if (r === 'PROCESSED' || r === 'IGNORED') {
      await ev.update({ status: r, attempts, lastError: null, processedAt: now() });
      return r;
    }
    await ev.update({
      status: 'NEEDS_REVIEW',
      attempts,
      lastError: r.reason.slice(0, 500),
      processedAt: now(),
    });
    if (r.reason === 'UNKNOWN_ORDER')
      logger.warn(
        { eventId, gatewayOrderId: ev.gatewayOrderId },
        'webhook for an unknown order needs review',
      );
    return 'NEEDS_REVIEW';
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    if (attempts >= MAX_ATTEMPTS) {
      await ev.update({ status: 'NEEDS_REVIEW', attempts, lastError: msg, processedAt: now() });
      await notifyTreasurers(n(ev.societyId), { reason: 'WEBHOOK_FAILED' });
      return 'NEEDS_REVIEW';
    }
    await ev.update({ status: 'FAILED_RETRYABLE', attempts, lastError: msg });
    throw err;
  }
}
