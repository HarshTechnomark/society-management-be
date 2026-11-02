import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  DunningEvent,
  PlatformCredit,
  PlatformInvoice,
  PlatformInvoiceLine,
  PlatformPayment,
  Society,
  closeDb,
  sequelize,
} from '../../../src/models';
import { forbiddenIssuedChanges } from '../../../src/models/platform-invoice.model';
import { gstStateCode } from '../../../src/modules/platform-billing/platform-billing.constants';
import { makeSociety, resetAccess } from '../../helpers/access';

/** Section 7 constraints (CHECKs, unique keys, RESTRICT foreign keys) and the model rules (BR-06-18, 7.2 to 7.5). */
let society: Society;
let seq = 0;

/** A valid ISSUED PERIOD invoice: subtotal ₹2,500, CGST and SGST 9 % each in Maharashtra. */
function invoiceAttrs(o: Record<string, unknown> = {}): Record<string, unknown> {
  seq += 1;
  return {
    societyId: society.id!,
    documentType: 'INVOICE',
    invoiceKind: 'PERIOD',
    dedupeKey: `PERIOD:1:2026-11-${String(seq).padStart(2, '0')}-${seq}`,
    invoiceNo: `PLT/2026-27/${String(seq).padStart(6, '0')}`,
    financialYear: '2026-27',
    status: 'ISSUED',
    issueDate: '2026-11-01',
    dueDate: '2026-11-16',
    suspendOn: '2026-12-01',
    periodStart: '2026-11-01',
    periodEnd: '2026-11-30',
    billingName: 'Sky Heights CHS',
    billingAddress: 'Baner Road, Pune, 411045',
    billingStateName: 'Maharashtra',
    placeOfSupplyStateCode: '27',
    taxType: 'INTRA_STATE',
    sacCode: '998314',
    subtotalPaise: 250000,
    cgstPaise: 22500,
    sgstPaise: 22500,
    igstPaise: 0,
    taxPaise: 45000,
    totalPaise: 295000,
    amountDuePaise: 295000,
    ...o,
  };
}
const createInvoice = (o: Record<string, unknown> = {}) => PlatformInvoice.create(invoiceAttrs(o) as never);
const draft = (o: Record<string, unknown> = {}) =>
  createInvoice({
    invoiceKind: 'MANUAL',
    dedupeKey: null,
    invoiceNo: null,
    financialYear: null,
    status: 'DRAFT',
    issueDate: null,
    dueDate: null,
    suspendOn: null,
    periodStart: null,
    periodEnd: null,
    ...o,
  });
const lineAttrs = (invoiceId: number, o: Record<string, unknown> = {}) => ({
  societyId: society.id!,
  invoiceId,
  lineNo: 1,
  lineType: 'PLAN',
  description: 'Premium plan, 100 flats × ₹25 × 1 month',
  sacCode: '998314',
  quantity: '100',
  unitPricePaise: 2500,
  amountPaise: 250000,
  ...o,
});
const paymentAttrs = (o: Record<string, unknown> = {}) => ({
  societyId: society.id!,
  kind: 'PAYMENT',
  origin: 'SOCIETY',
  status: 'CREATED',
  amountPaise: 295000,
  ...o,
});
const creditAttrs = (o: Record<string, unknown> = {}) => ({
  societyId: society.id!,
  entryType: 'GOODWILL',
  status: 'POSTED',
  amountPaise: 10000,
  balanceAfterPaise: 10000,
  reason: 'Goodwill for the delayed onboarding call',
  ...o,
});
const dunningAttrs = (o: Record<string, unknown> = {}) => ({
  societyId: society.id!,
  step: 'REMINDER',
  offsetDays: -7,
  scheduledFor: '2026-11-09',
  outcome: 'DONE',
  ...o,
});

const TABLES = [
  'dunning_events',
  'platform_credits',
  'platform_payments',
  'platform_invoice_lines',
  'platform_invoices',
];
beforeAll(async () => {
  await resetAccess();
  society = await makeSociety();
});
beforeEach(async () => {
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of TABLES) await sequelize.query(`DELETE FROM ${t}`);
  await sequelize.query('SET FOREIGN_KEY_CHECKS = 1');
});
afterAll(closeDb);

describe('schema (section 7)', () => {
  it('every table has the CHECK constraints the tests name', async () => {
    const [rows] = await sequelize.query(
      `SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
       WHERE TABLE_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK' AND TABLE_NAME IN (${TABLES.map(t => `'${t}'`).join(',')})`,
    );
    const names = new Set((rows as Array<{ name: string }>).map(r => r.name));
    for (const n of [
      'ck_pinv_document_type',
      'ck_pinv_tax_type',
      'ck_ppay_status',
      'ck_pcred_entry_type',
      'ck_pinvl_type',
      'ck_dun_step',
    ])
      expect(names.has(n), n).toBe(true);
    expect(names.size).toBeGreaterThanOrEqual(60);
  });
});

describe('platform_invoices constraints (7.1)', () => {
  it('accepts a valid issued invoice, draft and credit note', async () => {
    const inv = await createInvoice();
    expect(inv.pdfStatus).toBe('PENDING');
    expect((await PlatformInvoice.findByPk(inv.id!))!.gstRatePct).toBe('18.0000');
    await draft();
    await createInvoice({
      documentType: 'CREDIT_NOTE',
      invoiceKind: null,
      originalInvoiceId: inv.id,
      dedupeKey: null,
      invoiceNo: 'PCN/2026-27/000001',
      dueDate: null,
      creditNoteReason: 'SERVICE_CREDIT',
      amountDuePaise: 0,
    });
  });

  it('unique invoiceNo and dedupeKey (uq_pinv_no, uq_pinv_dedupe; BR-06-2)', async () => {
    const a = await createInvoice();
    await expect(createInvoice({ invoiceNo: a.invoiceNo })).rejects.toThrow(/uq_pinv_no|Validation error/);
    await expect(createInvoice({ dedupeKey: a.dedupeKey })).rejects.toThrow(
      /uq_pinv_dedupe|Validation error/,
    );
    // many drafts share NULL number and key
    await draft();
    await draft();
  });

  it.each([
    ['ck_pinv_document_type|ck_pinv_amount_due', { documentType: 'BILL' }],
    ['ck_pinv_kind', { invoiceKind: null }],
    ['ck_pinv_kind', { invoiceKind: 'OTHER' }],
    ['ck_pinv_original', { originalInvoiceId: 1 }],
    ['ck_pinv_dedupe', { invoiceKind: 'MANUAL' }],
    ['ck_pinv_status', { status: 'OPEN' }],
    ['ck_pinv_numbered', { status: 'DRAFT' }],
    ['ck_pinv_numbered', { invoiceNo: null, financialYear: null }],
    ['ck_pinv_fy', { financialYear: null }],
    ['ck_pinv_fy', { financialYear: '2026/27' }],
    ['ck_pinv_issue_date', { issueDate: null }],
    ['ck_pinv_period_required', { periodStart: null }],
    ['ck_pinv_period', { periodEnd: '2026-10-31' }],
    ['ck_pinv_cycle', { billingCycle: 'WEEKLY' }],
    ['ck_pinv_billing_gstin', { billingGstin: '27ABC' }],
    ['ck_pinv_tax_type|ck_pinv_tax_split', { taxType: 'EXPORT' }],
    ['ck_pinv_gst_rate', { gstRatePct: '28.5000' }],
    ['ck_pinv_sac', { sacCode: '99831A' }],
    ['ck_pinv_subtotal', { subtotalPaise: 0, cgstPaise: 0, sgstPaise: 0, taxPaise: 0, totalPaise: 0 }],
    ['ck_pinv_cgst_sgst', { sgstPaise: 22501, taxPaise: 45001, totalPaise: 295001 }],
    ['ck_pinv_tax_split', { igstPaise: 1, taxPaise: 45001, totalPaise: 295001 }],
    ['ck_pinv_tax_sum', { taxPaise: 45001, totalPaise: 295001 }],
    ['ck_pinv_total', { totalPaise: 295001 }],
    ['ck_pinv_settlement', { paidPaise: -1 }],
    ['ck_pinv_amount_due', { amountDuePaise: -1 }],
    ['ck_pinv_cn_reason', { creditNoteReason: 'SERVICE_CREDIT' }],
    ['ck_pinv_write_off_reason', { writeOffReason: 'too short' }],
    ['ck_pinv_pdf_status', { pdfStatus: 'DONE' }],
  ])('rejects %s %j', async (ck, o) => {
    await expect(createInvoice(o)).rejects.toThrow(new RegExp(ck));
  });

  it('credit-note rules: kind NULL, original required, only DRAFT/ISSUED/REJECTED, no amount due, no credit applied', async () => {
    const inv = await createInvoice();
    const cn = (o: Record<string, unknown>) =>
      createInvoice({
        documentType: 'CREDIT_NOTE',
        invoiceKind: null,
        originalInvoiceId: inv.id,
        dedupeKey: null,
        dueDate: null,
        amountDuePaise: 0,
        ...o,
      });
    await expect(cn({ invoiceKind: 'MANUAL' })).rejects.toThrow(/ck_pinv_kind/);
    await expect(cn({ originalInvoiceId: null })).rejects.toThrow(/ck_pinv_original/);
    await expect(cn({ status: 'PAID' })).rejects.toThrow(/ck_pinv_cn_status/);
    await expect(cn({ dueDate: '2026-11-16' })).rejects.toThrow(/ck_pinv_due_date/);
    await expect(cn({ amountDuePaise: 1 })).rejects.toThrow(/ck_pinv_amount_due/);
    await expect(cn({ creditAppliedPaise: 1 })).rejects.toThrow(/ck_pinv_credit_applied/);
    await expect(cn({ dedupeKey: 'ONE_TIME:x' })).rejects.toThrow(/ck_pinv_dedupe/);
  });

  it('INTER_STATE invoices carry IGST only', async () => {
    await createInvoice({
      taxType: 'INTER_STATE',
      placeOfSupplyStateCode: '29',
      cgstPaise: 0,
      sgstPaise: 0,
      igstPaise: 45000,
    });
    await expect(createInvoice({ taxType: 'INTER_STATE' })).rejects.toThrow(/ck_pinv_tax_split/);
  });

  it('foreign keys are RESTRICT: a society with invoices cannot be deleted', async () => {
    await createInvoice();
    await expect(sequelize.query(`DELETE FROM societies WHERE id = ${society.id}`)).rejects.toThrow(
      /foreign key constraint/i,
    );
    await expect(createInvoice({ subscriptionId: 999999 })).rejects.toThrow(/foreign key constraint/i);
  });
});

describe('platform_invoice_lines constraints (7.2)', () => {
  it('unique (invoiceId, lineNo), non-zero amounts, negatives only for DISCOUNT and PRORATION', async () => {
    const inv = await createInvoice();
    await PlatformInvoiceLine.create(lineAttrs(inv.id!) as never);
    await expect(PlatformInvoiceLine.create(lineAttrs(inv.id!) as never)).rejects.toThrow(
      /uq_pinvl_invoice_line|Validation error/,
    );
    await PlatformInvoiceLine.create(
      lineAttrs(inv.id!, { lineNo: 2, lineType: 'DISCOUNT', amountPaise: -1000 }) as never,
    );
    await PlatformInvoiceLine.create(
      lineAttrs(inv.id!, { lineNo: 3, lineType: 'PRORATION', amountPaise: -1000 }) as never,
    );
    for (const [o, ck] of [
      [{ amountPaise: 0 }, 'ck_pinvl_amount'],
      [{ amountPaise: -5 }, 'ck_pinvl_amount'],
      [{ lineType: 'TAX' }, 'ck_pinvl_type'],
      [{ quantity: '0' }, 'ck_pinvl_quantity'],
      [{ lineNo: 0 }, 'ck_pinvl_line_no'],
      [{ sacCode: '12345' }, 'ck_pinvl_sac'],
      [{ servicePeriodStart: '2026-11-02', servicePeriodEnd: '2026-11-01' }, 'ck_pinvl_period'],
    ] as const)
      await expect(
        PlatformInvoiceLine.create(lineAttrs(inv.id!, { lineNo: 9, ...o }) as never),
      ).rejects.toThrow(new RegExp(ck));
  });
});

describe('platform_payments constraints (7.3)', () => {
  it('unique gateway ids and bank reference key', async () => {
    await PlatformPayment.create(
      paymentAttrs({ gatewayOrderId: 'order_1', gatewayPaymentId: 'pay_1' }) as never,
    );
    await expect(
      PlatformPayment.create(paymentAttrs({ gatewayOrderId: 'order_1' }) as never),
    ).rejects.toThrow(/uq_ppay_order|Validation error/);
    await expect(
      PlatformPayment.create(paymentAttrs({ gatewayPaymentId: 'pay_1' }) as never),
    ).rejects.toThrow(/uq_ppay_gwpay|Validation error/);
    const manual = { origin: 'PLATFORM', status: 'PENDING_APPROVAL', method: 'NEFT', bankReference: 'UTR1' };
    await PlatformPayment.create(paymentAttrs({ ...manual, bankRefKey: 'NEFT:UTR1' }) as never);
    await expect(
      PlatformPayment.create(paymentAttrs({ ...manual, bankRefKey: 'NEFT:UTR1' }) as never),
    ).rejects.toThrow(/uq_ppay_bankref|Validation error/);
    // the same reference under another method is a different key
    await PlatformPayment.create(
      paymentAttrs({ ...manual, method: 'RTGS', bankRefKey: 'RTGS:UTR1' }) as never,
    );
  });

  it.each([
    ['ck_ppay_kind', { kind: 'CASH' }],
    ['ck_ppay_origin', { origin: 'BANK' }],
    ['ck_ppay_status|ck_ppay_kind_status', { status: 'PAID' }],
    ['ck_ppay_kind_status', { status: 'CLAIMED' }],
    ['ck_ppay_kind_status', { kind: 'REFUND', status: 'CAPTURED' }],
    ['ck_ppay_method', { method: 'CASH' }],
    ['ck_ppay_amount', { amountPaise: 0 }],
    ['ck_ppay_applied', { appliedPaise: 295001 }],
    ['ck_ppay_tds_invoice', { kind: 'TDS', status: 'CLAIMED' }],
    ['ck_ppay_tds_section', { tdsSection: '194J' }],
    ['ck_ppay_deducted_on', { deductedOn: '2026-11-01' }],
    ['ck_ppay_bank_ref_key', { status: 'REJECTED', bankRefKey: 'NEFT:X' }],
  ])('rejects %s %j', async (ck, o) => {
    await expect(PlatformPayment.create(paymentAttrs(o) as never)).rejects.toThrow(new RegExp(ck));
  });

  it('accepts a TDS claim on an invoice', async () => {
    const inv = await createInvoice();
    await PlatformPayment.create(
      paymentAttrs({
        invoiceId: inv.id,
        kind: 'TDS',
        status: 'CLAIMED',
        method: 'TDS',
        amountPaise: 25000,
        tdsSection: '194J',
        tdsRatePct: '10.0000',
        deductedOn: '2026-11-05',
      }) as never,
    );
  });
});

describe('platform_credits constraints (7.4)', () => {
  it.each([
    ['ck_pcred_entry_type|ck_pcred_amount', { entryType: 'BONUS' }],
    ['ck_pcred_status', { status: 'DONE' }],
    [
      'ck_pcred_pending',
      { entryType: 'PAYMENT_EXCESS', status: 'PENDING_APPROVAL', balanceAfterPaise: null },
    ],
    ['ck_pcred_amount', { entryType: 'APPLIED' }],
    ['ck_pcred_amount', { amountPaise: -10000 }],
    ['ck_pcred_balance', { balanceAfterPaise: -1 }],
    ['ck_pcred_posted_balance', { balanceAfterPaise: null }],
    ['ck_pcred_goodwill_reason', { reason: 'short' }],
    ['ck_pcred_goodwill_reason', { reason: null }],
  ])('rejects %s %j', async (ck, o) => {
    await expect(PlatformCredit.create(creditAttrs(o) as never)).rejects.toThrow(new RegExp(ck));
  });
});

describe('dunning_events constraints (7.5)', () => {
  it('unique dedupeKey; manual steps carry none; offsets −15…+14', async () => {
    const inv = await createInvoice();
    await DunningEvent.create(
      dunningAttrs({ invoiceId: inv.id, dedupeKey: `REMINDER:${inv.id}:-7` }) as never,
    );
    await expect(
      DunningEvent.create(dunningAttrs({ invoiceId: inv.id, dedupeKey: `REMINDER:${inv.id}:-7` }) as never),
    ).rejects.toThrow(/uq_dun_dedupe|Validation error/);
    await DunningEvent.create(
      dunningAttrs({ step: 'MANUAL_REMINDER', offsetDays: null, invoiceId: inv.id }) as never,
    );
    await DunningEvent.create(
      dunningAttrs({ step: 'MANUAL_REMINDER', offsetDays: null, invoiceId: inv.id }) as never,
    );
    for (const [o, ck] of [
      [{ step: 'MANUAL_REMINDER', offsetDays: null, dedupeKey: 'x' }, 'ck_dun_dedupe'],
      [{ offsetDays: 15 }, 'ck_dun_offset'],
      [{ offsetDays: -16 }, 'ck_dun_offset'],
      [{ step: 'PAST_DUE', offsetDays: 1 }, 'ck_dun_offset'],
      [{ step: 'CLEARED', offsetDays: null, invoiceId: inv.id }, 'ck_dun_invoice'],
      [{ outcome: 'DONE', skipReason: 'SUPERSEDED' }, 'ck_dun_skip_reason'],
      [{ outcome: 'MAYBE' }, 'ck_dun_outcome'],
      [
        {
          step: 'GRACE_EXTENDED',
          offsetDays: null,
          suspendOnBefore: '2026-12-01',
          suspendOnAfter: '2026-12-01',
        },
        'ck_dun_grace',
      ],
    ] as const)
      await expect(DunningEvent.create(dunningAttrs(o) as never)).rejects.toThrow(new RegExp(ck));
  });
});

describe('model rules', () => {
  it('BR-06-18: an issued invoice changes only settlement and status columns', async () => {
    const inv = await createInvoice();
    await inv.update({ paidPaise: 100000, amountDuePaise: 195000, status: 'PARTIALLY_PAID', version: 2 });
    await inv.update({ suspendOn: '2026-12-10', pdfStatus: 'READY' });
    await expect(inv.update({ subtotalPaise: 1 })).rejects.toThrow(/immutable: subtotalPaise/);
    await expect(inv.reload().then(i => i.update({ billingName: 'Renamed' }))).rejects.toThrow(/billingName/);
    // bulk updates run the same check per row
    await expect(
      PlatformInvoice.update({ billingName: 'Renamed' }, { where: { id: inv.id! } }),
    ).rejects.toThrow(/immutable/);
    await PlatformInvoice.update({ status: 'OVERDUE' }, { where: { id: inv.id! } });
    const fresh = (await PlatformInvoice.findByPk(inv.id!))!;
    expect([fresh.billingName, fresh.subtotalPaise, fresh.status]).toEqual([
      'Sky Heights CHS',
      250000,
      'OVERDUE',
    ]);
  });

  it('a draft is editable until it is numbered', async () => {
    const d = await draft();
    expect(forbiddenIssuedChanges(d)).toEqual([]);
    await d.update({ billingName: 'Sky Heights Co-op Housing Society', notes: 'Setup fee' });
    await d.update({
      status: 'ISSUED',
      invoiceNo: 'PLT/2026-27/000777',
      financialYear: '2026-27',
      issueDate: '2026-11-01',
      dueDate: '2026-11-16',
      amountDuePaise: 295000,
    });
    await expect(d.update({ notes: 'changed' })).rejects.toThrow(/immutable: notes/);
  });

  it('invoices, payments and credits are never deleted', async () => {
    const inv = await createInvoice();
    await expect(inv.destroy()).rejects.toThrow(/never deleted/);
    await expect(PlatformInvoice.destroy({ where: { id: inv.id! } })).rejects.toThrow(/never deleted/);
    const p = await PlatformPayment.create(paymentAttrs() as never);
    await expect(p.destroy()).rejects.toThrow(/never deleted/);
    const c = await PlatformCredit.create(creditAttrs() as never);
    await expect(c.destroy()).rejects.toThrow(/append-only/);
    expect(await PlatformInvoice.count()).toBe(1);
  });

  it('invoice lines and dunning events are immutable', async () => {
    const inv = await createInvoice();
    const line = await PlatformInvoiceLine.create(lineAttrs(inv.id!) as never);
    await expect(line.update({ description: 'x' })).rejects.toThrow(/immutable/);
    await expect(line.destroy()).rejects.toThrow(/immutable/);
    await expect(PlatformInvoiceLine.update({ description: 'x' }, { where: {} })).rejects.toThrow(
      /immutable/,
    );
    const ev = await DunningEvent.create(dunningAttrs({ invoiceId: inv.id }) as never);
    await expect(ev.update({ notes: 'x' })).rejects.toThrow(/append-only/);
    await expect(ev.destroy()).rejects.toThrow(/append-only/);
    await expect(DunningEvent.destroy({ where: {} })).rejects.toThrow(/append-only/);
  });

  it('a payment keeps its amount and kind; its status can move', async () => {
    const p = await PlatformPayment.create(paymentAttrs() as never);
    await p.update({ status: 'CAPTURED', method: 'UPI', appliedPaise: 295000, version: 2 });
    await expect(p.update({ amountPaise: 1 })).rejects.toThrow(/amountPaise/);
    await expect(PlatformPayment.update({ kind: 'REFUND' }, { where: { id: p.id! } })).rejects.toThrow(
      /kind/,
    );
  });

  it('a credit row changes only from PENDING_APPROVAL to POSTED or REJECTED', async () => {
    const posted = await PlatformCredit.create(creditAttrs() as never);
    await expect(posted.update({ reason: 'Edited goodwill reason text' })).rejects.toThrow(
      /PENDING_APPROVAL/,
    );
    const pending = await PlatformCredit.create(
      creditAttrs({ status: 'PENDING_APPROVAL', balanceAfterPaise: null }) as never,
    );
    await expect(pending.update({ amountPaise: 20000 })).rejects.toThrow(/POSTED or REJECTED/);
    await expect(
      pending.update({ status: 'POSTED', balanceAfterPaise: 20000, amountPaise: 20000 }),
    ).rejects.toThrow(/amountPaise/);
    await pending.reload();
    await pending.update({ status: 'POSTED', balanceAfterPaise: 20000, postedAt: new Date(), version: 2 });
    await expect(pending.update({ status: 'REJECTED' })).rejects.toThrow(/PENDING_APPROVAL/);
  });

  it('associations load lines, credit notes and payments', async () => {
    const inv = await createInvoice();
    await PlatformInvoiceLine.create(lineAttrs(inv.id!) as never);
    const cn = await createInvoice({
      documentType: 'CREDIT_NOTE',
      invoiceKind: null,
      originalInvoiceId: inv.id,
      dedupeKey: null,
      dueDate: null,
      amountDuePaise: 0,
    });
    await PlatformPayment.create(paymentAttrs({ invoiceId: inv.id }) as never);
    const loaded = (await PlatformInvoice.findByPk(inv.id!, {
      include: ['lines', 'creditNotes', 'payments', Society],
    })) as PlatformInvoice & {
      lines: unknown[];
      creditNotes: PlatformInvoice[];
      payments: unknown[];
      Society: Society;
    };
    expect(loaded.lines).toHaveLength(1);
    expect(loaded.creditNotes.map(c => c.id)).toEqual([cn.id]);
    expect(loaded.payments).toHaveLength(1);
    expect(loaded.Society.id).toBe(society.id);
    const back = (await PlatformInvoice.findByPk(cn.id!, {
      include: ['originalInvoice'],
    })) as PlatformInvoice & {
      originalInvoice: PlatformInvoice;
    };
    expect(back.originalInvoice.id).toBe(inv.id);
  });
});

describe('GST state codes (BR-06-14)', () => {
  it('maps state names to codes', () => {
    expect(
      ['Maharashtra', 'karnataka', 'Gujarat', 'Delhi', 'Telangana', 'Tamil Nadu'].map(gstStateCode),
    ).toEqual(['27', '29', '24', '07', '36', '33']);
    expect(gstStateCode('Atlantis')).toBeNull();
  });
});
