import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Expense, JournalEntry, closeDb } from '../../../src/models';
import { advance } from '../../../src/lib/clock';
import {
  accountsPortCalls,
  placeholderAccountsApprovalTypes,
  setAccountsPorts,
} from '../../../src/modules/accounts/accounts.ports';
import { listForCollection } from '../../../src/modules/accounts/accounts.expenses.read';
import { UnprocessableError } from '../../../src/utils/errors';
import { events } from '../../helpers/auth';
import { setSetting } from '../../helpers/billing-runs';
import { as, login, resetLogins } from '../../helpers/access';
import { balanceOf, fundIdByType } from '../../helpers/accounts';
import {
  autoApprove,
  bankBody,
  bill,
  decide,
  expBody,
  expWorld,
  idemH,
  moneyTx,
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
const fresh = async (id: number) => (await Expense.findByPk(id))!;
const reqOf = async (id: number) => Number((await fresh(id)).approvalRequestId);

describe('POST /expenses: create, auto-approve and post (8.6, 6.8)', () => {
  it('T13-10: auto-approved cash expense is POSTED in the same response with a voucher, cash falls', async () => {
    const w = await expWorld();
    autoApprove();
    const r = await post(w, expBody(w));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'POSTED',
      displayId: `EXP-${r.body.data.id}`,
      grossAmountPaise: 180_000,
      netPaidPaise: 180_000,
      ledgerAccount: { code: '5350' },
      paidFrom: { code: '1120' },
    });
    expect(r.body.data.voucherNo).toMatch(/^VCH\//);
    expect(await balanceOf(w.sid, '1120')).toBe(1_000_000 - 180_000);
    expect(await balanceOf(w.sid, '5350')).toBe(180_000);
    const e = await fresh(r.body.data.id);
    expect(e.approvedBy).toBeNull();
    expect(e.journalEntryId).not.toBeNull();
    expect(events.some(x => x.event === 'expense.updated' && (x.payload as any).status === 'POSTED')).toBe(
      true,
    );
  });

  it('without an auto-approve rule it is PENDING_APPROVAL, then the Treasurer approves and it posts', async () => {
    const w = await expWorld();
    const r = await post(w, expBody(w));
    expect(r.body.data.status).toBe('PENDING_APPROVAL');
    expect(await balanceOf(w.sid, '1120')).toBe(1_000_000);
    const call = accountsPortCalls.find(c => c.fn === 'approvals.request')!;
    expect(call.input).toMatchObject({
      type: 'EXPENSE',
      entityType: 'expense',
      amountPaise: 180_000,
      title: 'Shree Ganesh Gardeners · Garden and landscaping',
    });
    const d = await decide(w, await reqOf(r.body.data.id));
    expect(d.status, JSON.stringify(d.body)).toBe(200);
    const e = await fresh(r.body.data.id);
    expect(e.status).toBe('POSTED');
    expect(e.approvedBy).toBe(w.treasurer.user.id);
    expect(await balanceOf(w.sid, '1120')).toBe(820_000);
  });

  it('T13-12: the maker cannot approve their own expense', async () => {
    const w = await expWorld();
    const r = await w.treasurer.c(
      'post',
      '/expenses',
      expBody(w, {
        grossAmountPaise: 1_200_000,
        paidFromLedgerAccountId: w.id['1110-001'],
        paymentMode: 'NEFT',
        paymentReference: 'UTR000999111',
        fileIds: [bill(w, w.treasurer.user.id)],
      }),
      { headers: idemH() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const d = await decide(w, await reqOf(r.body.data.id));
    expect([d.status, d.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    expect((await fresh(r.body.data.id)).status).toBe('PENDING_APPROVAL');
  });

  it('T13-13: approval with too little balance fails with 422 INSUFFICIENT_BALANCE and the request stays pending', async () => {
    const w = await expWorld({ bankPaise: 1_000_000 });
    const r = await post(w, bankBody(w, { grossAmountPaise: 1_200_000, fileIds: [bill(w, w.user.id)] }));
    expect(r.body.data.status).toBe('PENDING_APPROVAL');
    const d = await decide(w, await reqOf(r.body.data.id));
    expect([d.status, d.body.code]).toEqual([422, 'INSUFFICIENT_BALANCE']);
    expect((await fresh(r.body.data.id)).status).toBe('PENDING_APPROVAL');
    expect(await balanceOf(w.sid, '1110-001')).toBe(1_000_000);
  });

  it('T13-14: lift AMC with GST 180,000 and TDS 20,000 posts Dr 5330, Cr bank, Cr 2140', async () => {
    const w = await expWorld();
    autoApprove();
    const r = await post(
      w,
      bankBody(w, {
        payee: 'Lift Co',
        ledgerAccountId: w.id['5330'],
        grossAmountPaise: 1_180_000,
        gstPaise: 180_000,
        tdsPaise: 20_000,
        tdsSection: '194C',
        fileIds: [bill(w, w.user.id)],
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.netPaidPaise).toBe(1_160_000);
    const d = await w.c('get', `/expenses/${r.body.data.id}`);
    const lines = d.body.data.journal.lines.map((l: any) => [
      l.ledgerAccount.code,
      l.debitPaise,
      l.creditPaise,
    ]);
    expect(lines).toEqual([
      ['5330', 1_180_000, 0],
      ['1110-001', 0, 1_160_000],
      ['2140', 0, 20_000],
    ]);
    expect(d.body.data.files).toHaveLength(1);
    expect(d.body.data.canReverse).toBe(false);
  });

  it('with finance.gstInputClaimable the GST goes to 1410', async () => {
    const w = await expWorld();
    autoApprove();
    await setSetting(w.sid, 'finance.gstInputClaimable', true);
    const r = await post(
      w,
      bankBody(w, { ledgerAccountId: w.id['5330'], grossAmountPaise: 118_000, gstPaise: 18_000 }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await balanceOf(w.sid, '1410')).toBe(18_000);
    expect(await balanceOf(w.sid, '5330')).toBe(100_000);
  });

  it('T13-16: a Repair fund expense takes the fund negative and credits 4900 with the fund id', async () => {
    const w = await expWorld();
    autoApprove();
    const fundId = await fundIdByType(w.sid, 'REPAIR');
    const r = await post(
      w,
      bankBody(w, {
        ledgerAccountId: w.id['5330'],
        grossAmountPaise: 4_500_000,
        fundId,
        fileIds: [bill(w, w.user.id)],
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await balanceOf(w.sid, '2420')).toBe(4_500_000); // debit balance: the fund is at -4,500,000
    expect(await balanceOf(w.sid, '4900')).toBe(-4_500_000);
    expect(await balanceOf(w.sid, '5330')).toBe(4_500_000);
    expect(await balanceOf(w.sid, '1110-001')).toBe(5_500_000);
  });

  it('T13-40: the same Idempotency-Key gives one expense; the same key with another body is 409', async () => {
    const w = await expWorld();
    const headers = idemH();
    const a = await w.c('post', '/expenses', expBody(w), { headers });
    const b = await w.c('post', '/expenses', expBody(w), { headers });
    expect(a.status).toBe(201);
    expect(b.body.data.id).toBe(a.body.data.id);
    expect(await Expense.count({ where: { societyId: w.sid } })).toBe(1);
    const c = await w.c('post', '/expenses', expBody(w, { grossAmountPaise: 190_000 }), { headers });
    expect([c.status, c.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
    expect((await w.c('post', '/expenses', expBody(w))).status).toBe(400);
  });

  it('submit=false saves a DRAFT without an approval request', async () => {
    const w = await expWorld();
    const r = await post(w, expBody(w, { submit: false }));
    expect(r.body.data.status).toBe('DRAFT');
    expect(accountsPortCalls.filter(c => c.fn === 'approvals.request')).toHaveLength(0);
    expect(await JournalEntry.count({ where: { societyId: w.sid, refType: 'expense' } })).toBe(0);
  });
});

describe('PATCH, submit, withdraw, delete (8.7, 6.2)', () => {
  it('T13-17: reverse a DRAFT, withdraw a POSTED and edit a PENDING expense are 409 INVALID_STATE', async () => {
    const w = await expWorld();
    const d = (await post(w, expBody(w, { submit: false }))).body.data;
    const rv = await w.treasurer.c(
      'post',
      `/expenses/${d.id}/reverse`,
      { reason: 'Entered by mistake', version: d.version },
      { headers: idemH() },
    );
    expect([rv.status, rv.body.code]).toEqual([409, 'INVALID_STATE']);
    const p = (await post(w, expBody(w))).body.data;
    const ed = await w.c('patch', `/expenses/${p.id}`, { description: 'x', version: p.version });
    expect([ed.status, ed.body.code]).toEqual([409, 'INVALID_STATE']);
    autoApprove();
    const posted = (await post(w, expBody(w, { payee: 'Other Payee' }))).body.data;
    expect(posted.status).toBe('POSTED');
    const wd = await w.c('post', `/expenses/${posted.id}/withdraw`, {
      reason: 'Changed my mind',
      version: posted.version,
    });
    expect([wd.status, wd.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('edits a draft (version required, stale is 409), replaces the bill set, audits before and after', async () => {
    const w = await expWorld();
    const d = (await post(w, expBody(w, { submit: false }))).body.data;
    const f1 = bill(w, w.user.id);
    const ok = await w.c('patch', `/expenses/${d.id}`, {
      grossAmountPaise: 190_000,
      description: 'Monthly',
      fileIds: [f1],
      version: d.version,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      grossAmountPaise: 190_000,
      netPaidPaise: 190_000,
      billFileCount: 1,
      version: d.version + 1,
    });
    const stale = await w.c('patch', `/expenses/${d.id}`, { description: 'Again', version: d.version });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const bad = await w.c('patch', `/expenses/${d.id}`, {
      version: ok.body.data.version,
      fileIds: [999_999],
    });
    expect([bad.status, bad.body.code]).toEqual([422, 'FILE_NOT_LINKABLE']);
    const cleared = await w.c('patch', `/expenses/${d.id}`, { version: ok.body.data.version, fileIds: [] });
    expect(cleared.body.data.billFileCount).toBe(0);
    expect(await w.c('patch', `/expenses/${d.id}`, { version: 99, bogus: 1 })).toMatchObject({ status: 400 });
  });

  it('a Treasurer (edit permission) may edit another maker draft; the Auditor may not (403)', async () => {
    const w = await expWorld();
    const d = (await post(w, expBody(w, { submit: false }))).body.data;
    const t = await w.treasurer.c('patch', `/expenses/${d.id}`, {
      description: 'Checked',
      version: d.version,
    });
    expect(t.status).toBe(200);
    const a = await w.auditor.c('patch', `/expenses/${d.id}`, {
      description: 'No',
      version: t.body.data.version,
    });
    expect([a.status, a.body.code]).toEqual([403, 'PERMISSION_DENIED']);
  });

  it('submit: BILL_REQUIRED above the limit; from a draft with a bill it becomes PENDING_APPROVAL', async () => {
    const w = await expWorld();
    const d = (await post(w, bankBody(w, { grossAmountPaise: 250_000, submit: false }))).body.data;
    const no = await w.c('post', `/expenses/${d.id}/submit`, { version: d.version }, { headers: idemH() });
    expect([no.status, no.body.code]).toEqual([422, 'BILL_REQUIRED']);
    const ed = await w.c('patch', `/expenses/${d.id}`, { fileIds: [bill(w, w.user.id)], version: d.version });
    const ok = await w.c(
      'post',
      `/expenses/${d.id}/submit`,
      { version: ed.body.data.version },
      { headers: idemH() },
    );
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data.status).toBe('PENDING_APPROVAL');
    expect(ok.body.data.approvalRequestId).not.toBeNull();
  });

  it('T13-11: 250,000 paise without a bill is 422 BILL_REQUIRED on create', async () => {
    const w = await expWorld();
    const r = await post(w, bankBody(w, { grossAmountPaise: 250_000 }));
    expect([r.status, r.body.code]).toEqual([422, 'BILL_REQUIRED']);
    expect(await Expense.count({ where: { societyId: w.sid } })).toBe(0);
  });

  it('withdraw by the maker cancels the request and the expense; another user gets 403; frees nothing posted', async () => {
    const w = await expWorld();
    const p = (await post(w, expBody(w))).body.data;
    const other = await w.treasurer.c('post', `/expenses/${p.id}/withdraw`, {
      reason: 'Not mine to withdraw',
      version: p.version,
    });
    expect(other.status).toBe(403);
    const r = await w.c('post', `/expenses/${p.id}/withdraw`, {
      reason: 'Entered twice',
      version: p.version,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'CANCELLED', cancelReason: 'Entered twice' });
    expect(accountsPortCalls.some(c => c.fn === 'approvals.cancel')).toBe(true);
    const again = await decide(w, Number(p.approvalRequestId ?? (await reqOf(p.id))));
    expect(again.status).toBe(409); // request no longer pending
    expect(await balanceOf(w.sid, '1120')).toBe(1_000_000);
  });

  it('DELETE cancels a draft only (maker or finance.expenses.delete)', async () => {
    const w = await expWorld();
    const d = (await post(w, expBody(w, { submit: false }))).body.data;
    const r = await w.c('delete', `/expenses/${d.id}`, { reason: 'Duplicate entry', version: d.version });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.status).toBe('CANCELLED');
    const p = (await post(w, expBody(w))).body.data;
    const bad = await w.c('delete', `/expenses/${p.id}`, { reason: 'Duplicate entry', version: p.version });
    expect([bad.status, bad.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('rejected: reason stored, edit moves it back to DRAFT, then it can be submitted again as a new request', async () => {
    const w = await expWorld();
    const p = (await post(w, expBody(w))).body.data;
    const firstReq = await reqOf(p.id);
    const rj = await decide(w, firstReq, 'reject', 'Wrong head');
    expect(rj.status, JSON.stringify(rj.body)).toBe(200);
    const e = await fresh(p.id);
    expect([e.status, e.rejectionReason]).toEqual(['REJECTED', 'Wrong head']);
    const ed = await w.c('patch', `/expenses/${p.id}`, { description: 'Fixed', version: Number(e.version) });
    expect(ed.body.data).toMatchObject({ status: 'DRAFT', rejectionReason: null });
    const sub = await w.c(
      'post',
      `/expenses/${p.id}/submit`,
      { version: ed.body.data.version },
      { headers: idemH() },
    );
    expect(sub.body.data.status).toBe('PENDING_APPROVAL');
    expect(await reqOf(p.id)).not.toBe(firstReq);
  });

  it('T13-47: changes requested, the maker edits and resubmits (approvals.resubmit), another approver posts', async () => {
    const w = await expWorld();
    const p = (await post(w, expBody(w))).body.data;
    const requestId = await reqOf(p.id);
    await moneyTx(t =>
      placeholderAccountsApprovalTypes.get('EXPENSE')!.onChangesRequested!(
        { society: { id: w.sid } } as never,
        p.id,
        t,
      ),
    );
    const e = await fresh(p.id);
    expect(e.status).toBe('CHANGES_REQUESTED');
    const ed = await w.c('patch', `/expenses/${p.id}`, {
      grossAmountPaise: 175_000,
      version: Number(e.version),
    });
    expect(ed.body.data.status).toBe('CHANGES_REQUESTED');
    const sub = await w.c(
      'post',
      `/expenses/${p.id}/submit`,
      { version: ed.body.data.version },
      { headers: idemH() },
    );
    expect(sub.body.data.status).toBe('PENDING_APPROVAL');
    expect(accountsPortCalls.find(c => c.fn === 'approvals.resubmit')?.input).toMatchObject({
      id: requestId,
      amountPaise: 175_000,
    });
    expect((await decide(w, requestId)).status).toBe(200);
    expect(await balanceOf(w.sid, '1120')).toBe(1_000_000 - 175_000);
  });
});

describe('POST /expenses/:id/reverse (8.8, BR-13-29)', () => {
  async function posted(w: ExpWorld) {
    autoApprove();
    const r = await post(w, expBody(w));
    return r.body.data as { id: number; version: number };
  }

  it('T13-18: the maker is refused; a stale step-up is 401; after step-up it is REVERSED with a reversal voucher and a notification', async () => {
    const w = await expWorld();
    const p = await posted(w);
    const body = { reason: 'Paid twice by mistake', version: p.version };
    const own = await w.c('post', `/expenses/${p.id}/reverse`, body, { headers: idemH() });
    expect([own.status, own.body.code]).toEqual([409, 'MAKER_CHECKER_VIOLATION']);
    advance(10 * 60_000);
    const stale = await w.treasurer.c('post', `/expenses/${p.id}/reverse`, body, { headers: idemH() });
    expect([stale.status, stale.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    resetLogins();
    const t2 = as(await login(w.treasurer.user));
    const r = await t2('post', `/expenses/${p.id}/reverse`, body, { headers: idemH() });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'REVERSED', reversalReason: 'Paid twice by mistake' });
    expect(r.body.data.reversalVoucherNo).toMatch(/^VCH\//);
    expect(await balanceOf(w.sid, '1120')).toBe(1_000_000);
    expect(await balanceOf(w.sid, '5350')).toBe(0);
    const note = accountsPortCalls.find(c => c.fn === 'notifications.send');
    expect(note?.input).toMatchObject({ template: 'accounts.expense_reversed', userIds: [w.user.id] });
    const again = await t2(
      'post',
      `/expenses/${p.id}/reverse`,
      { ...body, version: r.body.data.version },
      { headers: idemH() },
    );
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('validates the reversal date and the permission (Auditor 403) and needs the Idempotency-Key', async () => {
    const w = await expWorld();
    const p = await posted(w);
    const body = { reason: 'Paid twice by mistake', version: p.version };
    const aud = await w.auditor.c('post', `/expenses/${p.id}/reverse`, body, { headers: idemH() });
    expect(aud.status).toBe(403);
    expect((await w.treasurer.c('post', `/expenses/${p.id}/reverse`, body)).status).toBe(400);
    const early = await w.treasurer.c(
      'post',
      `/expenses/${p.id}/reverse`,
      { ...body, reversalDate: '2026-10-29' },
      { headers: idemH() },
    );
    expect([early.status, early.body.code]).toEqual([422, 'DATE_OUT_OF_RANGE']);
    const stale = await w.treasurer.c(
      'post',
      `/expenses/${p.id}/reverse`,
      { ...body, version: 77 },
      { headers: idemH() },
    );
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    const unknown = await w.treasurer.c('post', '/expenses/999999/reverse', body, { headers: idemH() });
    expect([unknown.status, unknown.body.code]).toEqual([404, 'EXPENSE_NOT_FOUND']);
  });
});

describe('module 21 vendor bill port (BR-13-28)', () => {
  it('records the payment on posting and reverses it on reversal; a 422 from module 21 is VENDOR_BILL_NOT_PAYABLE', async () => {
    const w = await expWorld();
    autoApprove();
    setAccountsPorts({
      vendors: {
        exists: async () => true,
        getBill: async () => ({ id: 7, vendorId: 3, payablePaise: 500_000 }),
      },
    });
    const r = await post(
      w,
      bankBody(w, {
        expenseType: 'VENDOR_BILL',
        ledgerAccountId: undefined,
        vendorBillId: 7,
        grossAmountPaise: 400_000,
        fileIds: [bill(w, w.user.id)],
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      status: 'POSTED',
      vendorId: 3,
      vendorBillId: 7,
      ledgerAccount: { code: '2110' },
    });
    expect(accountsPortCalls.find(c => c.fn === 'vendors.recordPayment')?.input).toEqual({
      vendorBillId: 7,
      expenseId: r.body.data.id,
      amountPaise: 400_000,
    });
    const rv = await w.treasurer.c(
      'post',
      `/expenses/${r.body.data.id}/reverse`,
      { reason: 'Bill disputed', version: r.body.data.version },
      { headers: idemH() },
    );
    expect(rv.status, JSON.stringify(rv.body)).toBe(200);
    expect(accountsPortCalls.find(c => c.fn === 'vendors.reversePayment')?.input).toEqual({
      vendorBillId: 7,
      expenseId: r.body.data.id,
    });
    setAccountsPorts({
      vendors: {
        recordPayment: async () => {
          throw new UnprocessableError('BILL_CLOSED', 'Bill is closed');
        },
      },
    });
    const bad = await post(
      w,
      bankBody(w, {
        expenseType: 'VENDOR_BILL',
        ledgerAccountId: undefined,
        vendorBillId: 7,
        grossAmountPaise: 100_000,
        payee: 'Another',
      }),
    );
    expect([bad.status, bad.body.code]).toEqual([422, 'VENDOR_BILL_NOT_PAYABLE']);
    expect(await Expense.count({ where: { societyId: w.sid, status: 'DRAFT' } })).toBe(0);
  });
});

describe('expenses.listForCollection (8.20)', () => {
  it('returns only POSTED expenses of the collection, with no bill or contact fields', async () => {
    const w = await expWorld();
    expect(await listForCollection(w.sid, 12345)).toEqual([]);
  });
});
