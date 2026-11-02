import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, FeatureFlag, Society, Subscription, closeDb, sequelize } from '../../../src/models';
import { signWebhookBody, type FakePaymentGateway } from '../../../src/adapters/payments/payment-gateway';
import { advance, setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { env } from '../../../src/lib/env';
import { invalidateFlags } from '../../../src/modules/subscriptions/flags.service';
import { as, login, memberUser, platformLogin, resetLogins } from '../../helpers/access';
import { call } from '../../helpers/auth';
import { placeholderFiles } from '../../../src/modules/societies/societies.ports';
import { billedSociety, idemKey, platformTeam, resetBilling } from '../../helpers/billing';

/** Task 6.3: the routes of 8.1 to 8.4 and 8.12 to 8.14, isolation (T06-31, T06-34) and autopay (T06-36). */
let gw: FakePaymentGateway;
beforeEach(async () => {
  gw = (await resetBilling()) as FakePaymentGateway;
});
afterEach(async () => {
  await FeatureFlag.update({ isEnabled: false }, { where: { flagKey: 'platform.autopay' } });
  invalidateFlags();
});
afterAll(async () => {
  await drainQueues();
  setNow(null);
  await closeDb();
});

async function setup() {
  const s = await billedSociety();
  return { ...s, ...(await platformTeam()) };
}

describe('reads (8.1 to 8.4)', () => {
  it('the society invoice list and detail carry the 8.2 and 8.3 shapes and hide drafts; the platform sees them', async () => {
    const { society, invoice, view, maker } = await setup();
    const d = await maker.c(
      'post',
      '/platform/invoices',
      {
        societyId: society.id,
        lines: [{ description: 'Setup assistance', quantity: '2', unitPricePaise: 50000 }],
        notes: 'On site',
      },
      { headers: idemKey() },
    );
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    const list = await view('get', '/subscription/invoices');
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toEqual({
      id: invoice.id,
      invoiceNo: invoice.invoiceNo,
      documentType: 'INVOICE',
      invoiceKind: 'PERIOD',
      societyId: society.id,
      societyName: society.name,
      status: 'ISSUED',
      issueDate: '2026-11-01',
      dueDate: '2026-11-16',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      subtotalPaise: 1050000,
      taxPaise: 189000,
      totalPaise: 1239000,
      amountDuePaise: 1239000,
      pdfStatus: 'PENDING',
    });
    expect(list.body.pagination).toEqual({ page: 1, limit: 20, total: 1, totalPages: 1 });
    const pl = await maker.c('get', '/platform/invoices');
    expect(pl.body.data.map((r: { status: string }) => r.status).sort()).toEqual(['DRAFT', 'ISSUED']);
    expect(pl.body.data.find((r: { id: number }) => r.id === invoice.id).societyName).toBe(society.name);
    expect((await view('get', `/subscription/invoices/${d.body.data.id}`)).body.code).toBe(
      'PLATFORM_INVOICE_NOT_FOUND',
    );
    const det = await view('get', `/subscription/invoices/${invoice.id}`);
    expect(det.status).toBe(200);
    expect(det.body.data).toMatchObject({
      id: invoice.id,
      supplier: { legalName: 'SocietyApp Technologies Pvt Ltd', gstin: '27ABCDE1234F1Z5', stateCode: '27' },
      buyer: { name: society.name, gstin: null, stateName: 'Maharashtra' },
      taxType: 'INTRA_STATE',
      gstRatePct: '18.0000',
      lines: [
        expect.objectContaining({
          lineNo: 1,
          lineType: 'PLAN',
          quantity: '420.0000',
          unitPricePaise: 2500,
          amountPaise: 1050000,
        }),
      ],
      creditNotes: [],
      payments: [],
      version: 1,
    });
    expect(det.body.data.createdBy).toBeUndefined();
    expect(det.body.data.dunningEvents).toBeUndefined();
    const pdet = await maker.c('get', `/platform/invoices/${d.body.data.id}`);
    expect(pdet.body.data).toMatchObject({
      status: 'DRAFT',
      createdBy: { id: maker.user.id, name: 'Maker Admin' },
      dunningEvents: [],
      writeOff: { requestedBy: null },
    });
  });

  it('filters, search, sort and the validation of the query', async () => {
    const { invoice, view, maker, support } = await setup();
    const other = await billedSociety({ name: 'Green Park CHS' });
    const q = (c: ReturnType<typeof as>, path: string, query: Record<string, string>) =>
      c('get', path, undefined, { query });
    expect((await q(view, '/subscription/invoices', { status: 'PAID' })).body.pagination.total).toBe(0);
    expect(
      (
        await q(view, '/subscription/invoices', {
          status: 'ISSUED,OVERDUE',
          documentType: 'INVOICE',
          invoiceKind: 'PERIOD',
        })
      ).body.pagination.total,
    ).toBe(1);
    expect(
      (await q(view, '/subscription/invoices', { q: invoice.invoiceNo.slice(0, 8) })).body.pagination.total,
    ).toBe(1);
    expect((await q(view, '/subscription/invoices', { q: 'NOPE' })).body.pagination.total).toBe(0);
    expect(
      (await q(view, '/subscription/invoices', { issueFrom: '2026-11-01', issueTo: '2026-11-30' })).body
        .pagination.total,
    ).toBe(1);
    expect((await q(view, '/subscription/invoices', { issueFrom: '2026-12-01' })).body.pagination.total).toBe(
      0,
    );
    expect(
      (await q(view, '/subscription/invoices', { issueFrom: '2026-12-01', issueTo: '2026-11-01' })).status,
    ).toBe(400);
    expect(
      (await q(view, '/subscription/invoices', { issueFrom: '2025-01-01', issueTo: '2026-11-01' })).status,
    ).toBe(400);
    expect((await q(view, '/subscription/invoices', { status: 'NOPE' })).status).toBe(400);
    expect((await q(view, '/subscription/invoices', { sortBy: 'createdBy' })).status).toBe(400);
    expect(
      (await q(maker.c, '/platform/invoices', { societyId: String(other.society.id) })).body.data.map(
        (r: { societyId: number }) => r.societyId,
      ),
    ).toEqual([other.society.id]);
    expect((await q(maker.c, '/platform/invoices', { q: 'Green' })).body.pagination.total).toBe(1);
    expect((await q(maker.c, '/platform/invoices', { taxType: 'INTER_STATE' })).body.pagination.total).toBe(
      0,
    );
    const sorted = await q(maker.c, '/platform/invoices', { sortBy: 'invoiceNo', sortOrder: 'asc' });
    expect(sorted.body.data.map((r: { invoiceNo: string }) => r.invoiceNo)).toEqual([
      invoice.invoiceNo,
      other.invoice.invoiceNo,
    ]);
    expect((await q(support.c, '/platform/invoices', {})).status).toBe(200);
  });

  it('pdf-url: 409 PDF_NOT_READY while pending, a short-lived URL when ready (audited), and FAILED stays not ready', async () => {
    const { invoice, view, maker, society } = await setup();
    placeholderFiles.set(55, {
      fileId: 55,
      societyId: society.id!,
      purpose: 'PLATFORM_INVOICE_PDF',
      name: 'x.pdf',
      contentType: 'application/pdf',
      content: Buffer.from('pdf'),
      ownerUserId: null,
      status: 'CLEAN',
    });
    const early = await view('get', `/subscription/invoices/${invoice.id}/pdf-url`);
    expect([early.status, early.body.code]).toEqual([409, 'PDF_NOT_READY']);
    await sequelize.query("UPDATE platform_invoices SET pdfStatus = 'READY', pdfFileId = 55 WHERE id = :id", {
      replacements: { id: invoice.id },
    });
    const r = await view('get', `/subscription/invoices/${invoice.id}/pdf-url`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ url: '/api/v1/dev/files/55', fileName: 'PLT-2026-27-000001.pdf' });
    expect(new Date(r.body.data.expiresAt).getTime()).toBe(new Date('2026-11-01T06:05:00Z').getTime());
    expect((await maker.c('get', `/platform/invoices/${invoice.id}/pdf-url`)).status).toBe(200);
    expect(await AuditLog.count({ where: { action: 'platform_billing.invoice.pdf_downloaded' } })).toBe(2);
    await sequelize.query(
      "UPDATE platform_invoices SET pdfStatus = 'FAILED', pdfFileId = NULL WHERE id = :id",
      { replacements: { id: invoice.id } },
    );
    expect((await view('get', `/subscription/invoices/${invoice.id}/pdf-url`)).body.code).toBe(
      'PDF_NOT_READY',
    );
  });

  it('export: CSV of the platform list with the audit row; Support lacks the export permission', async () => {
    const { invoice, maker, support } = await setup();
    const r = await maker.c('get', '/platform/invoices/export');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    const lines = r.text.split('\r\n');
    expect(lines[0]).toBe(
      'Invoice,Type,Society,GSTIN,Place of supply,Issue date,Due date,Period,Taxable,CGST,SGST,IGST,Total,Paid,TDS,Credit applied,Credit noted,Written off,Due,Status',
    );
    expect(lines[1]).toContain(invoice.invoiceNo);
    expect(lines[1]).toContain('10500.00,945.00,945.00,0.00,12390.00');
    expect(await AuditLog.count({ where: { action: 'platform_billing.invoice.exported' } })).toBe(1);
    expect((await support.c('get', '/platform/invoices/export')).status).toBe(403);
  });
});

describe('isolation and permissions (T06-31, T06-34)', () => {
  it('T06-31 society B gets 404 PLATFORM_INVOICE_NOT_FOUND on every invoice route of society A', async () => {
    const a = await billedSociety();
    const b = await billedSociety({ name: 'Green Park CHS' });
    const id = a.invoice.id;
    const treasurerB = await memberUser(b.society, 'treasurer', { name: 'Treasurer B' });
    const cb = as(await login(treasurerB));
    const cases: [string, string, object | undefined][] = [
      ['get', `/subscription/invoices/${id}`, undefined],
      ['get', `/subscription/invoices/${id}/pdf-url`, undefined],
      ['post', `/subscription/invoices/${id}/payment-orders`, {}],
      [
        'post',
        `/subscription/invoices/${id}/tds-claims`,
        { tdsSection: '194J', amountPaise: 1000, deductedOn: '2026-10-31' },
      ],
    ];
    for (const [m, path, body] of cases) {
      const r = await cb(m as 'get', path, body, { headers: idemKey() });
      expect([r.status, r.body.code], path).toEqual([404, 'PLATFORM_INVOICE_NOT_FOUND']);
    }
    // a payment of A is not verifiable by B
    const o = await a.pay('post', `/subscription/invoices/${id}/payment-orders`, {}, { headers: idemKey() });
    const v = await cb('post', `/subscription/payments/${o.body.data.paymentId}/verify`, {
      gatewayPaymentId: 'pay_abcdefgh12',
    });
    expect([v.status, v.body.code]).toEqual([404, 'PLATFORM_PAYMENT_NOT_FOUND']);
    expect(
      (await cb('get', '/subscription/invoices')).body.data.map((r: { id: number }) => r.id),
    ).not.toContain(id);
    expect((await cb('get', '/subscription/payments')).body.pagination.total).toBe(0);
  });

  it('T06-34 a society chairman gets 403 on platform billing routes', async () => {
    const { society } = await billedSociety();
    const chair = await memberUser(society, 'chairman');
    const c = as(await login(chair));
    for (const path of [
      '/platform/invoices',
      '/platform/payments',
      `/platform/societies/${society.id}/credits`,
    ]) {
      const r = await c('get', path);
      expect(r.status, path).toBe(403);
    }
    expect((await c('post', '/platform/payments', {}, { headers: idemKey() })).status).toBe(403);
  });
});

describe('manual invoices and credit notes (8.12 to 8.14)', () => {
  it('T06-38 21 lines and a zero price are 400 VALIDATION_FAILED listing the fields', async () => {
    const { society, maker } = await setup();
    const line = { description: 'Item', quantity: '1', unitPricePaise: 100 };
    const many = await maker.c(
      'post',
      '/platform/invoices',
      { societyId: society.id, lines: Array.from({ length: 21 }, () => line) },
      { headers: idemKey() },
    );
    expect([many.status, many.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(many.body.errors[0].field).toBe('lines');
    const zero = await maker.c(
      'post',
      '/platform/invoices',
      {
        societyId: society.id,
        lines: [
          { ...line, unitPricePaise: 0 },
          { ...line, quantity: '0' },
        ],
      },
      { headers: idemKey() },
    );
    expect(zero.body.errors.map((e: { field: string }) => e.field)).toEqual([
      'lines.0.unitPricePaise',
      'lines.1.quantity',
    ]);
    const unknownSociety = await maker.c(
      'post',
      '/platform/invoices',
      { societyId: 999999, lines: [line] },
      { headers: idemKey() },
    );
    expect(unknownSociety.body.code).toBe('NOT_FOUND');
  });

  it('a manual invoice: draft, reject by the maker is refused, approval needs step-up and a second admin, the stale version is refused', async () => {
    const { society, maker, checker } = await setup();
    const d = await maker.c(
      'post',
      '/platform/invoices',
      {
        societyId: society.id,
        lines: [{ description: 'Onsite training', quantity: '1.5', unitPricePaise: 100000 }],
      },
      { headers: idemKey() },
    );
    expect(d.body.data).toMatchObject({
      status: 'DRAFT',
      invoiceNo: '',
      subtotalPaise: 150000,
      totalPaise: 177000,
    });
    const id = d.body.data.id;
    expect((await maker.c('post', `/platform/invoices/${id}/approve`, { version: 1 })).body.code).toBe(
      'MAKER_CHECKER_VIOLATION',
    );
    expect((await checker.c('post', `/platform/invoices/${id}/approve`, { version: 2 })).body.code).toBe(
      'STALE_VERSION',
    );
    advance(6 * 60_000);
    expect((await checker.c('post', `/platform/invoices/${id}/approve`, { version: 1 })).body.code).toBe(
      'REAUTH_REQUIRED',
    );
    resetLogins();
    const fresh = as(await platformLogin(checker.user), 'PLATFORM');
    const ok = await fresh('post', `/platform/invoices/${id}/approve`, { version: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'ISSUED', amountDuePaise: 177000 });
    expect((await fresh('post', `/platform/invoices/${id}/approve`, { version: 2 })).body.code).toBe(
      'INVALID_STATE',
    );
  });

  it('reject needs a reason; REJECTED drafts are final', async () => {
    const { society, maker, checker } = await setup();
    const d = await maker.c(
      'post',
      '/platform/invoices',
      {
        societyId: society.id,
        lines: [{ description: 'Onsite training', quantity: '1', unitPricePaise: 100000 }],
      },
      { headers: idemKey() },
    );
    expect(
      (await checker.c('post', `/platform/invoices/${d.body.data.id}/reject`, { version: 1, reason: 'no' }))
        .status,
    ).toBe(400);
    const r = await checker.c('post', `/platform/invoices/${d.body.data.id}/reject`, {
      version: 1,
      reason: 'Wrong society was selected',
    });
    expect(r.body.data.status).toBe('REJECTED');
    expect(
      (await checker.c('post', `/platform/invoices/${d.body.data.id}/approve`, { version: 2 })).body.code,
    ).toBe('INVALID_STATE');
  });

  it('a full credit note on a paid invoice voids it and turns the settled money into credit (8.14 response)', async () => {
    const { invoice, maker, checker } = await setup();
    await sequelize.query(
      "UPDATE platform_invoices SET status = 'PAID', paidPaise = totalPaise, amountDuePaise = 0 WHERE id = :id",
      { replacements: { id: invoice.id } },
    );
    const post = (b: object) =>
      maker.c('post', `/platform/invoices/${invoice.id}/credit-notes`, b, { headers: idemKey() });
    expect(
      (await post({ reason: 'OTHER', subtotalPaise: 1050001, notes: 'Billed twice by mistake' })).body.code,
    ).toBe('CREDIT_NOTE_EXCEEDS_INVOICE');
    expect((await post({ reason: 'BAD', subtotalPaise: 100, notes: 'Billed twice by mistake' })).status).toBe(
      400,
    );
    const cn = await post({
      reason: 'DUPLICATE_INVOICE',
      subtotalPaise: 1050000,
      notes: 'Billed twice by mistake',
    });
    expect(cn.status, JSON.stringify(cn.body)).toBe(201);
    expect(cn.body.data).toMatchObject({ documentType: 'CREDIT_NOTE', status: 'DRAFT', totalPaise: 1239000 });
    const ok = await checker.c('post', `/platform/invoices/${cn.body.data.id}/approve`, { version: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      invoiceNo: 'PCN/2026-27/000001',
      documentType: 'CREDIT_NOTE',
      status: 'ISSUED',
      originalInvoice: {
        id: invoice.id,
        invoiceNo: invoice.invoiceNo,
        status: 'VOID',
        amountDuePaise: 0,
        excessToCreditPaise: 1239000,
      },
      creditBalancePaise: 1239000,
    });
    expect(
      (await checker.c('post', `/platform/invoices/${cn.body.data.id}/approve`, { version: 2 })).body.code,
    ).toBe('INVALID_STATE');
  });

  it('T06-25 a credit note after 30 November following the financial year is CREDIT_NOTE_TIME_BARRED', async () => {
    const { invoice } = await setup();
    setNow('2027-12-01T06:00:00Z');
    resetLogins();
    const { maker } = await platformTeam();
    const r = await maker.c(
      'post',
      `/platform/invoices/${invoice.id}/credit-notes`,
      { reason: 'OTHER', subtotalPaise: 100, notes: 'Too late to correct this' },
      { headers: idemKey() },
    );
    expect([r.status, r.body.code]).toEqual([422, 'CREDIT_NOTE_TIME_BARRED']);
  });

  it('T06-26 approving a credit note with a stale version is 409 STALE_VERSION', async () => {
    const { invoice, maker, checker } = await setup();
    const cn = await maker.c(
      'post',
      `/platform/invoices/${invoice.id}/credit-notes`,
      { reason: 'SERVICE_CREDIT', subtotalPaise: 10000, notes: 'Service outage in October' },
      { headers: idemKey() },
    );
    const r = await checker.c('post', `/platform/invoices/${cn.body.data.id}/approve`, { version: 5 });
    expect([r.status, r.body.code]).toEqual([409, 'STALE_VERSION']);
  });
});

describe('autopay (8.11, flag platform.autopay)', () => {
  const flagOn = async () => {
    await FeatureFlag.update({ isEnabled: true }, { where: { flagKey: 'platform.autopay' } });
    invalidateFlags();
  };

  it('T06-36 with the flag off POST and DELETE are 404 NOT_FOUND; the Secretary is 403 before that', async () => {
    const { pay, view } = await setup();
    const r = await pay('post', '/subscription/autopay', { method: 'UPI_AUTOPAY', maxAmountPaise: 2000000 });
    expect([r.status, r.body.code]).toEqual([404, 'NOT_FOUND']);
    expect((await pay('delete', '/subscription/autopay')).body.code).toBe('NOT_FOUND');
    expect(
      (await view('post', '/subscription/autopay', { method: 'UPI_AUTOPAY', maxAmountPaise: 2000000 }))
        .status,
    ).toBe(403);
  });

  it('set-up returns the auth URL and PENDING; the webhook activates; a second request is 409; DELETE cancels', async () => {
    const { pay, sub, society, invoice } = await setup();
    await flagOn();
    expect(
      (await pay('post', '/subscription/autopay', { method: 'UPI_AUTOPAY', maxAmountPaise: 99 })).status,
    ).toBe(400);
    const low = await pay('post', '/subscription/autopay', {
      method: 'UPI_AUTOPAY',
      maxAmountPaise: invoice.totalPaise - 1,
    });
    expect([low.status, low.body.code]).toEqual([422, 'MANDATE_LIMIT_TOO_LOW']);
    gw.failNext.createMandate = true;
    expect(
      (await pay('post', '/subscription/autopay', { method: 'UPI_AUTOPAY', maxAmountPaise: 2000000 })).body
        .code,
    ).toBe('GATEWAY_ERROR');
    const r = await pay('post', '/subscription/autopay', { method: 'UPI_AUTOPAY', maxAmountPaise: 2000000 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.authUrl).toMatch(/^https:\/\/fake-gateway\.invalid\/authorize\/token_/);
    expect(await Subscription.findByPk(sub.id!)).toMatchObject({
      autopayStatus: 'PENDING',
      autopayMethod: 'UPI_AUTOPAY',
      autopayMaxAmountPaise: 2000000,
    });
    expect(
      await AuditLog.count({
        where: { action: 'platform_billing.autopay.requested', societyId: society.id! },
      }),
    ).toBe(1);
    const dup = await pay('post', '/subscription/autopay', { method: 'EMANDATE', maxAmountPaise: 2000000 });
    expect([dup.status, dup.body.code]).toEqual([409, 'MANDATE_ALREADY_ACTIVE']);
    const mandateId = (await Subscription.findByPk(sub.id!))!.autopayMandateRef!;
    const body = JSON.stringify({
      id: 'evt_m1',
      event: 'mandate.activated',
      payload: { mandate: { entity: { id: mandateId } } },
    });
    const w = await call('post', '/webhooks/platform-billing/razorpay', body, {
      app: 'ADMIN',
      headers: {
        'content-type': 'application/json',
        'x-razorpay-signature': signWebhookBody(body, env().PLATFORM_RAZORPAY_WEBHOOK_SECRET),
      },
    });
    expect(w.status).toBe(200);
    await drainQueues();
    expect((await Subscription.findByPk(sub.id!))!.autopayStatus).toBe('ACTIVE');
    expect(await AuditLog.count({ where: { action: 'platform_billing.autopay.activated' } })).toBe(1);
    const del = await pay('delete', '/subscription/autopay');
    expect(del.status, JSON.stringify(del.body)).toBe(200);
    expect(gw.mandates.get(mandateId)!.status).toBe('cancelled');
    expect((await Subscription.findByPk(sub.id!))!.autopayStatus).toBe('CANCELLED');
    expect(await AuditLog.count({ where: { action: 'platform_billing.autopay.cancelled' } })).toBe(1);
    expect((await pay('delete', '/subscription/autopay')).body.code).toBe('INVALID_STATE');
  });

  it('a suspended society cannot set up autopay (423 SOCIETY_SUSPENDED) while it can still pay', async () => {
    const { pay, society, invoice } = await setup();
    await flagOn();
    await Society.update(
      { status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL', activatedAt: new Date() },
      { where: { id: society.id! } },
    );
    const r = await pay('post', '/subscription/autopay', { method: 'UPI_AUTOPAY', maxAmountPaise: 2000000 });
    expect([r.status, r.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
    expect(
      (await pay('post', `/subscription/invoices/${invoice.id}/payment-orders`, {}, { headers: idemKey() }))
        .status,
    ).toBe(201);
  });
});
