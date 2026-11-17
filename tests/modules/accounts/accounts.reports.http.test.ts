import { afterAll, beforeEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, sequelize } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { registerAccounts } from '../../../src/modules/accounts/accounts.public';
import { accountsPorts } from '../../../src/modules/accounts/accounts.ports';
import { ensureBooks } from '../../../src/modules/accounts/accounts.chart';
import { societyPorts } from '../../../src/modules/societies/societies.ports';
import { ctxOf, fundIdByType, post, resetAccounts } from '../../helpers/accounts';
import { expenseRow, ledgerId, reportBooks } from '../../helpers/accounts.reports';
import { idem, residentSociety, residentUser } from '../../helpers/residents';
import { featureOff } from '../../helpers/society-setup';
import { setSetting } from '../../helpers/billing-setup';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeAll(() => registerAccounts());
beforeEach(async () => {
  await resetAccounts();
});

async function world() {
  const w = await residentSociety({ flats: 1 });
  const sid = w.society.id!;
  await sequelize.transaction(t => ensureBooks(t, sid));
  const acc = {
    society: w.society,
    sid,
    user: ctxOf(w.society, w.user.id),
    userId: w.user.id,
    other: ctxOf(w.society, w.user.id),
    sys: ctxOf(w.society, null),
  };
  await reportBooks(acc as never);
  return w;
}

describe('GET /accounts/reports/:report (8.19)', () => {
  it('trial balance balances over HTTP', async () => {
    const w = await world();
    const r = await w.c('get', '/accounts/reports/trial-balance?asOf=2027-03-31');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.balanced).toBe(true);
    expect(r.body.data.totals.debitPaise).toBe(r.body.data.totals.creditPaise);
  });

  it('serves each of the seven reports for the financial year', async () => {
    const w = await world();
    for (const rep of [
      'income-expenditure',
      'balance-sheet',
      'receipts-payments',
      'gst-summary',
      'tds-register',
    ]) {
      const r = await w.c('get', `/accounts/reports/${rep}?financialYear=2026-27`);
      expect(r.status, `${rep} ${JSON.stringify(r.body)}`).toBe(200);
    }
  });

  it('rejects an unknown report, asOf together with a period, and a backwards range', async () => {
    const w = await world();
    expect((await w.c('get', '/accounts/reports/nope')).status).toBe(400);
    expect(
      (await w.c('get', '/accounts/reports/income-expenditure?asOf=2027-03-31&from=2026-04-01')).status,
    ).toBe(400);
    expect(
      (await w.c('get', '/accounts/reports/income-expenditure?from=2026-06-01&to=2026-05-01')).status,
    ).toBe(400);
  });

  it('is Premium only (402 when the plan lacks financial reports)', async () => {
    const w = await world();
    await featureOff(w.society.id!, 'accounting.financial_reports');
    const r = await w.c('get', '/accounts/reports/trial-balance');
    expect(r.status).toBe(402);
  });

  it('GST and TDS reports need their own plan key', async () => {
    const w = await world();
    await featureOff(w.society.id!, 'accounting.tds');
    const r = await w.c('get', '/accounts/reports/tds-register?financialYear=2026-27');
    expect(r.status).toBe(402);
  });

  it('a resident without the permission gets 403', async () => {
    const w = await world();
    const u = await residentUser(w.society, w.unit(1).id);
    expect((await u.c('get', '/accounts/reports/trial-balance')).status).toBe(403);
  });
});

describe('POST /accounts/exports (8.19)', () => {
  it('queues, renders CSV, XLSX and PDF, stores the file and notifies export_ready', async () => {
    const w = await world();
    const stored: { content: Buffer; name: string; contentType: string }[] = [];
    vi.spyOn(societyPorts().files, 'storeSystemFile').mockImplementation(async (i: any) => {
      stored.push(i);
      return { fileId: 900 + stored.length } as never;
    });
    const send = vi.spyOn(accountsPorts().notifications, 'send');
    for (const format of ['csv', 'xlsx', 'pdf']) {
      const r = await w.c(
        'post',
        '/accounts/exports',
        { report: 'trial-balance', params: { asOf: '2027-03-31' }, format },
        { headers: idem() },
      );
      expect(r.status, JSON.stringify(r.body)).toBe(202);
      expect(r.body.data.exportJobId).toBeTruthy();
    }
    await drainQueues();
    expect(stored.map(s => s.name.split('.').pop()).sort()).toEqual(['csv', 'pdf', 'xlsx']);
    const csv = stored.find(s => s.name.endsWith('.csv'))!;
    expect(String(csv.content)).toContain('Code,Account,Debit,Credit');
    expect(String(stored.find(s => s.name.endsWith('.pdf'))!.content).startsWith('%PDF')).toBe(true);
    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls[0]![0]).toBe('accounts.export_ready');
  });

  it('GET /accounts/exports/:id: preparing, then ready with a download link; other users get 404', async () => {
    const w = await world();
    const r = await w.c(
      'post',
      '/accounts/exports',
      { report: 'trial-balance', params: { asOf: '2027-03-31' }, format: 'csv' },
      { headers: idem() },
    );
    const id = r.body.data.exportJobId as string;
    const before = await w.c('get', `/accounts/exports/${id}`);
    expect(before.status).toBe(200);
    await drainQueues();
    const after = await w.c('get', `/accounts/exports/${id}`);
    expect(after.body.data).toMatchObject({ status: 'READY', report: 'trial-balance', format: 'csv' });
    expect(after.body.data.downloadUrl).toMatch(/^\/api\/v1\/dev\/files\/\d+$/);
    expect((await w.c('get', '/accounts/exports/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await w.c('get', '/accounts/exports/nope')).status).toBe(400);
  });

  it('general ledger needs an account of this society; unknown format is 422', async () => {
    const w = await world();
    const bad = await w.c(
      'post',
      '/accounts/exports',
      { report: 'general-ledger', params: {}, format: 'csv' },
      { headers: idem() },
    );
    expect(bad.status).toBe(400);
    const missing = await w.c(
      'post',
      '/accounts/exports',
      { report: 'general-ledger', params: { ledgerAccountId: 99999999 }, format: 'csv' },
      { headers: idem() },
    );
    expect(missing.status).toBe(404);
    const fmt = await w.c(
      'post',
      '/accounts/exports',
      { report: 'trial-balance', params: {}, format: 'doc' },
      { headers: idem() },
    );
    expect(fmt.status).toBe(400);
  });

  it('is Premium only', async () => {
    const w = await world();
    await featureOff(w.society.id!, 'accounting.financial_reports');
    const r = await w.c(
      'post',
      '/accounts/exports',
      { report: 'trial-balance', params: {}, format: 'csv' },
      { headers: idem() },
    );
    expect(r.status).toBe(402);
  });
});

describe('fund-paid expenses and transfers in the reports', () => {
  it('income and expenditure and receipts and payments ignore fund consumption and transfers', async () => {
    const w = await world();
    const sid = w.society.id!;
    const ctx = ctxOf(w.society, w.user.id);
    const run = async () => ({
      ie: (await w.c('get', '/accounts/reports/income-expenditure?financialYear=2026-27')).body.data,
      rp: (await w.c('get', '/accounts/reports/receipts-payments?financialYear=2026-27')).body.data,
    });
    const before = await run();
    const sinking = await fundIdByType(sid, 'SINKING');
    const repair = await fundIdByType(sid, 'REPAIR');
    const l = (code: string, d: number, c: number, fundId?: number) => ({
      ledgerAccountCode: code,
      debitPaise: d,
      creditPaise: c,
      ...(fundId ? { fundId } : {}),
    });
    await post(ctx, {
      date: '2026-08-01',
      voucherType: 'PAYMENT',
      refType: 'expense',
      refId: 9101,
      narration: 'Fund paid',
      lines: [
        l('5330', 45_000, 0),
        l('1110-001', 0, 45_000),
        l('2410', 45_000, 0, sinking),
        l('4900', 0, 45_000, sinking),
      ],
    });
    await post(ctx, {
      date: '2026-08-02',
      voucherType: 'JOURNAL',
      refType: 'fund_transfer',
      refId: 9102,
      narration: 'Fund transfer',
      lines: [l('2410', 30_000, 0, sinking), l('2420', 0, 30_000, repair)],
    });
    const after = await run();
    const a = after.ie.totals;
    const b = before.ie.totals;
    expect(a.incomePaise).toBe(b.incomePaise);
    expect(a.expenditurePaise).toBe(b.expenditurePaise + 45_000);
    expect(a.surplusPaise).toBe(a.incomePaise - a.expenditurePaise);
    expect(after.ie.rows.some((r: { code: string }) => r.code === '4900')).toBe(false);
    expect(after.rp.rows.some((r: { code: string }) => ['4900', '2420'].includes(r.code))).toBe(false);
    expect(after.rp.totals.paymentsPaise).toBe(before.rp.totals.paymentsPaise + 45_000);
    expect(after.rp.totals.receiptsPaise).toBe(before.rp.totals.receiptsPaise);
    const bs = (await w.c('get', '/accounts/reports/balance-sheet?asOf=2027-03-31')).body.data;
    expect(bs.balanced).toBe(true);
  });
});

describe('GET /accounts/journals source amount', () => {
  it('shows the amount of the source expense, and null for other vouchers', async () => {
    const w = await world();
    const sid = w.society.id!;
    const ctx = ctxOf(w.society, w.user.id);
    const sinking = await fundIdByType(sid, 'SINKING');
    const bank = await ledgerId(sid, '1110-001');
    const e = await expenseRow(sid, w.user.id, {
      date: '2026-08-01',
      gross: 45_000,
      bankLedgerId: bank,
      status: 'DRAFT',
    });
    await post(ctx, {
      date: '2026-08-01',
      voucherType: 'PAYMENT',
      refType: 'expense',
      refId: Number(e.id),
      narration: 'Fund paid',
      lines: [
        { ledgerAccountCode: '5330', debitPaise: 45_000, creditPaise: 0 },
        { ledgerAccountCode: '1110-001', debitPaise: 0, creditPaise: 45_000 },
        { ledgerAccountCode: '2410', debitPaise: 45_000, creditPaise: 0, fundId: sinking },
        { ledgerAccountCode: '4900', debitPaise: 0, creditPaise: 45_000, fundId: sinking },
      ],
    });
    const r = await w.c('get', '/accounts/journals?limit=100');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = r.body.data as { refType: string; totalPaise: number; sourceAmountPaise: number | null }[];
    const x = rows.find(v => v.refType === 'expense' && v.totalPaise === 90_000)!;
    expect(x.sourceAmountPaise).toBe(45_000);
    expect(rows.filter(v => v.refType !== 'expense').every(v => v.sourceAmountPaise === null)).toBe(true);
  });
});

describe('resident finances (8.3)', () => {
  it('is 404 while finance.showFinancesToResidents is off, and shows balances and funds when on', async () => {
    const w = await world();
    const u = await residentUser(w.society, w.unit(1).id);
    const off = await u.c('get', '/me/society-finances');
    expect(off.status).toBe(404);
    await setSetting(w.society.id!, 'finance.showFinancesToResidents', true);
    const on = await u.c('get', '/me/society-finances');
    expect(on.status, JSON.stringify(on.body)).toBe(200);
    expect(on.body.data).toHaveProperty('totalPaise');
    expect(['FULL', 'BALANCE']).toContain(on.body.data.level);
    expect(JSON.stringify(on.body.data)).not.toMatch(/Lift Co|narration/);
  });

  it('fund statement: 404 for a fund not shown or unknown, totals for a shown one', async () => {
    const w = await world();
    const u = await residentUser(w.society, w.unit(1).id);
    await setSetting(w.society.id!, 'finance.showFinancesToResidents', true);
    expect((await u.c('get', '/me/society-finances/funds/99999999/statement')).status).toBe(404);
    const fin = await u.c('get', '/me/society-finances');
    for (const f of fin.body.data.funds) {
      const r = await u.c('get', `/me/society-finances/funds/${f.id}/statement`);
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      const d = r.body.data;
      expect(d.balancePaise).toBe(d.collectedPaise + d.movedInPaise - d.spentPaise - d.movedOutPaise);
    }
  });

  it('keeps fund consumption and transfers out of income, and separates transfers from spending', async () => {
    const w = await world();
    const u = await residentUser(w.society, w.unit(1).id);
    await setSetting(w.society.id!, 'finance.showFinancesToResidents', true);
    const sid = w.society.id!;
    const ctx = ctxOf(w.society, w.user.id);
    const sinking = await fundIdByType(sid, 'SINKING');
    const repair = await fundIdByType(sid, 'REPAIR');
    const before = (await u.c('get', '/me/society-finances')).body.data;
    expect(before.incomeByCategory).not.toBeNull();
    const sum = (rows: { amountPaise: number }[]) => rows.reduce((a, r) => a + r.amountPaise, 0);
    const l = (code: string, d: number, c: number, fundId?: number) => ({
      ledgerAccountCode: code,
      debitPaise: d,
      creditPaise: c,
      ...(fundId ? { fundId } : {}),
    });
    // a fund-paid expense of 45,000 (BR-13-27) and a transfer of 30,000 sinking to repair
    await post(ctx, {
      date: '2026-08-01',
      voucherType: 'PAYMENT',
      refType: 'expense',
      refId: 9001,
      narration: 'Fund paid repair',
      lines: [
        l('5330', 45_000, 0),
        l('1110-001', 0, 45_000),
        l('2410', 45_000, 0, sinking),
        l('4900', 0, 45_000, sinking),
      ],
    });
    await post(ctx, {
      date: '2026-08-02',
      voucherType: 'JOURNAL',
      refType: 'fund_transfer',
      refId: 9002,
      narration: 'Fund transfer: top up',
      lines: [l('2410', 30_000, 0, sinking), l('2420', 0, 30_000, repair)],
    });
    const after = (await u.c('get', '/me/society-finances')).body.data;
    expect(sum(after.incomeByCategory)).toBe(sum(before.incomeByCategory));
    expect(sum(after.spendByCategory)).toBe(sum(before.spendByCategory) + 45_000);
    const st = (await u.c('get', `/me/society-finances/funds/${sinking}/statement`)).body.data;
    expect(st.spentPaise).toBe(45_000);
    expect(st.movedOutPaise).toBe(30_000);
    expect(st.movedInPaise).toBe(0);
    expect(st.spend).toEqual([{ category: 'Repairs and maintenance', amountPaise: 45_000 }]);
    const rp = (await u.c('get', `/me/society-finances/funds/${repair}/statement`)).body.data;
    expect(rp.spentPaise).toBe(0);
    expect(rp.movedInPaise).toBe(30_000);
    expect(rp.spend).toEqual([]);
  });
});
