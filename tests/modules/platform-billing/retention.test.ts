import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DunningEvent,
  PlatformCredit,
  PlatformInvoice,
  PlatformInvoiceLine,
  PlatformPayment,
  Society,
  SocietyLifecycleEvent,
  closeDb,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import {
  BILLING_EXPORT_PROVIDER,
  deleteRetainedBilling,
} from '../../../src/modules/platform-billing/platform-billing.retention';
import { exportProviders } from '../../../src/modules/societies/societies.exports';
import { runFinancialRetention, runPurge } from '../../../src/modules/societies/societies.purge';
import { billedSociety, idemKey, platformTeam, resetBilling } from '../../helpers/billing';

/** Task 6.4: module 05 export provider and retention (section 13, BR-05-22, BR-05-38). */
beforeEach(async () => {
  await resetBilling();
});
afterAll(async () => {
  await drainQueues();
  setNow(null);
  await closeDb();
});

const rowsOf = async (table: string, societyId: number) => {
  const t = BILLING_EXPORT_PROVIDER.tables.find(x => x.name === table)!;
  const out: Record<string, unknown>[] = [];
  for await (const r of t.stream(societyId)) out.push(r);
  return out;
};

/** A society with an invoice, a credit note, a manual payment, a refund-like row, a credit and a dunning event. */
async function richSociety(name: string) {
  const s = await billedSociety({ name });
  const t = await platformTeam();
  const cn = await t.maker.c(
    'post',
    `/platform/invoices/${s.invoice.id}/credit-notes`,
    { reason: 'PRICE_CORRECTION', subtotalPaise: 100000, notes: 'Price corrected for November' },
    { headers: idemKey() },
  );
  await t.checker.c('post', `/platform/invoices/${cn.body.data.id}/approve`, { version: 1 });
  const pay = await t.maker.c(
    'post',
    '/platform/payments',
    {
      societyId: s.society.id,
      invoiceId: s.invoice.id,
      method: 'NEFT',
      amountPaise: 500000,
      receivedOn: '2026-10-30',
      bankReference: `UTR${s.society.id}0001`.padEnd(10, '0'),
    },
    { headers: idemKey() },
  );
  expect(pay.status, JSON.stringify(pay.body)).toBe(201);
  const refund = await PlatformPayment.create({
    societyId: s.society.id!,
    kind: 'REFUND',
    origin: 'PLATFORM',
    status: 'REJECTED',
    amountPaise: 1000,
    appliedPaise: 0,
    sourcePaymentId: pay.body.data.id,
    version: 1,
  } as never);
  await DunningEvent.create({
    societyId: s.society.id!,
    invoiceId: s.invoice.id,
    step: 'MANUAL_REMINDER',
    scheduledFor: '2026-11-01',
    outcome: 'DONE',
  } as never);
  return { ...s, ...t, refundId: refund.id! };
}

describe('export provider', () => {
  it('is registered by module 06 and lists the five society tables, scoped to one society, without internal columns', async () => {
    const a = await richSociety('Export A CHS');
    const b = await richSociety('Export B CHS');
    expect(exportProviders().some(p => p.module === 'platform-billing')).toBe(true);
    expect(BILLING_EXPORT_PROVIDER.tables.map(t => t.name)).toEqual([
      'platform_invoices',
      'platform_invoice_lines',
      'platform_payments',
      'platform_credits',
      'dunning_events',
    ]);
    const inv = await rowsOf('platform_invoices', a.society.id!);
    expect(inv.map(r => r.documentType).sort()).toEqual(['CREDIT_NOTE', 'INVOICE']);
    expect(inv.every(r => r.societyId === a.society.id)).toBe(true);
    expect((await rowsOf('platform_invoice_lines', a.society.id!)).length).toBeGreaterThan(0);
    const pays = await rowsOf('platform_payments', a.society.id!);
    expect(pays).toHaveLength(2);
    expect(pays.every(p => !('bankRefKey' in p))).toBe(true);
    expect(await rowsOf('dunning_events', a.society.id!)).toHaveLength(1);
    expect(await rowsOf('platform_credits', b.society.id!)).toBeInstanceOf(Array);
    expect((await rowsOf('platform_invoices', b.society.id!)).every(r => r.societyId === b.society.id)).toBe(
      true,
    );
  });
});

describe('retention', () => {
  it('deleteRetainedBilling removes one society rows (children first) and leaves the others', async () => {
    const a = await richSociety('Gone A CHS');
    const b = await richSociety('Kept B CHS');
    const before = await PlatformInvoice.count({ where: { societyId: b.society.id! } });
    const r = await deleteRetainedBilling(a.society.id!);
    expect(r.deleted).toBeGreaterThan(5);
    for (const M of [PlatformInvoice, PlatformPayment, PlatformCredit, DunningEvent])
      expect(await (M as typeof PlatformInvoice).count({ where: { societyId: a.society.id! } })).toBe(0);
    const aInvoices = await PlatformInvoice.findAll({ where: { societyId: a.society.id! } });
    expect(aInvoices).toHaveLength(0);
    expect(await PlatformInvoiceLine.count({ where: { societyId: a.society.id! } })).toBe(0);
    expect(await PlatformInvoice.count({ where: { societyId: b.society.id! } })).toBe(before);
    expect(await PlatformPayment.count({ where: { societyId: b.society.id! } })).toBeGreaterThan(0);
    // the model itself still refuses deletes
    const row = (await PlatformInvoice.findOne({ where: { societyId: b.society.id! } }))!;
    await expect(row.destroy()).rejects.toThrow(/never deleted/);
  });

  it('purge leaves the module 06 tables alone; the yearly retention run deletes them through module 05', async () => {
    const a = await richSociety('Closed CHS');
    const id = a.society.id!;
    await Society.update(
      {
        status: 'CLOSED',
        closedAt: new Date('2026-07-30T06:00:00Z'),
        closureReason: 'OTHER',
        purgeAfter: new Date('2026-10-28T06:00:00Z'),
        financialRetainUntil: '2026-10-31',
        activatedAt: new Date('2026-01-01T00:00:00Z'),
      } as never,
      { where: { id } },
    );
    const count = () => PlatformInvoice.count({ where: { societyId: id } });
    const n = await count();
    expect(n).toBeGreaterThan(1);
    setNow('2026-11-01T06:00:00Z');
    expect((await runPurge()).purged).toBe(1);
    expect(await count()).toBe(n); // purge skips the financial tables
    expect(await runFinancialRetention()).toEqual({ done: 1, failed: 0 });
    expect(await count()).toBe(0);
    expect(await PlatformPayment.count({ where: { societyId: id } })).toBe(0);
    const ev = (await SocietyLifecycleEvent.findOne({
      where: { societyId: id, eventType: 'FINANCIAL_PURGED' },
    }))!;
    expect(
      (ev.metadata as { handlers: Record<string, { deleted: number }> }).handlers['platform-billing']!
        .deleted,
    ).toBeGreaterThan(5);
  });
});
