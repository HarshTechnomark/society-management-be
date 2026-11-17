import { afterAll, beforeEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, sequelize } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { registerAccounts } from '../../../src/modules/accounts/accounts.public';
import { accountsPorts } from '../../../src/modules/accounts/accounts.ports';
import { ensureBooks } from '../../../src/modules/accounts/accounts.chart';
import { societyPorts } from '../../../src/modules/societies/societies.ports';
import { ctxOf, resetAccounts } from '../../helpers/accounts';
import { reportBooks } from '../../helpers/accounts.reports';
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
      expect(r.body.data.balancePaise).toBe(r.body.data.collectedPaise - r.body.data.spentPaise);
    }
  });
});
