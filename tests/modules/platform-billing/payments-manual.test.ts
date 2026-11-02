import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  PlatformCredit,
  PlatformInvoice,
  PlatformPayment,
  closeDb,
  sequelize,
} from '../../../src/models';
import { advance, setNow } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { as, platformLogin, resetLogins } from '../../helpers/access';
import { inboxFor } from '../../helpers/auth';
import { billedSociety, idemKey, platformTeam, resetBilling } from '../../helpers/billing';

/** Task 6.3: manual payments with maker-checker (BR-06-29, BR-06-30; 8.18, 8.19; T06-14, T06-15, T06-16, T06-19, T06-33). */
beforeEach(async () => {
  await resetBilling();
});
afterAll(async () => {
  await drainQueues();
  setNow(null);
  await closeDb();
});

const body = (societyId: number, invoiceId: number | undefined, o: Record<string, unknown> = {}) => ({
  societyId,
  ...(invoiceId ? { invoiceId } : {}),
  method: 'NEFT',
  amountPaise: 1239000,
  receivedOn: '2026-10-30',
  bankReference: 'UTR202610300001',
  payerBankName: 'HDFC Bank',
  ...o,
});
type Call = ReturnType<typeof as>;
const record = (c: Call, b: object, headers = idemKey()) => c('post', '/platform/payments', b, { headers });
const subjects = async (email: string | null) => (await inboxFor(email!)).map(m => m.subject);

async function setup() {
  const s = await billedSociety();
  const team = await platformTeam();
  return { ...s, ...team };
}

describe('record (8.18)', () => {
  it('creates PENDING_APPROVAL with the audit row, notifies the other approvers, and shows in the society summary', async () => {
    const { society, invoice, maker, checker, view } = await setup();
    const r = await record(maker.c, body(society.id!, invoice.id));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toEqual({
      id: expect.any(Number),
      status: 'PENDING_APPROVAL',
      amountPaise: 1239000,
      invoiceId: invoice.id,
      version: 1,
    });
    const row = (await PlatformPayment.findByPk(r.body.data.id))!;
    expect(row).toMatchObject({
      origin: 'PLATFORM',
      method: 'NEFT',
      bankRefKey: 'NEFT:UTR202610300001',
      receivedOn: '2026-10-30',
      createdBy: maker.user.id,
    });
    expect(
      await AuditLog.count({
        where: { action: 'platform_billing.payment.recorded', societyId: society.id! },
      }),
    ).toBe(1);
    await drainQueues();
    expect((await subjects(checker.user.email)).some(x => x?.startsWith('Approval needed'))).toBe(true);
    expect((await subjects(maker.user.email)).some(x => x?.startsWith('Approval needed'))).toBe(false);
    expect((await view('get', '/subscription/billing-summary')).body.data.pendingManualPaymentPaise).toBe(
      1239000,
    );
    // the invoice is untouched until approval
    expect((await PlatformInvoice.findByPk(invoice.id))!.status).toBe('ISSUED');
  });

  it('T06-33 Platform Support gets 403 PERMISSION_DENIED; a missing Idempotency-Key is 400', async () => {
    const { society, invoice, support, maker } = await setup();
    const r = await record(support.c, body(society.id!, invoice.id));
    expect([r.status, r.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    const noKey = await maker.c('post', '/platform/payments', body(society.id!, invoice.id));
    expect(noKey.status).toBe(400);
  });

  it('needs a fresh step-up (401 REAUTH_REQUIRED)', async () => {
    const { society, invoice, maker } = await setup();
    advance(6 * 60_000);
    const r = await record(maker.c, body(society.id!, invoice.id));
    expect([r.status, r.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
  });

  it('the same Idempotency-Key replays; two parallel entries of one UTR make one row', async () => {
    const { society, invoice, maker } = await setup();
    const headers = idemKey();
    const a = await record(maker.c, body(society.id!, invoice.id), headers);
    const b = await record(maker.c, body(society.id!, invoice.id), headers);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.data.id).toBe(a.body.data.id);
    const rs = await Promise.all(
      [1, 2].map(() => record(maker.c, body(society.id!, invoice.id, { bankReference: 'UTR-RACE-1' }))),
    );
    expect(rs.map(r => r.status).sort()).toEqual([201, 409]);
    expect(await PlatformPayment.count({ where: { bankRefKey: 'NEFT:UTR-RACE-1' } })).toBe(1);
  });

  it('T06-16 the same UTR twice is 409 DUPLICATE_BANK_REFERENCE (any case); another method is fine; after rejection it can be entered again', async () => {
    const { society, invoice, maker, checker } = await setup();
    const a = await record(maker.c, body(society.id!, invoice.id, { bankReference: 'utr-abc-1234' }));
    expect(a.status).toBe(201);
    const dup = await record(maker.c, body(society.id!, invoice.id, { bankReference: 'UTR-ABC-1234' }));
    expect([dup.status, dup.body.code]).toEqual([409, 'DUPLICATE_BANK_REFERENCE']);
    expect(
      (
        await record(
          maker.c,
          body(society.id!, invoice.id, { method: 'IMPS', bankReference: 'UTR-ABC-1234' }),
        )
      ).status,
    ).toBe(201);
    const rej = await checker.c('post', `/platform/payments/${a.body.data.id}/reject`, {
      version: 1,
      reason: 'UTR not found in the bank statement',
    });
    expect(rej.status, JSON.stringify(rej.body)).toBe(200);
    expect(await PlatformPayment.findByPk(a.body.data.id)).toMatchObject({
      status: 'REJECTED',
      bankRefKey: null,
      rejectedReason: 'UTR not found in the bank statement',
    });
    expect(
      (await record(maker.c, body(society.id!, invoice.id, { bankReference: 'UTR-ABC-1234' }))).status,
    ).toBe(201);
    expect(await AuditLog.count({ where: { action: 'platform_billing.payment.rejected' } })).toBe(1);
  });

  it('validates fields and references: dates, cheque digits, unknown society, other society invoice, unpayable invoice', async () => {
    const { society, invoice, maker } = await setup();
    const other = await billedSociety({ name: 'Green Park CHS' });
    const bad = async (o: Record<string, unknown>, code: string, status = 400) => {
      const r = await record(maker.c, body(society.id!, invoice.id, o));
      expect([r.status, r.body.code], JSON.stringify(o)).toEqual([status, code]);
      return r;
    };
    const future = await bad({ receivedOn: '2026-11-02' }, 'VALIDATION_FAILED');
    expect(future.body.errors[0].field).toBe('receivedOn');
    await bad({ receivedOn: '2026-04-01' }, 'VALIDATION_FAILED');
    await bad({ method: 'CASH' }, 'VALIDATION_FAILED');
    await bad({ method: 'CHEQUE', bankReference: '12345' }, 'VALIDATION_FAILED');
    await bad({ bankReference: 'ab' }, 'VALIDATION_FAILED');
    await bad({ bankReference: 'has space' }, 'VALIDATION_FAILED');
    await bad({ amountPaise: 99 }, 'VALIDATION_FAILED');
    await bad({ societyId: 999999 }, 'NOT_FOUND', 404);
    await bad({ invoiceId: other.invoice.id }, 'PLATFORM_INVOICE_NOT_FOUND', 404);
    await bad({ invoiceId: 999999 }, 'PLATFORM_INVOICE_NOT_FOUND', 404);
    await bad({ attachmentFileId: 77 }, 'FILE_NOT_LINKABLE', 422);
    await sequelize.query("UPDATE platform_invoices SET status = 'VOID' WHERE id = :id", {
      replacements: { id: invoice.id },
    });
    await bad({}, 'INVOICE_NOT_PAYABLE', 409);
    expect(
      (
        await record(
          maker.c,
          body(society.id!, undefined, { method: 'CHEQUE', bankReference: '123456', amountPaise: 5000 }),
        )
      ).status,
    ).toBe(201);
  });
});

describe('approve and reject (8.19, BR-06-30)', () => {
  async function pending(o: Record<string, unknown> = {}) {
    const s = await setup();
    const r = await record(s.maker.c, body(s.society.id!, s.invoice.id, o));
    return { ...s, id: r.body.data.id as number };
  }

  it('T06-14 the maker approving gets 409 MAKER_CHECKER_VIOLATION', async () => {
    const { maker, id } = await pending();
    const r = await maker.c('post', `/platform/payments/${id}/approve`, { version: 1 });
    expect([r.status, r.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    const rej = await maker.c('post', `/platform/payments/${id}/reject`, {
      version: 1,
      reason: 'Entered by mistake today',
    });
    expect([rej.status, rej.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    expect((await PlatformPayment.findByPk(id))!.status).toBe('PENDING_APPROVAL');
  });

  it('T06-15 a second admin without step-up gets 401 REAUTH_REQUIRED; Support gets 403; after sign-in it works', async () => {
    const { checker, support, id } = await pending();
    expect((await support.c('post', `/platform/payments/${id}/approve`, { version: 1 })).body.code).toBe(
      'PERMISSION_DENIED',
    );
    advance(6 * 60_000);
    const r = await checker.c('post', `/platform/payments/${id}/approve`, { version: 1 });
    expect([r.status, r.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    resetLogins();
    const fresh = as(await platformLogin(checker.user), 'PLATFORM');
    const ok = await fresh('post', `/platform/payments/${id}/approve`, { version: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('approval captures at receivedOn 12:00 IST, pays the invoice, audits and notifies the society', async () => {
    const { checker, id, invoice, society, treasurer } = await pending();
    const r = await checker.c('post', `/platform/payments/${id}/approve`, { version: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      status: 'CAPTURED',
      appliedPaise: 1239000,
      invoiceNo: invoice.invoiceNo,
      version: 2,
    });
    expect(await PlatformPayment.findByPk(id)).toMatchObject({
      capturedAt: new Date('2026-10-30T06:30:00.000Z'),
      approvedBy: checker.user.id,
    });
    expect(await PlatformInvoice.findByPk(invoice.id)).toMatchObject({
      status: 'PAID',
      paidPaise: 1239000,
      amountDuePaise: 0,
    });
    expect(
      await AuditLog.count({
        where: { action: 'platform_billing.payment.approved', societyId: society.id! },
      }),
    ).toBe(1);
    await drainQueues();
    expect((await subjects(treasurer.email)).some(x => x?.startsWith('Payment of'))).toBe(true);
    const again = await checker.c('post', `/platform/payments/${id}/approve`, { version: 2 });
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('a stale version is 409 STALE_VERSION; reject needs a reason of 10 to 500 characters', async () => {
    const { checker, id } = await pending();
    const stale = await checker.c('post', `/platform/payments/${id}/approve`, { version: 7 });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    expect(
      (await checker.c('post', `/platform/payments/${id}/reject`, { version: 1, reason: 'short' })).status,
    ).toBe(400);
    expect(
      (await checker.c('post', `/platform/payments/${id}/approve`, { version: 1, extra: 1 })).status,
    ).toBe(400);
  });

  it('T06-19 an amount above the due pays the invoice, posts PAYMENT_EXCESS and applies it to the next open invoice', async () => {
    const { society, invoice, maker, checker } = await setup();
    const draft = await maker.c(
      'post',
      '/platform/invoices',
      {
        societyId: society.id,
        lines: [{ description: 'Training session', quantity: '1', unitPricePaise: 100000 }],
      },
      { headers: idemKey() },
    );
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const issued = await checker.c('post', `/platform/invoices/${draft.body.data.id}/approve`, {
      version: 1,
    });
    expect(issued.status, JSON.stringify(issued.body)).toBe(200);
    expect(issued.body.data).toMatchObject({ status: 'ISSUED', totalPaise: 118000 });
    const r = await record(
      maker.c,
      body(society.id!, invoice.id, { amountPaise: 1362000, bankReference: 'UTR-BIG-0001' }),
    );
    const ap = await checker.c('post', `/platform/payments/${r.body.data.id}/approve`, { version: 1 });
    expect(ap.status, JSON.stringify(ap.body)).toBe(200);
    expect(ap.body.data).toMatchObject({ appliedPaise: 1239000 });
    expect((await PlatformInvoice.findByPk(invoice.id))!.status).toBe('PAID');
    expect(await PlatformInvoice.findByPk(draft.body.data.id)).toMatchObject({
      status: 'PAID',
      creditAppliedPaise: 118000,
    });
    const rows = await PlatformCredit.findAll({
      where: { societyId: society.id! },
      order: [
        ['postedAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });
    expect(rows.map(c => [c.entryType, Number(c.amountPaise), Number(c.balanceAfterPaise)])).toEqual([
      ['PAYMENT_EXCESS', 123000, 123000],
      ['APPLIED', -118000, 5000],
    ]);
  });

  it('a payment on a PAID invoice (allowed) and one without an invoice go to credit in full', async () => {
    const { society, invoice, maker, checker } = await setup();
    await sequelize.query(
      "UPDATE platform_invoices SET status = 'PAID', amountDuePaise = 0, paidPaise = totalPaise WHERE id = :id",
      { replacements: { id: invoice.id } },
    );
    const a = await record(
      maker.c,
      body(society.id!, invoice.id, { amountPaise: 20000, bankReference: 'UTR-PAID-0001' }),
    );
    const b = await record(
      maker.c,
      body(society.id!, undefined, { amountPaise: 30000, bankReference: 'UTR-NOINV-001' }),
    );
    expect(
      (await checker.c('post', `/platform/payments/${a.body.data.id}/approve`, { version: 1 })).status,
    ).toBe(200);
    expect(
      (await checker.c('post', `/platform/payments/${b.body.data.id}/approve`, { version: 1 })).status,
    ).toBe(200);
    expect(await PlatformPayment.findByPk(a.body.data.id)).toMatchObject({ appliedPaise: 0 });
    const last = await PlatformCredit.findOne({
      where: { societyId: society.id! },
      order: [
        ['postedAt', 'DESC'],
        ['id', 'DESC'],
      ],
    });
    expect(Number(last!.balanceAfterPaise)).toBe(50000);
  });

  it('the payment lists: the platform sees everything with society name, the society a trimmed view', async () => {
    const { society, invoice, maker, checker, view } = await setup();
    const r = await record(maker.c, body(society.id!, invoice.id));
    await checker.c('post', `/platform/payments/${r.body.data.id}/approve`, { version: 1 });
    const pl = await maker.c('get', '/platform/payments', undefined, {
      query: { societyId: String(society.id), kind: 'PAYMENT', status: 'CAPTURED,PENDING_APPROVAL' },
    });
    expect(pl.status, JSON.stringify(pl.body)).toBe(200);
    expect(pl.body.data[0]).toMatchObject({
      id: r.body.data.id,
      origin: 'PLATFORM',
      bankRefKey: 'NEFT:UTR202610300001',
      societyName: society.name,
      invoiceNo: invoice.invoiceNo,
    });
    const sc = await view('get', '/subscription/payments', undefined, { query: { status: 'CAPTURED' } });
    expect(sc.body.data[0]).toMatchObject({
      id: r.body.data.id,
      bankReference: 'UTR202610300001',
      receivedOn: '2026-10-30',
    });
    expect(sc.body.data[0].bankRefKey).toBeUndefined();
    expect(sc.body.data[0].approvedBy).toBeUndefined();
    expect(
      (await maker.c('get', '/platform/payments', undefined, { query: { status: 'NOPE' } })).status,
    ).toBe(400);
  });
});
