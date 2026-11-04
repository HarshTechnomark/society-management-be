import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AuditLog,
  BillingNote,
  BillingRun,
  Invoice,
  InvoiceLine,
  OpeningBalance,
  Unit,
  UnitLedgerEntry,
  UnitResident,
  closeDb,
} from '../../../src/models';
import { advance } from '../../../src/lib/clock';
import { drainQueues } from '../../../src/lib/queue';
import { unitLedger } from '../../../src/modules/billing/billing.public';
import { billingPortCalls, setBillingPorts } from '../../../src/modules/billing/billing.ports';
import { putPlaceholderFile } from '../../../src/modules/society-setup/society-setup.ports';
import { seedBillingOpening } from '../../../seeders/billing-opening';
import { app } from '../../helpers/auth';
import { adminOf, addResident, mobile, owner } from '../../helpers/residents';
import { key, ledgerSociety, resetLedger } from '../../helpers/billing-ledger';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetLedger);

type W = Awaited<ReturnType<typeof ledgerSociety>>;
const HEADER = 'unit,arrears_principal,arrears_interest,advance';
const BASE = '/billing/opening-balances';

/** A society with 5 flats; flats 1 to 3 have an owner, flats 4 and 5 are unsold (no one to bill). */
async function society(): Promise<W> {
  const w = await ledgerSociety({ flats: 5 });
  const names = ['Asha Mehta', 'Bina Shah', 'Chetan Rao'];
  for (let i = 1; i <= 3; i++)
    await addResident(w.c, { name: names[i - 1], mobile: mobile(), link: owner(w.unit(i).id) });
  return w;
}
const sheet = (rows: string[], header = HEADER) => `${header}\n${rows.join('\n')}\n`;
const upload = (w: W, text: string, o: { purpose?: string; ownerUserId?: number; scan?: 'PENDING' } = {}) =>
  putPlaceholderFile({
    societyId: w.society.id!,
    ownerUserId: o.ownerUserId ?? w.user.id!,
    name: 'opening.csv',
    content: Buffer.from(text, 'utf8'),
    contentType: 'text/csv',
    purpose: o.purpose,
    scan: o.scan,
  });
const imp = (w: W, text: string, o: { asOfDate?: string; dryRun?: boolean } = {}) =>
  w.c(
    'post',
    `${BASE}/import`,
    { fileId: upload(w, text), asOfDate: o.asOfDate ?? '2026-10-31', ...(o.dryRun ? { dryRun: true } : {}) },
    { headers: key() },
  );
const post = (w: W, confirmTotalPaise: number) =>
  w.c('post', `${BASE}/post`, { confirmTotalPaise }, { headers: key() });
const rows = async (w: W, status?: string) =>
  await OpeningBalance.findAll({
    where: { societyId: w.society.id!, ...(status ? { status } : {}) },
    order: [['id', 'ASC']],
  });
const calls = (fn: string) => billingPortCalls.filter(c => c.fn === fn);

describe('opening balances: template and import (section 8.23, BR-11-65)', () => {
  it('the template is the header only', async () => {
    const w = await society();
    const r = await w.c('get', `${BASE}/template`);
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toMatch(/^text\/csv/);
    expect((r.text ?? r.body.toString()).replace(/^[\u{feff}]/u, '').trim()).toBe(HEADER);
  });

  it('imports valid rows as DRAFT with exact paise, empty amounts as zero, labels matched without case', async () => {
    const w = await society();
    const [a, b, c] = [w.unit(1).label, w.unit(2).label.toLowerCase(), w.unit(3).label];
    const r = await imp(w, sheet([`${a},12500.50,350.5,`, `${b},,,2000`, `${c},1,,`]));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      draft: 3,
      invalid: 0,
      dryRun: false,
      errors: [],
      totals: {
        draftArrearsPaise: 1250050 + 35050 + 100,
        draftAdvancePaise: 200000,
        invalidCount: 0,
        postedCount: 0,
      },
    });
    const list = await rows(w, 'DRAFT');
    expect(
      list.map(x => [
        Number(x.arrearsPrincipalPaise),
        Number(x.arrearsInterestPaise),
        Number(x.advancePaise),
      ]),
    ).toEqual([
      [1250050, 35050, 0],
      [0, 0, 200000],
      [100, 0, 0],
    ]);
    expect(list.map(x => x.importRowNo)).toEqual([2, 3, 4]);
    expect(
      list.every(x => x.asOfDate === '2026-10-31' && x.activeKey === `OB:${x.unitId}` && x.version === 1),
    ).toBe(true);
    const log = await AuditLog.findOne({
      where: { societyId: w.society.id!, action: 'billing.opening_balance.imported' },
    });
    expect(log).not.toBeNull();
  });

  it('T11-34 two unknown flats are INVALID with a reason and posting is refused until they are fixed or removed', async () => {
    const w = await society();
    const r = await imp(
      w,
      sheet([`${w.unit(1).label},100,,`, 'Z-999,50,,', 'Q-1,,,70', `${w.unit(2).label},,,10`]),
    );
    expect(r.body.data).toMatchObject({ draft: 2, invalid: 2, totals: { invalidCount: 2 } });
    expect(r.body.data.errors).toEqual([
      { rowNo: 3, unit: 'Z-999', message: 'Unknown flat' },
      { rowNo: 4, unit: 'Q-1', message: 'Unknown flat' },
    ]);
    const bad = await rows(w, 'INVALID');
    expect(
      bad.every(x => x.unitId === null && x.activeKey === null && x.validationError === 'Unknown flat'),
    ).toBe(true);
    const p = await post(w, 9000);
    expect([p.status, p.body.code]).toEqual([422, 'OPENING_BALANCE_HAS_INVALID_ROWS']);
    // removing the two invalid rows lets the post through
    for (const x of bad) expect((await w.c('delete', `${BASE}/${x.id}`, { version: 1 })).status).toBe(204);
    expect((await post(w, 9000)).status).toBe(200);
  });

  it('marks every bad row INVALID with its reason and keeps the good ones', async () => {
    const w = await society();
    const [u1, u2, u3] = [1, 2, 3].map(i => w.unit(i).label);
    const r = await imp(
      w,
      sheet([
        `${u1},"1,250.50",,`, // comma amount (spec edge case)
        `${u2},10.123,,`, // three decimals
        `${u3},-5,,`, // negative
        `${u1},100,,`, // fine: the first row of the flat was invalid
        `${w.unit(4).label},100,,`, // unsold flat: nobody to bill
        `${w.unit(5).label},100,,50`, // arrears and advance
        `${w.unit(5).label},,,`, // nothing at all
        `${u2},abc,,`,
        `,100,,`,
        `${w.unit(4).label},,,300`, // an advance for the unsold flat is fine
        `${u1},200,,`, // the flat is already DRAFT in this file
      ]),
    );
    expect(r.body.data).toMatchObject({ draft: 2, invalid: 9 });
    const msg = (await rows(w, 'INVALID')).map(x => [x.importRowNo, x.validationError]);
    expect(msg).toEqual([
      [2, 'Amount must be digits with up to 2 decimals'],
      [3, 'Amount must be digits with up to 2 decimals'],
      [4, 'Amount must be digits with up to 2 decimals'],
      [6, 'No owner or tenant on record to bill; add the resident first'],
      [7, 'A flat has arrears or an advance, not both'],
      [8, 'Enter arrears or an advance'],
      [9, 'Amount must be digits with up to 2 decimals'],
      [10, 'Flat is required'],
      [12, 'Duplicate flat in file'],
    ]);
    expect((await rows(w, 'DRAFT')).map(x => x.importRowNo)).toEqual([5, 11]);
  });

  it('a dry run writes nothing and leaves earlier DRAFT rows as they were', async () => {
    const w = await society();
    await imp(w, sheet([`${w.unit(1).label},100,,`]));
    const before = (await rows(w)).map(x => x.id);
    const r = await imp(w, sheet([`${w.unit(2).label},500,,`, 'Z-1,5,,']), { dryRun: true });
    expect(r.body.data).toMatchObject({
      dryRun: true,
      draft: 1,
      invalid: 1,
      totals: { draftArrearsPaise: 50000, invalidCount: 1 },
    });
    expect((await rows(w)).map(x => x.id)).toEqual(before);
    expect(
      await AuditLog.count({
        where: { societyId: w.society.id!, action: 'billing.opening_balance.imported' },
      }),
    ).toBe(1);
  });

  it('importing again replaces the earlier DRAFT and INVALID rows', async () => {
    const w = await society();
    await imp(w, sheet([`${w.unit(1).label},100,,`, 'Z-1,5,,']));
    const r = await imp(w, sheet([`${w.unit(2).label},,,900`]));
    expect(r.body.data).toMatchObject({
      draft: 1,
      invalid: 0,
      totals: { draftAdvancePaise: 90000, draftArrearsPaise: 0 },
    });
    const all = await rows(w);
    expect(all).toHaveLength(1);
    expect(all[0]!.unitId).toBe(w.unit(2).id);
  });

  it('a flat already POSTED is INVALID ("Already posted; reverse first") and its posted row is kept', async () => {
    const w = await society();
    await imp(w, sheet([`${w.unit(1).label},100,,`]));
    expect((await post(w, 10000)).status).toBe(200);
    const r = await imp(w, sheet([`${w.unit(1).label},100,,`, `${w.unit(2).label},,,5`]));
    expect(r.body.data).toMatchObject({ draft: 1, invalid: 1, totals: { postedCount: 1 } });
    expect((await rows(w, 'INVALID'))[0]!.validationError).toBe('Already posted; reverse first');
    expect(await rows(w, 'POSTED')).toHaveLength(1);
  });

  it('the as-of date: not in the future; with a regular run it is the day before the run starts', async () => {
    const w = await society();
    const text = sheet([`${w.unit(1).label},100,,`]);
    for (const asOfDate of ['2026-11-02', '2030-01-01']) {
      const r = await imp(w, text, { asOfDate });
      expect([r.status, r.body.code]).toEqual([422, 'OPENING_BALANCE_DATE_INVALID']);
    }
    expect((await imp(w, text, { asOfDate: '2026-11-01' })).status).toBe(200); // today is allowed
    await BillingRun.create({
      societyId: w.society.id!,
      runLabel: 'BR-2026-11',
      runType: 'REGULAR',
      cycle: 'MONTHLY',
      periodStart: '2026-11-01',
      periodEnd: '2026-11-30',
      billDate: '2026-11-01',
      scopeType: 'ALL_UNITS',
      status: 'PREVIEW',
      activeKey: 'REG:2026-11-01',
      totalPaise: 0,
      version: 1,
    } as never);
    const bad = await imp(w, text, { asOfDate: '2026-10-30' });
    expect([bad.status, bad.body.code]).toEqual([422, 'OPENING_BALANCE_DATE_INVALID']);
    expect((await imp(w, text, { asOfDate: '2026-10-31' })).status).toBe(200);
  });

  it('refuses a wrong header, an empty file, a file of another purpose or owner, an unscanned file and too many rows', async () => {
    const w = await society();
    const body = (fileId: number) => ({ fileId, asOfDate: '2026-10-31' });
    const go = (fileId: number) => w.c('post', `${BASE}/import`, body(fileId), { headers: key() });
    for (const text of [
      'flat,arrears,interest,advance\nA-101,1,,',
      `${HEADER},extra\nA-101,1,,,`,
      `${HEADER}\n`,
      '',
    ]) {
      const r = await go(upload(w, text));
      expect([r.status, r.body.code], text).toEqual([422, 'IMPORT_FILE_INVALID']);
    }
    expect((await go(upload(w, sheet(['A-101,1,,']), { purpose: 'KYC_DOCUMENT' }))).body.code).toBe(
      'IMPORT_FILE_INVALID',
    );
    const other = await ledgerSociety();
    const theirs = putPlaceholderFile({
      societyId: other.society.id!,
      ownerUserId: other.user.id!,
      name: 'x.csv',
      content: Buffer.from(sheet(['A-101,1,,'])),
    });
    expect([(await go(theirs)).status, (await go(theirs)).body.code]).toEqual([404, 'FILE_NOT_FOUND']);
    expect((await go(upload(w, sheet(['A-101,1,,']), { ownerUserId: other.user.id! }))).status).toBe(404);
    expect((await go(upload(w, sheet(['A-101,1,,']), { scan: 'PENDING' }))).body.code).toBe(
      'IMPORT_FILE_NOT_READY',
    );
    expect((await go(987654)).status).toBe(404);
    const many = await go(upload(w, sheet(Array.from({ length: 5001 }, (_, i) => `X-${i},1,,`))));
    expect([many.status, many.body.code]).toEqual([422, 'IMPORT_TOO_MANY_ROWS']);
    expect(await OpeningBalance.count({ where: { societyId: w.society.id! } })).toBe(0);
  });

  it('accepts exactly 5,000 rows', async () => {
    const w = await society();
    const r = await imp(w, sheet(Array.from({ length: 5000 }, (_, i) => `X-${i},1,,`)), { dryRun: true });
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(200);
    expect(r.body.data.invalid).toBe(5000);
    expect(r.body.data.errors).toHaveLength(50); // the preview is capped
  }, 120_000);

  it('validates the body (strict), needs an Idempotency-Key and replays the first answer for the same key', async () => {
    const w = await society();
    const fileId = upload(w, sheet([`${w.unit(1).label},100,,`]));
    const send = (b: unknown, headers: Record<string, string> = key()) =>
      w.c('post', `${BASE}/import`, b, { headers });
    for (const b of [
      { fileId: String(fileId), asOfDate: '2026-10-31' },
      { fileId, asOfDate: '31-10-2026' },
      { fileId, asOfDate: '2026-02-30' },
      { fileId },
      { asOfDate: '2026-10-31' },
      { fileId, asOfDate: '2026-10-31', extra: 1 },
      { fileId, asOfDate: '2026-10-31', dryRun: 'yes' },
    ]) {
      const r = await send(b);
      expect([r.status, r.body.code], JSON.stringify(b)).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect((await send({ fileId, asOfDate: '2026-10-31' }, {})).status).toBe(400);
    const k = key();
    const a = await send({ fileId, asOfDate: '2026-10-31' }, k);
    const b = await send({ fileId, asOfDate: '2026-10-31' }, k);
    expect(a.status).toBe(200);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body).toEqual(a.body);
    const c = await send({ fileId, asOfDate: '2026-10-30' }, k);
    expect([c.status, c.body.code]).toEqual([409, 'IDEMPOTENCY_KEY_REUSED']);
  });
});

describe('opening balances: list and delete', () => {
  it('lists rows with the fields the screen needs, totals of the whole society, a status filter and pagination', async () => {
    const w = await society();
    await imp(w, sheet([`${w.unit(1).label},100.25,5,`, `${w.unit(2).label},,,40`, 'Z-1,9,,']));
    const r = await w.c('get', BASE);
    expect(r.status).toBe(200);
    expect(r.body.data.totals).toEqual({
      draftArrearsPaise: 10525,
      draftAdvancePaise: 4000,
      invalidCount: 1,
      postedCount: 0,
    });
    expect(r.body.pagination).toEqual({ page: 1, limit: 20, total: 3, totalPages: 1 });
    expect(r.body.data.items[0]).toEqual({
      id: expect.any(Number),
      unitId: w.unit(1).id,
      unitLabel: w.unit(1).label,
      unitLabelInput: w.unit(1).label,
      importRowNo: 2,
      asOfDate: '2026-10-31',
      arrearsPrincipalPaise: 10025,
      arrearsInterestPaise: 500,
      advancePaise: 0,
      status: 'DRAFT',
      validationError: null,
      invoiceId: null,
      postedAt: null,
      reversedAt: null,
      version: 1,
    });
    expect(r.body.data.items[2]).toMatchObject({
      unitId: null,
      unitLabel: 'Z-1',
      status: 'INVALID',
      validationError: 'Unknown flat',
    });
    const inv = await w.c('get', BASE, undefined, { query: { status: 'INVALID' } });
    expect(inv.body.data.items).toHaveLength(1);
    expect(inv.body.data.totals.draftArrearsPaise).toBe(10525);
    const page = await w.c('get', BASE, undefined, { query: { page: '2', limit: '2' } });
    expect(page.body.data.items).toHaveLength(1);
    expect(page.body.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });
    for (const q of [{ status: 'NOPE' }, { limit: '101' }, { page: '0' }, { x: '1' }] as Record<
      string,
      string
    >[])
      expect((await w.c('get', BASE, undefined, { query: q })).status).toBe(400);
  });

  it("does not show another society's rows", async () => {
    const w = await society();
    const o = await society();
    await imp(o, sheet([`${o.unit(1).label},100,,`]));
    expect((await w.c('get', BASE)).body.data.items).toEqual([]);
  });

  it('deletes a DRAFT or INVALID row with its version; a stale version is 409; a posted or unknown row is not deleted', async () => {
    const w = await society();
    await imp(w, sheet([`${w.unit(1).label},100,,`, `${w.unit(2).label},200,,`, 'Z-1,9,,']));
    const [d1, d2, bad] = await rows(w);
    const stale = await w.c('delete', `${BASE}/${d1!.id}`, { version: 5 });
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    expect((await w.c('delete', `${BASE}/${d1!.id}`, { version: 1 })).status).toBe(204);
    expect((await w.c('delete', `${BASE}/${bad!.id}`, { version: 1 })).status).toBe(204);
    expect(await rows(w)).toHaveLength(1);
    expect(
      await AuditLog.count({
        where: { societyId: w.society.id!, action: 'billing.opening_balance.deleted' },
      }),
    ).toBe(2);
    const gone = await w.c('delete', `${BASE}/${d1!.id}`, { version: 1 });
    expect([gone.status, gone.body.code]).toEqual([404, 'OPENING_BALANCE_NOT_FOUND']);
    expect((await post(w, 200 * 100)).status).toBe(200);
    const posted = await w.c('delete', `${BASE}/${d2!.id}`, { version: 2 });
    expect([posted.status, posted.body.code]).toEqual([409, 'INVALID_STATE']);
    expect((await w.c('delete', `${BASE}/${d2!.id}`, {})).status).toBe(400);
    expect((await w.c('delete', `${BASE}/${d2!.id}`, { version: 2, x: 1 })).status).toBe(400);
  });

  it("another society's row is 404 OPENING_BALANCE_NOT_FOUND for delete and reverse", async () => {
    const w = await society();
    const o = await society();
    await imp(o, sheet([`${o.unit(1).label},100,,`]));
    const [theirs] = await rows(o);
    for (const r of [
      await w.c('delete', `${BASE}/${theirs!.id}`, { version: 1 }),
      await w.c('post', `${BASE}/${theirs!.id}/reverse`, { version: 1, reason: 'Wrong amounts entered' }),
    ])
      expect([r.status, r.body.code]).toEqual([404, 'OPENING_BALANCE_NOT_FOUND']);
    expect(await rows(o)).toHaveLength(1);
  });
});

describe('opening balances: post (BR-11-65, BR-11-71)', () => {
  it('T11-35 a wrong confirmTotalPaise is 422 OPENING_BALANCE_TOTAL_MISMATCH and nothing is posted', async () => {
    const w = await society();
    await imp(w, sheet([`${w.unit(1).label},1000,,`, `${w.unit(2).label},,,300`]));
    for (const wrong of [100000, 70000 - 1, 130000, 0]) {
      const r = await post(w, wrong);
      expect([r.status, r.body.code], String(wrong)).toEqual([422, 'OPENING_BALANCE_TOTAL_MISMATCH']);
    }
    expect(await rows(w, 'POSTED')).toHaveLength(0);
    expect(await Invoice.count({ where: { societyId: w.society.id! } })).toBe(0);
    expect(await UnitLedgerEntry.count({ where: { societyId: w.society.id! } })).toBe(0);
  });

  it('posts arrears as an OB/<flat> invoice with one ledger debit and a journal, and an advance as a credit, a journal and a module 12 advance', async () => {
    const w = await society();
    await imp(
      w,
      sheet([`${w.unit(1).label},1250.50,350.50,`, `${w.unit(2).label},,,2000`, `${w.unit(4).label},,,10.5`]),
    );
    const confirm = 160100 - 200000 - 1050;
    const r = await post(w, confirm);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toEqual({ posted: 3, totalArrearsPaise: 160100, totalAdvancePaise: 201050 });

    const inv = (await Invoice.findOne({ where: { societyId: w.society.id!, unitId: w.unit(1).id } }))!;
    expect(inv).toMatchObject({
      invoiceNo: `OB/${w.unit(1).label}`,
      invoiceType: 'OPENING',
      invoiceDate: '2026-10-31',
      dueDate: '2026-10-31',
      financialYear: '2026-27',
      status: 'ISSUED',
      pdfStatus: 'READY',
      pdfFileId: null,
      dedupeKey: expect.stringMatching(new RegExp(`^OB:${w.unit(1).id}:\\d+$`)),
      refType: 'opening_balance',
    });
    expect(
      [
        inv.subtotalPaise,
        inv.taxPaise,
        inv.roundOffPaise,
        inv.totalPaise,
        inv.outstandingPaise,
        inv.paidPaise,
      ].map(Number),
    ).toEqual([160100, 0, 0, 160100, 160100, 0]);
    expect(Number(inv.nonInterestBearingPaise)).toBe(35050);
    expect(inv.billToRelation).toBe('OWNER');
    expect(inv.billToName).toBe('Asha Mehta');
    const lines = await InvoiceLine.findAll({ where: { invoiceId: inv.id! }, order: [['lineNo', 'ASC']] });
    expect(lines.map(l => [l.lineKind, l.headKey, Number(l.amountPaise), l.ledgerAccountCode])).toEqual([
      ['CHARGE', 'OPENING_ARREARS', 125050, '3900'],
      ['INTEREST', 'INTEREST', 35050, '3900'],
    ]);

    const e1 = (await UnitLedgerEntry.findAll({ where: { unitId: w.unit(1).id } }))!;
    expect(e1).toHaveLength(1);
    expect(e1[0]).toMatchObject({
      entryType: 'OPENING_BALANCE',
      refType: 'opening_balance',
      entryDate: '2026-10-31',
    });
    expect([Number(e1[0]!.debitPaise), Number(e1[0]!.creditPaise)]).toEqual([160100, 0]);
    expect(await unitLedger.balance(w.society.id!, w.unit(1).id)).toBe(160100);
    expect(await unitLedger.balance(w.society.id!, w.unit(2).id)).toBe(-200000);
    expect(await unitLedger.balance(w.society.id!, w.unit(4).id)).toBe(-1050);
    expect(await Invoice.count({ where: { societyId: w.society.id!, unitId: w.unit(2).id } })).toBe(0);

    const journals = calls('journal.post').map(c => c.input as any);
    expect(journals).toHaveLength(3);
    expect(journals[0]).toMatchObject({
      date: '2026-10-31',
      voucherType: 'OPENING_BALANCE',
      refType: 'opening_balance',
    });
    expect(journals[0].lines.map((l: any) => [l.accountCode, l.debitPaise, l.creditPaise])).toEqual([
      ['1300', 160100, 0],
      ['3900', 0, 160100],
    ]);
    expect(journals[1].lines.map((l: any) => [l.accountCode, l.debitPaise, l.creditPaise])).toEqual([
      ['3900', 200000, 0],
      ['2210', 0, 200000],
    ]);
    const adv = calls('payments.creditOpeningAdvance').map(c => c.input as any);
    expect(adv.map(a => [a.unitId, a.amountPaise, a.asOfDate])).toEqual([
      [w.unit(2).id, 200000, '2026-10-31'],
      [w.unit(4).id, 1050, '2026-10-31'],
    ]);
    expect(calls('payments.creditOpeningAdvance').every(c => c.t !== undefined)).toBe(true);
    expect(calls('payments.queueAdvanceApply').map(c => c.input)).toEqual([
      { societyId: w.society.id, unitIds: [w.unit(2).id, w.unit(4).id] },
    ]);

    const done = await rows(w, 'POSTED');
    expect(done).toHaveLength(3);
    expect(done[0]).toMatchObject({ invoiceId: inv.id, version: 2, postedBy: w.user.id });
    expect(done[0]!.postedAt).not.toBeNull();
    expect(done[1]!.invoiceId).toBeNull();
    expect(
      await AuditLog.count({ where: { societyId: w.society.id!, action: 'billing.opening_balance.posted' } }),
    ).toBe(3);
  });

  it('the statement of the flat shows the opening entry, and module 09 duesPaise is the real ledger balance', async () => {
    const w = await society();
    await imp(w, sheet([`${w.unit(1).label},900,,`, `${w.unit(2).label},,,250`]));
    await post(w, 90000 - 25000);
    const st = await w.c('get', `/billing/units/${w.unit(1).id}/statement`, undefined, {
      query: { from: '2026-10-01', to: '2026-11-30' },
    });
    expect(st.body.data.entries).toHaveLength(1);
    expect(st.body.data.entries[0]).toMatchObject({
      entryType: 'OPENING_BALANCE',
      entryDate: '2026-10-31',
      debitPaise: 90000,
      balancePaise: 90000,
      narration: `Arrears brought forward as of 2026-10-31 (OB/${w.unit(1).label})`,
    });
    const list = await w.c('get', '/residents/units');
    const dues = new Map(list.body.data.map((u: any) => [u.unitId, u.duesPaise]));
    expect(dues.get(w.unit(1).id)).toBe(90000);
    expect(dues.get(w.unit(2).id)).toBe(-25000);
    expect(dues.get(w.unit(3).id)).toBe(0);
    expect((await w.c('get', `/residents/units/${w.unit(1).id}`)).body.data.duesPaise).toBe(90000);
  });

  it('refuses when nothing is to post (409), posting twice posts nothing the second time', async () => {
    const w = await society();
    const none = await post(w, 0);
    expect([none.status, none.body.code]).toEqual([409, 'INVALID_STATE']);
    await imp(w, sheet([`${w.unit(1).label},100,,`]));
    expect((await post(w, 10000)).status).toBe(200);
    const again = await post(w, 10000);
    expect([again.status, again.body.code]).toEqual([409, 'INVALID_STATE']);
    expect(await Invoice.count({ where: { societyId: w.society.id! } })).toBe(1);
    expect(await UnitLedgerEntry.count({ where: { societyId: w.society.id! } })).toBe(1);
  });

  it('a failing row rolls back its whole batch: no invoice, ledger entry, journal or POSTED row', async () => {
    const w = await society();
    await imp(w, sheet([`${w.unit(1).label},100,,`, `${w.unit(2).label},200,,`, `${w.unit(3).label},300,,`]));
    await Unit.update({ status: 'ARCHIVED', archivedAt: new Date() }, { where: { id: w.unit(3).id } });
    const r = await post(w, 60000);
    expect([r.status, r.body.code]).toEqual([404, 'UNIT_NOT_FOUND']);
    expect(await rows(w, 'POSTED')).toHaveLength(0);
    expect(await Invoice.count({ where: { societyId: w.society.id! } })).toBe(0);
    expect(await UnitLedgerEntry.count({ where: { societyId: w.society.id! } })).toBe(0);
    // a repeat after the problem is fixed works (the rows are still DRAFT)
    await Unit.update({ status: 'ACTIVE', archivedAt: null }, { where: { id: w.unit(3).id } });
    expect((await post(w, 60000)).status).toBe(200);
  });

  it('refuses when the owner of an arrears flat is gone since the import: 422 NO_BILL_TO, nothing posted', async () => {
    const w = await society();
    await imp(w, sheet([`${w.unit(1).label},100,,`]));
    await UnitResident.destroy({ where: { unitId: w.unit(1).id } });
    const r = await post(w, 10000);
    expect([r.status, r.body.code]).toEqual([422, 'NO_BILL_TO']);
    expect(await rows(w, 'POSTED')).toHaveLength(0);
  });

  it('the books must be open for the as-of date (PERIOD_LOCKED)', async () => {
    const w = await society();
    await imp(w, sheet([`${w.unit(1).label},100,,`]));
    setBillingPorts({ journal: { isDateLocked: async () => true } });
    const r = await post(w, 10000);
    expect([r.status, r.body.code]).toEqual([422, 'PERIOD_LOCKED']);
    expect(await rows(w, 'POSTED')).toHaveLength(0);
  });

  it('posting needs a recent authentication (step-up): 401 REAUTH_REQUIRED after the window', async () => {
    const w = await society();
    await imp(w, sheet([`${w.unit(1).label},100,,`]));
    advance(10 * 60_000);
    const r = await post(w, 10000);
    expect([r.status, r.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    expect(await rows(w, 'POSTED')).toHaveLength(0);
  });

  it('validates the body (integer, strict) and needs an Idempotency-Key', async () => {
    const w = await society();
    for (const b of [
      {},
      { confirmTotalPaise: '100' },
      { confirmTotalPaise: 1.5 },
      { confirmTotalPaise: 1, x: 1 },
    ])
      expect((await w.c('post', `${BASE}/post`, b, { headers: key() })).status).toBe(400);
    expect((await w.c('post', `${BASE}/post`, { confirmTotalPaise: 1 }, { headers: {} })).status).toBe(400);
  });

  it('the net total can be negative when the advances exceed the arrears', async () => {
    const w = await society();
    await imp(w, sheet([`${w.unit(1).label},10,,`, `${w.unit(2).label},,,50`]));
    expect((await post(w, 1000 - 5000)).status).toBe(200);
  });
});

describe('opening balances: reverse (BR-11-66)', () => {
  const posted = async (w: W, text: string) => {
    await imp(w, text);
    const r = await post(w, 0);
    void r;
  };
  const postNet = async (w: W, text: string, net: number) => {
    await imp(w, text);
    expect((await post(w, net)).status).toBe(200);
    return (await rows(w, 'POSTED'))[0]!;
  };
  const reverse = (w: W, id: number, version: number, reason = 'Imported from the wrong sheet') =>
    w.c('post', `${BASE}/${id}/reverse`, { reason, version });
  void posted;

  it('cancels the untouched arrears invoice with a CANCELLATION credit note, an ADJUSTMENT credit and a reversing journal', async () => {
    const w = await society();
    const row = await postNet(w, sheet([`${w.unit(1).label},700,50,`]), 75000);
    const r = await reverse(w, row.id!, 2);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({ id: row.id, status: 'REVERSED', version: 3, unitId: w.unit(1).id });
    expect(r.body.data.reversedAt).toEqual(expect.any(String));
    const fresh = (await OpeningBalance.findByPk(row.id!))!;
    expect(fresh).toMatchObject({
      status: 'REVERSED',
      activeKey: null,
      reverseReason: 'Imported from the wrong sheet',
      reversedBy: w.user.id,
    });
    const inv = (await Invoice.findByPk(fresh.invoiceId!))!;
    expect(inv.status).toBe('CANCELLED');
    expect([inv.creditedPaise, inv.outstandingPaise, inv.totalPaise].map(Number)).toEqual([75000, 0, 75000]);
    expect(inv.cancelledAt).not.toBeNull();
    const note = (await BillingNote.findOne({ where: { invoiceId: inv.id! } }))!;
    expect(note).toMatchObject({
      noteType: 'CREDIT',
      reasonCode: 'CANCELLATION',
      status: 'ISSUED',
      noteNo: 'CN/2026-27/000001',
      approvalType: null,
    });
    expect(Number(note.totalPaise)).toBe(75000);
    const nl = await InvoiceLine.findAll({ where: { billingNoteId: note.id! }, order: [['lineNo', 'ASC']] });
    expect(nl.map(l => Number(l.amountPaise))).toEqual([70000, 5000]);
    expect(
      (await InvoiceLine.findAll({ where: { invoiceId: inv.id! } })).map(l => Number(l.creditedPaise)).sort(),
    ).toEqual([5000, 70000]);
    const entries = await UnitLedgerEntry.findAll({
      where: { unitId: w.unit(1).id },
      order: [['id', 'ASC']],
    });
    expect(entries.map(e => [e.entryType, e.refType, Number(e.debitPaise), Number(e.creditPaise)])).toEqual([
      ['OPENING_BALANCE', 'opening_balance', 75000, 0],
      ['ADJUSTMENT', 'opening_balance', 0, 75000],
    ]);
    expect(await unitLedger.balance(w.society.id!, w.unit(1).id)).toBe(0);
    const j = calls('journal.post')
      .map(c => c.input as any)
      .pop();
    expect(j.refType).toBe('opening_balance_reversal');
    expect(j.lines.map((l: any) => [l.accountCode, l.debitPaise, l.creditPaise])).toEqual([
      ['3900', 75000, 0],
      ['1300', 0, 75000],
    ]);
    expect(
      await AuditLog.count({
        where: { societyId: w.society.id!, action: 'billing.opening_balance.reversed' },
      }),
    ).toBe(1);
  });

  it('after a reversal the flat can be imported and posted again (new invoice number OB/<flat>/2)', async () => {
    const w = await society();
    const row = await postNet(w, sheet([`${w.unit(1).label},100,,`]), 10000);
    expect((await reverse(w, row.id!, 2)).status).toBe(200);
    await imp(w, sheet([`${w.unit(1).label},250,,`]));
    expect((await post(w, 25000)).status).toBe(200);
    const nos = (await Invoice.findAll({ where: { societyId: w.society.id! }, order: [['id', 'ASC']] })).map(
      i => i.invoiceNo,
    );
    expect(nos).toEqual([`OB/${w.unit(1).label}`, `OB/${w.unit(1).label}/2`]);
    expect(await unitLedger.balance(w.society.id!, w.unit(1).id)).toBe(25000);
  });

  it('is 422 OPENING_BALANCE_HAS_PAYMENTS once the invoice has a payment, a credit or a debit note', async () => {
    const w = await society();
    for (const patch of [
      { paidPaise: 1000, outstandingPaise: 9000, status: 'PARTIALLY_PAID' },
      { creditedPaise: 1000, outstandingPaise: 9000 },
      { debitedPaise: 500, outstandingPaise: 10500 },
    ]) {
      const row = await postNet(w, sheet([`${w.unit(1).label},100,,`]), 10000);
      await Invoice.update(patch as never, { where: { id: row.invoiceId! } });
      const r = await reverse(w, row.id!, 2);
      expect([r.status, r.body.code], JSON.stringify(patch)).toEqual([422, 'OPENING_BALANCE_HAS_PAYMENTS']);
      expect((await OpeningBalance.findByPk(row.id!))!.status).toBe('POSTED');
      await Invoice.update(
        {
          paidPaise: 0,
          creditedPaise: 0,
          debitedPaise: 0,
          outstandingPaise: 10000,
          status: 'ISSUED',
        } as never,
        { where: { id: row.invoiceId! } },
      );
      expect((await reverse(w, row.id!, 2)).status).toBe(200);
    }
  });

  it('an opening advance is 422 OPENING_ADVANCE_NOT_REVERSIBLE', async () => {
    const w = await society();
    const row = await postNet(w, sheet([`${w.unit(1).label},,,100`]), -10000);
    const r = await reverse(w, row.id!, 2);
    expect([r.status, r.body.code]).toEqual([422, 'OPENING_ADVANCE_NOT_REVERSIBLE']);
    expect(await unitLedger.balance(w.society.id!, w.unit(1).id)).toBe(-10000);
  });

  it('a DRAFT, INVALID or already reversed row is 409 INVALID_STATE; a stale version is 409 STALE_VERSION', async () => {
    const w = await society();
    await imp(w, sheet([`${w.unit(1).label},100,,`, 'Z-1,5,,']));
    const [draft, bad] = await rows(w);
    for (const id of [draft!.id!, bad!.id!]) {
      const r = await reverse(w, id, 1);
      expect([r.status, r.body.code]).toEqual([409, 'INVALID_STATE']);
    }
    expect((await post(w, 0)).status).toBe(422); // invalid row still there
    await w.c('delete', `${BASE}/${bad!.id}`, { version: 1 });
    expect((await post(w, 10000)).status).toBe(200);
    const stale = await reverse(w, draft!.id!, 1);
    expect([stale.status, stale.body.code]).toEqual([409, 'STALE_VERSION']);
    expect((await reverse(w, draft!.id!, 2)).status).toBe(200);
    const twice = await reverse(w, draft!.id!, 3);
    expect([twice.status, twice.body.code]).toEqual([409, 'INVALID_STATE']);
  });

  it('validates the reason (10 to 500 characters) and the version, and needs step-up', async () => {
    const w = await society();
    const row = await postNet(w, sheet([`${w.unit(1).label},100,,`]), 10000);
    for (const b of [
      { reason: 'short', version: 2 },
      { reason: 'x'.repeat(501), version: 2 },
      { reason: 'Imported from the wrong sheet' },
      { reason: 'Imported from the wrong sheet', version: 0 },
      { reason: 'Imported from the wrong sheet', version: 2, extra: true },
    ])
      expect((await w.c('post', `${BASE}/${row.id}/reverse`, b)).status, JSON.stringify(b)).toBe(400);
    expect(
      (await w.c('post', `${BASE}/abc/reverse`, { reason: 'Imported from the wrong sheet', version: 2 }))
        .status,
    ).toBe(400);
    advance(10 * 60_000);
    const r = await reverse(w, row.id!, 2);
    expect([r.status, r.body.code]).toEqual([401, 'REAUTH_REQUIRED']);
    expect((await OpeningBalance.findByPk(row.id!))!.status).toBe('POSTED');
  });

  it('refuses while a cancellation request is open on the arrears invoice', async () => {
    const w = await society();
    const row = await postNet(w, sheet([`${w.unit(1).label},100,,`]), 10000);
    setBillingPorts({ approvals: { lockOpenForEntity: async () => ({ id: 1, type: 'INVOICE_CANCEL' }) } });
    const r = await reverse(w, row.id!, 2);
    expect([r.status, r.body.code]).toEqual([409, 'INVOICE_CANCEL_PENDING']);
  });
});

describe('opening balances: permissions and isolation (T11-42, T11-40)', () => {
  it('only finance.billing.import may import, post, reverse and delete; view roles may list', async () => {
    const w = await society();
    await imp(w, sheet([`${w.unit(1).label},100,,`]));
    const [row] = await rows(w);
    const fileId = upload(w, sheet([`${w.unit(2).label},5,,`]));
    for (const role of ['secretary', 'auditor', 'facility_manager']) {
      const g = await adminOf(w.society, role);
      const sends: [string, string, unknown][] = [
        ['post', `${BASE}/import`, { fileId, asOfDate: '2026-10-31' }],
        ['post', `${BASE}/post`, { confirmTotalPaise: 10000 }],
        ['post', `${BASE}/${row!.id}/reverse`, { reason: 'Imported from the wrong sheet', version: 2 }],
        ['delete', `${BASE}/${row!.id}`, { version: 1 }],
      ];
      for (const [m, p, b] of sends) {
        const r = await g.c(m as 'post', p, b, { headers: key() });
        expect([r.status, r.body.code], `${role} ${m} ${p}`).toEqual([403, 'PERMISSION_DENIED']);
      }
      expect((await g.c('get', BASE)).status).toBe(role === 'facility_manager' ? 403 : 200);
    }
    expect(await rows(w, 'DRAFT')).toHaveLength(1);
    const acct = await adminOf(w.society, 'accountant');
    expect(
      (await acct.c('post', `${BASE}/import`, { fileId, asOfDate: '2026-10-31' }, { headers: key() })).status,
    ).toBe(404); // the file belongs to the chairman, not to the accountant
    const mine = putPlaceholderFile({
      societyId: w.society.id!,
      ownerUserId: acct.user.id!,
      name: 'a.csv',
      content: Buffer.from(sheet([`${w.unit(2).label},5,,`])),
    });
    expect(
      (await acct.c('post', `${BASE}/import`, { fileId: mine, asOfDate: '2026-10-31' }, { headers: key() }))
        .status,
    ).toBe(200);
  });

  it('needs a session', async () => {
    const r = await request(app).get(`/api/v1${BASE}`);
    expect(r.status).toBe(401);
  });
});

describe('demo seed (seeders/billing-opening.ts)', () => {
  it('seeds posted, draft and invalid opening balances for Sky Heights once, and leaves a seeded society alone', async () => {
    const w = await ledgerSociety({ flats: 6 });
    await w.society.update({ slug: 'sky-heights' });
    const names = ['Asha Mehta', 'Bina Shah', 'Chetan Rao', 'Divya Nair', 'Esha Gupta', 'Farid Khan'];
    for (let i = 1; i <= 6; i++)
      await addResident(w.c, { name: names[i - 1], mobile: mobile(), link: owner(w.unit(i).id) });
    const first = await seedBillingOpening();
    expect(first.created).toHaveLength(2);
    expect(await rows(w, 'POSTED')).toHaveLength(4);
    expect(await rows(w, 'DRAFT')).toHaveLength(2);
    expect(await rows(w, 'INVALID')).toHaveLength(1);
    expect((await rows(w, 'POSTED')).every(r => r.asOfDate === '2026-03-31')).toBe(true);
    expect(await Invoice.count({ where: { societyId: w.society.id!, invoiceType: 'OPENING' } })).toBe(3);
    expect(await unitLedger.balance(w.society.id!, w.unit(1).id)).toBe(1_250_000);
    expect(await unitLedger.balance(w.society.id!, w.unit(4).id)).toBe(-300_000);
    const again = await seedBillingOpening();
    expect(again).toEqual({ created: [], skipped: ['sky-heights'] });
    expect(await OpeningBalance.count({ where: { societyId: w.society.id! } })).toBe(7);
    // the screens read it: the list totals and the unposted import can still be posted
    const list = await w.c('get', BASE);
    expect(list.body.data.totals).toMatchObject({ postedCount: 4, invalidCount: 1 });
  });
});
