import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  Expense,
  Fund,
  LedgerAccount,
  Society,
  SocietyBalance,
  closeDb,
  sequelize,
} from '../../../src/models';
import { flushAcl } from '../../../src/modules/access-control/access-control.cache';
import { ensureBooks } from '../../../src/modules/accounts/accounts.chart';
import { setupSociety } from '../../helpers/society-setup';
import { resetLogins } from '../../helpers/access';
import { fundIdByType } from '../../helpers/accounts';
import {
  autoApprove,
  bankBody,
  bill,
  expBody,
  expWorld,
  idemH,
  resetExpenses,
  type ExpWorld,
} from '../../helpers/accounts-expenses';

afterAll(closeDb);
beforeEach(async () => {
  resetLogins();
  await resetExpenses();
});

const post = (w: ExpWorld, body: Record<string, unknown>) =>
  w.c('post', '/expenses', body, { headers: idemH() });
const codeOf = (r: { status: number; body: any }) => [r.status, r.body.code];
const fieldOf = (r: { body: any }) => r.body.errors?.[0]?.field;

describe('BR-13-20 date, BR-13-21 head, BR-13-22 payment source', () => {
  it('DATE_OUT_OF_RANGE for a future date and for one older than 90 days; PERIOD_LOCKED for a locked date', async () => {
    const w = await expWorld();
    expect(codeOf(await post(w, expBody(w, { expenseDate: '2026-11-02' })))).toEqual([
      422,
      'DATE_OUT_OF_RANGE',
    ]);
    expect(codeOf(await post(w, expBody(w, { expenseDate: '2026-07-01' })))).toEqual([
      422,
      'DATE_OUT_OF_RANGE',
    ]);
    expect((await post(w, expBody(w, { expenseDate: '2026-11-01', submit: false }))).status).toBe(201);
    expect((await post(w, expBody(w, { expenseDate: '2026-08-03', submit: false }))).status).toBe(201);
    await SocietyBalance.update({ booksLockedThrough: '2026-10-31' } as never, {
      where: { societyId: w.sid },
    });
    expect(codeOf(await post(w, expBody(w)))).toEqual([409, 'PERIOD_LOCKED']);
  });

  it('INVALID_EXPENSE_HEAD for an income, a group or an unknown-type head; 404 for an unknown account', async () => {
    const w = await expWorld();
    expect(codeOf(await post(w, expBody(w, { ledgerAccountId: w.id['4100'] })))).toEqual([
      422,
      'INVALID_EXPENSE_HEAD',
    ]);
    expect(codeOf(await post(w, expBody(w, { ledgerAccountId: w.id['1110'] })))).toEqual([
      422,
      'INVALID_EXPENSE_HEAD',
    ]);
    expect(codeOf(await post(w, expBody(w, { ledgerAccountId: 999_999 })))).toEqual([
      404,
      'LEDGER_ACCOUNT_NOT_FOUND',
    ]);
    expect(codeOf(await post(w, expBody(w, { ledgerAccountId: undefined })))).toEqual([
      400,
      'VALIDATION_FAILED',
    ]);
  });

  it('INVALID_PAYMENT_SOURCE: cash mode from a bank, bank mode from cash, a group or a non-cash ledger', async () => {
    const w = await expWorld();
    expect(codeOf(await post(w, expBody(w, { paidFromLedgerAccountId: w.id['1110-001'] })))).toEqual([
      422,
      'INVALID_PAYMENT_SOURCE',
    ]);
    expect(codeOf(await post(w, expBody(w, { paymentMode: 'UPI' })))).toEqual([
      422,
      'INVALID_PAYMENT_SOURCE',
    ]);
    expect(
      codeOf(await post(w, expBody(w, { paidFromLedgerAccountId: w.id['1110'], paymentMode: 'UPI' }))),
    ).toEqual([422, 'INVALID_PAYMENT_SOURCE']);
    expect(codeOf(await post(w, expBody(w, { paidFromLedgerAccountId: w.id['2110'] })))).toEqual([
      422,
      'INVALID_PAYMENT_SOURCE',
    ]);
  });

  it('a reference is required for NEFT, CHEQUE, RTGS and IMPS (6 to 30 characters)', async () => {
    const w = await expWorld();
    const r = await post(w, bankBody(w, { paymentReference: undefined }));
    expect([r.status, fieldOf(r)]).toEqual([400, 'paymentReference']);
    expect((await post(w, bankBody(w, { paymentReference: 'AB1' }))).status).toBe(400);
    expect(
      (await post(w, bankBody(w, { paymentMode: 'UPI', paymentReference: undefined, submit: false }))).status,
    ).toBe(201);
  });
});

describe('BR-13-23 amounts, TDS, statutory dues', () => {
  it('amount limits, GST and TDS below the gross, TDS needs a section', async () => {
    const w = await expWorld();
    expect((await post(w, expBody(w, { grossAmountPaise: 99 }))).status).toBe(400);
    expect((await post(w, expBody(w, { grossAmountPaise: 100_000_000_001 }))).status).toBe(400);
    expect(fieldOf(await post(w, bankBody(w, { gstPaise: 180_000 })))).toBe('gstPaise');
    expect(fieldOf(await post(w, bankBody(w, { tdsPaise: 180_000, tdsSection: '194C' })))).toBe('tdsPaise');
    expect(fieldOf(await post(w, bankBody(w, { tdsPaise: 1_000 })))).toBe('tdsSection');
    expect((await post(w, bankBody(w, { tdsPaise: 1_000, tdsSection: 'ABC' }))).status).toBe(400);
  });

  it('T13-15: TDS and GST on Starter are 402 FEATURE_NOT_IN_PLAN with errors[0].field of the request field', async () => {
    const w = await expWorld({ plan: 'STARTER' });
    const t = await post(w, bankBody(w, { tdsPaise: 20_000, tdsSection: '194C' }));
    expect([t.status, t.body.code, fieldOf(t)]).toEqual([402, 'FEATURE_NOT_IN_PLAN', 'tdsPaise']);
    const g = await post(w, bankBody(w, { gstPaise: 18_000 }));
    expect([g.status, fieldOf(g)]).toEqual([402, 'gstPaise']);
    const v = await post(
      w,
      bankBody(w, { expenseType: 'STATUTORY_DUE', ledgerAccountId: w.id['2140'], tdsSection: '194C' }),
    );
    expect([v.status, fieldOf(v)]).toEqual([402, 'expenseType']);
    const p = await post(w, expBody(w, { paidFromLedgerAccountId: w.id['1130'] }));
    expect([p.status, fieldOf(p)]).toEqual([402, 'paidFromLedgerAccountId']);
    expect((await post(w, expBody(w, { submit: false }))).status).toBe(201); // T13-37: /expenses works on Starter
  });

  it('a Starter society can only use cash book categories as the head', async () => {
    const w = await expWorld({ plan: 'STARTER' });
    const r = await post(w, expBody(w, { ledgerAccountId: w.id['5330'], submit: false }));
    expect(r.status).toBe(201); // 5330 is a cash book category
    await LedgerAccount.update({ isCashBookCategory: false }, { where: { id: w.id['5350'] } });
    expect(codeOf(await post(w, expBody(w)))).toEqual([422, 'INVALID_EXPENSE_HEAD']);
  });

  it('STATUTORY_DUE: only 2310 to 2330 and 2140, no GST, TDS or fund; a TDS deposit needs the section and may carry a challan', async () => {
    const w = await expWorld();
    autoApprove();
    const base = { expenseType: 'STATUTORY_DUE', payee: 'Income Tax Dept' };
    expect(codeOf(await post(w, bankBody(w, { ...base, ledgerAccountId: w.id['5330'] })))).toEqual([
      422,
      'INVALID_EXPENSE_HEAD',
    ]);
    expect(fieldOf(await post(w, bankBody(w, { ...base, ledgerAccountId: w.id['2140'] })))).toBe(
      'tdsSection',
    );
    expect(
      codeOf(await post(w, bankBody(w, { ...base, ledgerAccountId: w.id['2310'], challanNo: 'CHALLAN123' }))),
    ).toEqual([422, 'INVALID_EXPENSE_HEAD']);
    expect(
      codeOf(await post(w, bankBody(w, { ...base, ledgerAccountId: w.id['2310'], tdsSection: '194C' }))),
    ).toEqual([422, 'INVALID_EXPENSE_HEAD']);
    expect(
      codeOf(
        await post(
          w,
          bankBody(w, {
            ...base,
            ledgerAccountId: w.id['2310'],
            fundId: await fundIdByType(w.sid, 'REPAIR'),
          }),
        ),
      ),
    ).toEqual([422, 'INVALID_EXPENSE_HEAD']);
    expect(
      codeOf(await post(w, bankBody(w, { ...base, ledgerAccountId: w.id['2310'], gstPaise: 100 }))),
    ).toEqual([400, 'VALIDATION_FAILED']);
    const ok = await post(
      w,
      bankBody(w, {
        ...base,
        ledgerAccountId: w.id['2140'],
        tdsSection: '194C',
        challanNo: 'CHALLAN123',
        grossAmountPaise: 70_000,
      }),
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.data).toMatchObject({
      status: 'POSTED',
      tdsSection: '194C',
      challanNo: 'CHALLAN123',
      tdsPaise: 0,
    });
    const gst = await post(
      w,
      bankBody(w, {
        ...base,
        ledgerAccountId: w.id['2310'],
        grossAmountPaise: 50_000,
        paymentReference: 'UTR000777888',
      }),
    );
    expect(gst.body.data.status).toBe('POSTED');
  });

  it('a challan number is refused on a direct expense', async () => {
    const w = await expWorld();
    expect(codeOf(await post(w, bankBody(w, { challanNo: 'CHALLAN123' })))).toEqual([
      422,
      'INVALID_EXPENSE_HEAD',
    ]);
  });
});

describe('funds, vendors, bill files', () => {
  it('FUND_NOT_FOUND (unknown), FUND_INACTIVE (closed)', async () => {
    const w = await expWorld();
    expect(codeOf(await post(w, expBody(w, { fundId: 999_999 })))).toEqual([404, 'FUND_NOT_FOUND']);
    const fundId = await fundIdByType(w.sid, 'SINKING');
    await Fund.update({ status: 'CLOSED' }, { where: { id: fundId } });
    expect(codeOf(await post(w, expBody(w, { fundId })))).toEqual([422, 'FUND_INACTIVE']);
  });

  it('a fund of another society is FUND_NOT_FOUND', async () => {
    const a = await expWorld();
    const other = await setupSociety({ plan: 'PREMIUM', name: 'Other CHS' });
    await sequelize.transaction(t => ensureBooks(t, other.society.id!));
    const foreign = await fundIdByType(other.society.id!, 'REPAIR');
    expect(codeOf(await post(a, expBody(a, { fundId: foreign })))).toEqual([404, 'FUND_NOT_FOUND']);
  });

  it('VENDOR_BILL needs the bill; module 21 placeholder knows no vendor or bill', async () => {
    const w = await expWorld();
    const base = { expenseType: 'VENDOR_BILL', ledgerAccountId: undefined, payee: 'Vendor X' };
    expect(fieldOf(await post(w, bankBody(w, base)))).toBe('vendorBillId');
    expect(codeOf(await post(w, bankBody(w, { ...base, vendorBillId: 5 })))).toEqual([
      404,
      'VENDOR_BILL_NOT_FOUND',
    ]);
    expect(codeOf(await post(w, bankBody(w, { vendorId: 5 })))).toEqual([404, 'VENDOR_NOT_FOUND']);
  });

  it("FILE_NOT_LINKABLE for the wrong purpose, another user's upload, or a file already used; at most 5 files", async () => {
    const w = await expWorld();
    expect(codeOf(await post(w, expBody(w, { fileIds: [bill(w, w.user.id, 'PAYMENT_PROOF')] })))).toEqual([
      422,
      'FILE_NOT_LINKABLE',
    ]);
    expect(codeOf(await post(w, expBody(w, { fileIds: [bill(w, w.treasurer.user.id)] })))).toEqual([
      422,
      'FILE_NOT_LINKABLE',
    ]);
    const f = bill(w, w.user.id);
    expect((await post(w, expBody(w, { fileIds: [f], submit: false }))).status).toBe(201);
    expect(codeOf(await post(w, expBody(w, { fileIds: [f] })))).toEqual([422, 'FILE_NOT_LINKABLE']);
    const six = [1, 2, 3, 4, 5, 6].map(() => bill(w, w.user.id));
    expect((await post(w, expBody(w, { fileIds: six }))).status).toBe(400);
    expect(await Expense.count({ where: { societyId: w.sid } })).toBe(1);
  });
});

describe('access: permissions, tenancy, suspension, reading', () => {
  it('T13-36: the Auditor cannot create or reverse (403) but can read and export', async () => {
    const w = await expWorld();
    const aud = await w.auditor.c('post', '/expenses', expBody(w), { headers: idemH() });
    expect([aud.status, aud.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect((await w.auditor.c('get', '/expenses')).status).toBe(200);
    expect((await w.auditor.c('get', '/expenses/export')).status).toBe(200);
  });

  it('T13-35: another society gets 404 EXPENSE_NOT_FOUND on read and every write', async () => {
    const a = await expWorld();
    const e = (await post(a, expBody(a, { submit: false }))).body.data;
    const other = await setupSociety({ plan: 'PREMIUM', name: 'Other CHS' });
    const x = other.c;
    for (const [m, path, body] of [
      ['get', `/expenses/${e.id}`, undefined],
      ['patch', `/expenses/${e.id}`, { version: 1, description: 'x' }],
      ['post', `/expenses/${e.id}/submit`, { version: 1 }],
      ['post', `/expenses/${e.id}/withdraw`, { version: 1, reason: 'Not mine at all' }],
      ['delete', `/expenses/${e.id}`, { version: 1, reason: 'Not mine at all' }],
      ['post', `/expenses/${e.id}/reverse`, { version: 1, reason: 'Not mine at all' }],
    ] as const) {
      const r = await x(m, path, body, { headers: idemH() });
      expect([m, path, r.status, r.body.code]).toEqual([m, path, 404, 'EXPENSE_NOT_FOUND']);
    }
  });

  it('T13-41: writes are refused while the society is suspended; reads work', async () => {
    const w = await expWorld();
    await Society.update(
      { status: 'SUSPENDED', suspendedAt: new Date(), suspensionCause: 'MANUAL' } as never,
      { where: { id: w.sid } },
    );
    await flushAcl();
    const r = await post(w, expBody(w));
    expect([r.status, r.body.code]).toEqual([423, 'SOCIETY_SUSPENDED']);
    expect((await w.c('get', '/expenses')).status).toBe(200);
  });

  it('lists with filters, search (payee, EXP-id, voucher), sorting and pagination; detail carries hints', async () => {
    const w = await expWorld();
    autoApprove();
    const a = (await post(w, expBody(w))).body.data;
    const b = (
      await post(
        w,
        bankBody(w, {
          payee: 'Lift Co',
          ledgerAccountId: w.id['5330'],
          grossAmountPaise: 500_000,
          expenseDate: '2026-10-20',
          fileIds: [bill(w, w.user.id)],
        }),
      )
    ).body.data;
    const d = (await post(w, expBody(w, { payee: 'Draft Payee', submit: false }))).body.data;
    const list = await w.c('get', '/expenses');
    expect(list.body.pagination.total).toBe(3);
    expect(list.body.data[0].id).toBe(d.id); // 30 Oct, newest id first
    const q = async (query: Record<string, string>) =>
      (await w.c('get', '/expenses', undefined, { query })).body.data.map((x: any) => x.id);
    expect(await q({ status: 'POSTED' })).toEqual(
      [a.id, b.id].sort((x, y) => y - x).sort((x, y) => (x === b.id ? 1 : y === b.id ? -1 : 0)),
    );
    expect(await q({ q: 'lift' })).toEqual([b.id]);
    expect(await q({ q: `EXP-${a.id}` })).toEqual([a.id]);
    expect(await q({ q: a.voucherNo })).toEqual([a.id]);
    expect(await q({ paidFrom: 'CASH' })).toContain(a.id);
    expect(await q({ paidFrom: 'BANK' })).toEqual([b.id]);
    expect(await q({ from: '2026-10-25' })).not.toContain(b.id);
    expect(await q({ ledgerAccountId: String(w.id['5330']) })).toEqual([b.id]);
    expect(await q({ createdByMe: 'true' })).toHaveLength(3);
    expect(await q({ sortBy: 'grossAmountPaise', sortOrder: 'desc' })).toEqual([
      b.id,
      expect.anything(),
      expect.anything(),
    ]);
    expect(
      (await w.c('get', '/expenses', undefined, { query: { limit: '2', page: '2' } })).body.data,
    ).toHaveLength(1);
    expect((await w.c('get', '/expenses', undefined, { query: { status: 'NOPE' } })).status).toBe(400);
    const det = await w.c('get', `/expenses/${d.id}`);
    expect(det.body.data).toMatchObject({
      id: d.id,
      canApprove: false,
      canReverse: false,
      journal: null,
      files: [],
    });
    const posted = await w.treasurer.c('get', `/expenses/${a.id}`);
    expect(posted.body.data).toMatchObject({ canReverse: true });
    expect((await w.c('get', '/expenses/999999')).body.code).toBe('EXPENSE_NOT_FOUND');
  });

  it('exports the filtered list as CSV and audits it', async () => {
    const w = await expWorld();
    autoApprove();
    await post(w, expBody(w, { payee: 'Comma, Payee' }));
    const r = await w.c('get', '/expenses/export', undefined, { query: { status: 'POSTED' } });
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/csv');
    const text = String(r.text ?? r.body);
    expect(text).toContain('"Comma, Payee"');
    expect(text).toContain('1800.00');
    expect(await AuditLog.count({ where: { action: 'accounts.expense.exported', societyId: w.sid } })).toBe(
      1,
    );
  });
});
