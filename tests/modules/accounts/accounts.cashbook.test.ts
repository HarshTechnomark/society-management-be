import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeDb } from '../../../src/models';
import { ctxOf, post } from '../../helpers/accounts';
import {
  autoApprove,
  bankBody,
  expBody,
  expWorld,
  idemH,
  resetExpenses,
} from '../../helpers/accounts-expenses';
import { resetLogins } from '../../helpers/access';

afterAll(closeDb);
beforeEach(async () => {
  resetLogins();
  await resetExpenses();
});

const book = (w: Awaited<ReturnType<typeof expWorld>>, q: Record<string, string | number> = {}) =>
  w.c('get', '/accounts/cash-book', undefined, {
    query: Object.fromEntries(
      Object.entries({ from: '2026-10-01', to: '2026-10-31', ...q }).map(([k, v]) => [k, String(v)]),
    ),
  });

describe('GET /accounts/cash-book (8.4)', () => {
  it('opening, rows with running balance, closing, over bank and cash', async () => {
    const w = await expWorld({ bankPaise: 5_000_000, cashPaise: 1_000_000 });
    await autoApprove();
    await w.c('post', '/expenses', expBody(w), { headers: idemH() }); // cash out 180,000 on 30 Oct
    await w.c('post', '/expenses', bankBody(w, { grossAmountPaise: 100_000, expenseDate: '2026-10-31' }), {
      headers: idemH(),
    });
    const r = await book(w, { from: '2026-10-02', to: '2026-10-31' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.openingPaise).toBe(6_000_000); // both opening balances were dated 1 Oct
    expect(
      r.body.data.rows.map((x: any) => [x.date, x.inPaise, x.outPaise, x.runningPaise, x.refType]),
    ).toEqual([
      ['2026-10-30', 0, 180_000, 5_820_000, 'expense'],
      ['2026-10-31', 0, 100_000, 5_720_000, 'expense'],
    ]);
    expect(r.body.data.closingPaise).toBe(5_720_000);
    expect(r.body.data.rows[0]).toMatchObject({ account: 'Cash in hand', voucherType: 'PAYMENT' });
    expect(r.body.data.rows[0].voucherNo).toMatch(/^VCH\//);
    expect(r.body.pagination.total).toBe(2);
    const all = await book(w);
    expect(all.body.data.openingPaise).toBe(0);
    expect(all.body.data.rows).toHaveLength(4);
    expect(all.body.data.rows[0]).toMatchObject({ inPaise: 5_000_000 + 0, refType: 'opening' }); // same-day lines ordered by entry
  });

  it('filters by account (CASH, BANK:<id>) and by direction; running balance still counts every line', async () => {
    const w = await expWorld({ bankPaise: 5_000_000, cashPaise: 1_000_000 });
    await autoApprove();
    await w.c('post', '/expenses', expBody(w), { headers: idemH() });
    const cash = await book(w, { account: 'CASH', from: '2026-10-02' });
    expect(cash.body.data).toMatchObject({ openingPaise: 1_000_000, closingPaise: 820_000 });
    expect(cash.body.data.rows).toHaveLength(1);
    const outOnly = await book(w, { direction: 'OUT' });
    expect(outOnly.body.data.rows).toHaveLength(1);
    expect(outOnly.body.data.rows[0].runningPaise).toBe(6_000_000 - 180_000);
    expect((await book(w, { direction: 'IN' })).body.data.rows).toHaveLength(2);
    const missing = await book(w, { account: 'BANK:999' });
    expect([missing.status, missing.body.code]).toEqual([404, 'BANK_ACCOUNT_NOT_FOUND']);
  });

  it('contra moves between two cash or bank ledgers show on both sides when ALL', async () => {
    const w = await expWorld({ bankPaise: 5_000_000, cashPaise: 0 });
    await post(ctxOf(w.society, null), {
      date: '2026-10-15',
      voucherType: 'CONTRA',
      refType: 'cash_withdrawal',
      refId: 1,
      narration: 'Cash withdrawn',
      lines: [
        { ledgerAccountCode: '1120', debitPaise: 300_000, creditPaise: 0 },
        { ledgerAccountCode: '1110-001', debitPaise: 0, creditPaise: 300_000 },
      ],
    });
    const r = await book(w, { from: '2026-10-10' });
    expect(r.body.data.rows.map((x: any) => [x.inPaise, x.outPaise])).toEqual([
      [300_000, 0],
      [0, 300_000],
    ]);
    expect(r.body.data.closingPaise).toBe(r.body.data.openingPaise);
  });

  it('paginates the rows and validates the range', async () => {
    const w = await expWorld();
    const p = await book(w, { limit: 1, page: 2 });
    expect(p.body.data.rows).toHaveLength(1);
    expect(p.body.pagination).toMatchObject({ page: 2, limit: 1, total: 2 });
    expect((await book(w, { from: '2025-01-01', to: '2026-12-31' })).status).toBe(400);
    expect((await book(w, { from: '2026-10-31', to: '2026-10-01' })).status).toBe(400);
    expect((await book(w, { account: 'FOO' })).status).toBe(400);
    expect((await w.c('get', '/accounts/cash-book')).status).toBe(400);
  });

  it('is open to the Auditor and works on Starter (simple cash book is always on)', async () => {
    const w = await expWorld({ plan: 'STARTER' });
    expect((await book(w)).status).toBe(200);
    expect(
      (
        await w.auditor.c('get', '/accounts/cash-book', undefined, {
          query: { from: '2026-10-01', to: '2026-10-31' },
        })
      ).status,
    ).toBe(200);
  });
});
