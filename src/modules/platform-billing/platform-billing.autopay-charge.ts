/**
 * `platform-billing:autopay-charge` (daily 06:00 IST, section 9.1): charges active mandates for invoices due today and
 * retries on day +1 and +3 after the due date. At most one `CREATED` payment per invoice per day (`origin SYSTEM`).
 */
import { Op } from 'sequelize';
import { PlatformInvoice, PlatformPayment, Subscription, sequelize } from '../../models';
import { paymentGateway } from '../../adapters';
import { logger } from '../../lib/logger';
import { send } from '../societies/societies.notify';
import { isFlagOn } from '../subscriptions/flags.service';
import { addDaysYmd, OPEN_STATUSES } from './pricing';
import { confirmGatewayPayment, failGatewayPayment } from './platform-billing.payments';
import { payersOf } from './platform-billing.notify';
import { lockSociety, todayIst } from './platform-billing.settlement';
import { SYSTEM_CTX, isOpenInvoice, num } from './platform-billing.shared';
import { istDate } from '../../lib/clock';

export const AUTOPAY_RETRY_OFFSETS = [0, 1, 3] as const;

export interface AutopayResult {
  mandates: number;
  charged: number;
  failed: number;
  skipped: number;
}

export async function runAutopayCharge(today: string = todayIst()): Promise<AutopayResult> {
  const r: AutopayResult = { mandates: 0, charged: 0, failed: 0, skipped: 0 };
  const ctx = SYSTEM_CTX('autopay');
  const subs = await Subscription.findAll({
    where: { autopayStatus: 'ACTIVE', autopayMandateRef: { [Op.ne]: null } },
  });
  const dueDates = AUTOPAY_RETRY_OFFSETS.map(o => addDaysYmd(today, -o));
  for (const sub of subs) {
    r.mandates += 1;
    if (!(await isFlagOn('platform.autopay', { societyId: sub.societyId }))) {
      r.skipped += 1;
      continue;
    }
    const invoices = await PlatformInvoice.findAll({
      where: {
        societyId: sub.societyId,
        documentType: 'INVOICE',
        status: OPEN_STATUSES as unknown as string[],
        amountDuePaise: { [Op.gt]: 0 },
        dueDate: dueDates,
      },
      order: [['id', 'ASC']],
    });
    for (const invRow of invoices) {
      try {
        const prepared = await sequelize.transaction(async t => {
          await lockSociety(sub.societyId, t);
          const inv = await PlatformInvoice.findByPk(invRow.id!, { transaction: t, lock: t.LOCK.UPDATE });
          if (!inv || !isOpenInvoice(inv)) return null;
          const amount = num(inv.amountDuePaise);
          if (amount > num(sub.autopayMaxAmountPaise)) return 'LIMIT' as const;
          const todays = await PlatformPayment.findAll({
            where: { invoiceId: inv.id!, kind: 'PAYMENT', origin: 'SYSTEM' },
            attributes: ['id', 'createdAt'],
            transaction: t,
          });
          if (todays.some(p => istDate(p.createdAt!) === today)) return null; // one attempt per invoice per day
          const payment = await PlatformPayment.create(
            {
              societyId: sub.societyId,
              invoiceId: inv.id!,
              kind: 'PAYMENT',
              origin: 'SYSTEM',
              status: 'CREATED',
              method: sub.autopayMethod,
              amountPaise: amount,
              appliedPaise: 0,
              createdBy: null,
              updatedBy: null,
              version: 1,
            } as never,
            { transaction: t },
          );
          return { payment, invoiceNo: inv.invoiceNo! };
        });
        if (prepared === 'LIMIT') {
          r.skipped += 1;
          continue;
        }
        if (!prepared) continue;
        const { payment, invoiceNo } = prepared;
        try {
          const charge = await paymentGateway().chargeMandate({
            mandateId: sub.autopayMandateRef!,
            amountPaise: num(payment.amountPaise),
            receipt: `PLTPAY-${payment.id}`,
          });
          await sequelize.transaction(async t => {
            const p = await PlatformPayment.findByPk(payment.id!, { transaction: t, lock: t.LOCK.UPDATE });
            p!.set({ gatewayOrderId: charge.orderId, version: p!.version + 1 });
            await p!.save({ transaction: t });
          });
          if (!charge.paymentId) continue; // the webhook or reconcile job settles it
          const info = await paymentGateway().fetchPayment(charge.paymentId);
          if (info.status === 'captured') {
            const out = await confirmGatewayPayment(ctx, payment.id!, {
              paymentId: charge.paymentId,
              orderId: info.orderId,
              amountPaise: info.amountPaise,
              method: info.method,
            });
            if (out === 'CAPTURED') r.charged += 1;
          } else if (info.status === 'failed') throw new Error('The mandate charge failed');
        } catch (err) {
          r.failed += 1;
          logger.warn({ err, paymentId: payment.id }, 'platform autopay charge failed');
          await failGatewayPayment(
            ctx,
            payment.id!,
            err instanceof Error ? err.message : 'Autopay charge failed',
          );
          await send('platform_billing.payment_failed', await payersOf(sub.societyId), {
            amountPaise: num(payment.amountPaise),
            invoiceNo,
          });
        }
      } catch (err) {
        r.failed += 1;
        logger.error({ err, invoiceId: invRow.id }, 'platform autopay run failed for an invoice');
      }
    }
  }
  logger.info(r, 'platform-billing:autopay-charge done');
  return r;
}
