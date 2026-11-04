import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditLog,
  Invoice,
  InvoiceLine,
  Resident,
  Society,
  UnitLedgerEntry,
  UnitResident,
  closeDb,
  sequelize,
} from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { billingPortCalls, setBillingPorts } from '../../../src/modules/billing/billing.ports';
import { invoices } from '../../../src/modules/billing/billing.invoices.service';
import { billingPorts } from '../../../src/modules/billing/billing.ports';
import { events, makeUser } from '../../helpers/auth';
import { systemCtx } from '../../../src/types/context';
import { approve } from '../../../src/modules/billing/billing.runs.approvals-hook';
import { rawInvoice } from '../../helpers/maint-billing';
import { featureOff, memberOf } from '../../helpers/society-setup';
import { resetLogins } from '../../helpers/access';

import { addTenant, createAndCompute, makeResident, setSetting } from '../../helpers/billing-runs';
import {
  ctxFor,
  idemH,
  invoiceWorld,
  makeInvoice,
  pay,
  postAdHoc,
  resetInvoices,
  runSociety,
  setGst,
  sysCtx,
  type RunSociety,
} from '../../helpers/billing-invoices';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  resetLogins();
  resetRateLimits();
  await resetInvoices();
});
afterEach(() => vi.restoreAllMocks());

const ledgerOf = (w: RunSociety) =>
  UnitLedgerEntry.findAll({ where: { societyId: w.society.id! }, order: [['id', 'ASC']] });
const journalCalls = () => billingPortCalls.filter(c => c.fn === 'journal.post').map(c => c.input as any);

describe('admin ad-hoc invoice (8.14, BR-11-48, BR-11-50)', () => {
  it('issues one ADHOC invoice with lines, a gapless number, ledger entry, balanced journal, audit and realtime', async () => {
    const w = await invoiceWorld();
    const inv = await makeInvoice(w);
    expect(inv).toMatchObject({
      invoiceNo: 'INV/2026-27/000001',
      invoiceType: 'ADHOC',
      status: 'ISSUED',
      unit: { id: w.units[0]!.id, label: 'A-101' },
      billTo: { name: 'Owner of A-101', relation: 'OWNER' },
      invoiceDate: '2026-11-04',
      dueDate: '2026-11-20',
      description: 'Test bill',
      subtotalPaise: 453_000,
      taxPaise: 0,
      roundOffPaise: 0,
      totalPaise: 453_000,
      outstandingPaise: 453_000,
      paidPaise: 0,
      isOverdue: false,
      isDisputed: false,
      version: 1,
    });
    expect(inv.lines.map((l: any) => [l.lineNo, l.lineKind, l.headKey, l.amountPaise])).toEqual([
      [1, 'CHARGE', 'MAINTENANCE', 368_000],
      [2, 'CHARGE', 'PARKING', 50_000],
      [3, 'CHARGE', 'WATER', 35_000],
    ]);
    const row = (await Invoice.findByPk(inv.id))!;
    expect(row).toMatchObject({ dedupeKey: null, createdBy: w.user.id, financialYear: '2026-27' });
    const ledger = await ledgerOf(w);
    expect(ledger.map(e => [e.entryType, e.refType, Number(e.refId), Number(e.debitPaise)])).toEqual([
      ['INVOICE', 'invoice', inv.id, 453_000],
    ]);
    const [j] = journalCalls();
    expect(j).toMatchObject({ voucherType: 'INVOICE', refType: 'invoice', refId: inv.id });
    const dr = j.lines.reduce((a: number, l: any) => a + l.debitPaise, 0);
    const cr = j.lines.reduce((a: number, l: any) => a + l.creditPaise, 0);
    expect([dr, cr]).toEqual([453_000, 453_000]);
    expect(j.lines[0]).toMatchObject({ accountCode: '1300', debitPaise: 453_000 });
    expect(j.lines.map((l: any) => l.accountCode)).toEqual(['1300', '4100', '4120', '4130']);
    const audit = await AuditLog.findOne({
      where: { action: 'billing.invoice.created_adhoc', entityId: String(inv.id) },
    });
    expect(audit).not.toBeNull();
    expect(
      events.some(e => e.event === 'billing.invoice.updated' && e.room === `society:${w.society.id}:finance`),
    ).toBe(true);
    expect(events.some(e => e.event === 'billing.dues.changed' && e.room === `unit:${w.units[0]!.id}`)).toBe(
      true,
    );
    // after commit the advance of the flat is applied by module 12 (8.14)
    expect(billingPortCalls.find(c => c.fn === 'payments.queueAdvanceApply')?.input).toEqual({
      societyId: w.society.id,
      unitIds: [w.units[0]!.id],
    });
  });

  it('is idempotent for the same Idempotency-Key (Idempotent-Replay) and refuses a changed body with the same key', async () => {
    const w = await invoiceWorld();
    const body = {
      unitId: w.units[0]!.id,
      lines: [{ chargeHeadId: w.heads.PARKING!.id, description: 'Parking', amountPaise: 50_000 }],
      dueDate: '2026-11-20',
      description: 'Parking',
    };
    const h = idemH();
    const a = await w.c('post', '/invoices', body, { headers: h });
    const b = await w.c('post', '/invoices', body, { headers: h });
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await Invoice.count({ where: { societyId: w.society.id! } })).toBe(1);
    const c = await w.c('post', '/invoices', { ...body, description: 'Other' }, { headers: h });
    expect([c.status, c.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    expect((await w.c('post', '/invoices', body)).status).toBe(400);
  });

  it('GST: THRESHOLD heads of the invoice alone above the limit are taxed on the whole amount, with CGST, SGST and round-off (BR-11-31)', async () => {
    const w = await invoiceWorld();
    await setGst(w);
    await setSetting(w.society.id!, 'billing.applyGst', true);
    const inv = await makeInvoice(w, 0, [
      { head: 'MAINTENANCE', amountPaise: 688_000 },
      { head: 'SINKING_FUND', amountPaise: 60_000 },
      { head: 'REPAIR_FUND', amountPaise: 25_000 },
      { head: 'PARKING', amountPaise: 50_000 },
      { head: 'WATER', amountPaise: 35_000 },
    ]);
    expect(inv).toMatchObject({
      gstApplied: true,
      societyGstin: '27AAAAS1234A1Z5',
      thresholdBasePaise: 823_000,
      taxableValuePaise: 823_000,
      subtotalPaise: 858_000,
      cgstPaise: 74_070,
      sgstPaise: 74_070,
      taxPaise: 148_140,
      roundOffPaise: -40,
      totalPaise: 1_006_100,
    });
    expect(inv.lines.map((l: any) => l.lineKind)).toEqual([
      'CHARGE',
      'CHARGE',
      'CHARGE',
      'CHARGE',
      'CHARGE',
      'CGST',
      'SGST',
      'ROUND_OFF',
    ]);
    expect(inv.lines.find((l: any) => l.lineKind === 'WATER' || l.headKey === 'WATER').isTaxable).toBe(false);
    const [j] = journalCalls();
    const dr = j.lines.reduce((a: number, l: any) => a + l.debitPaise, 0);
    expect(dr).toBe(1_006_140); // Dr 1300 1,006,100 and Dr 4990 40 (example I)
    expect(j.lines.find((l: any) => l.accountCode === '4990')).toMatchObject({ debitPaise: 40 });
    expect(j.lines.find((l: any) => l.accountCode === '2410')).toMatchObject({
      fundId: 1001,
      creditPaise: 60_000,
    });
    expect(j.lines.find((l: any) => l.accountCode === '2310')).toMatchObject({ creditPaise: 74_070 });
  });

  it('GST: exactly the limit is exempt and a switched-off society is never taxed; a taxed head without SAC is refused', async () => {
    const w = await invoiceWorld();
    await setGst(w);
    await setSetting(w.society.id!, 'billing.applyGst', true);
    const exempt = await makeInvoice(w, 0, [{ head: 'MAINTENANCE', amountPaise: 750_000 }]);
    expect([exempt.gstApplied, exempt.taxPaise]).toEqual([false, 0]);
    await sequelize.query(
      "UPDATE charge_heads SET sacCode = NULL WHERE societyId = ? AND `key` = 'MAINTENANCE'",
      {
        replacements: [w.society.id!],
      },
    );
    const r = await postAdHoc(w, 0, [{ head: 'MAINTENANCE', amountPaise: 800_000 }]);
    expect([r.status, r.body.code]).toEqual([422, 'GST_SETTINGS_INVALID']);
    await setSetting(w.society.id!, 'billing.applyGst', false);
    const off = await makeInvoice(w, 1, [{ head: 'PARKING', amountPaise: 900_000 }]);
    expect(off.taxPaise).toBe(0);
  });

  it('round-off: an amount that is not a whole rupee gets a round-off line (BR-11-4); off when billing.roundToRupee is false', async () => {
    const w = await invoiceWorld();
    const inv = await makeInvoice(w, 0, [{ head: 'PARKING', amountPaise: 50_049 }]);
    expect([inv.roundOffPaise, inv.totalPaise]).toEqual([-49, 50_000]);
    const up = await makeInvoice(w, 0, [{ head: 'PARKING', amountPaise: 50_050 }]);
    expect([up.roundOffPaise, up.totalPaise]).toEqual([50, 50_100]);
    await setSetting(w.society.id!, 'billing.roundToRupee', false);
    const exact = await makeInvoice(w, 1, [{ head: 'PARKING', amountPaise: 50_049 }]);
    expect([exact.roundOffPaise, exact.totalPaise]).toEqual([0, 50_049]);
  });

  it('validation and head rules: 404 head, system head, archived head, unit, due date range, NO_BILL_TO, MIXED_BILL_TO', async () => {
    const w = await invoiceWorld({ flats: 3 });
    const line = (head: string) => ({
      chargeHeadId: w.heads[head]!.id,
      description: 'Charge',
      amountPaise: 1000,
    });
    const post = (body: Record<string, unknown>) =>
      w.c(
        'post',
        '/invoices',
        {
          unitId: w.units[0]!.id,
          lines: [line('PARKING')],
          dueDate: '2026-11-20',
          description: 'Bill',
          ...body,
        },
        { headers: idemH() },
      );
    expect((await post({ lines: [{ ...line('PARKING'), chargeHeadId: 999_999 }] })).body.code).toBe(
      'CHARGE_HEAD_NOT_FOUND',
    );
    await sequelize.query("UPDATE charge_heads SET isSystem = 1 WHERE societyId = ? AND `key` = 'WATER'", {
      replacements: [w.society.id!],
    });
    expect((await post({ lines: [line('WATER')] })).body.code).toBe('CHARGE_HEAD_NOT_ALLOWED');
    await sequelize.query(
      "UPDATE charge_heads SET status = 'ARCHIVED' WHERE societyId = ? AND `key` = 'NOC'",
      { replacements: [w.society.id!] },
    );
    expect((await post({ lines: [line('NOC')] })).body.code).toBe('CHARGE_HEAD_ARCHIVED');
    expect((await post({ unitId: 999_999 })).body.code).toBe('UNIT_NOT_FOUND');
    for (const dueDate of ['2026-11-03', '2027-11-05', '2026-13-40'])
      expect([dueDate, (await post({ dueDate })).body.code]).toEqual([dueDate, 'VALIDATION_FAILED']);
    expect((await post({ lines: [] })).body.code).toBe('VALIDATION_FAILED');
    expect((await post({ lines: [{ ...line('PARKING'), amountPaise: 100_000_001 }] })).body.code).toBe(
      'VALIDATION_FAILED',
    );
    expect((await post({ description: 'x' })).body.code).toBe('VALIDATION_FAILED');
    expect((await post({ extra: 1 })).body.code).toBe('VALIDATION_FAILED');
    // a flat without an owner or bill-to party
    await sequelize.query(
      'UPDATE unit_residents SET toDate = ?, endReason = ? WHERE societyId = ? AND unitId = ?',
      {
        replacements: ['2026-10-01', 'OTHER', w.society.id!, w.units[2]!.id],
      },
    );
    expect((await post({ unitId: w.units[2]!.id })).body.code).toBe('NO_BILL_TO');
  });

  it('owner heads go to the owner and bill-to heads to the tenant who pays; two parties in one invoice is MIXED_BILL_TO', async () => {
    const w = await invoiceWorld();
    const ownerLink = (await UnitResident.findOne({
      where: { societyId: w.society.id!, unitId: w.units[1]!.id },
    }))!;
    await addTenant(w.society.id!, w.units[1]!.id, ownerLink.residentId, {
      payer: 'TENANT',
      from: '2026-10-01',
      name: 'Tenant T',
    });
    const tenantBill = await makeInvoice(w, 1, [{ head: 'PARKING', amountPaise: 50_000 }]);
    expect(tenantBill.billTo).toMatchObject({ name: 'Tenant T', relation: 'TENANT' });
    const ownerBill = await makeInvoice(w, 1, [{ head: 'SINKING_FUND', amountPaise: 60_000 }]);
    expect(ownerBill.billTo).toMatchObject({ name: 'Owner of A-102', relation: 'OWNER' });
    const mixed = await postAdHoc(w, 1, [
      { head: 'PARKING', amountPaise: 50_000 },
      { head: 'SINKING_FUND', amountPaise: 60_000 },
    ]);
    expect([mixed.status, mixed.body.code]).toEqual([422, 'MIXED_BILL_TO']);
    expect(await Invoice.count({ where: { societyId: w.society.id!, unitId: w.units[1]!.id } })).toBe(2);
  });

  it('a unit that is archived is 404 UNIT_NOT_FOUND', async () => {
    const w = await invoiceWorld();
    await sequelize.query(
      "UPDATE units SET status = 'ARCHIVED', archivedAt = NOW(), archivedReason = 'Merged' WHERE id = ?",
      {
        replacements: [w.units[0]!.id],
      },
    );
    const r = await postAdHoc(w, 0, [{ head: 'PARKING', amountPaise: 1000 }]);
    expect([r.status, r.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
  });
});

describe('invoices.createAdHoc for other modules (BR-11-48, BR-11-49, BR-11-49a, T11-23)', () => {
  const input = (w: RunSociety, o: Record<string, unknown> = {}) => ({
    unitId: w.units[0]!.id,
    chargeHeadKey: 'RENOVATION_FEE',
    amountPaise: 500_000,
    refType: 'renovation_permit',
    refId: 7,
    dueDate: '2026-11-30',
    ...o,
  });
  const call = (w: RunSociety, i: Record<string, unknown>) =>
    sequelize.transaction(t => invoices.createAdHoc(sysCtx(w), i as never, t));

  it('issues one invoice for a seeded owner head to the flat’s owner, GST NONE, no dedupe key, and returns { invoiceId, invoiceNo, totalPaise }', async () => {
    const w = await invoiceWorld();
    const ownerLink = (await UnitResident.findOne({
      where: { societyId: w.society.id!, unitId: w.units[0]!.id },
    }))!;
    await addTenant(w.society.id!, w.units[0]!.id, ownerLink.residentId, {
      payer: 'TENANT',
      from: '2026-10-01',
    });
    const r = await call(w, input(w));
    expect(r).toMatchObject({ invoiceNo: 'INV/2026-27/000001', totalPaise: 500_000 });
    const inv = (await Invoice.findByPk(r.invoiceId))!;
    expect(inv).toMatchObject({
      invoiceType: 'ADHOC',
      billToRelation: 'OWNER',
      billToName: 'Owner of A-101',
      refType: 'renovation_permit',
      refId: 7,
      dedupeKey: null,
      taxPaise: 0,
      gstApplied: false,
      dueDate: '2026-11-30',
    });
    const line = (await InvoiceLine.findOne({ where: { invoiceId: r.invoiceId } }))!;
    expect([line.headKey, line.ledgerAccountCode, Number(line.amountPaise)]).toEqual([
      'RENOVATION_FEE',
      '4190',
      500_000,
    ]);
    const audit = await AuditLog.findOne({
      where: { action: 'billing.invoice.created_adhoc', entityId: String(r.invoiceId) },
    });
    expect(audit?.after).toMatchObject({ refType: 'renovation_permit', refId: 7 });
    // the caller's payment flow decides: no advance application
    expect(billingPortCalls.some(c => c.fn === 'payments.queueAdvanceApply')).toBe(false);
    for (const key of ['TRANSFER_PREMIUM', 'SHARE_TRANSFER_FEE', 'ENTRANCE_FEE']) {
      const x = await call(w, input(w, { chargeHeadKey: key, refId: 8 }));
      expect(x.totalPaise).toBe(500_000);
    }
  });

  it('a non-rupee amount gets a round-off line and totalPaise differs from amountPaise', async () => {
    const w = await invoiceWorld();
    const r = await call(w, input(w, { amountPaise: 12_345 }));
    expect(r.totalPaise).toBe(12_300);
  });

  it('refuses an unknown or system key, an archived head, a bad refType, past due date, unknown unit and an archived unit', async () => {
    const w = await invoiceWorld();
    const codes = async (o: Record<string, unknown>) => {
      try {
        await call(w, input(w, o));
        return 'OK';
      } catch (e) {
        return (e as { code: string }).code;
      }
    };
    expect(await codes({ chargeHeadKey: 'NO_SUCH_HEAD' })).toBe('CHARGE_HEAD_NOT_ALLOWED');
    expect(await codes({ chargeHeadKey: 'INTEREST' })).toBe('CHARGE_HEAD_NOT_ALLOWED');
    await sequelize
      .query("UPDATE charge_heads SET status = 'ARCHIVED' WHERE societyId = ? AND `key` = 'ENTRANCE_FEE'", {
        replacements: [w.society.id!],
      })
      .catch(() => undefined);
    expect(await codes({ chargeHeadKey: 'MAINTENANCE', refType: 'Bad Type' })).toBe('VALIDATION_FAILED');
    expect(await codes({ refId: 0 })).toBe('VALIDATION_FAILED');
    expect(await codes({ amountPaise: 0 })).toBe('VALIDATION_FAILED');
    expect(await codes({ amountPaise: 100_000_001 })).toBe('VALIDATION_FAILED');
    expect(await codes({ dueDate: '2026-11-03' })).toBe('VALIDATION_FAILED');
    expect(await codes({ dueDate: '2026-11-04' })).toBe('OK');
    expect(await codes({ unitId: 999_999 })).toBe('UNIT_NOT_FOUND');
  });

  it('COLLECTION lines need a fund from the registered resolver (BR-11-49a): FUND_NOT_RESOLVED without one, the fund on the journal line with one', async () => {
    const w = await invoiceWorld();
    const none = await call(
      w,
      input(w, { chargeHeadKey: 'COLLECTION', refType: 'collection_request', refId: 3 }),
    ).catch(e => e);
    expect(none.code).toBe('FUND_NOT_RESOLVED');
    expect(await Invoice.count({ where: { societyId: w.society.id! } })).toBe(0);
    invoices.registerFundResolver('collection_request', async (_s, refId) => (refId === 3 ? 4321 : null));
    await call(w, input(w, { chargeHeadKey: 'COLLECTION', refType: 'collection_request', refId: 3 }));
    const [j] = journalCalls();
    expect(j.lines.find((l: any) => l.accountCode === 'COLLECTION_FUND')).toMatchObject({ fundId: 4321 });
    expect(
      (
        await call(
          w,
          input(w, { chargeHeadKey: 'COLLECTION', refType: 'collection_request', refId: 4 }),
        ).catch(e => e)
      ).code,
    ).toBe('FUND_NOT_RESOLVED');
  });

  it(
    'T11-23 twenty parallel calls give twenty invoices with consecutive numbers',
    { timeout: 120_000 },
    async () => {
      const w = await invoiceWorld();
      // 20 calls, 10 at a time: the connection pool has 20 and createAdHoc reads settings and residents outside the caller's transaction
      const res: Awaited<ReturnType<typeof call>>[] = [];
      let next = 0;
      await Promise.all(
        Array.from({ length: 10 }, async () => {
          while (next < 20) res.push(await call(w, input(w, { refId: ++next })));
        }),
      );
      const nos = res.map(r => Number(r.invoiceNo.split('/')[2])).sort((a, b) => a - b);
      expect(nos).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    },
  );

  it('an error rolls back the caller’s work and gives the number back (gapless)', async () => {
    const w = await invoiceWorld();
    await call(w, input(w));
    vi.spyOn(billingPorts().journal, 'post').mockRejectedValueOnce(new Error('journal down'));
    await expect(call(w, input(w, { refId: 9 }))).rejects.toThrow('journal down');
    const again = await call(w, input(w, { refId: 10 }));
    expect(again.invoiceNo).toBe('INV/2026-27/000002');
  });

  it('PERIOD_LOCKED when module 13 says the date is locked', async () => {
    const w = await invoiceWorld();
    setBillingPorts({ journal: { isDateLocked: async () => true } });
    expect((await call(w, input(w)).catch(e => e)).code).toBe('PERIOD_LOCKED');
    const r = await postAdHoc(w, 0, [{ head: 'PARKING', amountPaise: 1000 }]);
    expect([r.status, r.body.code]).toEqual([422, 'PERIOD_LOCKED']);
  });
});

describe('allocation, reversal, disputed flag (T11-25, T11-26, section 6.4)', () => {
  it('T11-26 allocation pays the invoice, reversal reopens it: ISSUED, PARTIALLY_PAID, PAID, ISSUED, settledOn set then NULL', async () => {
    const w = await invoiceWorld();
    const inv = await makeInvoice(w);
    const part = await pay(w, inv.id, 100_000);
    expect(part).toMatchObject({
      status: 'PARTIALLY_PAID',
      paidPaise: 100_000,
      outstandingPaise: 353_000,
      settledOn: null,
    });
    const full = await pay(w, inv.id, 353_000);
    expect(full).toMatchObject({ status: 'PAID', outstandingPaise: 0, settledOn: '2026-11-04' });
    const back = await sequelize.transaction(t => invoices.reverseAllocation(sysCtx(w), inv.id, 453_000, t));
    expect(back).toMatchObject({
      status: 'ISSUED',
      paidPaise: 0,
      outstandingPaise: 453_000,
      settledOn: null,
    });
    expect(events.filter(e => e.event === 'billing.invoice.updated').length).toBeGreaterThan(3);
  });

  it('T11-25 an allocation above the outstanding is 422 ALLOCATION_EXCEEDS_OUTSTANDING and changes nothing', async () => {
    const w = await invoiceWorld();
    const inv = await makeInvoice(w);
    await expect(pay(w, inv.id, 453_001)).rejects.toMatchObject({
      status: 422,
      code: 'ALLOCATION_EXCEEDS_OUTSTANDING',
    });
    await expect(pay(w, inv.id, 0)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    expect((await Invoice.findByPk(inv.id))!.paidPaise).toBe(0);
  });

  it('reversal above paid is 422 REVERSAL_EXCEEDS_PAID; an unknown or foreign invoice is 404; a paid invoice takes no allocation', async () => {
    const w = await invoiceWorld();
    const inv = await makeInvoice(w);
    await pay(w, inv.id, 1000);
    await expect(
      sequelize.transaction(t => invoices.reverseAllocation(sysCtx(w), inv.id, 1001, t)),
    ).rejects.toMatchObject({
      code: 'REVERSAL_EXCEEDS_PAID',
    });
    await expect(pay(w, 999_999, 1)).rejects.toMatchObject({ status: 404, code: 'INVOICE_NOT_FOUND' });
    const other = await runSociety({ flats: 1 });
    await expect(
      sequelize.transaction(t => invoices.applyAllocation(sysCtx(other), inv.id, 1, t)),
    ).rejects.toMatchObject({
      code: 'INVOICE_NOT_FOUND',
    });
    await pay(w, inv.id, 452_000);
    await expect(pay(w, inv.id, 1)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });

  it('applyAllocation works with a system context that has no society (module 12 jobs)', async () => {
    const w = await invoiceWorld();
    const inv = await makeInvoice(w);
    const r = await sequelize.transaction(t => invoices.applyAllocation(systemCtx('job'), inv.id, 1000, t));
    expect(r.paidPaise).toBe(1000);
  });

  it('setDisputed flips the flag, audits the change and ignores a repeat', async () => {
    const w = await invoiceWorld();
    const inv = await makeInvoice(w);
    await sequelize.transaction(t => invoices.setDisputed(sysCtx(w), inv.id, true, t));
    expect((await Invoice.findByPk(inv.id))!.isDisputed).toBe(true);
    await sequelize.transaction(t => invoices.setDisputed(sysCtx(w), inv.id, true, t));
    expect(await AuditLog.count({ where: { action: 'billing.invoice.dispute_flag_changed' } })).toBe(1);
    await sequelize.transaction(t => invoices.setDisputed(sysCtx(w), inv.id, false, t));
    expect(await AuditLog.count({ where: { action: 'billing.invoice.dispute_flag_changed' } })).toBe(2);
    await expect(
      sequelize.transaction(t => invoices.setDisputed(sysCtx(w), 999_999, true, t)),
    ).rejects.toMatchObject({
      code: 'INVOICE_NOT_FOUND',
    });
  });
});

describe('immutability (BR-11-6)', () => {
  it('an issued invoice and its lines cannot be changed outside the settlement columns, and are never deleted', async () => {
    const w = await invoiceWorld();
    const inv = await makeInvoice(w);
    const row = (await Invoice.findByPk(inv.id))!;
    row.totalPaise = 1;
    await expect(row.save()).rejects.toThrow(/immutable/);
    await expect(
      Invoice.update({ dueDate: '2026-12-31' } as never, { where: { id: inv.id } }),
    ).rejects.toThrow(/immutable/);
    await expect(row.destroy()).rejects.toThrow(/never deleted/);
    const line = (await InvoiceLine.findOne({ where: { invoiceId: inv.id } }))!;
    line.amountPaise = 5;
    await expect(line.save()).rejects.toThrow(/immutable/);
    await expect(line.destroy()).rejects.toThrow(/never deleted/);
    expect((await w.c('put', `/invoices/${inv.id}`, { totalPaise: 1 })).status).toBe(404);
    expect((await w.c('delete', `/invoices/${inv.id}`)).status).toBe(404);
  });
});

describe('readers for other modules (section 8.24)', () => {
  it('listOpen: outstanding only, oldest due first, not cancelled, with the period label; payerUserId limits to what that user sees', async () => {
    const w = await invoiceWorld();
    const a = await makeInvoice(w, 0, [{ head: 'PARKING', amountPaise: 50_000 }]);
    const b = await postAdHoc(w, 0, [{ head: 'WATER', amountPaise: 35_000 }], {
      dueDate: '2026-11-10',
      description: 'Water special',
    });
    const c = await makeInvoice(w, 0, [{ head: 'WATER', amountPaise: 10_000 }]);
    await pay(w, c.id, 10_000);
    const list = await invoices.listOpen(w.society.id!, w.units[0]!.id);
    expect(list.map(i => i.id)).toEqual([b.body.data.id, a.id]);
    expect(list[0]).toEqual({
      id: b.body.data.id,
      invoiceNo: b.body.data.invoiceNo,
      periodLabel: 'Water special',
      issueDate: '2026-11-04',
      dueDate: '2026-11-10',
      outstandingPaise: 35_000,
      isDisputed: false,
    });
    expect(await invoices.listOpen(w.society.id!, w.units[1]!.id)).toEqual([]);
    const ownerRes = (await UnitResident.findOne({
      where: { societyId: w.society.id!, unitId: w.units[0]!.id },
    }))!;
    const strangerUser = await makeUser({ name: 'Stranger' });
    const ownerUser = await makeUser({ name: 'Owner user' });
    const stranger = await makeResident(w.society.id!, 'Stranger');
    await Resident.update({ userId: strangerUser.id! } as never, { where: { id: stranger.id! } });
    expect(await invoices.listOpen(w.society.id!, w.units[0]!.id, { payerUserId: strangerUser.id! })).toEqual(
      [],
    );
    await Resident.update({ userId: ownerUser.id! } as never, { where: { id: ownerRes.residentId } });
    expect(
      (await invoices.listOpen(w.society.id!, w.units[0]!.id, { payerUserId: ownerUser.id! })).length,
    ).toBe(2);
  });

  it('billedForMonth sums regular and supplementary invoices of the period month, not cancelled ones, not ad-hoc', async () => {
    const w = await invoiceWorld();
    await makeInvoice(w);
    const sid = w.society.id!;
    const mk = (no: string, total: number, o: Record<string, unknown>) =>
      rawInvoice(sid, w.units[1]!.id, {
        invoiceNo: no,
        totalPaise: total,
        subtotalPaise: total,
        outstandingPaise: total,
        ...o,
      } as never);
    const r1 = await mk('T/1', 538_000, {
      invoiceType: 'REGULAR',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
    });
    const r2 = await mk('T/2', 100_000, {
      invoiceType: 'SUPPLEMENTARY',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
    });
    await mk('T/3', 9_00, { invoiceType: 'REGULAR', periodStart: '2026-10-01', periodEnd: '2026-10-31' });
    await mk('T/4', 100_000, {
      invoiceType: 'REGULAR',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      status: 'CANCELLED',
      outstandingPaise: 0,
      creditedPaise: 100_000,
    });
    const r = await invoices.billedForMonth(sid, '2026-11');
    expect(r.billedPaise).toBe(638_000);
    expect([...r.invoiceIds].sort()).toEqual([Number(r1.id), Number(r2.id)].sort());
    await expect(invoices.billedForMonth(sid, '2026-13')).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
    });
  });

  it('get returns the flat invoice with lines, or null for an unknown or another society’s id', async () => {
    const w = await invoiceWorld();
    const inv = await makeInvoice(w);
    const g = (await invoices.get(w.society.id!, inv.id))!;
    expect(g).toMatchObject({
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      unitLabel: 'A-101',
      totalPaise: 453_000,
      status: 'ISSUED',
    });
    expect(g.lines).toHaveLength(3);
    expect(await invoices.get(w.society.id!, 999_999)).toBeNull();
    const other = await runSociety({ flats: 1 });
    expect(await invoices.get(other.society.id!, inv.id)).toBeNull();
  });
});

describe('invoice list, export and detail (8.11, 8.12)', () => {
  async function seeded() {
    const w = await invoiceWorld({ flats: 3 });
    const a = await makeInvoice(w, 0, [{ head: 'MAINTENANCE', amountPaise: 368_000 }]);
    const b = await makeInvoice(w, 1, [{ head: 'PARKING', amountPaise: 50_000 }]);
    const c = await postAdHoc(w, 2, [{ head: 'WATER', amountPaise: 35_000 }], { dueDate: '2026-11-04' });
    await pay(w, b.id, 50_000);
    await pay(w, a.id, 8_000);
    return { w, a, b, c: c.body.data };
  }
  const list = (w: RunSociety, query: Record<string, unknown> = {}) =>
    w.c('get', '/invoices', undefined, { query: query as Record<string, string> });

  it('lists with the 8.11 item shape, newest first, with pagination', async () => {
    const { w, a } = await seeded();
    const r = await list(w);
    expect(r.status).toBe(200);
    expect(r.body.pagination).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
    expect(Object.keys(r.body.data[0]).sort()).toEqual(
      [
        'billToName',
        'billToRelation',
        'dueDate',
        'id',
        'invoiceDate',
        'invoiceNo',
        'invoiceType',
        'isDisputed',
        'isOverdue',
        'outstandingPaise',
        'paidPaise',
        'periodLabel',
        'status',
        'totalPaise',
        'unitId',
        'unitLabel',
      ].sort(),
    );
    expect(r.body.data.map((i: any) => i.id)).toContain(a.id);
    const p = await list(w, { limit: 2, page: 2 });
    expect([p.body.data.length, p.body.pagination.totalPages]).toEqual([1, 2]);
  });

  it('filters: status (including derived OVERDUE and OPEN), unit, type, FY, dates, q, disputed; sorts', async () => {
    const { w, a, b, c } = await seeded();
    // c was issued with a due date in the past (raw update: the API refuses a past due date)
    await sequelize.query(
      "UPDATE invoices SET invoiceDate = '2026-10-20', dueDate = '2026-10-30' WHERE id = ?",
      { replacements: [c.id] },
    );
    const ids = async (q: Record<string, unknown>) =>
      (await list(w, q)).body.data.map((i: any) => i.id).sort();
    expect(await ids({ status: 'PAID' })).toEqual([b.id]);
    expect(await ids({ status: 'PARTIALLY_PAID' })).toEqual([a.id]);
    expect(await ids({ status: 'ISSUED' })).toEqual([c.id]);
    expect(await ids({ status: 'OPEN' })).toEqual([a.id, c.id].sort());
    expect(await ids({ status: 'OVERDUE' })).toEqual([c.id]); // due 4 Nov, today 10 Nov; the paid one is not overdue
    expect((await list(w, { status: 'OVERDUE' })).body.data[0].isOverdue).toBe(true);
    expect(await ids({ unitId: w.units[1]!.id })).toEqual([b.id]);
    expect(await ids({ buildingId: w.buildingId })).toHaveLength(3);
    expect(await ids({ buildingId: 999_999 })).toEqual([]);
    expect(await ids({ invoiceType: 'ADHOC' })).toHaveLength(3);
    expect(await ids({ invoiceType: 'REGULAR' })).toEqual([]);
    expect(await ids({ financialYear: '2026-27' })).toHaveLength(3);
    expect(await ids({ financialYear: '2025-26' })).toEqual([]);
    expect(await ids({ dueFrom: '2026-11-10' })).toEqual([a.id, b.id].sort());
    expect(await ids({ dueTo: '2026-11-04' })).toEqual([c.id]);
    expect(await ids({ q: 'A-102' })).toEqual([b.id]);
    expect(await ids({ q: a.invoiceNo })).toEqual([a.id]);
    expect(await ids({ q: 'Owner of A-103' })).toEqual([c.id]);
    expect(await ids({ q: '%' })).toEqual([]);
    expect(await ids({ billToResidentId: (await Invoice.findByPk(a.id))!.billToResidentId })).toEqual([a.id]);
    await sequelize.transaction(t => invoices.setDisputed(sysCtx(w), a.id, true, t));
    expect(await ids({ isDisputed: 'true' })).toEqual([a.id]);
    expect(await ids({ isDisputed: 'false' })).toHaveLength(2);
    const asc = (await list(w, { sortBy: 'totalPaise', sortOrder: 'asc' })).body.data.map(
      (i: any) => i.totalPaise,
    );
    expect(asc).toEqual([35_000, 50_000, 368_000]);
    const byUnit = (await list(w, { sortBy: 'unitLabel', sortOrder: 'asc' })).body.data.map(
      (i: any) => i.unitLabel,
    );
    expect(byUnit).toEqual(['A-101', 'A-102', 'A-103']);
    expect((await list(w, { sortBy: 'password' })).status).toBe(400);
    expect((await list(w, { status: 'BOGUS' })).status).toBe(400);
    expect((await list(w, { limit: 101 })).status).toBe(400);
    expect((await list(w, { q: '' })).status).toBe(400);
    expect((await list(w, { financialYear: '2026' })).status).toBe(400);
  });

  it('detail has the 8.12 shape with lines, notes, allocations from module 12 and ledger links; another society’s id is 404', async () => {
    const { w, a } = await seeded();
    setBillingPorts({
      payments: { listAllocationsForInvoice: async () => [{ paymentId: 77, amountPaise: 8_000 }] },
    });
    const r = await w.c('get', `/invoices/${a.id}`);
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d).toMatchObject({
      id: a.id,
      status: 'PARTIALLY_PAID',
      unit: { id: w.units[0]!.id, label: 'A-101' },
      billTo: { name: 'Owner of A-101', relation: 'OWNER' },
      periodLabel: 'Test bill',
      paidPaise: 8_000,
      outstandingPaise: 360_000,
      previousDuesPaise: 0,
      notes: [],
      allocations: [{ paymentId: 77, amountPaise: 8_000 }],
      version: 2,
    });
    expect(d.ledger).toEqual([
      expect.objectContaining({ entryType: 'INVOICE', refType: 'invoice', refId: a.id, debitPaise: 368_000 }),
    ]);
    expect(d.lines[0]).toMatchObject({
      lineNo: 1,
      lineKind: 'CHARGE',
      headKey: 'MAINTENANCE',
      amountPaise: 368_000,
      isTaxable: false,
      creditedPaise: 0,
    });
    const other = await runSociety({ flats: 1 });
    const x = await other.c('get', `/invoices/${a.id}`);
    expect([x.status, x.body.code]).toEqual([404, 'INVOICE_NOT_FOUND']);
    expect((await other.c('get', '/invoices')).body.data).toEqual([]);
    expect((await w.c('get', '/invoices/abc')).status).toBe(400);
  });

  it('previous dues of the flat and party are printed on a new bill (BR-11-37)', async () => {
    const w = await invoiceWorld();
    await makeInvoice(w, 0, [{ head: 'PARKING', amountPaise: 50_000 }]);
    const second = await makeInvoice(w, 0, [{ head: 'WATER', amountPaise: 35_000 }]);
    expect(second.previousDuesPaise).toBe(50_000);
  });

  it('CSV export: filtered, injection-safe, audited, 10 an hour, needs the export permission, refuses over 50,000 rows', async () => {
    const { w, a } = await seeded();
    await sequelize.query('UPDATE invoices SET billToName = \'=HYPERLINK("http://x")\' WHERE id = ?', {
      replacements: [a.id],
    });
    const r = await w.c('get', '/invoices/export', undefined, { query: { format: 'csv', status: 'OPEN' } });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    const text = r.text ?? r.body.toString();
    expect(text).toContain('Invoice no,Type,Flat');
    expect(text).toContain(a.invoiceNo);
    expect(text).toContain(`'=HYPERLINK`);
    expect(text).not.toContain('A-102'); // the paid invoice is filtered out
    expect(text).toContain('3680.00');
    const audit = await AuditLog.findOne({ where: { action: 'billing.invoices.exported' } });
    expect(audit?.after).toMatchObject({ filter: { status: 'OPEN' }, rows: 2 });
    expect((await w.c('get', '/invoices/export', undefined, { query: { format: 'json' } })).status).toBe(400);
    const viewer = await memberOf(w.society, 'society_admin');
    expect((await viewer.c('get', '/invoices/export', undefined, { query: { format: 'csv' } })).status).toBe(
      403,
    );
    expect((await viewer.c('get', '/invoices')).status).toBe(200);
    vi.spyOn(Invoice, 'count').mockResolvedValueOnce(50_001);
    const big = await w.c('get', '/invoices/export', undefined, { query: { format: 'csv' } });
    expect([big.status, big.body.code]).toEqual([422, 'EXPORT_TOO_LARGE']);
    for (let i = 0; i < 8; i++)
      expect((await w.c('get', '/invoices/export', undefined, { query: { format: 'csv' } })).status).toBe(
        200,
      );
    const limited = await w.c('get', '/invoices/export', undefined, { query: { format: 'csv' } });
    expect([limited.status, limited.body.code]).toEqual([429, 'RATE_LIMITED']);
  });
});

describe('advance auto-adjust and PDF at issue (F18, BR-11-37)', () => {
  it('after each committed batch of a run issue, module 12 queueAdvanceApply gets the flats and a render-pdf job renders every bill', async () => {
    const w = await invoiceWorld();
    const run = await createAndCompute(w.c);
    const d = (await w.c('get', `/billing/runs/${run.id}`)).body.data;
    const p = await w.c(
      'post',
      `/billing/runs/${run.id}/publish`,
      { confirmLabel: d.runLabel, version: d.version },
      { headers: idemH() },
    );
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    await approve(p.body.data.approvalRequestId, ctxFor(w, w.treasurer.user.id!));
    await drainQueues();
    const calls = billingPortCalls
      .filter(c => c.fn === 'payments.queueAdvanceApply')
      .map(c => c.input as any);
    expect(calls).toHaveLength(1);
    expect(calls[0].societyId).toBe(w.society.id);
    expect([...calls[0].unitIds].sort()).toEqual(w.units.map(u => u.id).sort());
    const rows = await Invoice.findAll({ where: { societyId: w.society.id! } });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.pdfStatus === 'READY' && r.pdfFileId)).toBe(true);
  });
});

describe('access, isolation and plan (T11-40, T11-43, T11-47)', () => {
  it('a viewer reads but cannot create, credit, debit, cancel or write off', async () => {
    const w = await invoiceWorld();
    const inv = await makeInvoice(w);
    const viewer = await memberOf(w.society, 'society_admin');
    expect((await viewer.c('get', `/invoices/${inv.id}`)).status).toBe(200);
    const writes: [string, string, unknown][] = [
      ['post', '/invoices', { unitId: 1, lines: [], dueDate: '2026-11-20', description: 'xx' }],
      ['post', `/invoices/${inv.id}/credit-notes`, {}],
      ['post', `/invoices/${inv.id}/debit-notes`, {}],
      ['post', `/invoices/${inv.id}/cancel`, { reason: 'Wrong flat billed' }],
      ['post', `/invoices/${inv.id}/write-off`, { amountPaise: 1, reason: 'Gone for good' }],
    ];
    for (const [m, p, b] of writes) {
      const r = await viewer.c(m as never, p, b as never, { headers: idemH() });
      expect([m, p, r.status, r.body.code]).toEqual([m, p, 403, 'PERMISSION_DENIED']);
    }
  });

  it('T11-47 a suspended society refuses an invoice with 423', async () => {
    const w = await invoiceWorld();
    await Society.update(
      { status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL' } as never,
      {
        where: { id: w.society.id! },
      },
    );
    const r = await postAdHoc(w, 0, [{ head: 'PARKING', amountPaise: 1000 }]);
    expect([r.status, r.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
  });

  it('another society’s invoice id is 404 INVOICE_NOT_FOUND on every invoice route', async () => {
    const a = await invoiceWorld();
    const inv = await makeInvoice(a);
    const b = await runSociety({ flats: 1 });
    for (const [m, p, body] of [
      ['get', `/invoices/${inv.id}`, undefined],
      ['get', `/invoices/${inv.id}/pdf-url`, undefined],
      [
        'post',
        `/invoices/${inv.id}/credit-notes`,
        { reasonCode: 'WAIVER', remarks: 'Not my bill', lines: [{ invoiceLineId: 1, amountPaise: 1 }] },
      ],
      [
        'post',
        `/invoices/${inv.id}/debit-notes`,
        {
          reasonCode: 'OTHER',
          remarks: 'Not my bill',
          lines: [{ chargeHeadId: b.heads.PARKING!.id, description: 'Extra', amountPaise: 100 }],
        },
      ],
      ['post', `/invoices/${inv.id}/cancel`, { reason: 'Not my invoice at all' }],
      ['post', `/invoices/${inv.id}/write-off`, { amountPaise: 1, reason: 'Not my invoice at all' }],
    ] as const) {
      const r = await b.c(m, p, body as never, { headers: idemH() });
      expect([m, p, r.status, r.body.code]).toEqual([m, p, 404, 'INVOICE_NOT_FOUND']);
    }
  });

  it('the plan feature of each route is checked (402 FEATURE_NOT_IN_PLAN when the society lacks it)', async () => {
    const w = await invoiceWorld();
    const inv = await makeInvoice(w);
    await featureOff(w.society.id!, 'billing.credit_notes');
    await featureOff(w.society.id!, 'billing.supplementary_and_ad_hoc_invoices');
    const c = await w.c(
      'post',
      `/invoices/${inv.id}/cancel`,
      { reason: 'Wrong flat billed' },
      { headers: idemH() },
    );
    expect([c.status, c.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    const a = await postAdHoc(w, 0, [{ head: 'PARKING', amountPaise: 1000 }]);
    expect([a.status, a.body.code]).toEqual([402, 'FEATURE_NOT_IN_PLAN']);
    expect((await w.c('get', `/invoices/${inv.id}`)).status).toBe(200);
  });
});
