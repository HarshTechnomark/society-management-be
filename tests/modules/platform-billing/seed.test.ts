import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DunningEvent,
  NumberSequence,
  PlatformCredit,
  PlatformInvoice,
  PlatformInvoiceLine,
  PlatformPayment,
  Society,
  closeDb,
} from '../../../src/models';
import { setNow } from '../../../src/lib/clock';
import { seedPlatformBilling } from '../../../seeders/platform-billing';
import { resetSubs, subSociety } from '../../helpers/subscriptions';
import { makeUser } from '../../helpers/auth';

/** Section 7.6 demo seed: content and idempotency. */
async function snapshot() {
  return {
    invoices: (await PlatformInvoice.findAll({ order: [['id', 'ASC']], raw: true })).map(r => ({
      ...r,
      createdAt: undefined,
      updatedAt: undefined,
    })),
    lines: await PlatformInvoiceLine.count(),
    payments: await PlatformPayment.count(),
    credits: await PlatformCredit.count(),
    dunning: await DunningEvent.count(),
    sequences: (await NumberSequence.findAll({ raw: true })).map(s => [s.series, s.nextValue]),
  };
}

beforeEach(async () => {
  setNow('2026-11-01T06:00:00Z');
  await resetSubs();
  await makeUser({ mobile: '9000000001', name: 'Platform Admin' });
  await makeUser({ mobile: '9000000003', name: 'Isha Kapoor' });
  const sky = await subSociety({ plan: 'PREMIUM', flats: 72, name: 'Sky Heights CHS' });
  const green = await subSociety({ plan: 'STARTER', flats: 30, name: 'Green Park CHS' });
  await Society.update({ slug: 'sky-heights' }, { where: { id: sky.society.id! } });
  await Society.update({ slug: 'green-park' }, { where: { id: green.society.id! } });
});
afterAll(async () => {
  setNow(null);
  await closeDb();
});

describe('demo seed (7.6)', () => {
  it('creates three PERIOD invoices per society, a NEFT payment, a credit note and a 194J TDS claim', async () => {
    const r = await seedPlatformBilling();
    expect(r.created).toEqual(['sky-heights', 'green-park']);
    const invoices = await PlatformInvoice.findAll({ order: [['id', 'ASC']] });
    const periods = invoices.filter(i => i.invoiceKind === 'PERIOD');
    expect(periods).toHaveLength(6);
    expect(periods.map(i => i.status)).toEqual(['PAID', 'PAID', 'ISSUED', 'PAID', 'PAID', 'ISSUED']);
    expect(periods.map(i => i.invoiceNo)).toEqual(
      [1, 2, 3, 4, 5, 6].map(n => `PLT/2026-27/${String(n).padStart(6, '0')}`),
    );
    expect(periods.map(i => i.periodStart).slice(0, 3)).toEqual(['2026-09-01', '2026-10-01', '2026-11-01']);
    for (const i of invoices) {
      expect(i.totalPaise).toBe(i.subtotalPaise + i.taxPaise);
      expect(i.cgstPaise).toBe(i.sgstPaise);
      expect(i.taxType).toBe('INTRA_STATE');
    }
    const cn = invoices.filter(i => i.documentType === 'CREDIT_NOTE');
    expect(cn.map(c => c.invoiceNo)).toEqual(['PCN/2026-27/000001']);
    const payments = await PlatformPayment.findAll();
    expect(payments.filter(p => p.method === 'UPI')).toHaveLength(3);
    const neft = payments.filter(p => p.method === 'NEFT');
    expect(neft).toHaveLength(1);
    expect(neft[0]!.approvedBy).not.toBeNull();
    expect(neft[0]!.approvedBy).not.toBe(neft[0]!.createdBy);
    const tds = payments.filter(p => p.kind === 'TDS');
    expect(tds.map(p => [p.tdsSection, p.status])).toEqual([['194J', 'CLAIMED']]);
    // the credit ledger nets to zero after the credit note excess was applied to the next invoice
    const credits = await PlatformCredit.findAll({ order: [['id', 'ASC']] });
    expect(credits.map(c => [c.entryType, c.balanceAfterPaise])).toEqual([
      ['CREDIT_NOTE', credits[0]!.amountPaise],
      ['APPLIED', 0],
    ]);
    expect(await PlatformInvoiceLine.count()).toBe(7);
  });

  it('is idempotent: a second run changes nothing', async () => {
    await seedPlatformBilling();
    const before = await snapshot();
    const r = await seedPlatformBilling();
    expect(r).toEqual({ created: [], skipped: ['sky-heights', 'green-park'] });
    expect(await snapshot()).toEqual(before);
  });
});
