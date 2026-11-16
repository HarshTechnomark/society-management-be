import { drainQueues } from '../../src/lib/queue';
import { Invoice, sequelize } from '../../src/models';
import { invoices } from '../../src/modules/billing/billing.public';
import { registerPayments, setPaymentsPorts } from '../../src/modules/payments/payments.public';
import { setPaymentGateway } from '../../src/adapters';
import { FakePaymentGateway } from '../../src/adapters/payments/payment-gateway';
import type { SettleInput } from '../../src/modules/payments/payments.types';
import { invoiceWorld, resetInvoices, sysCtx } from './billing-invoices';
import type { RunSociety } from './billing-runs';

export { sysCtx };

/** Fresh state for module 12 tests: the module 11 reset plus module 12 registration and placeholder ports. Call from `beforeEach`. */
export async function resetPayments(): Promise<FakePaymentGateway> {
  await resetInvoices();
  setPaymentsPorts();
  registerPayments();
  const gw = new FakePaymentGateway();
  setPaymentGateway(gw);
  return gw;
}

export const paymentsWorld = (o: Parameters<typeof invoiceWorld>[0] = {}): Promise<RunSociety> =>
  invoiceWorld(o);

/** A WATER (no GST) ad-hoc invoice of exactly `amountPaise`, due on `dueDate`. */
export async function mkInvoice(
  w: RunSociety,
  unitIndex: number,
  amountPaise: number,
  dueDate: string,
  refId = Math.floor(Math.random() * 1e9) + 1,
): Promise<Invoice> {
  const r = await sequelize.transaction(t =>
    invoices.createAdHoc(
      sysCtx(w),
      {
        unitId: w.units[unitIndex]!.id,
        chargeHeadKey: 'WATER',
        amountPaise,
        refType: 'test_charge',
        refId,
        dueDate,
      },
      t,
    ),
  );
  if (r.totalPaise !== amountPaise) throw new Error(`invoice total ${r.totalPaise} != ${amountPaise}`);
  return (await Invoice.findByPk(r.invoiceId))!;
}

let seq = 0;
export const offline = (
  w: RunSociety,
  unitIndex: number,
  amountPaise: number,
  o: Partial<SettleInput> = {},
): SettleInput => ({
  societyId: w.society.id!,
  unitId: w.units[unitIndex]!.id,
  source: 'OFFLINE',
  method: 'NEFT',
  status: 'CONFIRMED',
  payerUserId: null,
  payerName: 'Test Payer',
  amountPaise,
  paymentDate: '2026-11-04',
  mode: 'OLDEST_FIRST',
  referenceNo: `UTR${String(++seq).padStart(10, '0')}`,
  referenceKey: `BANK:UTR${String(seq).padStart(10, '0')}`,
  ...o,
});

export const settle = () => drainQueues();
