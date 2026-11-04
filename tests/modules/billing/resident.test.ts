import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Invoice, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { featureOff } from '../../helpers/society-setup';
import { residentUser } from '../../helpers/residents';
import { makeRule } from '../../helpers/billing-runs';
import { duesWorld, makeInvoice, resetDues, type DuesWorld } from '../../helpers/billing-dues';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetDues);

/** Flat A-101: an owner with a login (co-owner next to the primary owner) and a tenant with a login; A-102 has a tenant too. */
async function world() {
  const w = await duesWorld(2);
  const [a, b] = w.units as [DuesWorld['units'][0], DuesWorld['units'][0]];
  const owner = await residentUser(w.society, a.id, { name: 'Owner One', relation: 'CO_OWNER' });
  const tenant = await residentUser(w.society, a.id, { name: 'Tenant One', relation: 'TENANT' });
  const other = await residentUser(w.society, b.id, { name: 'Tenant Two', relation: 'TENANT' });
  const mine = (r: typeof owner) => ({ residentId: r.resident.id!, name: r.resident.name });
  const ownerInv = await makeInvoice(w, {
    unit: a,
    billTo: mine(owner),
    totalPaise: 600_000,
    dueDate: '2026-10-10',
    headKey: 'SINKING_FUND',
  });
  const tenantInv = await makeInvoice(w, {
    unit: a,
    billTo: mine(tenant),
    totalPaise: 300_000,
    dueDate: '2026-11-20',
    billToRelation: 'TENANT',
  });
  const paidInv = await makeInvoice(w, {
    unit: a,
    billTo: mine(owner),
    totalPaise: 100_000,
    paidPaise: 100_000,
    settledOn: '2026-09-05',
  });
  const otherInv = await makeInvoice(w, {
    unit: b,
    billTo: mine(other),
    totalPaise: 250_000,
    billToRelation: 'TENANT',
  });
  return { w, a, b, owner, tenant, other, ownerInv, tenantInv, paidInv, otherInv };
}

describe('GET /me/invoices (8.21, BR-11-61)', () => {
  it('an owner sees every invoice of the flat; a tenant sees only their own; nobody sees another flat', async () => {
    const x = await world();
    const o = await x.owner.c('get', '/me/invoices');
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body.data.map((i: any) => i.id).sort()).toEqual(
      [x.ownerInv.id, x.tenantInv.id, x.paidInv.id].sort(),
    );
    expect(o.body.pagination.total).toBe(3);
    const t = await x.tenant.c('get', '/me/invoices');
    expect(t.body.data.map((i: any) => i.id)).toEqual([x.tenantInv.id]);
    const other = await x.other.c('get', '/me/invoices');
    expect(other.body.data.map((i: any) => i.id)).toEqual([x.otherInv.id]);
  });

  it('item shape of 8.11, status filter OPEN / PAID / ALL, unit filter and paging', async () => {
    const x = await world();
    const all = await x.owner.c('get', '/me/invoices?limit=1&page=2');
    expect(all.body.pagination).toMatchObject({ page: 2, limit: 1, total: 3 });
    const open = await x.owner.c('get', '/me/invoices?status=OPEN');
    expect(open.body.data.map((i: any) => i.id).sort()).toEqual([x.ownerInv.id, x.tenantInv.id].sort());
    const paid = await x.owner.c('get', '/me/invoices?status=PAID');
    expect(paid.body.data).toHaveLength(1);
    expect(paid.body.data[0]).toEqual({
      id: x.paidInv.id,
      invoiceNo: x.paidInv.invoiceNo,
      invoiceType: 'REGULAR',
      unitId: x.a.id,
      unitLabel: 'A-101',
      billToName: 'Owner One',
      billToRelation: 'OWNER',
      periodLabel: 'Sep 2026',
      invoiceDate: '2026-09-01',
      dueDate: '2026-09-10',
      totalPaise: 100_000,
      paidPaise: 100_000,
      outstandingPaise: 0,
      status: 'PAID',
      isOverdue: false,
      isDisputed: false,
    });
    const byUnit = await x.owner.c('get', `/me/invoices?unitId=${x.a.id}&financialYear=2026-27`);
    expect(byUnit.body.data).toHaveLength(3);
    expect((await x.owner.c('get', `/me/invoices?unitId=${x.b.id}`)).status).toBe(404);
    expect((await x.owner.c('get', '/me/invoices?status=BAD')).status).toBe(400);
  });

  it('a person billed on a flat they left or never owned still sees that bill (BR-11-61 a), and that unit may be listed', async () => {
    const x = await world();
    const stray = await makeInvoice(x.w, {
      unit: x.a,
      billTo: { residentId: x.other.resident.id!, name: 'Tenant Two' },
      totalPaise: 50_000,
      billToRelation: 'TENANT',
    });
    const r = await x.other.c('get', '/me/invoices');
    expect(r.body.data.map((i: any) => i.id).sort()).toEqual([x.otherInv.id, stray.id].sort());
    expect((await x.other.c('get', `/me/invoices?unitId=${x.a.id}`)).status).toBe(200);
    expect((await x.other.c('get', `/me/invoices/${x.ownerInv.id}`)).status).toBe(404);
  });
});

describe('GET /me/invoices/:id and pdf-url', () => {
  it('T11-41: a tenant opening the owner invoice gets 404 INVOICE_NOT_FOUND; so does another flat', async () => {
    const x = await world();
    const r = await x.tenant.c('get', `/me/invoices/${x.ownerInv.id}`);
    expect(r.status).toBe(404);
    expect(r.body.code ?? r.body.error?.code).toBe('INVOICE_NOT_FOUND');
    expect((await x.tenant.c('get', `/me/invoices/${x.otherInv.id}`)).status).toBe(404);
    expect((await x.tenant.c('get', `/me/invoices/${x.ownerInv.id}/pdf-url`)).status).toBe(404);
    expect((await x.tenant.c('get', '/me/invoices/99999999')).status).toBe(404);
    expect((await x.owner.c('get', `/me/invoices/${x.tenantInv.id}`)).status).toBe(200);
  });

  it('the detail has the 8.12 shape with lines, and explain-my-bill data on each charge line (F23)', async () => {
    const x = await world();
    const head = x.w.heads.MAINTENANCE!;
    const { version } = await makeRule(x.w.society.id!, head, {
      rateType: 'FLAT_PER_UNIT',
      amountPaise: 123_000,
    });
    const inv = await makeInvoice(x.w, {
      unit: x.a,
      billTo: { residentId: x.owner.resident.id!, name: 'Owner One' },
      totalPaise: 123_000,
      ruleVersionId: version.id!,
    });
    const r = await x.owner.c('get', `/me/invoices/${inv.id}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const d = r.body.data;
    expect(d).toMatchObject({
      id: inv.id,
      invoiceNo: inv.invoiceNo,
      status: 'ISSUED',
      unit: { id: x.a.id, label: 'A-101' },
      billTo: { residentId: x.owner.resident.id, name: 'Owner One', relation: 'OWNER' },
      periodLabel: 'Sep 2026',
      isOverdue: true,
      totalPaise: 123_000,
      outstandingPaise: 123_000,
      notes: [],
      pdfStatus: 'PENDING',
      pdfUrl: null,
    });
    expect(d.lines).toHaveLength(1);
    expect(d.lines[0].computation).toMatchObject({
      method: 'FLAT_PER_UNIT',
      formula: '123000 x 1',
      text: 'flat',
      ruleVersionId: version.id,
      ruleVersionNo: 1,
      ruleEffectiveFrom: '2026-04-01',
    });
  });

  it('without billing.explain_my_bill the computation is omitted', async () => {
    const x = await world();
    await featureOff(x.w.society.id!, 'billing.explain_my_bill');
    const r = await x.owner.c('get', `/me/invoices/${x.ownerInv.id}`);
    expect(r.status).toBe(200);
    expect(r.body.data.lines[0]).not.toHaveProperty('computation');
  });

  it('pdf-url: 409 PDF_NOT_READY while pending; a ready PDF gives a short-lived url', async () => {
    const x = await world();
    const early = await x.owner.c('get', `/me/invoices/${x.ownerInv.id}/pdf-url`);
    expect(early.status).toBe(409);
    expect(early.body.code ?? early.body.error?.code).toBe('PDF_NOT_READY');
    await Invoice.update({ pdfStatus: 'READY', pdfFileId: 4242 }, { where: { id: x.ownerInv.id! } });
    const ready = await x.owner.c('get', `/me/invoices/${x.ownerInv.id}/pdf-url`);
    expect(ready.status, JSON.stringify(ready.body)).toBe(200);
    expect(typeof ready.body.data.url).toBe('string');
    expect(typeof ready.body.data.expiresAt).toBe('string');
    expect((await x.owner.c('get', `/me/invoices/${x.ownerInv.id}`)).body.data.pdfUrl).toBe(
      `/me/invoices/${x.ownerInv.id}/pdf-url`,
    );
  });
});

describe('GET /me/dues and /me/units/:unitId/statement', () => {
  it('dues per flat: outstanding, overdue, next due date and open count over the invoices the caller sees', async () => {
    const x = await world();
    const o = await x.owner.c('get', '/me/dues');
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body.data.units).toEqual([
      {
        unitId: x.a.id,
        unitLabel: 'A-101',
        relation: 'OWNER',
        outstandingPaise: 900_000,
        overduePaise: 600_000,
        nextDueDate: '2026-11-20',
        openInvoiceCount: 2,
      },
    ]);
    const t = await x.tenant.c('get', '/me/dues');
    expect(t.body.data.units).toEqual([
      {
        unitId: x.a.id,
        unitLabel: 'A-101',
        relation: 'TENANT',
        outstandingPaise: 300_000,
        overduePaise: 0,
        nextDueDate: '2026-11-20',
        openInvoiceCount: 1,
      },
    ]);
  });

  it('T11-41 the statement is for the owner side only: the owner gets entries, the tenant 404 UNIT_NOT_FOUND', async () => {
    const x = await world();
    const o = await x.owner.c('get', `/me/units/${x.a.id}/statement?from=2026-09-01&to=2026-11-30`);
    expect(o.status, JSON.stringify(o.body)).toBe(200);
    expect(o.body.data.unit).toEqual({ id: x.a.id, label: 'A-101' });
    expect(o.body.data.entries).toHaveLength(4);
    expect(o.body.data.closingBalancePaise).toBe(900_000);
    const t = await x.tenant.c('get', `/me/units/${x.a.id}/statement`);
    expect(t.status).toBe(404);
    expect(t.body.code ?? t.body.error?.code).toBe('UNIT_NOT_FOUND');
    expect((await x.owner.c('get', `/me/units/${x.b.id}/statement`)).status).toBe(404);
    expect((await x.owner.c('get', `/me/units/${x.a.id}/statement?format=csv`)).status).toBe(400);
  });
});
