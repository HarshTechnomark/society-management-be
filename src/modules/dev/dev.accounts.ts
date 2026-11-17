import { Op } from 'sequelize';
import { Payment, Settlement } from '../../models';
import { AppError } from '../../utils/errors';
import { systemCtx, type Ctx } from '../../types/context';
import { moneyTx, withSociety } from '../payments/payments.shared';
import { ingestSettlement } from '../accounts/accounts.settlements.service';
import { n } from '../accounts/accounts.shared';
import { societyToday } from '../billing/billing.runs.shared';

/**
 * Development only (module 13.3a): the fake gateway has no settlement API, so this builds the settlement the gateway would pay out
 * for the captured online payments that no settlement lists yet (2 % fee, 18 % GST on the fee), so the browser test can reconcile
 * real captured payments. Body `{ societyId, date?, reconcile? }`; `reconcile: true` also lets the reconcile job run at once.
 */
export async function devGenerateSettlement(body: {
  societyId?: unknown;
  date?: unknown;
  reconcile?: unknown;
}) {
  const societyId = Number(body.societyId);
  if (!Number.isInteger(societyId) || societyId < 1)
    throw new AppError(400, 'VALIDATION_FAILED', 'societyId is required');
  const date =
    typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : await societyToday(societyId);
  const settled = new Set<string>();
  for (const s of await Settlement.findAll({ where: { societyId }, attributes: ['items'] }))
    for (const i of s.items) settled.add(i.gatewayPaymentId);
  const pays = (
    await Payment.findAll({
      where: {
        societyId,
        source: { [Op.in]: ['ONLINE', 'AUTOPAY'] },
        status: 'CAPTURED',
        gatewayPaymentId: { [Op.ne]: null },
      },
      order: [['id', 'ASC']],
    })
  ).filter(p => !settled.has(p.gatewayPaymentId!));
  if (!pays.length)
    throw new AppError(422, 'NOTHING_TO_SETTLE', 'No captured online payment is waiting for a settlement');
  const items = pays.map(p => {
    const amountPaise = n(p.grossAmountPaise);
    const feePaise = Math.round(amountPaise * 0.02);
    return {
      type: 'payment' as const,
      gatewayPaymentId: p.gatewayPaymentId!,
      amountPaise,
      feePaise,
      taxPaise: Math.round(feePaise * 0.18),
    };
  });
  const gross = items.reduce((a, i) => a + i.amountPaise, 0);
  const fee = items.reduce((a, i) => a + i.feePaise, 0);
  const tax = items.reduce((a, i) => a + i.taxPaise, 0);
  const tag = Date.now().toString(36);
  const ctx: Ctx = withSociety(systemCtx('dev-settlement'), societyId);
  const r = await moneyTx(t =>
    ingestSettlement(
      ctx,
      {
        gatewayProvider: 'RAZORPAY',
        gatewaySettlementId: `setl_dev_${tag}`,
        settlementDate: date,
        utr: `UTRDEV${tag}`.toUpperCase().slice(0, 30),
        feePaise: fee,
        feeGstPaise: tax,
        adjustmentPaise: 0,
        netPaise: gross - fee - tax,
        items,
        skipEnqueue: body.reconcile !== true,
      },
      t,
    ),
  );
  return {
    settlementId: r.settlementId,
    gatewaySettlementId: `setl_dev_${tag}`,
    payments: items.length,
    grossPaise: gross,
    netPaise: gross - fee - tax,
  };
}
