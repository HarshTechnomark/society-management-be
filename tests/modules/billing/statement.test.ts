import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Unit, closeDb, sequelize } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { unitLedger } from '../../../src/modules/billing/billing.public';
import { app } from '../../helpers/auth';
import { adminOf } from '../../helpers/residents';
import { ledgerSociety, resetLedger, societyCtx } from '../../helpers/billing-ledger';
import { rawInvoice, rawNote, rawOpening } from '../../helpers/maint-billing';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetLedger);

type W = Awaited<ReturnType<typeof ledgerSociety>>;
let seq = 0;
const entry = (
  w: W,
  unitId: number,
  o: { type?: string; ref?: string; debit?: number; credit?: number; date: string; narration?: string },
) =>
  sequelize.transaction(t =>
    unitLedger.post(
      societyCtx(w.society),
      {
        unitId,
        entryType: (o.type ?? (o.credit ? 'PAYMENT' : 'INVOICE')) as never,
        refType: (o.ref ?? (o.credit ? 'payment' : 'invoice')) as never,
        refId: ++seq,
        debitPaise: o.debit ?? 0,
        creditPaise: o.credit ?? 0,
        date: o.date,
        narration: o.narration ?? 'Entry',
      },
      t,
    ),
  );

const url = (unitId: number) => `/billing/units/${unitId}/statement`;

describe('statement of account (section 8.20, BR-11-59)', () => {
  it('returns opening, entries with a running balance and the closing balance (the spec example)', async () => {
    const w = await ledgerSociety();
    const u = w.unit(1).id;
    await entry(w, u, { date: '2026-11-01', debit: 538000, narration: 'Bill INV/2026-27/000150 (Nov 2026)' });
    await entry(w, u, { date: '2026-11-08', credit: 538000, narration: 'Receipt RCT/2026-27/000046 (UPI)' });
    const r = await w.c('get', url(u), undefined, { query: { from: '2026-04-01', to: '2026-11-30' } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      unit: { id: u, label: w.unit(1).label },
      from: '2026-04-01',
      to: '2026-11-30',
      openingBalancePaise: 0,
      closingBalancePaise: 0,
    });
    expect(r.body.data.entries).toHaveLength(2);
    expect(r.body.data.entries[0]).toMatchObject({
      entryDate: '2026-11-01',
      entryType: 'INVOICE',
      refType: 'invoice',
      narration: 'Bill INV/2026-27/000150 (Nov 2026)',
      debitPaise: 538000,
      creditPaise: 0,
      balancePaise: 538000,
    });
    expect(r.body.data.entries[1]).toMatchObject({
      entryType: 'PAYMENT',
      creditPaise: 538000,
      balancePaise: 0,
    });
    expect(Object.keys(r.body.data.entries[0]).sort()).toEqual(
      [
        'balancePaise',
        'creditPaise',
        'debitPaise',
        'entryDate',
        'entryType',
        'id',
        'narration',
        'refId',
        'refType',
      ].sort(),
    );
  });

  it('the opening balance of a range is the sum of the entries before from; the running balance carries it', async () => {
    const w = await ledgerSociety();
    const u = w.unit(1).id;
    await entry(w, u, { date: '2026-03-01', debit: 100000 });
    await entry(w, u, { date: '2026-03-15', credit: 30000 });
    await entry(w, u, { date: '2026-04-01', debit: 50000 });
    await entry(w, u, { date: '2026-05-10', credit: 120000 });
    const r = await w.c('get', url(u), undefined, { query: { from: '2026-04-01', to: '2026-12-31' } });
    expect(r.body.data.openingBalancePaise).toBe(70000);
    expect(r.body.data.entries.map((e: any) => e.balancePaise)).toEqual([120000, 0]);
    expect(r.body.data.closingBalancePaise).toBe(0);
    const narrow = await w.c('get', url(u), undefined, { query: { from: '2026-04-02', to: '2026-12-31' } });
    expect(narrow.body.data.openingBalancePaise).toBe(120000);
    expect(narrow.body.data.entries).toHaveLength(1);
    expect(narrow.body.data.closingBalancePaise).toBe(0);
  });

  it('a range with no entry has closing = opening; an advance shows as a negative balance', async () => {
    const w = await ledgerSociety();
    const u = w.unit(1).id;
    await entry(w, u, { date: '2026-02-01', credit: 25000 });
    const r = await w.c('get', url(u), undefined, { query: { from: '2026-04-01', to: '2026-05-01' } });
    expect(r.body.data.openingBalancePaise).toBe(-25000);
    expect(r.body.data.entries).toEqual([]);
    expect(r.body.data.closingBalancePaise).toBe(-25000);
  });

  it('entries are ordered by entry date, then id, whatever the order they were posted in', async () => {
    const w = await ledgerSociety();
    const u = w.unit(1).id;
    const a = await entry(w, u, { date: '2026-10-20', debit: 300, narration: 'late posted early date' });
    const b = await entry(w, u, { date: '2026-10-05', debit: 100, narration: 'early' });
    const c = await entry(w, u, { date: '2026-10-05', debit: 200, narration: 'early too' });
    const r = await w.c('get', url(u), undefined, { query: { from: '2026-10-01', to: '2026-10-31' } });
    expect(r.body.data.entries.map((e: any) => e.id)).toEqual([b.id, c.id, a.id]);
    expect(r.body.data.entries.map((e: any) => e.balancePaise)).toEqual([100, 300, 600]);
  });

  it('only the flat own entries are shown', async () => {
    const w = await ledgerSociety();
    await entry(w, w.unit(1).id, { date: '2026-10-05', debit: 100 });
    await entry(w, w.unit(2).id, { date: '2026-10-05', debit: 999 });
    const r = await w.c('get', url(w.unit(1).id), undefined, {
      query: { from: '2026-10-01', to: '2026-10-31' },
    });
    expect(r.body.data.entries).toHaveLength(1);
    expect(r.body.data.closingBalancePaise).toBe(100);
  });

  it('defaults to the current financial year up to today (1 Nov 2026: 2026-04-01 to 2026-11-01)', async () => {
    const w = await ledgerSociety();
    const r = await w.c('get', url(w.unit(1).id));
    expect(r.status).toBe(200);
    expect(r.body.data.from).toBe('2026-04-01');
    expect(r.body.data.to).toBe('2026-11-01');
  });

  it('refuses a range above 1,100 days, from after to, a bad date and an unknown parameter with 400', async () => {
    const w = await ledgerSociety();
    const u = w.unit(1).id;
    const bad = async (query: Record<string, string>) => {
      const r = await w.c('get', url(u), undefined, { query });
      expect(r.status, JSON.stringify(query)).toBe(400);
      expect(r.body.code).toBe('VALIDATION_FAILED');
    };
    await bad({ from: '2023-01-01', to: '2026-12-31' });
    await bad({ from: '2026-11-02', to: '2026-11-01' });
    await bad({ from: '2026-02-30', to: '2026-11-01' });
    await bad({ from: '01-11-2026' });
    await bad({ from: '2026-04-01', format: 'pdf' });
    await bad({ page: '2' });
    await bad({ from: '2023-01-01' }); // to defaults to today: 1,401 days
  });

  it('accepts a range of exactly 1,100 days (both days counted) and refuses 1,101', async () => {
    const w = await ledgerSociety();
    const u = w.unit(1).id;
    // 2023-11-13 .. 2026-11-16 is 1,100 days, both days counted
    const ok = await w.c('get', url(u), undefined, { query: { from: '2023-11-13', to: '2026-11-16' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const over = await w.c('get', url(u), undefined, { query: { from: '2023-11-12', to: '2026-11-16' } });
    expect(over.status).toBe(400);
  });

  it("a non-numeric or zero unit id is 400; an unknown unit, another society's unit and an archived unit are 404 UNIT_NOT_FOUND", async () => {
    const w = await ledgerSociety();
    const other = await ledgerSociety();
    expect((await w.c('get', '/billing/units/abc/statement')).status).toBe(400);
    expect((await w.c('get', '/billing/units/0/statement')).status).toBe(400);
    for (const id of [99999999, other.unit(1).id]) {
      const r = await w.c('get', url(id));
      expect(r.status).toBe(404);
      expect(r.body.code).toBe('UNIT_NOT_FOUND');
    }
    await Unit.update({ status: 'ARCHIVED', archivedAt: new Date() }, { where: { id: w.unit(3).id } });
    expect((await w.c('get', url(w.unit(3).id))).body.code).toBe('UNIT_NOT_FOUND');
  });

  it('JSON needs finance.billing.view: the Facility Manager is 403, the Auditor (view, export) can read and download', async () => {
    const w = await ledgerSociety();
    const fm = await adminOf(w.society, 'facility_manager');
    const r = await fm.c('get', url(w.unit(1).id));
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PERMISSION_DENIED');
    const aud = await adminOf(w.society, 'auditor');
    expect((await aud.c('get', url(w.unit(1).id))).status).toBe(200);
    expect((await aud.c('get', url(w.unit(1).id), undefined, { query: { format: 'csv' } })).status).toBe(200);
  });

  it('is 401 without a session', async () => {
    const anon = await request(app).get(`/api/v1${url(1)}`);
    expect(anon.status).toBe(401);
  });

  it('CSV needs finance.billing.export: the Secretary (view only) gets JSON but 403 for CSV', async () => {
    const w = await ledgerSociety();
    const sec = await adminOf(w.society, 'secretary');
    expect((await sec.c('get', url(w.unit(1).id))).status).toBe(200);
    const r = await sec.c('get', url(w.unit(1).id), undefined, { query: { format: 'csv' } });
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('PERMISSION_DENIED');
  });

  it('CSV: header, opening and closing rows, injection-safe text, plain negative numbers, audited', async () => {
    const w = await ledgerSociety();
    const u = w.unit(1).id;
    await entry(w, u, { date: '2026-03-01', debit: 1000 });
    await entry(w, u, { date: '2026-10-05', debit: 538000, narration: '=HYPERLINK("http://x","pay")' });
    await entry(w, u, { date: '2026-10-06', credit: 600000, narration: '@cmd, "quoted"' });
    await entry(w, u, { date: '2026-10-07', debit: 5, narration: '-2+3' });
    const r = await w.c('get', url(u), undefined, {
      query: { from: '2026-10-01', to: '2026-10-31', format: 'csv' },
    });
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    expect(r.headers['content-disposition']).toMatch(
      /attachment; filename="statement-A-101-2026-10-01-2026-10-31\.csv"/,
    );
    const text: string = r.text ?? r.body.toString();
    const lines = text
      .replace(/^[\u{feff}]/u, '')
      .trim()
      .split('\r\n');
    expect(lines[0]).toBe('Date,Type,Reference,Narration,Debit,Credit,Balance');
    expect(lines[1]).toBe('2026-10-01,,,Opening balance,,,10.00');
    expect(lines[2]).toBe(
      `2026-10-05,INVOICE,invoice ${lines[2]!.split(',')[2]!.split(' ')[1]},"'=HYPERLINK(""http://x"",""pay"")",5380.00,,5390.00`,
    );
    expect(lines[3]).toMatch(/,"'@cmd, ""quoted""",,6000\.00,-610\.00$/);
    expect(lines[4]).toMatch(/,'-2\+3,0\.05,,-609\.95$/);
    expect(lines[5]).toBe('2026-10-31,,,Closing balance,,,-609.95');
    const log = await AuditLog.findOne({
      where: { societyId: w.society.id!, action: 'billing.statement.exported' },
    });
    expect(log).not.toBeNull();
  });

  it('CSV Reference is the document number (bill, note, opening balance bill); other entries keep the ref text', async () => {
    const w = await ledgerSociety();
    const u = w.unit(1).id;
    const sid = w.society.id!;
    const inv = await rawInvoice(sid, u, { invoiceNo: 'INV/2026-27/000777' } as never);
    const note = await rawNote(sid, Number(inv.id), u, {
      noteNo: 'CN/2026-27/000003',
      noteDate: '2026-10-05',
      status: 'ISSUED',
    } as never);
    const obInv = await rawInvoice(sid, u, {
      invoiceNo: 'INV/2025-26/OB-000001',
      invoiceType: 'OPENING',
    } as never);
    const ob = await rawOpening(sid, { unitId: u, invoiceId: Number(obInv.id), status: 'POSTED' } as never);
    const advance = await rawOpening(sid, { unitId: u, importRowNo: 3, status: 'POSTED' } as never);
    const post = (o: Record<string, unknown>) =>
      sequelize.transaction(t =>
        unitLedger.post(
          societyCtx(w.society),
          { unitId: u, debitPaise: 0, creditPaise: 0, date: '2026-10-05', narration: 'Entry', ...o } as never,
          t,
        ),
      );
    await post({
      entryType: 'OPENING_BALANCE',
      refType: 'opening_balance',
      refId: Number(ob.id),
      debitPaise: 100,
    });
    await post({ entryType: 'INVOICE', refType: 'invoice', refId: Number(inv.id), debitPaise: 200 });
    await post({
      entryType: 'CREDIT_NOTE',
      refType: 'billing_note',
      refId: Number(note.id),
      creditPaise: 50,
    });
    await post({
      entryType: 'OPENING_BALANCE',
      refType: 'opening_balance',
      refId: Number(advance.id),
      creditPaise: 10,
    });
    await post({ entryType: 'PAYMENT', refType: 'payment', refId: 4242, creditPaise: 40 });
    const r = await w.c('get', url(u), undefined, {
      query: { from: '2026-10-01', to: '2026-10-31', format: 'csv' },
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const refs = (r.text as string)
      .trim()
      .split('\r\n')
      .slice(2, -1)
      .map(l => l.split(',')[2]);
    expect(refs).toEqual([
      'INV/2025-26/OB-000001',
      'INV/2026-27/000777',
      'CN/2026-27/000003',
      `opening_balance ${advance.id}`,
      'payment 4242',
    ]);
  });

  it('CSV downloads are limited to 10 an hour per user', async () => {
    const w = await ledgerSociety();
    for (let i = 0; i < 10; i++)
      expect((await w.c('get', url(w.unit(1).id), undefined, { query: { format: 'csv' } })).status).toBe(200);
    const r = await w.c('get', url(w.unit(1).id), undefined, { query: { format: 'csv' } });
    expect(r.status).toBe(429);
    expect((await w.c('get', url(w.unit(1).id))).status).toBe(200); // JSON is not limited
  });
});
