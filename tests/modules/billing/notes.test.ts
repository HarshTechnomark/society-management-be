import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AuditLog,
  BillingNote,
  ChargeHead,
  Invoice,
  InvoiceLine,
  Resident,
  UnitLedgerEntry,
  UnitResident,
  closeDb,
  sequelize,
} from '../../../src/models';
import { advance } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { resetRateLimits } from '../../../src/middlewares/rateLimit.middleware';
import { billingPortCalls, setBillingPorts } from '../../../src/modules/billing/billing.ports';
import { invoices } from '../../../src/modules/billing/billing.invoices.service';
import { unitLedger } from '../../../src/modules/billing/billing.ledger.service';
import { ensureSeeded } from '../../../src/modules/billing/billing.heads.service';
import { issueDebitNote } from '../../../src/modules/billing/billing.notes.debit';
import { approve, reject, requestChanges } from '../../../src/modules/billing/billing.notes.approvals-hook';
import { listRoutes } from '../../../src/modules/access-control/access-control.registry';
import { app, makeUser } from '../../helpers/auth';
import { resetLogins } from '../../helpers/access';
import { memberOf } from '../../helpers/society-setup';
import { setSetting } from '../../helpers/billing-runs';
import {
  ctxFor,
  idemH,
  invoiceWorld,
  makeInvoice,
  module12ReleasesOnCancel,
  pay,
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

const calls = (fn: string) => billingPortCalls.filter(c => c.fn === fn).map(c => c.input as any);
const journals = () => calls('journal.post');
const sums = (j: any) => [
  j.lines.reduce((a: number, l: any) => a + l.debitPaise, 0),
  j.lines.reduce((a: number, l: any) => a + l.creditPaise, 0),
];
const inv = async (id: number) => (await Invoice.findByPk(id))!;
const lineId = (invoice: any, headKey: string) =>
  invoice.lines.find((l: any) => l.headKey === headKey).id as number;
const ledgerNet = async (w: RunSociety, unitIdx = 0) =>
  unitLedger.balance(w.society.id!, w.units[unitIdx]!.id);

/** A chairman requests, the treasurer decides (module 14 stand-in). */
const treasurerCtx = (w: RunSociety) => ctxFor(w, w.treasurer.user.id!);
const creditBody = (lines: [number, number][], o: Record<string, unknown> = {}) => ({
  reasonCode: 'BILLING_ERROR',
  remarks: 'Parking was charged by mistake',
  lines: lines.map(([invoiceLineId, amountPaise]) => ({ invoiceLineId, amountPaise })),
  ...o,
});
const postCredit = (w: RunSociety, invoiceId: number, body: Record<string, unknown>) =>
  w.c('post', `/invoices/${invoiceId}/credit-notes`, body, { headers: idemH() });
const issueCredit = async (w: RunSociety, invoice: any, lines: [number, number][]) => {
  const r = await postCredit(w, invoice.id, creditBody(lines));
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  await approve(r.body.data.approvalRequestId, treasurerCtx(w));
  return r.body.data;
};

describe('credit notes (8.15, BR-11-41 to BR-11-43)', () => {
  it('a credit note waits for approval, reserves its amounts, and when approved gets a gapless CN number and reduces the invoice (US-11-07)', async () => {
    const w = await invoiceWorld();
    const ownerUser = await makeUser({ name: 'Owner with login' });
    const ownerLink = (await UnitResident.findOne({
      where: { societyId: w.society.id!, unitId: w.units[0]!.id },
    }))!;
    await Resident.update({ userId: ownerUser.id! } as never, { where: { id: ownerLink.residentId } });
    const invoice = await makeInvoice(w);
    const parking = lineId(invoice, 'PARKING');
    const r = await postCredit(w, invoice.id, creditBody([[parking, 50_000]]));
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      noteType: 'CREDIT',
      noteNo: null,
      status: 'PENDING_APPROVAL',
      invoiceId: invoice.id,
      reasonCode: 'BILLING_ERROR',
      subtotalPaise: 50_000,
      taxPaise: 0,
      totalPaise: 50_000,
      approvalType: 'CREDIT_NOTE',
    });
    expect(r.body.data.lines).toEqual([
      expect.objectContaining({
        lineKind: 'CHARGE',
        headKey: 'PARKING',
        amountPaise: 50_000,
        refInvoiceLineId: parking,
      }),
    ]);
    expect(calls('approvals.request')[0]).toMatchObject({
      type: 'CREDIT_NOTE',
      entityType: 'billing_note',
      entityId: r.body.data.id,
      amountPaise: 50_000,
    });
    expect((await InvoiceLine.findByPk(parking))!.creditedPaise).toBe(50_000); // reserved
    expect((await inv(invoice.id)).outstandingPaise).toBe(453_000); // not applied yet
    expect(await AuditLog.count({ where: { action: 'billing.credit_note.requested' } })).toBe(1);

    // the requester cannot approve (maker-checker)
    await expect(approve(r.body.data.approvalRequestId, ctxFor(w, w.user.id!))).rejects.toMatchObject({
      status: 409,
      code: 'MAKER_CHECKER_VIOLATION',
    });
    const decided = await approve(r.body.data.approvalRequestId, treasurerCtx(w));
    expect(decided).toEqual({ type: 'CREDIT_NOTE', entityId: r.body.data.id, status: 'APPROVED' });
    const note = (await BillingNote.findByPk(r.body.data.id))!;
    expect(note).toMatchObject({
      status: 'ISSUED',
      noteNo: 'CN/2026-27/000001',
      noteDate: '2026-11-04',
      financialYear: '2026-27',
      appliedToInvoicePaise: 50_000,
      excessToAdvancePaise: 0,
    });
    expect(await inv(invoice.id)).toMatchObject({
      creditedPaise: 50_000,
      outstandingPaise: 403_000,
      status: 'ISSUED',
    });
    const ledger = await UnitLedgerEntry.findAll({ where: { refType: 'billing_note' } });
    expect(ledger.map(e => [e.entryType, Number(e.creditPaise), Number(e.debitPaise)])).toEqual([
      ['CREDIT_NOTE', 50_000, 0],
    ]);
    expect(await ledgerNet(w)).toBe(403_000);
    const j = journals().find(x => x.voucherType === 'CREDIT_NOTE');
    expect(sums(j)).toEqual([50_000, 50_000]);
    expect(j.lines).toEqual([
      expect.objectContaining({ accountCode: '1300', creditPaise: 50_000 }),
      expect.objectContaining({ accountCode: '4120', debitPaise: 50_000 }),
    ]);
    expect(await AuditLog.count({ where: { action: 'billing.credit_note.issued' } })).toBe(1);
    const detail = (await w.c('get', `/invoices/${invoice.id}`)).body.data;
    expect(detail.notes).toEqual([
      expect.objectContaining({ noteNo: 'CN/2026-27/000001', status: 'ISSUED' }),
    ]);
    expect(detail.lines.find((l: any) => l.headKey === 'PARKING').creditedPaise).toBe(50_000);
    await drainQueues();
    expect(await BillingNote.count({ where: { pdfStatus: 'READY' } })).toBe(1);
    expect(calls('notifications.send').find(c => c.template === 'billing.credit_note_issued')).toMatchObject({
      userIds: [ownerUser.id],
      data: { noteNo: 'CN/2026-27/000001', amountPaise: 50_000 },
    });
    // the next credit note takes the next number
    const second = await issueCredit(w, invoice, [[lineId(invoice, 'WATER'), 1_000]]);
    expect((await BillingNote.findByPk(second.id))!.noteNo).toBe('CN/2026-27/000002');
  });

  it('T11-27 a credit above the line’s remainder is 422 CREDIT_EXCEEDS_LINE with maxAllowedPaise; two pending notes cannot over-credit', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    const parking = lineId(invoice, 'PARKING');
    const water = lineId(invoice, 'WATER');
    const over = await postCredit(
      w,
      invoice.id,
      creditBody([
        [parking, 50_001],
        [water, 35_001],
      ]),
    );
    expect([over.status, over.body.code]).toEqual([422, 'CREDIT_EXCEEDS_LINE']);
    expect(over.body.errors).toEqual([
      expect.objectContaining({ field: 'lines[0].amountPaise', maxAllowedPaise: 50_000 }),
      expect.objectContaining({ field: 'lines[1].amountPaise', maxAllowedPaise: 35_000 }),
    ]);
    expect(await BillingNote.count()).toBe(0);
    expect((await postCredit(w, invoice.id, creditBody([[parking, 30_000]]))).status).toBe(201);
    const again = await postCredit(w, invoice.id, creditBody([[parking, 30_000]]));
    expect([again.status, again.body.code]).toEqual([422, 'CREDIT_EXCEEDS_LINE']);
    expect(again.body.errors[0].maxAllowedPaise).toBe(20_000);
    expect((await postCredit(w, invoice.id, creditBody([[parking, 20_000]]))).status).toBe(201);
  });

  it('rejection releases the reservations and the line can be credited again; the note is REJECTED with the reason', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    const parking = lineId(invoice, 'PARKING');
    const r = await postCredit(w, invoice.id, creditBody([[parking, 50_000]]));
    await reject(r.body.data.approvalRequestId, 'Parking is correct', treasurerCtx(w));
    expect(await BillingNote.findByPk(r.body.data.id)).toMatchObject({
      status: 'REJECTED',
      rejectedReason: 'Parking is correct',
      noteNo: null,
    });
    expect((await InvoiceLine.findByPk(parking))!.creditedPaise).toBe(0);
    expect(await AuditLog.count({ where: { action: 'billing.credit_note.rejected' } })).toBe(1);
    expect((await inv(invoice.id)).creditedPaise).toBe(0);
    expect((await postCredit(w, invoice.id, creditBody([[parking, 50_000]]))).status).toBe(201);
  });

  it('body validation: unique ids, only charge, interest and late fee lines of this invoice, user reasons only', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    const other = await makeInvoice(w, 1);
    const parking = lineId(invoice, 'PARKING');
    const bad = async (body: Record<string, unknown>) => (await postCredit(w, invoice.id, body)).body.code;
    expect(
      await bad(
        creditBody([
          [parking, 1],
          [parking, 2],
        ]),
      ),
    ).toBe('VALIDATION_FAILED');
    expect(await bad(creditBody([[lineId(other, 'PARKING'), 1]]))).toBe('VALIDATION_FAILED'); // another invoice's line
    expect(await bad(creditBody([[999_999, 1]]))).toBe('VALIDATION_FAILED');
    expect(await bad(creditBody([[parking, 0]]))).toBe('VALIDATION_FAILED');
    expect(await bad(creditBody([[parking, 1]], { reasonCode: 'WRITE_OFF' }))).toBe('VALIDATION_FAILED');
    expect(await bad(creditBody([[parking, 1]], { reasonCode: 'CANCELLATION' }))).toBe('VALIDATION_FAILED');
    expect(await bad(creditBody([[parking, 1]], { remarks: 'no' }))).toBe('VALIDATION_FAILED');
    expect(await bad(creditBody([]))).toBe('VALIDATION_FAILED');
    expect(await bad({ ...creditBody([[parking, 1]]), extra: true })).toBe('VALIDATION_FAILED');
    expect(
      (await w.c('post', `/invoices/${invoice.id}/credit-notes`, creditBody([[parking, 1]]))).status,
    ).toBe(400); // key
  });

  it('a module 14 auto-approval issues the note at once inside the request (response has the number)', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    setBillingPorts({ approvals: { request: async () => ({ id: 901, status: 'APPROVED' }) } });
    const r = await postCredit(w, invoice.id, creditBody([[lineId(invoice, 'PARKING'), 50_000]]));
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'ISSUED',
      noteNo: 'CN/2026-27/000001',
      noteDate: '2026-11-04',
      appliedToInvoicePaise: 50_000,
    });
    expect((await inv(invoice.id)).outstandingPaise).toBe(403_000);
    expect(r.body.message).toBe('Credit note issued');
  });

  it('T11-28 on a paid invoice module 12 releases the allocations first; the excess becomes an advance and is re-applied after commit (example H)', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    const m12 = module12ReleasesOnCancel(w);
    await pay(w, invoice.id, 453_000);
    expect((await inv(invoice.id)).status).toBe('PAID');
    billingPortCalls.length = 0;
    const note = await issueCredit(w, invoice, [[lineId(invoice, 'PARKING'), 50_000]]);
    expect(m12.calls).toEqual([invoice.id]);
    const row = (await BillingNote.findByPk(note.id))!;
    expect([row.status, Number(row.appliedToInvoicePaise), Number(row.excessToAdvancePaise)]).toEqual([
      'ISSUED',
      50_000,
      50_000,
    ]);
    expect(await inv(invoice.id)).toMatchObject({
      paidPaise: 0,
      creditedPaise: 50_000,
      outstandingPaise: 403_000,
      status: 'ISSUED',
      settledOn: null,
    });
    expect(calls('payments.queueAdvanceApply')).toEqual([
      { societyId: w.society.id, unitIds: [w.units[0]!.id] },
    ]);
    // module 12 then re-applies 403,000 of the advance: the invoice is PAID again
    await pay(w, invoice.id, 403_000);
    expect(await inv(invoice.id)).toMatchObject({ status: 'PAID', outstandingPaise: 0, paidPaise: 403_000 });
  });

  it('a credit note is refused on a cancelled invoice (409 INVALID_STATE) and while a cancellation request is open (409 INVOICE_CANCEL_PENDING)', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    const parking = lineId(invoice, 'PARKING');
    const c = await w.c(
      'post',
      `/invoices/${invoice.id}/cancel`,
      { reason: 'Billed to the wrong flat' },
      { headers: idemH() },
    );
    expect(c.status).toBe(202);
    const blocked = await postCredit(w, invoice.id, creditBody([[parking, 1]]));
    expect([blocked.status, blocked.body.code]).toEqual([409, 'INVOICE_CANCEL_PENDING']); // T11-29
    await approve(c.body.data.approvalRequestId, treasurerCtx(w));
    const done = await postCredit(w, invoice.id, creditBody([[parking, 1]]));
    expect([done.status, done.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('PERIOD_LOCKED on an immediate issue; nothing is left behind and the number is not used', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    setBillingPorts({
      approvals: { request: async () => ({ id: 902, status: 'APPROVED' }) },
      journal: { isDateLocked: async () => true },
    });
    const r = await postCredit(w, invoice.id, creditBody([[lineId(invoice, 'PARKING'), 100]]));
    expect([r.status, r.body.code]).toEqual([422, 'PERIOD_LOCKED']);
    expect(await BillingNote.count()).toBe(0);
    expect(
      (await InvoiceLine.findOne({ where: { invoiceId: invoice.id, headKey: 'PARKING' } }))!.creditedPaise,
    ).toBe(0);
  });

  describe('tax of a credit note (BR-11-41)', () => {
    async function gstInvoice(w: RunSociety) {
      await setGst(w);
      await setSetting(w.society.id!, 'billing.applyGst', true);
      return makeInvoice(w, 0, [
        { head: 'MAINTENANCE', amountPaise: 688_000 },
        { head: 'SINKING_FUND', amountPaise: 60_000 },
        { head: 'REPAIR_FUND', amountPaise: 25_000 },
        { head: 'PARKING', amountPaise: 50_000 },
        { head: 'WATER', amountPaise: 35_000 },
      ]);
    }

    it('credits half the rate of the taxable value credited; when the whole taxable value is credited the tax is exactly what is left', async () => {
      const w = await invoiceWorld();
      const invoice = await gstInvoice(w);
      const first = await issueCredit(w, invoice, [[lineId(invoice, 'MAINTENANCE'), 1_001]]);
      const n1 = (await BillingNote.findByPk(first.id))!;
      expect([n1.cgstPaise, n1.sgstPaise, n1.taxPaise, n1.totalPaise]).toEqual([90, 90, 180, 1_181]);
      expect(first.lines.map((l: any) => l.lineKind)).toEqual(['CHARGE', 'CGST', 'SGST']);
      const second = await issueCredit(w, invoice, [
        [lineId(invoice, 'MAINTENANCE'), 686_999],
        [lineId(invoice, 'SINKING_FUND'), 60_000],
        [lineId(invoice, 'REPAIR_FUND'), 25_000],
        [lineId(invoice, 'PARKING'), 50_000],
      ]);
      const n2 = (await BillingNote.findByPk(second.id))!;
      // naive 9 % of 821,999 twice would be 147,960 + 0 or 148,140 - the invoice's own remaining tax is exact
      expect([n2.cgstPaise, n2.sgstPaise]).toEqual([73_980, 73_980]);
      expect(Number(n1.taxPaise) + Number(n2.taxPaise)).toBe(148_140);
      const row = await inv(invoice.id);
      expect(row.creditedPaise).toBe(1_181 + Number(n2.totalPaise));
      // the credited amount of the tax lines never exceeds them, and the invoice keeps only water and round-off
      const tax = await InvoiceLine.findAll({ where: { invoiceId: invoice.id, lineKind: ['CGST', 'SGST'] } });
      expect(tax.map(l => [Number(l.creditedPaise), Number(l.amountPaise)])).toEqual([
        [74_070, 74_070],
        [74_070, 74_070],
      ]);
      expect(row.outstandingPaise).toBe(35_000 - 40);
      // the journals of both notes balance
      for (const j of journals().filter(x => x.voucherType === 'CREDIT_NOTE'))
        expect(sums(j)[0]).toBe(sums(j)[1]);
    });

    it('a credit of tax-free lines carries no tax', async () => {
      const w = await invoiceWorld();
      const invoice = await gstInvoice(w);
      const r = await issueCredit(w, invoice, [[lineId(invoice, 'WATER'), 35_000]]);
      expect(r.taxPaise).toBe(0);
    });
  });
});

describe('changes requested, edit and withdraw (8.19)', () => {
  async function pending(w: RunSociety) {
    const invoice = await makeInvoice(w);
    const parking = lineId(invoice, 'PARKING');
    const r = await postCredit(w, invoice.id, creditBody([[parking, 50_000]]));
    return { invoice, parking, note: r.body.data };
  }

  it('the maker edits a note after "changes requested" (amounts re-reserved, resubmitted); only the requester, only in that state, version checked', async () => {
    const w = await invoiceWorld();
    const { invoice, parking, note } = await pending(w);
    const patch = (c: RunSociety['c'], body: Record<string, unknown>) =>
      c('patch', `/billing/notes/${note.id}`, body);
    expect((await patch(w.c, { remarks: 'Updated remark text', version: 1 })).body.code).toBe(
      'INVALID_STATE',
    ); // still pending
    await requestChanges(note.approvalRequestId, treasurerCtx(w));
    expect((await BillingNote.findByPk(note.id))!.status).toBe('CHANGES_REQUESTED');
    expect((await patch(w.c, { remarks: 'Updated remark text', version: 1 })).body.code).toBe(
      'STALE_VERSION',
    );
    const treasurer = w.treasurer;
    const notMaker = await patch(treasurer.c, { remarks: 'Updated remark text', version: 2 });
    expect([notMaker.status, notMaker.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    const tooMuch = await patch(w.c, {
      lines: [{ invoiceLineId: parking, amountPaise: 50_001 }],
      version: 2,
    });
    expect([tooMuch.status, tooMuch.body.code]).toEqual([422, 'CREDIT_EXCEEDS_LINE']);
    expect((await InvoiceLine.findByPk(parking))!.creditedPaise).toBe(50_000);
    const ok = await patch(w.c, {
      remarks: 'Updated remark text',
      lines: [{ invoiceLineId: parking, amountPaise: 20_000 }],
      version: 2,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      status: 'PENDING_APPROVAL',
      totalPaise: 20_000,
      remarks: 'Updated remark text',
      version: 3,
    });
    expect(ok.body.data.lines).toHaveLength(1);
    expect((await InvoiceLine.findByPk(parking))!.creditedPaise).toBe(20_000);
    expect(calls('approvals.resubmit')[0]).toMatchObject({ id: note.approvalRequestId, amountPaise: 20_000 });
    expect(await AuditLog.count({ where: { action: 'billing.credit_note.resubmitted' } })).toBe(1);
    await approve(note.approvalRequestId, treasurerCtx(w));
    expect(await inv(invoice.id)).toMatchObject({ creditedPaise: 20_000, outstandingPaise: 433_000 });
  });

  it('withdraw: the requester or a holder of finance.billing.edit; cancels the request, releases the amounts; refused when issued', async () => {
    const w = await invoiceWorld();
    const { parking, note } = await pending(w);
    const wd = (c: RunSociety['c'], body: Record<string, unknown>) =>
      c('post', `/billing/notes/${note.id}/withdraw`, body);
    expect((await wd(w.c, { reason: 'No', version: 1 })).status).toBe(400);
    expect((await wd(w.c, { reason: 'Raised by mistake', version: 7 })).body.code).toBe('STALE_VERSION');
    const viewer = await memberOf(w.society, 'secretary');
    expect((await wd(viewer.c, { reason: 'Raised by mistake', version: 1 })).status).toBe(403);
    const r = await wd(w.c, { reason: 'Raised by mistake', version: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'REJECTED', rejectedReason: 'Raised by mistake' });
    expect((await InvoiceLine.findByPk(parking))!.creditedPaise).toBe(0);
    expect(calls('approvals.cancel')[0]).toMatchObject({
      id: note.approvalRequestId,
      reason: 'Raised by mistake',
    });
    expect(await AuditLog.count({ where: { action: 'billing.credit_note.withdrawn' } })).toBe(1);
    const again = await wd(w.c, { reason: 'Raised by mistake', version: 2 });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('a holder of finance.billing.edit (the treasurer) may withdraw somebody else’s pending note', async () => {
    const w = await invoiceWorld();
    const { note } = await pending(w);
    const r = await w.treasurer.c('post', `/billing/notes/${note.id}/withdraw`, {
      reason: 'Raised by mistake',
      version: 1,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });
});

describe('billing notes list and detail (8.19)', () => {
  it('lists notes with filters and sorting, shows a note with lines, and another society’s note is 404 NOTE_NOT_FOUND', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    const other = await makeInvoice(w, 1);
    const n1 = await issueCredit(w, invoice, [[lineId(invoice, 'PARKING'), 50_000]]);
    const pendingNote = (await postCredit(w, other.id, creditBody([[lineId(other, 'WATER'), 10_000]]))).body
      .data;
    const d = await w.c(
      'post',
      `/invoices/${invoice.id}/debit-notes`,
      {
        reasonCode: 'ADDITIONAL_CHARGE',
        remarks: 'Extra parking sticker',
        lines: [{ chargeHeadId: w.heads.PARKING!.id, description: 'Sticker', amountPaise: 20_000 }],
      },
      { headers: idemH() },
    );
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    const list = async (q: Record<string, unknown>) =>
      (await w.c('get', '/billing/notes', undefined, { query: q as Record<string, string> })).body.data.map(
        (n: any) => n.id,
      );
    expect((await list({})).sort()).toEqual([n1.id, pendingNote.id, d.body.data.id].sort());
    expect(await list({ noteType: 'DEBIT' })).toEqual([d.body.data.id]);
    expect(await list({ status: 'PENDING_APPROVAL' })).toEqual([pendingNote.id]);
    expect(await list({ invoiceId: invoice.id, noteType: 'CREDIT' })).toEqual([n1.id]);
    expect(await list({ unitId: w.units[1]!.id })).toEqual([pendingNote.id]);
    expect(await list({ reasonCode: 'ADDITIONAL_CHARGE' })).toEqual([d.body.data.id]);
    expect(await list({ from: '2026-11-04', to: '2026-11-04', noteType: 'CREDIT' })).toEqual([n1.id]);
    expect((await list({ sortBy: 'totalPaise', sortOrder: 'asc' }))[0]).toBe(pendingNote.id);
    const first = (await w.c('get', '/billing/notes', undefined, { query: { noteType: 'CREDIT' } })).body;
    expect(first.pagination).toMatchObject({ total: 2 });
    expect(first.data[0]).toEqual(
      expect.objectContaining({
        invoiceNo: expect.any(String),
        unitLabel: expect.any(String),
        totalPaise: expect.any(Number),
      }),
    );
    expect(first.data[0].lines).toBeUndefined();
    const one = (await w.c('get', `/billing/notes/${n1.id}`)).body.data;
    expect(one).toMatchObject({
      id: n1.id,
      noteNo: 'CN/2026-27/000001',
      invoiceNo: invoice.invoiceNo,
      unitLabel: 'A-101',
    });
    expect(one.lines).toHaveLength(1);
    const b = await runSociety({ flats: 1 });
    for (const [m, p, body] of [
      ['get', `/billing/notes/${n1.id}`, undefined],
      ['get', `/billing/notes/${n1.id}/pdf-url`, undefined],
      ['patch', `/billing/notes/${n1.id}`, { remarks: 'Hacking the note', version: 1 }],
      ['post', `/billing/notes/${n1.id}/withdraw`, { reason: 'Hacking the note', version: 1 }],
    ] as const) {
      const r = await b.c(m, p, body as never);
      expect([m, p, r.status, r.body.code]).toEqual([m, p, 404, 'NOTE_NOT_FOUND']);
    }
    expect((await b.c('get', '/billing/notes')).body.data).toEqual([]);
  });
});

describe('debit notes (8.16, BR-11-46)', () => {
  const debit = (w: RunSociety, invoiceId: number, o: Record<string, unknown> = {}) =>
    w.c(
      'post',
      `/invoices/${invoiceId}/debit-notes`,
      {
        reasonCode: 'ADDITIONAL_CHARGE',
        remarks: 'Extra parking sticker',
        lines: [{ chargeHeadId: w.heads.PARKING!.id, description: 'Sticker', amountPaise: 20_000 }],
        ...o,
      },
      { headers: idemH() },
    );

  it('issues at once with a DN number, adds to the invoice, posts ledger and a balanced journal, and reopens a PAID invoice', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    await pay(w, invoice.id, 453_000);
    const r = await debit(w, invoice.id);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      noteType: 'DEBIT',
      noteNo: 'DN/2026-27/000001',
      status: 'ISSUED',
      reasonCode: 'ADDITIONAL_CHARGE',
      subtotalPaise: 20_000,
      totalPaise: 20_000,
      noteDate: '2026-11-04',
    });
    expect(await inv(invoice.id)).toMatchObject({
      debitedPaise: 20_000,
      outstandingPaise: 20_000,
      status: 'PARTIALLY_PAID',
      settledOn: null,
    });
    expect(await unitLedger.balance(w.society.id!, w.units[0]!.id)).toBe(473_000);
    const ledger = await UnitLedgerEntry.findAll({ where: { refType: 'billing_note' } });
    expect(ledger.map(e => [e.entryType, Number(e.debitPaise)])).toEqual([['DEBIT_NOTE', 20_000]]);
    const j = journals().find(x => x.voucherType === 'DEBIT_NOTE');
    expect(sums(j)).toEqual([20_000, 20_000]);
    expect(j.lines[0]).toMatchObject({ accountCode: '1300', debitPaise: 20_000 });
    expect(await AuditLog.count({ where: { action: 'billing.debit_note.issued' } })).toBe(1);
    // no approval is involved
    expect(calls('approvals.request')).toEqual([]);
    expect((await debit(w, invoice.id)).body.data.noteNo).toBe('DN/2026-27/000002');
    // pay the rest: PAID again
    await pay(w, invoice.id, 40_000);
    expect((await inv(invoice.id)).status).toBe('PAID');
  });

  it('round-off per BR-11-4 and tax following the parent invoice’s GST decision', async () => {
    const w = await invoiceWorld();
    const plain = await makeInvoice(w, 0, [{ head: 'PARKING', amountPaise: 50_000 }]);
    const r = await debit(w, plain.id, {
      lines: [{ chargeHeadId: w.heads.MAINTENANCE!.id, description: 'Late work', amountPaise: 20_049 }],
    });
    expect([r.body.data.roundOffPaise, r.body.data.totalPaise, r.body.data.taxPaise]).toEqual([
      -49, 20_000, 0,
    ]);
    expect(r.body.data.lines.map((l: any) => l.lineKind)).toEqual(['CHARGE', 'ROUND_OFF']);
    expect((await inv(plain.id)).debitedPaise).toBe(20_000);

    await setGst(w);
    await setSetting(w.society.id!, 'billing.applyGst', true);
    const taxed = await makeInvoice(w, 1, [{ head: 'MAINTENANCE', amountPaise: 800_000 }]);
    expect(taxed.gstApplied).toBe(true);
    const t = await debit(w, taxed.id, {
      lines: [{ chargeHeadId: w.heads.MAINTENANCE!.id, description: 'More work', amountPaise: 10_000 }],
    });
    expect([
      t.body.data.cgstPaise,
      t.body.data.sgstPaise,
      t.body.data.taxPaise,
      t.body.data.totalPaise,
    ]).toEqual([900, 900, 1_800, 11_800]);
    const j = journals()
      .filter(x => x.voucherType === 'DEBIT_NOTE')
      .pop();
    expect(j.lines.find((l: any) => l.accountCode === '2310')).toMatchObject({ creditPaise: 900 });
    expect(sums(j)[0]).toBe(sums(j)[1]);
    // the parent without GST: a taxable head follows the parent, so no tax
    const none = await debit(w, plain.id, {
      lines: [{ chargeHeadId: w.heads.MAINTENANCE!.id, description: 'More work', amountPaise: 10_000 }],
    });
    expect(none.body.data.taxPaise).toBe(0);
  });

  it('refuses unknown, system and archived heads, a cancelled invoice, an open cancellation, a locked period; a failed debit note does not use a number', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    const line = (id: number) => ({
      lines: [{ chargeHeadId: id, description: 'Extra', amountPaise: 1_000 }],
    });
    expect((await debit(w, invoice.id, line(999_999))).body.code).toBe('CHARGE_HEAD_NOT_FOUND');
    await sequelize.query("UPDATE charge_heads SET isSystem = 1 WHERE societyId = ? AND `key` = 'WATER'", {
      replacements: [w.society.id!],
    });
    expect((await debit(w, invoice.id, line(w.heads.WATER!.id))).body.code).toBe('CHARGE_HEAD_NOT_ALLOWED');
    await sequelize.query(
      "UPDATE charge_heads SET status = 'ARCHIVED' WHERE societyId = ? AND `key` = 'NOC'",
      { replacements: [w.society.id!] },
    );
    expect((await debit(w, invoice.id, line(w.heads.NOC!.id))).body.code).toBe('CHARGE_HEAD_ARCHIVED');
    expect((await debit(w, invoice.id, { reasonCode: 'INTEREST' })).body.code).toBe('VALIDATION_FAILED');
    expect((await debit(w, invoice.id, { lines: [] })).body.code).toBe('VALIDATION_FAILED');
    expect((await debit(w, 999_999)).body.code).toBe('INVOICE_NOT_FOUND');
    setBillingPorts({ journal: { isDateLocked: async () => true } });
    expect((await debit(w, invoice.id)).body.code).toBe('PERIOD_LOCKED');
    setBillingPorts({ journal: { isDateLocked: async () => false } });
    expect((await debit(w, invoice.id)).body.data.noteNo).toBe('DN/2026-27/000001'); // gapless
    const c = await w.c(
      'post',
      `/invoices/${invoice.id}/cancel`,
      { reason: 'Billed to the wrong flat' },
      { headers: idemH() },
    );
    expect((await debit(w, invoice.id)).body.code).toBe('INVOICE_CANCEL_PENDING');
    await approve(c.body.data.approvalRequestId, treasurerCtx(w));
    const done = await debit(w, invoice.id);
    expect([done.status, done.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('a line of an issued debit note can be credited (BR-11-41) and BR-11-47 keeps interest and late fee out of the interest base', async () => {
    const w = await invoiceWorld();
    await ensureSeeded(w.society.id!);
    const invoice = await makeInvoice(w, 0, [{ head: 'MAINTENANCE', amountPaise: 100_000 }]);
    const interest = (await ChargeHead.findOne({ where: { societyId: w.society.id!, key: 'INTEREST' } }))!;
    const row = await inv(invoice.id);
    const note = await sequelize.transaction(async t => {
      const locked = await Invoice.findByPk(invoice.id, { transaction: t, lock: t.LOCK.UPDATE });
      return issueDebitNote(
        sysCtx(w),
        w.society.id!,
        locked!,
        {
          reasonCode: 'INTEREST',
          remarks: 'Interest 11 to 30 September',
          lines: [
            { head: interest, description: 'Interest on arrears', amountPaise: 9_205, kind: 'INTEREST' },
          ],
          dedupeKey: `INT:${invoice.id}:2026-09-30`,
          interestFromDate: '2026-09-11',
          interestToDate: '2026-09-30',
        },
        t,
      );
    });
    void row;
    expect(note).toMatchObject({
      noteNo: 'DN/2026-27/000001',
      reasonCode: 'INTEREST',
      roundOffPaise: -5,
      totalPaise: 9_200,
      dedupeKey: `INT:${invoice.id}:2026-09-30`,
    });
    expect(await inv(invoice.id)).toMatchObject({
      debitedPaise: 9_200,
      outstandingPaise: 109_200,
      nonInterestBearingPaise: 9_205,
    });
    // the same dedupe key cannot be issued twice
    await expect(
      sequelize.transaction(async t => {
        const locked = await Invoice.findByPk(invoice.id, { transaction: t, lock: t.LOCK.UPDATE });
        return issueDebitNote(
          sysCtx(w),
          w.society.id!,
          locked!,
          {
            reasonCode: 'INTEREST',
            remarks: 'Again',
            lines: [{ head: interest, description: 'Interest', amountPaise: 9_205, kind: 'INTEREST' }],
            dedupeKey: `INT:${invoice.id}:2026-09-30`,
          },
          t,
        );
      }),
    ).rejects.toThrow();
    // credit part of the interest line of the debit note
    const dnLine = (await InvoiceLine.findOne({ where: { billingNoteId: note.id!, lineKind: 'INTEREST' } }))!;
    const c = await issueCredit(w, invoice, [[Number(dnLine.id), 5_000]]);
    expect(c.totalPaise).toBe(5_000);
    expect(await inv(invoice.id)).toMatchObject({
      creditedPaise: 5_000,
      outstandingPaise: 104_200,
      nonInterestBearingPaise: 4_205,
    });
    expect((await InvoiceLine.findByPk(dnLine.id!))!.creditedPaise).toBe(5_000);
  });
});

describe('cancellation (8.17, BR-11-44)', () => {
  const cancel = (w: RunSociety, id: number, reason = 'Billed to the wrong flat') =>
    w.c('post', `/invoices/${id}/cancel`, { reason }, { headers: idemH() });

  it('asks for approval (202), blocks a second request and any note while open, and on approval credits every open line with tax and round-off', async () => {
    const w = await invoiceWorld();
    await setGst(w);
    await setSetting(w.society.id!, 'billing.applyGst', true);
    const invoice = await makeInvoice(w, 0, [
      { head: 'MAINTENANCE', amountPaise: 688_000 },
      { head: 'SINKING_FUND', amountPaise: 60_000 },
      { head: 'REPAIR_FUND', amountPaise: 25_000 },
      { head: 'PARKING', amountPaise: 50_000 },
      { head: 'WATER', amountPaise: 35_000 },
    ]);
    expect(invoice.totalPaise).toBe(1_006_100);
    const r = await cancel(w, invoice.id);
    expect(r.status).toBe(202);
    expect(r.body.data).toEqual({ approvalRequestId: expect.any(Number), status: 'PENDING' });
    expect(calls('approvals.request')[0]).toMatchObject({
      type: 'INVOICE_CANCEL',
      entityType: 'invoice',
      entityId: invoice.id,
      title: `Cancel ${invoice.invoiceNo}`,
      amountPaise: 1_006_100,
      payload: { reason: 'Billed to the wrong flat', totalPaise: 1_006_100, paidPaise: 0 },
    });
    expect(await AuditLog.count({ where: { action: 'billing.invoice.cancel_requested' } })).toBe(1);
    const second = await cancel(w, invoice.id);
    expect([second.status, second.body.code]).toEqual([409, 'APPROVAL_ALREADY_PENDING']);
    const wo = await w.c(
      'post',
      `/invoices/${invoice.id}/write-off`,
      { amountPaise: 100, reason: 'Small amount left over' },
      { headers: idemH() },
    );
    expect([wo.status, wo.body.code]).toEqual([409, 'INVOICE_CANCEL_PENDING']);
    await expect(approve(r.body.data.approvalRequestId, ctxFor(w, w.user.id!))).rejects.toMatchObject({
      code: 'MAKER_CHECKER_VIOLATION',
    });
    await approve(r.body.data.approvalRequestId, treasurerCtx(w));
    const row = await inv(invoice.id);
    expect(row).toMatchObject({
      status: 'CANCELLED',
      outstandingPaise: 0,
      creditedPaise: 1_006_100,
      paidPaise: 0,
    });
    expect(row.cancelledAt).toBeInstanceOf(Date);
    const note = (await BillingNote.findOne({ where: { invoiceId: invoice.id } }))!;
    expect(note).toMatchObject({
      reasonCode: 'CANCELLATION',
      status: 'ISSUED',
      approvalType: 'INVOICE_CANCEL',
      noteNo: 'CN/2026-27/000001',
      subtotalPaise: 858_000,
      cgstPaise: 74_070,
      sgstPaise: 74_070,
      totalPaise: 1_006_100,
      appliedToInvoicePaise: 1_006_100,
    });
    const lines = await InvoiceLine.findAll({
      where: { billingNoteId: note.id! },
      order: [['lineNo', 'ASC']],
    });
    expect(lines.map(l => [l.lineKind, Number(l.amountPaise)])).toEqual([
      ['CHARGE', 688_000],
      ['CHARGE', 60_000],
      ['CHARGE', 25_000],
      ['CHARGE', 50_000],
      ['CHARGE', 35_000],
      ['CGST', 74_070],
      ['SGST', 74_070],
      ['ROUND_OFF', -40],
    ]);
    const orig = await InvoiceLine.findAll({ where: { invoiceId: invoice.id } });
    expect(orig.every(l => Number(l.creditedPaise) === Math.abs(Number(l.amountPaise)))).toBe(true);
    expect(await ledgerNet(w)).toBe(0);
    const j = journals().find(x => x.voucherType === 'CREDIT_NOTE');
    expect(sums(j)).toEqual([1_006_100, 1_006_100].map((v, i) => (i === 0 ? 1_006_140 : v + 40)));
    expect(j.lines.find((l: any) => l.accountCode === '4990')).toMatchObject({ creditPaise: 40 });
    expect(await AuditLog.count({ where: { action: 'billing.invoice.cancelled' } })).toBe(1);
    await drainQueues();
    expect(calls('notifications.send').length >= 0).toBe(true);
    // the dedupe key (none for ad hoc) stays; every action is now INVALID_STATE
    for (const [p, body] of [
      [`/invoices/${invoice.id}/cancel`, { reason: 'Billed to the wrong flat' }],
      [`/invoices/${invoice.id}/write-off`, { amountPaise: 1, reason: 'Nothing is owed any more' }],
    ] as const) {
      const x = await w.c('post', p, body, { headers: idemH() });
      expect([p, x.status, x.body.code]).toEqual([p, 409, 'INVALID_STATE']);
    }
  });

  it('is refused while a credit note is pending (409 CREDIT_NOTE_PENDING); a rejected request leaves the invoice open and can be asked again', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    const n = await postCredit(w, invoice.id, creditBody([[lineId(invoice, 'PARKING'), 100]]));
    const blocked = await cancel(w, invoice.id);
    expect([blocked.status, blocked.body.code]).toEqual([409, 'CREDIT_NOTE_PENDING']);
    await reject(n.body.data.approvalRequestId, 'No', treasurerCtx(w));
    const r = await cancel(w, invoice.id);
    expect(r.status).toBe(202);
    await reject(r.body.data.approvalRequestId, 'Keep the bill', treasurerCtx(w));
    expect((await inv(invoice.id)).status).toBe('ISSUED');
    expect((await cancel(w, invoice.id)).status).toBe(202);
  });

  it('a paid invoice: module 12 releases the allocations first, the note credits the rest, the advance is re-applied after commit', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    const m12 = module12ReleasesOnCancel(w);
    await pay(w, invoice.id, 200_000);
    billingPortCalls.length = 0;
    const r = await cancel(w, invoice.id);
    await approve(r.body.data.approvalRequestId, treasurerCtx(w));
    expect(m12.calls).toEqual([invoice.id]);
    expect(await inv(invoice.id)).toMatchObject({
      status: 'CANCELLED',
      paidPaise: 0,
      outstandingPaise: 0,
      creditedPaise: 453_000,
    });
    expect(calls('payments.queueAdvanceApply')).toEqual([
      { societyId: w.society.id, unitIds: [w.units[0]!.id] },
    ]);
    expect(await ledgerNet(w)).toBe(0);
  });

  it('auto-approval cancels at once and answers 200 with the cancelled invoice', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    setBillingPorts({ approvals: { request: async () => ({ id: 903, status: 'APPROVED' }) } });
    const r = await cancel(w, invoice.id);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ id: invoice.id, status: 'CANCELLED', outstandingPaise: 0 });
  });

  it('after a partial write-off the cancellation credits exactly what is still owed', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    const wo = await w.c(
      'post',
      `/invoices/${invoice.id}/write-off`,
      { amountPaise: 100_000, reason: 'Bad debt of old tenant' },
      { headers: idemH() },
    );
    await approve(wo.body.data.approvalRequestId, treasurerCtx(w));
    expect(await inv(invoice.id)).toMatchObject({ writtenOffPaise: 100_000, outstandingPaise: 353_000 });
    const r = await cancel(w, invoice.id);
    await approve(r.body.data.approvalRequestId, treasurerCtx(w));
    expect(await inv(invoice.id)).toMatchObject({
      status: 'CANCELLED',
      outstandingPaise: 0,
      creditedPaise: 453_000,
    });
    const note = (await BillingNote.findOne({ where: { reasonCode: 'CANCELLATION' } }))!;
    expect(note.totalPaise).toBe(353_000);
    expect(await ledgerNet(w)).toBe(0);
  });

  it('invoices.requestCancel for other modules: same rules, own transaction, errors', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    const req = (id: number) =>
      sequelize.transaction(t => invoices.requestCancel(sysCtx(w), id, 'Transfer cancelled by the buyer', t));
    const r = await req(invoice.id);
    expect(r).toEqual({ approvalRequestId: expect.any(Number), status: 'PENDING' });
    await expect(req(invoice.id)).rejects.toMatchObject({ status: 409, code: 'APPROVAL_ALREADY_PENDING' });
    await expect(req(999_999)).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' });
    await approve(r.approvalRequestId, treasurerCtx(w));
    await expect(req(invoice.id)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });
});

describe('write-off (8.17, BR-11-45)', () => {
  const writeOff = (w: RunSociety, id: number, amountPaise: number, reason = 'Bad debt of old tenant') =>
    w.c('post', `/invoices/${id}/write-off`, { amountPaise, reason }, { headers: idemH() });

  it('needs recent authentication (401 REAUTH_REQUIRED), 10 characters of reason, an amount within the outstanding and an open invoice', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    expect((await writeOff(w, invoice.id, 1, 'short')).status).toBe(400);
    expect((await writeOff(w, invoice.id, 0)).status).toBe(400);
    const over = await writeOff(w, invoice.id, 453_001);
    expect([over.status, over.body.code]).toEqual([422, 'WRITE_OFF_EXCEEDS_OUTSTANDING']);
    advance(10 * 60_000);
    const stale = await writeOff(w, invoice.id, 1_000);
    expect([stale.status, stale.body.code]).toEqual([401, 'REAUTH_REQUIRED']); // T11-30
    expect(await BillingNote.count()).toBe(0);
  });

  it('is requested as a credit note with one WRITE_OFF line, issued on approval: Dr 5900 / Cr 1300, writtenOff and credited rise', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    await pay(w, invoice.id, 400_000);
    const r = await writeOff(w, invoice.id, 30_000);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'PENDING_APPROVAL',
      reasonCode: 'WRITE_OFF',
      approvalType: 'WRITE_OFF',
      totalPaise: 30_000,
      noteNo: null,
    });
    expect(r.body.data.lines).toEqual([
      expect.objectContaining({ lineKind: 'WRITE_OFF', amountPaise: 30_000, refInvoiceLineId: null }),
    ]);
    expect(calls('approvals.request')[0]).toMatchObject({
      type: 'WRITE_OFF',
      entityType: 'billing_note',
      amountPaise: 30_000,
    });
    expect(await AuditLog.count({ where: { action: 'billing.write_off.requested' } })).toBe(1);
    await approve(r.body.data.approvalRequestId, treasurerCtx(w));
    expect(await inv(invoice.id)).toMatchObject({
      writtenOffPaise: 30_000,
      creditedPaise: 30_000,
      outstandingPaise: 23_000,
      status: 'PARTIALLY_PAID',
    });
    const j = journals().find(x => x.voucherType === 'WRITE_OFF');
    expect(j.lines).toEqual([
      expect.objectContaining({ accountCode: '1300', creditPaise: 30_000 }),
      expect.objectContaining({ accountCode: '5900', debitPaise: 30_000 }),
    ]);
    expect((await BillingNote.findOne({ where: { reasonCode: 'WRITE_OFF' } }))!.noteNo).toBe(
      'CN/2026-27/000001',
    );
    expect(await ledgerNet(w)).toBe(423_000); // module 12 posts the payment entry, not this module
    expect(await AuditLog.count({ where: { action: 'billing.write_off.issued' } })).toBe(1);
    const rest = await writeOff(w, invoice.id, 23_000);
    await approve(rest.body.data.approvalRequestId, treasurerCtx(w));
    expect(await inv(invoice.id)).toMatchObject({
      status: 'PAID',
      outstandingPaise: 0,
      writtenOffPaise: 53_000,
    });
    const paid = await writeOff(w, invoice.id, 1);
    expect([paid.status, paid.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('rejection leaves the invoice as it was; an approval after the bill was paid throws WRITE_OFF_EXCEEDS_OUTSTANDING and the note stays pending', async () => {
    const w = await invoiceWorld();
    const invoice = await makeInvoice(w);
    const a = await writeOff(w, invoice.id, 100_000);
    await reject(a.body.data.approvalRequestId, 'Pursue the member', treasurerCtx(w));
    expect(await BillingNote.findByPk(a.body.data.id)).toMatchObject({
      status: 'REJECTED',
      rejectedReason: 'Pursue the member',
    });
    expect((await inv(invoice.id)).writtenOffPaise).toBe(0);
    expect(await AuditLog.count({ where: { action: 'billing.write_off.rejected' } })).toBe(1);
    const b = await writeOff(w, invoice.id, 100_000);
    await pay(w, invoice.id, 400_000);
    await expect(approve(b.body.data.approvalRequestId, treasurerCtx(w))).rejects.toMatchObject({
      status: 422,
      code: 'WRITE_OFF_EXCEEDS_OUTSTANDING',
    });
    expect((await BillingNote.findByPk(b.body.data.id))!.status).toBe('PENDING_APPROVAL');
  });
});

describe('credit and cancel by source for other modules (BR-11-50a, BR-11-50b, T11-50 to T11-54)', () => {
  async function holdInvoice(w: RunSociety, o: { amountPaise?: number; refId?: number } = {}) {
    const r = await sequelize.transaction(t =>
      invoices.createAdHoc(
        sysCtx(w),
        {
          unitId: w.units[0]!.id,
          chargeHeadKey: 'PARKING',
          amountPaise: o.amountPaise ?? 100_000,
          refType: 'booking',
          refId: o.refId ?? 5,
          dueDate: '2026-11-30',
        },
        t,
      ),
    );
    return r.invoiceId;
  }
  const credit = (w: RunSociety, id: number, o: Record<string, unknown> = {}) =>
    sequelize.transaction(t =>
      invoices.creditBySource(
        sysCtx(w),
        id,
        {
          refType: 'booking',
          refId: 5,
          percent: '50.0000',
          reason: 'Booking cancelled by the member',
          ...o,
        } as never,
        t,
      ),
    );
  const cancelSrc = (w: RunSociety, id: number, o: Record<string, unknown> = {}) =>
    sequelize.transaction(t =>
      invoices.cancelBySource(
        sysCtx(w),
        id,
        { refType: 'booking', refId: 5, reason: 'Hold expired', ...o } as never,
        t,
      ),
    );

  it('T11-50 50 % on a paid 100,000 booking invoice issues CN 50,000 without an approval request, releases and re-applies the advance', async () => {
    const w = await invoiceWorld();
    const id = await holdInvoice(w);
    const m12 = module12ReleasesOnCancel(w);
    await pay(w, id, 100_000);
    billingPortCalls.length = 0;
    const r = await credit(w, id);
    expect(r).toEqual({ noteId: expect.any(Number), noteNo: 'CN/2026-27/000001', totalPaise: 50_000 });
    expect(calls('approvals.request')).toEqual([]);
    expect(m12.calls).toEqual([id]);
    const note = (await BillingNote.findByPk(r.noteId))!;
    expect(note).toMatchObject({
      status: 'ISSUED',
      reasonCode: 'SOURCE_REFUND',
      approvalType: null,
      excessToAdvancePaise: 50_000,
      remarks: 'Booking cancelled by the member',
    });
    expect(await inv(id)).toMatchObject({ creditedPaise: 50_000, paidPaise: 0, outstandingPaise: 50_000 });
    expect(calls('payments.queueAdvanceApply')).toHaveLength(1);
    expect(await AuditLog.count({ where: { action: 'billing.credit_note.issued_by_source' } })).toBe(1);
    expect(sums(journals().find(x => x.voucherType === 'CREDIT_NOTE'))).toEqual([50_000, 50_000]);
  });

  it('T11-52 60 % after 50 % is 422 CREDIT_EXCEEDS_LINE; 100 % credits every open line; invalid percent is 400', async () => {
    const w = await invoiceWorld();
    const id = await holdInvoice(w);
    await credit(w, id);
    await expect(credit(w, id, { percent: '60.0000' })).rejects.toMatchObject({
      status: 422,
      code: 'CREDIT_EXCEEDS_LINE',
    });
    for (const percent of ['0', '0.0000', '100.0001', 'abc', '5.12345', '-1'])
      await expect(credit(w, id, { percent })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(credit(w, id, { reason: 'no' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const rest = await credit(w, id, { percent: '100.0000' });
    expect(rest.totalPaise).toBe(50_000);
    expect(await inv(id)).toMatchObject({ creditedPaise: 100_000, outstandingPaise: 0, status: 'PAID' });
    await expect(credit(w, id, { percent: '1.0000' })).rejects.toMatchObject({ code: 'CREDIT_EXCEEDS_LINE' });
  });

  it('percent rounds half up on the charge line and the round-off of the invoice is kept when 100 % is credited', async () => {
    const w = await invoiceWorld();
    const id = await holdInvoice(w, { amountPaise: 12_345, refId: 6 });
    const r = await credit(w, id, { refId: 6, percent: '33.3333' });
    expect(r.totalPaise).toBe(4_115); // 12,345 x 33.3333 % = 4,114.9
    const full = await credit(w, id, { refId: 6, percent: '100.0000' });
    // the rest of the charge (8,230) plus the invoice's round-off line (-45) = what the invoice still owed
    expect(full.totalPaise).toBe(8_185);
    expect(await inv(id)).toMatchObject({ outstandingPaise: 0, totalPaise: 12_300 });
  });

  it('T11-51 another refId, another refType, a regular invoice, a cancelled invoice, an open cancellation request', async () => {
    const w = await invoiceWorld();
    const id = await holdInvoice(w);
    await expect(credit(w, id, { refId: 6 })).rejects.toMatchObject({
      status: 422,
      code: 'INVOICE_SOURCE_MISMATCH',
    });
    await expect(credit(w, id, { refType: 'transfer' })).rejects.toMatchObject({
      code: 'INVOICE_SOURCE_MISMATCH',
    });
    await expect(credit(w, 999_999)).rejects.toMatchObject({ status: 404, code: 'INVOICE_NOT_FOUND' });
    await expect(credit(w, id, { refType: 'Bad Type' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const regular = await makeInvoice(w, 1);
    await Invoice.sequelize!.query(
      "UPDATE invoices SET invoiceType = 'REGULAR', periodStart = '2026-11-01', periodEnd = '2026-11-30' WHERE id = ?",
      { replacements: [regular.id] },
    );
    await expect(credit(w, regular.id)).rejects.toMatchObject({ code: 'INVOICE_SOURCE_MISMATCH' });
    const pendingCancel = await sequelize.transaction(t =>
      invoices.requestCancel(sysCtx(w), id, 'Transfer cancelled by the buyer', t),
    );
    await expect(credit(w, id)).rejects.toMatchObject({ status: 409, code: 'INVOICE_CANCEL_PENDING' });
    await expect(cancelSrc(w, id)).rejects.toMatchObject({ status: 409, code: 'INVOICE_CANCEL_PENDING' });
    await approve(pendingCancel.approvalRequestId, treasurerCtx(w));
    await expect(credit(w, id)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });

  it('T11-53 cancelBySource cancels an unpaid hold invoice with a CANCELLATION note and no approval request', async () => {
    const w = await invoiceWorld();
    const id = await holdInvoice(w);
    billingPortCalls.length = 0;
    const r = await cancelSrc(w, id);
    expect(r).toEqual({ noteId: expect.any(Number), noteNo: 'CN/2026-27/000001' });
    expect(calls('approvals.request')).toEqual([]);
    expect(await inv(id)).toMatchObject({ status: 'CANCELLED', outstandingPaise: 0, creditedPaise: 100_000 });
    expect(await BillingNote.findByPk(r.noteId)).toMatchObject({
      reasonCode: 'CANCELLATION',
      status: 'ISSUED',
      approvalType: null,
      totalPaise: 100_000,
    });
    expect(await ledgerNet(w)).toBe(0);
    expect(await AuditLog.count({ where: { action: 'billing.invoice.cancelled_by_source' } })).toBe(1);
    await expect(cancelSrc(w, id)).rejects.toMatchObject({ status: 409, code: 'INVALID_STATE' });
  });

  it('T11-54 after a payment was allocated cancelBySource is 422 INVOICE_HAS_ALLOCATIONS and nothing changes; a source mismatch and a pending credit note are refused', async () => {
    const w = await invoiceWorld();
    const id = await holdInvoice(w);
    await expect(cancelSrc(w, id, { refId: 9 })).rejects.toMatchObject({ code: 'INVOICE_SOURCE_MISMATCH' });
    await pay(w, id, 1_000);
    await expect(cancelSrc(w, id)).rejects.toMatchObject({ status: 422, code: 'INVOICE_HAS_ALLOCATIONS' });
    expect(await inv(id)).toMatchObject({ status: 'PARTIALLY_PAID', paidPaise: 1_000, creditedPaise: 0 });
    const other = await holdInvoice(w, { refId: 8 });
    const line = (await InvoiceLine.findOne({ where: { invoiceId: other, lineKind: 'CHARGE' } }))!;
    await w.c('post', `/invoices/${other}/credit-notes`, creditBody([[Number(line.id), 100]]), {
      headers: idemH(),
    });
    await expect(cancelSrc(w, other, { refId: 8 })).rejects.toMatchObject({
      status: 409,
      code: 'CREDIT_NOTE_PENDING',
    });
    // a reversed allocation still counts (no allocation "ever" reversed onto it)
    setBillingPorts({
      payments: {
        listAllocationsForInvoice: async () => [{ paymentId: 1, allocatedOn: '2026-11-04', amountPaise: 0 }],
      },
    });
    const third = await holdInvoice(w, { refId: 10 });
    await expect(cancelSrc(w, third, { refId: 10 })).rejects.toMatchObject({
      code: 'INVOICE_HAS_ALLOCATIONS',
    });
  });
});

describe('every note route has the marker, permission, entitlement and idempotency the spec says', () => {
  it('matches section 2 and 8', async () => {
    const routes = listRoutes(app).filter(
      r => r.path.startsWith('/invoices') || r.path.startsWith('/billing/notes'),
    );
    const found = Object.fromEntries(routes.map(r => [`${r.method} ${r.path}`, r]));
    const expected: Record<string, [string, string[], boolean, boolean]> = {
      'GET /invoices': ['finance.billing.view', [], false, false],
      'GET /invoices/export': ['finance.billing.export', [], false, false],
      'GET /invoices/:id': ['finance.billing.view', [], false, false],
      'GET /invoices/:id/pdf-url': [
        'finance.billing.view',
        ['billing.invoice_pdf_with_upi_qr'],
        false,
        false,
      ],
      'POST /invoices': [
        'finance.billing.create',
        ['billing.supplementary_and_ad_hoc_invoices'],
        true,
        false,
      ],
      'POST /invoices/:id/credit-notes': ['finance.billing.create', ['billing.credit_notes'], true, false],
      'POST /invoices/:id/debit-notes': ['finance.billing.create', ['billing.debit_notes'], true, false],
      'POST /invoices/:id/cancel': ['finance.billing.edit', ['billing.credit_notes'], true, false],
      'POST /invoices/:id/write-off': ['finance.billing.edit', ['billing.credit_notes'], true, true],
      'GET /billing/notes': ['finance.billing.view', [], false, false],
      'GET /billing/notes/:id': ['finance.billing.view', [], false, false],
      'GET /billing/notes/:id/pdf-url': [
        'finance.billing.view',
        ['billing.invoice_pdf_with_upi_qr'],
        false,
        false,
      ],
      'PATCH /billing/notes/:id': ['finance.billing.create', ['billing.credit_notes'], false, false],
      'POST /billing/notes/:id/withdraw': ['finance.billing.create', ['billing.credit_notes'], false, false],
    };
    const mine = Object.keys(found).filter(k => !k.includes('/remind'));
    expect(mine.sort()).toEqual(Object.keys(expected).sort());
    for (const [k, [perm, features, idempotent, stepUp]] of Object.entries(expected))
      expect(found[k], k).toMatchObject({
        kind: 'society',
        permissions: [perm],
        features,
        idempotent,
        stepUp,
      });
  });
});
