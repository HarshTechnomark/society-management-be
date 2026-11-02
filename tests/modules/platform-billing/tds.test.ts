import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, PlatformInvoice, PlatformPayment, closeDb, sequelize } from '../../../src/models';
import { paymentGateway } from '../../../src/adapters';
import type { FakePaymentGateway } from '../../../src/adapters/payments/payment-gateway';
import { setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { placeholderBillingFiles } from '../../../src/modules/platform-billing/platform-billing.ports';
import { inboxFor } from '../../helpers/auth';
import { billedSociety, idemKey, platformTeam, resetBilling } from '../../helpers/billing';

/** Task 6.3: TDS claims and the platform decision (BR-06-33; 8.9, 8.10, 8.20; T06-23, T06-24, T06-32). */
beforeEach(async () => {
  await resetBilling();
});
afterAll(async () => {
  await drainQueues();
  setNow(null);
  await closeDb();
});

// the fixture invoice: taxable 1,050,000 paise, total 1,239,000; the 10% cap is 105,000
const claim = (amountPaise: number, o: Record<string, unknown> = {}) => ({
  tdsSection: '194J',
  tdsRatePct: '2',
  amountPaise,
  deductedOn: '2026-10-31',
  ...o,
});
async function setup() {
  const s = await billedSociety();
  return { ...s, ...(await platformTeam()) };
}

describe('claims by the society (8.9)', () => {
  it('T06-32 the Secretary (view only) gets 403 on tds-claims; the Treasurer gets 201 and the invoice is settled at once', async () => {
    const { view, pay, invoice, society } = await setup();
    const no = await view('post', `/subscription/invoices/${invoice.id}/tds-claims`, claim(21000), {
      headers: idemKey(),
    });
    expect([no.status, no.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    const r = await pay('post', `/subscription/invoices/${invoice.id}/tds-claims`, claim(21000), {
      headers: idemKey(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toEqual({
      id: expect.any(Number),
      kind: 'TDS',
      status: 'CLAIMED',
      amountPaise: 21000,
      tdsSection: '194J',
      invoice: { id: invoice.id, status: 'PARTIALLY_PAID', amountDuePaise: 1218000 },
    });
    expect(await PlatformPayment.findByPk(r.body.data.id)).toMatchObject({
      method: 'TDS',
      origin: 'SOCIETY',
      appliedPaise: 21000,
      tdsRatePct: '2.0000',
      deductedOn: '2026-10-31',
    });
    expect(await PlatformInvoice.findByPk(invoice.id)).toMatchObject({ tdsPaise: 21000 });
    expect(
      await AuditLog.count({ where: { action: 'platform_billing.tds.claimed', societyId: society.id! } }),
    ).toBe(1);
  });

  it('T06-23 10% of the taxable value plus 1 paisa is 422 TDS_EXCEEDS_LIMIT (never on GST); exactly 10% is accepted', async () => {
    const { pay, invoice } = await setup();
    const over = await pay('post', `/subscription/invoices/${invoice.id}/tds-claims`, claim(105001), {
      headers: idemKey(),
    });
    expect([over.status, over.body.code]).toEqual([422, 'TDS_EXCEEDS_LIMIT']);
    expect(
      (
        await pay('post', `/subscription/invoices/${invoice.id}/tds-claims`, claim(105000), {
          headers: idemKey(),
        })
      ).status,
    ).toBe(201);
  });

  it('above the amount due is TDS_EXCEEDS_LIMIT; one active claim per invoice; a rejected claim frees the slot', async () => {
    const { pay, invoice, maker } = await setup();
    await sequelize.query(
      'UPDATE platform_invoices SET amountDuePaise = 5000, paidPaise = totalPaise - 5000, status = "PARTIALLY_PAID" WHERE id = :id',
      { replacements: { id: invoice.id } },
    );
    expect(
      (
        await pay('post', `/subscription/invoices/${invoice.id}/tds-claims`, claim(5100), {
          headers: idemKey(),
        })
      ).body.code,
    ).toBe('TDS_EXCEEDS_LIMIT');
    const a = await pay('post', `/subscription/invoices/${invoice.id}/tds-claims`, claim(1000), {
      headers: idemKey(),
    });
    expect(a.status).toBe(201);
    const dup = await pay('post', `/subscription/invoices/${invoice.id}/tds-claims`, claim(1000), {
      headers: idemKey(),
    });
    expect([dup.status, dup.body.code]).toEqual([409, 'TDS_ALREADY_CLAIMED']);
    const rej = await maker.c('post', `/platform/payments/${a.body.data.id}/tds-decision`, {
      decision: 'REJECTED',
      reason: 'Certificate does not match',
      version: 1,
    });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(
      (
        await pay('post', `/subscription/invoices/${invoice.id}/tds-claims`, claim(1000), {
          headers: idemKey(),
        })
      ).status,
    ).toBe(201);
  });

  it('validates the date and the fields; an unpayable invoice is 409; replays with the same key', async () => {
    const { pay, invoice } = await setup();
    const post = (b: object, headers = idemKey()) =>
      pay('post', `/subscription/invoices/${invoice.id}/tds-claims`, b, { headers });
    expect((await post(claim(21000, { deductedOn: '2026-11-02' }))).body.errors[0].field).toBe('deductedOn');
    expect((await post(claim(21000, { deductedOn: '2026-09-30' }))).status).toBe(400);
    expect((await post(claim(99))).status).toBe(400);
    expect((await post(claim(21000, { tdsSection: '194Q' }))).status).toBe(400);
    expect((await post(claim(21000, { tdsRatePct: '25' }))).status).toBe(400);
    expect((await post(claim(21000, { certificateFileId: 9 }))).body.code).toBe('FILE_NOT_LINKABLE');
    placeholderBillingFiles.add('TDS_CERTIFICATE:9');
    const headers = idemKey();
    const a = await post(claim(21000, { certificateFileId: 9 }), headers);
    expect(a.status).toBe(201);
    expect((await post(claim(21000, { certificateFileId: 9 }), headers)).headers['idempotent-replay']).toBe(
      'true',
    );
    expect((await PlatformPayment.findByPk(a.body.data.id))!.tdsCertificateFileId).toBe(9);
    await sequelize.query("UPDATE platform_invoices SET status = 'PAID', amountDuePaise = 0 WHERE id = :id", {
      replacements: { id: invoice.id },
    });
    const closed = await post(claim(1000));
    expect([closed.status, closed.body.code]).toEqual([409, 'INVOICE_NOT_PAYABLE']);
  });

  it('PATCH attaches a certificate only while CLAIMED, with the current version', async () => {
    const { pay, invoice, maker } = await setup();
    const c = (
      await pay('post', `/subscription/invoices/${invoice.id}/tds-claims`, claim(21000), {
        headers: idemKey(),
      })
    ).body.data;
    const patch = (b: object) => pay('patch', `/subscription/tds-claims/${c.id}`, b);
    expect((await patch({ certificateFileId: 5, version: 1 })).body.code).toBe('FILE_NOT_LINKABLE');
    placeholderBillingFiles.add('TDS_CERTIFICATE:5');
    expect((await patch({ certificateFileId: 5, version: 4 })).body.code).toBe('STALE_VERSION');
    const ok = await patch({ certificateFileId: 5, version: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(await AuditLog.count({ where: { action: 'platform_billing.tds.certificate_attached' } })).toBe(1);
    await maker.c('post', `/platform/payments/${c.id}/tds-decision`, { decision: 'VERIFIED', version: 2 });
    expect((await patch({ certificateFileId: 5, version: 3 })).body.code).toBe('INVALID_STATE');
  });

  it('the platform records a claim for a society (origin PLATFORM) and a society cannot touch another society claim', async () => {
    const { invoice, maker, support } = await setup();
    const other = await billedSociety({ name: 'Green Park CHS' });
    expect(
      (
        await support.c('post', `/platform/invoices/${invoice.id}/tds-claims`, claim(1000), {
          headers: idemKey(),
        })
      ).status,
    ).toBe(403);
    const r = await maker.c('post', `/platform/invoices/${invoice.id}/tds-claims`, claim(21000), {
      headers: idemKey(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await PlatformPayment.findByPk(r.body.data.id))!.origin).toBe('PLATFORM');
    const iso = await other.pay('patch', `/subscription/tds-claims/${r.body.data.id}`, {
      certificateFileId: 1,
      version: 1,
    });
    expect([iso.status, iso.body.code]).toEqual([404, 'PLATFORM_PAYMENT_NOT_FOUND']);
    const iso2 = await other.pay('post', `/subscription/invoices/${invoice.id}/tds-claims`, claim(1000), {
      headers: idemKey(),
    });
    expect([iso2.status, iso2.body.code]).toEqual([404, 'PLATFORM_INVOICE_NOT_FOUND']);
  });
});

describe('decision (8.20, 6.3)', () => {
  async function claimed(amount = 21000) {
    const s = await setup();
    const c = (
      await s.pay('post', `/subscription/invoices/${s.invoice.id}/tds-claims`, claim(amount), {
        headers: idemKey(),
      })
    ).body.data;
    return { ...s, id: c.id as number };
  }

  it('VERIFIED keeps the invoice as is; a second verify is INVALID_STATE; Support cannot decide', async () => {
    const { maker, support, id, invoice } = await claimed();
    expect(
      (await support.c('post', `/platform/payments/${id}/tds-decision`, { decision: 'VERIFIED', version: 1 }))
        .status,
    ).toBe(403);
    const r = await maker.c('post', `/platform/payments/${id}/tds-decision`, {
      decision: 'VERIFIED',
      version: 1,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('VERIFIED');
    expect((await PlatformInvoice.findByPk(invoice.id))!.tdsPaise).toBe(21000);
    expect(await AuditLog.count({ where: { action: 'platform_billing.tds.verified' } })).toBe(1);
    expect(
      (await maker.c('post', `/platform/payments/${id}/tds-decision`, { decision: 'VERIFIED', version: 2 }))
        .body.code,
    ).toBe('INVALID_STATE');
    expect(
      (await maker.c('post', `/platform/payments/${id}/tds-decision`, { decision: 'VERIFIED', version: 9 }))
        .body.code,
    ).toBe('INVALID_STATE');
  });

  it('REJECTED needs a reason; it adds the amount back and notifies the society; a stale version is 409', async () => {
    const { maker, id, invoice, treasurer } = await claimed();
    expect(
      (await maker.c('post', `/platform/payments/${id}/tds-decision`, { decision: 'REJECTED', version: 1 }))
        .status,
    ).toBe(400);
    expect(
      (
        await maker.c('post', `/platform/payments/${id}/tds-decision`, {
          decision: 'REJECTED',
          reason: 'Certificate is missing',
          version: 5,
        })
      ).body.code,
    ).toBe('STALE_VERSION');
    const r = await maker.c('post', `/platform/payments/${id}/tds-decision`, {
      decision: 'REJECTED',
      reason: 'Certificate is missing',
      version: 1,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      status: 'REJECTED',
      invoice: { amountDuePaise: 1239000, status: 'ISSUED' },
    });
    expect(await PlatformInvoice.findByPk(invoice.id)).toMatchObject({ tdsPaise: 0 });
    await drainQueues();
    expect((await inboxFor(treasurer.email!)).some(m => m.subject?.startsWith('TDS claim on'))).toBe(true);
    expect(await AuditLog.count({ where: { action: 'platform_billing.tds.rejected' } })).toBe(1);
  });

  it('VERIFIED can be rejected within 90 days of the verification, not after', async () => {
    const { maker, id } = await claimed();
    await maker.c('post', `/platform/payments/${id}/tds-decision`, { decision: 'VERIFIED', version: 1 });
    await sequelize.query(
      "UPDATE platform_payments SET decidedAt = '2026-07-01 00:00:00.000' WHERE id = :id",
      { replacements: { id } },
    );
    const late = await maker.c('post', `/platform/payments/${id}/tds-decision`, {
      decision: 'REJECTED',
      reason: 'Found wrong later on',
      version: 2,
    });
    expect([late.status, late.body.code]).toEqual([409, 'INVALID_STATE']);
    await sequelize.query(
      "UPDATE platform_payments SET decidedAt = '2026-09-01 00:00:00.000' WHERE id = :id",
      { replacements: { id } },
    );
    const ok = await maker.c('post', `/platform/payments/${id}/tds-decision`, {
      decision: 'REJECTED',
      reason: 'Found wrong later on',
      version: 2,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('T06-24 TDS rejected on a PAID invoice past its due date reopens it as OVERDUE', async () => {
    const { maker, pay, invoice } = await setup();
    // the society pays 1,218,000 online and claims TDS 21,000: the invoice is PAID
    const o = (
      await pay(
        'post',
        `/subscription/invoices/${invoice.id}/payment-orders`,
        { amountPaise: 1218000 },
        { headers: idemKey() },
      )
    ).body.data;
    const p = (paymentGateway() as FakePaymentGateway).payOrder(o.gatewayOrderId);
    await pay('post', `/subscription/payments/${o.paymentId}/verify`, { gatewayPaymentId: p.paymentId });
    const c = await pay('post', `/subscription/invoices/${invoice.id}/tds-claims`, claim(21000), {
      headers: idemKey(),
    });
    expect(c.body.data.invoice).toMatchObject({ status: 'PAID', amountDuePaise: 0 });
    await sequelize.query("UPDATE platform_invoices SET dueDate = '2026-10-20' WHERE id = :id", {
      replacements: { id: invoice.id },
    });
    const r = await maker.c('post', `/platform/payments/${c.body.data.id}/tds-decision`, {
      decision: 'REJECTED',
      reason: 'Certificate is not valid',
      version: 1,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.invoice).toEqual({ id: invoice.id, status: 'OVERDUE', amountDuePaise: 21000 });
    expect((await PlatformInvoice.findByPk(invoice.id))!.paidAt).toBeNull();
  });
});
