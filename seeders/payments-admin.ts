import { Op } from 'sequelize';
import { Payment, Society, Unit } from '../src/models';
import { istDate, now } from '../src/lib/clock';
import { addDaysYmd } from '../src/modules/billing/billing.calc.period';
import { residents } from '../src/modules/residents/residents.public';
import { settleInput } from '../src/modules/payments/payments.settle';
import { renderReceiptFor } from '../src/modules/payments/payments.receipts.service';
import { moneyTx } from '../src/modules/payments/payments.shared';
import type { PaymentMethod } from '../src/modules/payments/payments.constants';
import { systemCtx } from '../src/types/context';
import type { PaymentsSeedReport } from './payments';

/**
 * Module 12.3 demo seed (not run in production): recorded payments in Sky Heights CHS so the payments list, the live feed, the
 * summary and the receipts have rows. They are made through the money core (`settleInput`, the flow every part uses: allocation
 * oldest first, the rest to the flat's advance, gapless receipt number, ledger credit, journal, audit), never written by hand.
 * Three payments (UPI, cash, NEFT) for each of the first 12 flats with an owner, dated over the last 80 days. Idempotent by
 * `referenceKey = DEMO:PAY:<flat>:<n>`; the receipt PDF is rendered here with the `payments:render-receipt` function.
 */
const PLAN: { method: PaymentMethod; amountPaise: number; daysAgo: number }[] = [
  { method: 'UPI', amountPaise: 850_000, daysAgo: 75 },
  { method: 'CASH', amountPaise: 400_000, daysAgo: 40 },
  { method: 'NEFT', amountPaise: 1_250_000, daysAgo: 6 },
];
const FLATS = 12;

export async function seedPaymentsAdmin(): Promise<PaymentsSeedReport> {
  if (process.env.NODE_ENV === 'production') throw new Error('payments demo seed must not run in production');
  const report: PaymentsSeedReport = { created: [], skipped: [] };
  const society = await Society.findOne({ where: { slug: 'sky-heights' } });
  if (!society) {
    report.skipped.push('sky-heights (no demo society)');
    return report;
  }
  const societyId = Number(society.id);
  const today = istDate(now());
  const flats = await Unit.findAll({
    where: { societyId, status: 'ACTIVE' },
    attributes: ['id', 'label'],
    order: [['label', 'ASC']],
    limit: 60,
  });
  const ctx = {
    ...systemCtx('seed'),
    society: {
      id: societyId,
      name: society.name,
      status: society.status,
      timezone: 'Asia/Kolkata',
      planKey: '',
    },
  };
  let done = 0;
  for (const f of flats) {
    if (done >= FLATS) break;
    const billTo = await residents.billToFor(Number(f.id), today);
    if (!billTo) continue;
    done++;
    for (const [i, step] of PLAN.entries()) {
      const key = `DEMO:PAY:${f.label}:${i + 1}`;
      if (await Payment.count({ where: { societyId, referenceKey: { [Op.eq]: key } } })) {
        report.skipped.push(`${f.label} #${i + 1}`);
        continue;
      }
      const { payment, created } = await moneyTx(t =>
        settleInput(
          ctx,
          {
            societyId,
            unitId: Number(f.id),
            source: 'OFFLINE',
            method: step.method,
            status: 'CONFIRMED',
            payerUserId: null,
            payerName: billTo.name,
            amountPaise: step.amountPaise,
            paymentDate: addDaysYmd(today, -step.daysAgo),
            referenceNo: step.method === 'CASH' ? null : `DEMO${f.label.replace(/\W/g, '')}${i + 1}`,
            referenceKey: key,
            mode: 'OLDEST_FIRST',
            notes: 'Demo payment',
          },
          t,
        ),
      );
      if (created) {
        await renderReceiptFor(Number(payment.id));
        report.created.push(`${f.label} #${i + 1}`);
      } else report.skipped.push(`${f.label} #${i + 1}`);
    }
  }
  return report;
}
