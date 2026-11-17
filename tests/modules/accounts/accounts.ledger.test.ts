import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, LedgerAccount, closeDb, sequelize } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { setAccountsPorts } from '../../../src/modules/accounts/accounts.ports';
import { ensureBooks } from '../../../src/modules/accounts/accounts.chart';
import { listLedgerAccounts } from '../../../src/modules/accounts/accounts.ledger.service';
import { systemCtx } from '../../../src/types/context';
import { useRealJournal } from '../../helpers/accounts';
import { idemH, resetRuns, runSociety, type RunSociety } from '../../helpers/billing-runs';
import { memberOf } from '../../helpers/society-setup';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(async () => {
  await resetRuns();
  setAccountsPorts();
  useRealJournal();
});

const create = (w: { c: RunSociety['c'] }, body: Record<string, unknown>) =>
  w.c('post', '/accounts/ledger-accounts', body, { headers: idemH() });
const idOf = async (w: RunSociety, code: string) => {
  await sequelize.transaction(t => ensureBooks(t, w.society.id!));
  return Number((await LedgerAccount.findOne({ where: { societyId: w.society.id!, code } }))!.id);
};
const flat = (nodes: any[]): any[] => nodes.flatMap(x => [x, ...flat(x.children)]);

describe('GET /accounts/ledger-accounts (8.10)', () => {
  it('returns the seeded chart as a tree with group balances as the sum of children', async () => {
    const w = await runSociety({ flats: 1 });
    const r = await w.c('get', '/accounts/ledger-accounts');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const all = flat(r.body.data);
    const assets = r.body.data.find((n: any) => n.code === '1000');
    expect(assets).toMatchObject({ accountType: 'ASSET', isGroup: true, isSystem: true, balancePaise: 0 });
    expect(all.find((n: any) => n.code === '1120')).toMatchObject({
      isGroup: false,
      subtype: 'CASH',
      balancePaise: 0,
    });
    expect(all.find((n: any) => n.code === '2410')).toBeTruthy();
    // nested: 1100 is a child of 1000
    expect(assets.children.some((c: any) => c.code === '1100')).toBe(true);
  });

  it('group balance sums the children (opening cash shows on 1100 and 1000)', async () => {
    const w = await runSociety({ flats: 1 });
    const o = await w.c(
      'post',
      '/accounts/opening-balances',
      { asOfDate: '2026-11-01', lines: [{ ledgerAccountCode: '1120', debitPaise: 70_000, creditPaise: 0 }] },
      { headers: idemH() },
    );
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const all = flat((await w.c('get', '/accounts/ledger-accounts')).body.data);
    expect(all.find((n: any) => n.code === '1120').balancePaise).toBe(70_000);
    expect(all.find((n: any) => n.code === '1000').balancePaise).toBe(70_000);
  });

  it('filters: type, cashBookOnly and activeOnly (default true)', async () => {
    const w = await runSociety({ flats: 1 });
    const exp = await w.c('get', '/accounts/ledger-accounts', undefined, { query: { type: 'EXPENSE' } });
    expect(flat(exp.body.data).every((n: any) => n.accountType === 'EXPENSE')).toBe(true);
    const cb = await w.c('get', '/accounts/ledger-accounts', undefined, { query: { cashBookOnly: 'true' } });
    const leaves = flat(cb.body.data).filter((n: any) => !n.children.length);
    expect(leaves.length).toBeGreaterThan(0);
    expect(leaves.every((n: any) => n.isCashBookCategory)).toBe(true);
    const id = await idOf(w, '5330');
    await LedgerAccount.update({ isActive: false } as never, { where: { id } });
    expect(
      flat((await w.c('get', '/accounts/ledger-accounts')).body.data).some((n: any) => n.code === '5330'),
    ).toBe(false);
    const incl = await w.c('get', '/accounts/ledger-accounts', undefined, { query: { activeOnly: 'false' } });
    expect(flat(incl.body.data).some((n: any) => n.code === '5330')).toBe(true);
  });

  it('a user with only finance.expenses.create (expense picker) gets the tree without balances; the Auditor sees balances', async () => {
    const w = await runSociety({ flats: 1 });
    await w.c('get', '/accounts/ledger-accounts');
    const picker = {
      ...systemCtx('t'),
      society: { id: w.society.id!, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
      permissions: new Set(['finance.expenses.create']),
    };
    const tree = await listLedgerAccounts(picker, { activeOnly: true });
    expect(flat(tree).length).toBeGreaterThan(50);
    expect(flat(tree).some((n: any) => 'balancePaise' in n)).toBe(false);
    const auditor = await memberOf(w.society, 'auditor');
    expect(
      flat((await auditor.c('get', '/accounts/ledger-accounts')).body.data).every(
        (n: any) => 'balancePaise' in n,
      ),
    ).toBe(true);
  });

  it('works on the Starter plan (the tree GET is always on)', async () => {
    const w = await runSociety({ flats: 1, plan: 'STARTER' });
    expect((await w.c('get', '/accounts/ledger-accounts')).status).toBe(200);
  });
});

describe('POST /accounts/ledger-accounts (8.10)', () => {
  it('creates a custom account under a system group; the type is inherited; audit written', async () => {
    const w = await runSociety({ flats: 1 });
    const parent = await idOf(w, '5000');
    const r = await create(w, {
      parentId: parent,
      code: '5395',
      name: 'Garden upkeep',
      isCashBookCategory: true,
      transparencyCategory: 'Garden',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toMatchObject({
      code: '5395',
      accountType: 'EXPENSE',
      subtype: 'OTHER',
      isSystem: false,
      isGroup: false,
      isActive: true,
      isCashBookCategory: true,
      transparencyCategory: 'Garden',
      balancePaise: 0,
      version: 1,
    });
    const row = (await LedgerAccount.findOne({ where: { societyId: w.society.id!, code: '5395' } }))!;
    expect(row.systemKey).toBeNull();
    expect(Number(row.balancePaise)).toBe(0);
    expect(
      await AuditLog.count({
        where: { action: 'accounts.ledger_account.created', entityId: String(row.id) },
      }),
    ).toBe(1);
  });

  it('refuses a taken code with 409 DUPLICATE_LEDGER_CODE, also across a replay with a new key', async () => {
    const w = await runSociety({ flats: 1 });
    const parent = await idOf(w, '5000');
    expect((await create(w, { parentId: parent, code: '5396', name: 'One' })).status).toBe(201);
    const r = await create(w, { parentId: parent, code: '5396', name: 'Two' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('DUPLICATE_LEDGER_CODE');
    const seeded = await create(w, { parentId: parent, code: '5330', name: 'Clash' });
    expect(seeded.body.code).toBe('DUPLICATE_LEDGER_CODE');
  });

  it('INVALID_PARENT for a leaf parent and for the system-managed groups 1110, 2440, 2450', async () => {
    const w = await runSociety({ flats: 1 });
    for (const [parentCode, code] of [
      ['5330', '5331'],
      ['1110', '1115'],
      ['2440', '2445'],
      ['2450', '2455'],
    ] as const) {
      const r = await create(w, { parentId: await idOf(w, parentCode), code, name: 'Nope' });
      expect(r.status, parentCode).toBe(422);
      expect(r.body.code).toBe('INVALID_PARENT');
    }
    expect((await create(w, { parentId: 999_999_999, code: '5399', name: 'Nope' })).body.code).toBe(
      'LEDGER_ACCOUNT_NOT_FOUND',
    );
  });

  it('validates the code (4 digits, first digit of the parent), the name, subtype and the cash book flag', async () => {
    const w = await runSociety({ flats: 1 });
    const parent = await idOf(w, '5000');
    const bad = async (body: Record<string, unknown>) =>
      await create(w, { parentId: parent, code: '5397', name: 'Valid', ...body });
    expect((await bad({ code: '539' })).status).toBe(400);
    expect((await bad({ code: '4397' })).status).toBe(400); // first digit differs from the parent
    expect((await bad({ name: 'x' })).status).toBe(400);
    expect((await bad({ subtype: 'BANK' })).status).toBe(400); // system-only subtype
    expect((await bad({ isCashBookCategory: true, isGroup: true })).status).toBe(400);
    const incomeParent = await idOf(w, '4000');
    expect(
      (await create(w, { parentId: incomeParent, code: '4777', name: 'Valid', isCashBookCategory: true }))
        .status,
    ).toBe(400);
    expect((await create(w, { parentId: parent, code: '5398', name: 'Valid', surprise: 1 })).status).toBe(
      400,
    );
    expect((await bad({ subtype: 'PAYABLE' })).status).toBe(201);
  });

  it('a group account can be created and takes children', async () => {
    const w = await runSociety({ flats: 1 });
    const g = await create(w, {
      parentId: await idOf(w, '5000'),
      code: '5880',
      name: 'Events group',
      isGroup: true,
    });
    expect(g.status, JSON.stringify(g.body)).toBe(201);
    expect((await create(w, { parentId: g.body.data.id, code: '5885', name: 'Diwali' })).status).toBe(201);
  });

  it('needs Premium (402 FEATURE_NOT_IN_PLAN) and finance.accounts.edit (403)', async () => {
    const s = await runSociety({ flats: 1, plan: 'STARTER' });
    const r = await create(s, { parentId: await idOf(s, '5000'), code: '5395', name: 'Garden' });
    expect(r.status).toBe(402);
    expect(r.body.code).toBe('FEATURE_NOT_IN_PLAN');
    const w = await runSociety({ flats: 1 });
    const auditor = await memberOf(w.society, 'auditor');
    const d = await create(auditor, { parentId: await idOf(w, '5000'), code: '5395', name: 'Garden' });
    expect(d.status).toBe(403);
    expect(d.body.code).toBe('PERMISSION_DENIED');
  });
});

describe('PATCH /accounts/ledger-accounts/:id (8.10)', () => {
  const patch = (w: { c: RunSociety['c'] }, id: number, body: Record<string, unknown>) =>
    w.c('patch', `/accounts/ledger-accounts/${id}`, body);

  async function custom(w: RunSociety, code = '5395') {
    const r = await create(w, { parentId: await idOf(w, '5000'), code, name: 'Garden upkeep' });
    return r.body.data as { id: number; version: number };
  }

  it('renames, flags and describes a custom account; bumps the version; audits before and after', async () => {
    const w = await runSociety({ flats: 1 });
    const a = await custom(w);
    const r = await patch(w, a.id, {
      version: a.version,
      name: 'Garden care',
      isCashBookCategory: true,
      transparencyCategory: 'Garden',
      description: 'Lawn',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      name: 'Garden care',
      isCashBookCategory: true,
      version: a.version + 1,
      code: '5395',
    });
    const log = (await AuditLog.findOne({
      where: { action: 'accounts.ledger_account.updated', entityId: String(a.id) },
    }))!;
    expect(JSON.stringify(log.before)).toContain('Garden upkeep');
    expect(JSON.stringify(log.after)).toContain('Garden care');
  });

  it('never writes balancePaise: an unknown key is a 400', async () => {
    const w = await runSociety({ flats: 1 });
    const a = await custom(w);
    const r = await patch(w, a.id, { version: a.version, balancePaise: 5 });
    expect(r.status).toBe(400);
    expect(Number((await LedgerAccount.findByPk(a.id))!.balancePaise)).toBe(0);
  });

  it('409 STALE_VERSION on an old version; 404 for a missing id', async () => {
    const w = await runSociety({ flats: 1 });
    const a = await custom(w);
    await patch(w, a.id, { version: a.version, name: 'Garden care' });
    const r = await patch(w, a.id, { version: a.version, name: 'Garden again' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('STALE_VERSION');
    expect((await patch(w, 999_999_999, { version: 1, name: 'Nothing' })).body.code).toBe(
      'LEDGER_ACCOUNT_NOT_FOUND',
    );
  });

  it('a system account allows only the cash book flag, transparency category and description (422 SYSTEM_ACCOUNT_LOCKED)', async () => {
    const w = await runSociety({ flats: 1 });
    const id = await idOf(w, '5330');
    const v = Number((await LedgerAccount.findByPk(id))!.version);
    const locked = await patch(w, id, { version: v, name: 'Renamed' });
    expect(locked.status).toBe(422);
    expect(locked.body.code).toBe('SYSTEM_ACCOUNT_LOCKED');
    expect((await patch(w, id, { version: v, isActive: false })).body.code).toBe('SYSTEM_ACCOUNT_LOCKED');
    const okRes = await patch(w, id, { version: v, transparencyCategory: 'Lifts', description: 'AMC' });
    expect(okRes.status, JSON.stringify(okRes.body)).toBe(200);
    expect(okRes.body.data.transparencyCategory).toBe('Lifts');
    // sending the unchanged name is not a change
    expect((await patch(w, id, { version: v + 1, name: okRes.body.data.name })).status).toBe(200);
  });

  it('deactivation needs a zero balance and no active children (422 ACCOUNT_BALANCE_NOT_ZERO); activation back works', async () => {
    const w = await runSociety({ flats: 1 });
    const a = await custom(w, '5395');
    const g = await create(w, {
      parentId: await idOf(w, '5000'),
      code: '5880',
      name: 'Events group',
      isGroup: true,
    });
    const kid = await create(w, { parentId: g.body.data.id, code: '5885', name: 'Diwali' });
    const withKid = await patch(w, g.body.data.id, { version: 1, isActive: false });
    expect(withKid.status).toBe(422);
    expect(withKid.body.code).toBe('ACCOUNT_BALANCE_NOT_ZERO');
    await LedgerAccount.update({ balancePaise: 500 } as never, { where: { id: a.id } });
    expect((await patch(w, a.id, { version: a.version, isActive: false })).body.code).toBe(
      'ACCOUNT_BALANCE_NOT_ZERO',
    );
    await LedgerAccount.update({ balancePaise: 0 } as never, { where: { id: a.id } });
    const off = await patch(w, a.id, { version: a.version, isActive: false });
    expect(off.status, JSON.stringify(off.body)).toBe(200);
    expect(off.body.data.isActive).toBe(false);
    expect((await patch(w, kid.body.data.id, { version: 1, isActive: false })).status).toBe(200);
    expect((await patch(w, g.body.data.id, { version: 1, isActive: false })).status).toBe(200);
    expect(
      (await patch(w, a.id, { version: off.body.data.version, isActive: true })).body.data.isActive,
    ).toBe(true);
  });

  it('the cash book flag only on expense accounts that take postings', async () => {
    const w = await runSociety({ flats: 1 });
    const incomeId = await idOf(w, '4100');
    const v = Number((await LedgerAccount.findByPk(incomeId))!.version);
    expect((await patch(w, incomeId, { version: v, isCashBookCategory: true })).status).toBe(400);
  });

  it('needs Premium and finance.accounts.edit', async () => {
    const s = await runSociety({ flats: 1, plan: 'STARTER' });
    const id = await idOf(s, '5330');
    expect((await patch(s, id, { version: 1, description: 'x' })).body.code).toBe('FEATURE_NOT_IN_PLAN');
    const w = await runSociety({ flats: 1 });
    const auditor = await memberOf(w.society, 'auditor');
    expect((await patch(auditor, await idOf(w, '5330'), { version: 1, description: 'x' })).status).toBe(403);
  });
});

describe('another society', () => {
  it("cannot read or change this society's account (404 LEDGER_ACCOUNT_NOT_FOUND)", async () => {
    const a = await runSociety({ flats: 1 });
    const b = await runSociety({ flats: 1 });
    await a.c('get', '/accounts/ledger-accounts');
    const id = await idOf(a, '5330');
    const r = await b.c('patch', `/accounts/ledger-accounts/${id}`, { version: 1, description: 'x' });
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('LEDGER_ACCOUNT_NOT_FOUND');
    const parent = await create(b, { parentId: await idOf(a, '5000'), code: '5395', name: 'Garden' });
    expect(parent.status).toBe(404);
  });
});
