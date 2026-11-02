/**
 * Autopay (8.11, flag `platform.autopay`): mandate set-up and cancellation through the gateway adapter, with the state
 * kept on the module 04 subscription (`setAutopay`). Charging active mandates is the `autopay-charge` job (later task).
 */
import { PlatformInvoice, Subscription, sequelize } from '../../models';
import { paymentGateway } from '../../adapters';
import { env } from '../../lib/env';
import { addDays, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { subscriptions } from '../subscriptions/subscriptions.public';
import { lockSociety, todayIst } from './platform-billing.settlement';
import { actorId, invalidState, num } from './platform-billing.shared';

const gatewayError = () => new AppError(502, 'GATEWAY_ERROR', 'The payment gateway could not be reached');

async function subscriptionOf(societyId: number, t?: import('sequelize').Transaction): Promise<Subscription> {
  const sub = await Subscription.findOne({ where: { societyId }, order: [['id', 'DESC']], transaction: t });
  if (!sub) throw new NotFoundError('SUBSCRIPTION_NOT_FOUND', 'No subscription found');
  return sub;
}

export async function requestAutopay(
  ctx: Ctx,
  societyId: number,
  input: { method: 'UPI_AUTOPAY' | 'EMANDATE'; maxAmountPaise: number },
) {
  const check = async (t: import('sequelize').Transaction) => {
    await lockSociety(societyId, t);
    const sub = await subscriptionOf(societyId, t);
    if (['PENDING', 'ACTIVE'].includes(sub.autopayStatus))
      throw new ConflictError('MANDATE_ALREADY_ACTIVE', 'Autopay is already set up or waiting for approval');
    return sub;
  };
  const sub = await sequelize.transaction(async t => {
    const s = await check(t);
    const last = await PlatformInvoice.findOne({
      where: {
        societyId,
        documentType: 'INVOICE',
        invoiceKind: 'PERIOD',
        status: ['ISSUED', 'PARTIALLY_PAID', 'OVERDUE', 'PAID'],
      },
      order: [['id', 'DESC']],
      transaction: t,
    });
    if (last && input.maxAmountPaise < num(last.totalPaise))
      throw new UnprocessableError('MANDATE_LIMIT_TOO_LOW', 'The limit is below your last invoice', [
        { field: 'maxAmountPaise', message: `At least ${num(last.totalPaise)} paise` },
      ]);
    return s;
  });
  let mandate: { mandateId: string; authUrl: string };
  try {
    mandate = await paymentGateway().createMandate({
      societyGatewayAccountId: env().PLATFORM_GATEWAY_ACCOUNT_ID,
      customerRef: `society-${societyId}`,
      maxAmountPaise: input.maxAmountPaise,
      frequency: 'AS_PRESENTED',
      startDate: todayIst(),
      endDate: addDays(now(), 3650).toISOString().slice(0, 10),
    });
  } catch (err) {
    logger.warn({ err, societyId }, 'platform gateway createMandate failed');
    throw gatewayError();
  }
  try {
    await sequelize.transaction(async t => {
      await check(t);
      await subscriptions.setAutopay(
        ctx,
        sub.id!,
        {
          autopayStatus: 'PENDING',
          autopayMethod: input.method,
          autopayMandateRef: mandate.mandateId,
          autopayMaxAmountPaise: input.maxAmountPaise,
        },
        t,
      );
      await audit(
        ctx,
        {
          action: 'platform_billing.autopay.requested',
          entityType: 'subscription',
          entityId: sub.id!,
          societyId,
          after: { method: input.method, maxAmountPaise: input.maxAmountPaise },
        },
        t,
      );
    });
  } catch (err) {
    await paymentGateway()
      .cancelMandate(mandate.mandateId)
      .catch(() => undefined);
    throw err;
  }
  return { authUrl: mandate.authUrl };
}

export async function cancelAutopay(ctx: Ctx, societyId: number) {
  const sub = await subscriptionOf(societyId);
  if (!['PENDING', 'ACTIVE'].includes(sub.autopayStatus) || !sub.autopayMandateRef)
    throw invalidState('There is no autopay to cancel');
  try {
    await paymentGateway().cancelMandate(sub.autopayMandateRef);
  } catch (err) {
    logger.warn({ err, societyId }, 'platform gateway cancelMandate failed');
    throw gatewayError();
  }
  await sequelize.transaction(async t => {
    await lockSociety(societyId, t);
    await subscriptions.setAutopay(ctx, sub.id!, { autopayStatus: 'CANCELLED' }, t);
    await audit(
      ctx,
      {
        action: 'platform_billing.autopay.cancelled',
        entityType: 'subscription',
        entityId: sub.id!,
        societyId,
        before: { autopayStatus: sub.autopayStatus },
        after: { autopayStatus: 'CANCELLED', cancelledBy: actorId(ctx) },
      },
      t,
    );
  });
  return { autopayStatus: 'CANCELLED' as const };
}

/** Webhook `mandate.activated` and `mandate.cancelled`: state checks make a repeat a no-op. */
export async function settleMandateEvent(ctx: Ctx, mandateId: string, activated: boolean): Promise<string> {
  const sub = await Subscription.findOne({ where: { autopayMandateRef: mandateId } });
  if (!sub) return 'ignored: unknown mandate';
  const target = activated ? 'ACTIVE' : 'CANCELLED';
  return sequelize.transaction(async t => {
    await lockSociety(sub.societyId, t);
    const fresh = await Subscription.findByPk(sub.id!, { transaction: t });
    if (!fresh || fresh.autopayStatus === target) return 'unchanged';
    if (activated && fresh.autopayStatus !== 'PENDING') return 'unchanged';
    try {
      await subscriptions.setAutopay(ctx, fresh.id!, { autopayStatus: target }, t);
    } catch (err) {
      if (err instanceof NotFoundError) return 'ignored: autopay is off';
      throw err;
    }
    await audit(
      ctx,
      {
        action: activated ? 'platform_billing.autopay.activated' : 'platform_billing.autopay.cancelled',
        entityType: 'subscription',
        entityId: fresh.id!,
        societyId: fresh.societyId,
        after: { autopayStatus: target },
      },
      t,
    );
    return activated ? 'activated' : 'cancelled';
  });
}
