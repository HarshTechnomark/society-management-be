import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, BankAccount, BankStatementLine, JournalEntry, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import request from 'supertest';
import { app, events } from '../../helpers/auth';
import { setRealtimeSink } from '../../../src/lib/realtime';
import { setSetting } from '../../helpers/billing-runs';
import {
  bookIn,
  bookOut,
  csv,
  idemH,
  importFile,
  lineIdOf,
  lineOnCode,
  standardBooks,
  standardStatement,
  statementWorld,
  type StatementWorld,
} from '../../helpers/accounts-statements';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
let w: StatementWorld;
beforeEach(async () => {
  w = await statementWorld();
  events.length = 0;
  setRealtimeSink({ emit: e => events.push(e), disconnectSession: () => undefined });
});

const lineOf = async (importId: number, lineNo: number) =>
  (await BankStatementLine.findOne({ where: { importId, lineNo } }))!;
const post = (path: string, body: Record<string, unknown> = {}) =>
  w.c('post', path, body, { headers: idemH() });
const stmt = async (id: number) => (await w.c('get', `/accounts/bank-statements/${id}`)).body.data;

describe('auto-match (BR-13-41, T13-22)', () => {
  it('pass 1 by UTR and cheque number gives 100, pass 2 by amount and date gives 80, the bank charge stays unmatched', async () => {
    const b = await standardBooks(w);
    const { id } = await importFile(w, standardStatement());
    const utr = await lineOf(id, 2);
    expect(utr).toMatchObject({
      matchStatus: 'MATCHED',
      matchMethod: 'AUTO_REFERENCE',
      matchConfidence: 100,
    });
    expect(Number(utr.matchedJournalLineId)).toBe(await lineIdOf(b.utr, w.ledgerId));
    expect(await lineOf(id, 3)).toMatchObject({ matchMethod: 'AUTO_AMOUNT_DATE', matchConfidence: 80 });
    expect(await lineOf(id, 4)).toMatchObject({ matchMethod: 'AUTO_REFERENCE', matchConfidence: 100 }); // cheque number
    expect(await lineOf(id, 5)).toMatchObject({ matchStatus: 'UNMATCHED' });
    expect((await stmt(id)).matchedCount).toBe(3);
    expect(await AuditLog.count({ where: { action: 'accounts.statement.auto_matched' } })).toBe(1);
    expect(events.some(e => e.event === 'statement.updated')).toBe(true);
  });

  it('create-entry 5600 posts a PAYMENT through the engine (refType statement_line) and matches the charge', async () => {
    await standardBooks(w);
    const { id } = await importFile(w, standardStatement());
    const line = await lineOf(id, 5);
    const r = await post(`/accounts/bank-statement-lines/${line.id}/create-entry`, {
      ledgerAccountCode: '5600',
      version: line.version,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data.line).toMatchObject({ matchStatus: 'MATCHED', matchMethod: 'CREATED_ENTRY' });
    const entry = (await JournalEntry.findByPk(r.body.data.entry.id))!;
    expect(entry).toMatchObject({
      voucherType: 'PAYMENT',
      refType: 'statement_line',
      refId: String(line.id),
      entryDate: '2026-11-13',
      status: 'POSTED',
    });
    expect(Number(entry.totalPaise)).toBe(2360);
    expect((await stmt(id)).matchedCount).toBe(4);
    expect(await AuditLog.count({ where: { action: 'accounts.statement_line.entry_created' } })).toBe(1);
  });

  it('a credit line creates a RECEIPT and a bank-to-bank line a CONTRA; bank and fund ledgers and groups are refused', async () => {
    const { id } = await importFile(
      w,
      csv('10-11-2026,Interest,,,150.00,150.00', '11-11-2026,Transfer,,300.00,,0.00'),
    );
    const credit = await lineOf(id, 2);
    const ok = await post(`/accounts/bank-statement-lines/${credit.id}/create-entry`, {
      ledgerAccountCode: '4300',
      version: credit.version,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect((await JournalEntry.findByPk(ok.body.data.entry.id))!.voucherType).toBe('RECEIPT');
    const debit = await lineOf(id, 3);
    const self = await post(`/accounts/bank-statement-lines/${debit.id}/create-entry`, {
      ledgerAccountCode: '1110-001',
      version: debit.version,
    });
    expect(self.status).toBe(422);
    const group = await post(`/accounts/bank-statement-lines/${debit.id}/create-entry`, {
      ledgerAccountCode: '1110',
      version: debit.version,
    });
    expect(group.status).toBe(422);
    const cash = await post(`/accounts/bank-statement-lines/${debit.id}/create-entry`, {
      ledgerAccountCode: '1120',
      version: debit.version,
    });
    expect(cash.status, JSON.stringify(cash.body)).toBe(201);
    expect((await JournalEntry.findByPk(cash.body.data.entry.id))!.voucherType).toBe('CONTRA');
  });

  it('create-entry into a locked period is 409 PERIOD_LOCKED and leaves the line unmatched', async () => {
    const { id } = await importFile(w, csv('10-11-2026,Interest,,,150.00,150.00'));
    await JournalEntry.sequelize!.query(
      'UPDATE society_balances SET booksLockedThrough = ? WHERE societyId = ?',
      { replacements: ['2026-11-30', w.societyId] },
    );
    const l = await lineOf(id, 2);
    const r = await post(`/accounts/bank-statement-lines/${l.id}/create-entry`, {
      ledgerAccountCode: '4300',
      version: l.version,
    });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PERIOD_LOCKED');
    expect((await lineOf(id, 2)).matchStatus).toBe('UNMATCHED');
  });

  it('pass 2 never runs above ₹5,00,000 and skips ambiguous amounts; the window setting moves the date limit', async () => {
    await bookIn(w, '2026-11-10', 60_000_000); // ₹6,00,000
    await bookIn(w, '2026-11-11', 250_000);
    await bookIn(w, '2026-11-11', 250_000); // two equal candidates: ambiguous
    await bookIn(w, '2026-11-12', 70_000); // 4 days from the statement date 16-11
    const { id } = await importFile(
      w,
      csv(
        '10-11-2026,Big deposit,,,600000.00,0.00',
        '11-11-2026,Deposit,,,2500.00,0.00',
        '16-11-2026,Deposit,,,700.00,0.00',
      ),
    );
    expect((await lineOf(id, 2)).matchStatus).toBe('UNMATCHED');
    expect((await lineOf(id, 3)).matchStatus).toBe('UNMATCHED');
    expect((await lineOf(id, 4)).matchStatus).toBe('UNMATCHED'); // 4 days apart, window 3
    await setSetting(w.societyId, 'finance.autoMatchWindowDays', 5);
    const r = await post(`/accounts/bank-statements/${id}/auto-match`);
    expect(r.status).toBe(202);
    await drainQueues();
    expect((await lineOf(id, 4)).matchStatus).toBe('MATCHED');
    expect((await lineOf(id, 2)).matchStatus).toBe('UNMATCHED');
  });

  it('re-running auto-match is safe and does not touch matched lines; a debit never matches a ledger debit', async () => {
    await bookIn(w, '2026-11-10', 100_000); // money in on the books
    const { id } = await importFile(w, csv('10-11-2026,Paid out,,1000.00,,0.00')); // a statement debit of the same amount
    expect((await lineOf(id, 2)).matchStatus).toBe('UNMATCHED');
    await bookOut(w, '2026-11-10', 100_000);
    await post(`/accounts/bank-statements/${id}/auto-match`);
    await drainQueues();
    const first = await lineOf(id, 2);
    expect(first.matchStatus).toBe('MATCHED');
    await post(`/accounts/bank-statements/${id}/auto-match`);
    await drainQueues();
    expect(Number((await lineOf(id, 2)).version)).toBe(Number(first.version));
  });

  it('auto-match on a statement that is not PARSED is 409 INVALID_STATE', async () => {
    const { id } = await importFile(w, csv('not-a-date,x,,1.00,,'));
    const r = await post(`/accounts/bank-statements/${id}/auto-match`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('INVALID_STATE');
  });
});

describe('candidates and manual match (BR-13-42, T13-24)', () => {
  it('lists equal amounts first, then within 10% and 15 days, with a score', async () => {
    const exact = await bookIn(w, '2026-11-10', 100_000);
    const near = await bookIn(w, '2026-11-12', 105_000);
    await bookIn(w, '2026-11-12', 150_000); // outside 10%
    await bookOut(w, '2026-11-10', 100_000); // wrong direction
    const { id } = await importFile(w, csv('11-11-2026,Deposit,,,1000.00,0.00'));
    const l = await lineOf(id, 2);
    // two candidates: the exact one is not auto-matched only when ambiguous, so unmatch if it was matched
    if (l.matchStatus === 'MATCHED')
      await post(`/accounts/bank-statement-lines/${l.id}/unmatch`, { version: l.version });
    const r = await w.c('get', `/accounts/bank-statement-lines/${l.id}/candidates`);
    expect(r.status).toBe(200);
    expect(r.body.data.map((c: any) => c.journalEntryId)).toEqual([exact, near]);
    expect(r.body.data[0]).toMatchObject({ exactAmount: true, amountPaise: 100_000 });
    expect(r.body.data[0].score).toBeGreaterThan(r.body.data[1].score);
  });

  it('manual match: amount mismatch 422, another bank ledger 422, journal line already used 409, then success', async () => {
    const a = await bookIn(w, '2026-11-01', 100_000);
    const b = await bookIn(w, '2026-11-02', 100_000);
    const c = await bookIn(w, '2026-11-03', 777_00);
    const { id } = await importFile(w, csv('20-11-2026,One,,,1000.00,0.00', '21-11-2026,Two,,,1000.00,0.00'));
    const l1 = await lineOf(id, 2);
    const l2 = await lineOf(id, 3);
    const jl = (e: number) => lineIdOf(e, w.ledgerId);
    const bad = await post(`/accounts/bank-statement-lines/${l1.id}/match`, {
      journalLineId: await jl(c),
      version: l1.version,
    });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('MATCH_AMOUNT_MISMATCH');
    const other = await post(`/accounts/bank-statement-lines/${l1.id}/match`, {
      journalLineId: await lineOnCode(a, w.societyId, '1300'),
      version: l1.version,
    });
    expect(other.status).toBe(422);
    expect(other.body.code).toBe('MATCH_WRONG_ACCOUNT');
    const ok = await post(`/accounts/bank-statement-lines/${l1.id}/match`, {
      journalLineId: await jl(a),
      version: l1.version,
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body.data).toMatchObject({
      matchStatus: 'MATCHED',
      matchMethod: 'MANUAL',
      matchedJournalLineId: await jl(a),
    });
    const used = await post(`/accounts/bank-statement-lines/${l2.id}/match`, {
      journalLineId: await jl(a),
      version: l2.version,
    });
    expect(used.status).toBe(409);
    expect(used.body.code).toBe('JOURNAL_LINE_ALREADY_MATCHED');
    const again = await post(`/accounts/bank-statement-lines/${l1.id}/match`, {
      journalLineId: await jl(b),
      version: ok.body.data.version,
    });
    expect(again.body.code).toBe('LINE_ALREADY_MATCHED');
    const stale = await post(`/accounts/bank-statement-lines/${l2.id}/match`, {
      journalLineId: await jl(b),
      version: 99,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('STALE_VERSION');
  });

  it('a statement credit cannot match a ledger credit (same direction)', async () => {
    const out = await bookOut(w, '2026-11-10', 100_000);
    const { id } = await importFile(w, csv('10-11-2026,Deposit,,,1000.00,0.00'));
    const l = await lineOf(id, 2);
    const r = await post(`/accounts/bank-statement-lines/${l.id}/match`, {
      journalLineId: await lineIdOf(out, w.ledgerId),
      version: l.version,
    });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe('MATCH_WRONG_ACCOUNT');
  });

  it('ignore needs a 5 to 200 character reason; unmatch undoes a match and an ignore', async () => {
    const { id } = await importFile(w, csv('10-11-2026,Odd,,,10.00,0.00', '11-11-2026,Odd2,,,11.00,0.00'));
    const l = await lineOf(id, 2);
    expect(
      (await post(`/accounts/bank-statement-lines/${l.id}/ignore`, { reason: 'no', version: l.version }))
        .status,
    ).toBe(400);
    const ig = await post(`/accounts/bank-statement-lines/${l.id}/ignore`, {
      reason: 'Personal refund, not society money',
      version: l.version,
    });
    expect(ig.body.data).toMatchObject({
      matchStatus: 'IGNORED',
      ignoredReason: 'Personal refund, not society money',
    });
    expect((await stmt(id)).matchedCount).toBe(1);
    const again = await post(`/accounts/bank-statement-lines/${l.id}/ignore`, {
      reason: 'Personal refund, not society money',
      version: ig.body.data.version,
    });
    expect(again.body.code).toBe('LINE_ALREADY_MATCHED');
    const un = await post(`/accounts/bank-statement-lines/${l.id}/unmatch`, {
      version: ig.body.data.version,
    });
    expect(un.body.data).toMatchObject({ matchStatus: 'UNMATCHED', ignoredReason: null });
    expect((await stmt(id)).matchedCount).toBe(0);
    const nothing = await post(`/accounts/bank-statement-lines/${l.id}/unmatch`, {
      version: un.body.data.version,
    });
    expect(nothing.body.code).toBe('INVALID_STATE');
    expect(await AuditLog.count({ where: { action: 'accounts.statement_line.ignored' } })).toBe(1);
    expect(await AuditLog.count({ where: { action: 'accounts.statement_line.unmatched' } })).toBe(1);
  });
});

describe('mark reconciled and the BRS (BR-13-43, T13-25, T13-43)', () => {
  it('refuses with unmatched lines; after ignoring them it reconciles and sets the bank account; BRS difference is 0', async () => {
    await standardBooks(w);
    const { id } = await importFile(w, standardStatement());
    const open = await w.c('post', `/accounts/bank-statements/${id}/mark-reconciled`, {
      version: (await stmt(id)).version,
    });
    expect(open.status).toBe(422);
    expect(open.body.code).toBe('RECONCILIATION_INCOMPLETE');
    // the bank charge: before it is handled the BRS shows the difference explained by the unmatched statement debit
    const before = await w.c('get', `/accounts/bank-accounts/${w.bankId}/brs`);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.data).toMatchObject({
      bookBalancePaise: 10_850_000,
      unclearedDebitsPaise: 0,
      unmatchedStatementDebitsPaise: 2360,
      computedBankBalancePaise: 10_847_640,
      statementBalancePaise: 10_847_640,
      differencePaise: 0,
    });
    const charge = await lineOf(id, 5);
    await post(`/accounts/bank-statement-lines/${charge.id}/create-entry`, {
      ledgerAccountCode: '5600',
      version: charge.version,
    });
    const done = await w.c('post', `/accounts/bank-statements/${id}/mark-reconciled`, {
      version: (await stmt(id)).version,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.data.status).toBe('RECONCILED');
    const bank = (await BankAccount.findByPk(w.bankId))!;
    expect(bank.lastReconciledDate).toBe('2026-11-13');
    expect(Number(bank.lastReconciledBalancePaise)).toBe(10_847_640);
    const brs = await w.c('get', `/accounts/bank-accounts/${w.bankId}/brs`);
    expect(brs.body.data).toMatchObject({
      differencePaise: 0,
      unmatchedStatementDebitsPaise: 0,
      unclearedDebitsPaise: 0,
      unclearedCreditsPaise: 0,
      items: [],
    });
    expect(await AuditLog.count({ where: { action: 'accounts.statement.reconciled' } })).toBe(1);
  });

  it('ignored lines count in the BRS; matches cannot be undone after RECONCILED; bank dates only move in the mark route', async () => {
    const { id } = await importFile(w, csv('10-11-2026,Odd,,,10.00,10.00'));
    expect((await BankAccount.findByPk(w.bankId))!.lastReconciledDate).toBeNull();
    const l = await lineOf(id, 2);
    const ig = await post(`/accounts/bank-statement-lines/${l.id}/ignore`, {
      reason: 'Not the society money',
      version: l.version,
    });
    const brs = await w.c('get', `/accounts/bank-accounts/${w.bankId}/brs`);
    expect(brs.body.data.unmatchedStatementCreditsPaise).toBe(1000);
    expect(brs.body.data.items[0]).toMatchObject({
      kind: 'STATEMENT_UNMATCHED_CREDIT',
      matchStatus: 'IGNORED',
    });
    await w.c('post', `/accounts/bank-statements/${id}/mark-reconciled`, {
      version: (await stmt(id)).version,
    });
    const un = await post(`/accounts/bank-statement-lines/${l.id}/unmatch`, {
      version: ig.body.data.version,
    });
    expect(un.status).toBe(409);
    expect(un.body.code).toBe('INVALID_STATE');
    const again = await w.c('post', `/accounts/bank-statements/${id}/mark-reconciled`, { version: 99 });
    expect(again.body.code).toBe('STALE_VERSION');
  });

  it('BRS lists uncleared book items and rejects a future asOf; no statement means a null difference', async () => {
    await bookIn(w, '2026-11-10', 50_000);
    await bookOut(w, '2026-11-11', 20_000);
    const r = await w.c('get', `/accounts/bank-accounts/${w.bankId}/brs`);
    expect(r.body.data).toMatchObject({
      bookBalancePaise: 30_000,
      unclearedDebitsPaise: 50_000,
      unclearedCreditsPaise: 20_000,
      computedBankBalancePaise: 0,
      statementBalancePaise: null,
      differencePaise: null,
    });
    expect(r.body.data.items.map((i: any) => i.kind)).toEqual(['BOOK_UNCLEARED_IN', 'BOOK_UNCLEARED_OUT']);
    const asOf = await w.c('get', `/accounts/bank-accounts/${w.bankId}/brs`, undefined, {
      query: { asOf: '2026-11-10' },
    });
    expect(asOf.body.data.bookBalancePaise).toBe(50_000);
    const future = await w.c('get', `/accounts/bank-accounts/${w.bankId}/brs`, undefined, {
      query: { asOf: '2026-12-31' },
    });
    expect(future.status).toBe(400);
    expect((await w.c('get', '/accounts/bank-accounts/999999/brs')).body.code).toBe('BANK_ACCOUNT_NOT_FOUND');
  });
});

describe('plan gating and isolation (2.2, T13-35)', () => {
  it('Starter may import and match but gets 402 FEATURE_NOT_IN_PLAN on the BRS and mark-reconciled', async () => {
    const s = await statementWorld('STARTER');
    const imp = await importFile(s, csv('10-11-2026,Odd,,,10.00,10.00'));
    expect(imp.r.status, JSON.stringify(imp.r.body)).toBe(202);
    const brs = await s.c('get', `/accounts/bank-accounts/${s.bankId}/brs`);
    expect(brs.status).toBe(402);
    expect(brs.body.code).toBe('FEATURE_NOT_IN_PLAN');
    const mark = await s.c('post', `/accounts/bank-statements/${imp.id}/mark-reconciled`, { version: 2 });
    expect(mark.status).toBe(402);
  });

  it("another society's statement, line, candidates and BRS are 404 with the module codes", async () => {
    const other = await statementWorld('PREMIUM', false);
    const mine = await importFile(other, csv('10-11-2026,Odd,,,10.00,10.00'));
    const line = await lineOf(mine.id, 2);
    const me = w;
    const get = (p: string, m: 'get' | 'post' = 'get', b?: Record<string, unknown>) =>
      me.c(m, p, b, m === 'post' ? { headers: idemH() } : undefined);
    expect((await get(`/accounts/bank-statements/${mine.id}`)).body.code).toBe('STATEMENT_NOT_FOUND');
    expect((await get(`/accounts/bank-statements/${mine.id}/lines`)).body.code).toBe('STATEMENT_NOT_FOUND');
    expect((await get(`/accounts/bank-statement-lines/${line.id}/candidates`)).body.code).toBe(
      'STATEMENT_LINE_NOT_FOUND',
    );
    expect(
      (
        await get(`/accounts/bank-statement-lines/${line.id}/ignore`, 'post', {
          reason: 'not mine at all',
          version: 1,
        })
      ).body.code,
    ).toBe('STATEMENT_LINE_NOT_FOUND');
    expect((await get(`/accounts/bank-statements/${mine.id}/auto-match`, 'post')).body.code).toBe(
      'STATEMENT_NOT_FOUND',
    );
    expect(
      (await get(`/accounts/bank-statements/${mine.id}/mark-reconciled`, 'post', { version: 2 })).body.code,
    ).toBe('STATEMENT_NOT_FOUND');
    expect(
      (await get(`/accounts/bank-statement-lines/${line.id}/unmatch`, 'post', { version: 1 })).body.code,
    ).toBe('STATEMENT_LINE_NOT_FOUND');
    expect(
      (await get(`/accounts/bank-statement-lines/${line.id}/match`, 'post', { journalLineId: 1, version: 1 }))
        .body.code,
    ).toBe('STATEMENT_LINE_NOT_FOUND');
    expect(
      (
        await get(`/accounts/bank-statement-lines/${line.id}/create-entry`, 'post', {
          ledgerAccountCode: '5600',
          version: 1,
        })
      ).body.code,
    ).toBe('STATEMENT_LINE_NOT_FOUND');
    expect((await get(`/accounts/bank-accounts/${other.bankId}/brs`)).body.code).toBe(
      'BANK_ACCOUNT_NOT_FOUND',
    );
  });
});

describe('dev sample statement', () => {
  it('lists identical amounts once, so the sample auto-matches, one manual match, the charge entry and the BRS reconcile to 0', async () => {
    await bookIn(w, '2026-11-10', 1_000_000, { instrumentRef: 'UTR5550001112' });
    for (let i = 0; i < 4; i++) await bookIn(w, '2026-11-11', 250_000);
    await bookIn(w, '2026-11-12', 77_700);
    const res = await request(app)
      .get('/api/v1/dev/accounts/sample-statement')
      .query({ bankAccountId: w.bankId });
    const { id } = await importFile(w, Buffer.from(res.text.replace(/^\uFEFF/, ''), 'utf8'));
    // utr + one of the four identical + the unique amount + the bank charge
    expect(await stmt(id)).toMatchObject({ status: 'PARSED', lineCount: 4, matchedCount: 2 });
    const identical = (await BankStatementLine.findOne({
      where: { importId: id, matchStatus: 'UNMATCHED', creditPaise: 250_000 },
    }))!;
    const cands = await w.c('get', `/accounts/bank-statement-lines/${identical.id}/candidates`);
    expect(cands.body.data).toHaveLength(4);
    const m = await post(`/accounts/bank-statement-lines/${identical.id}/match`, {
      journalLineId: cands.body.data[0].journalLineId,
      version: identical.version,
    });
    expect(m.status, JSON.stringify(m.body)).toBe(200);
    const charge = (await BankStatementLine.findOne({ where: { importId: id, matchStatus: 'UNMATCHED' } }))!;
    expect(
      (
        await post(`/accounts/bank-statement-lines/${charge.id}/create-entry`, {
          ledgerAccountCode: '5600',
          version: charge.version,
        })
      ).status,
    ).toBe(201);
    const fresh = await stmt(id);
    const rec = await post(`/accounts/bank-statements/${id}/mark-reconciled`, { version: fresh.version });
    expect(rec.status, JSON.stringify(rec.body)).toBe(200);
    const brs = (await w.c('get', `/accounts/bank-accounts/${w.bankId}/brs`)).body.data;
    expect(brs.differencePaise).toBe(0);
    expect(brs.unclearedDebitsPaise).toBe(750_000);
  });

  it('builds a CSV from the recent postings that imports and auto-matches, plus one unmatched bank charge', async () => {
    await bookIn(w, '2026-11-10', 1_000_000, { instrumentRef: 'UTR5550001112' });
    await bookIn(w, '2026-11-11', 250_000);
    const res = await request(app)
      .get('/api/v1/dev/accounts/sample-statement')
      .query({ bankAccountId: w.bankId });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    const { id } = await importFile(w, Buffer.from(res.text.replace(/^\uFEFF/, ''), 'utf8'));
    const s = await stmt(id);
    expect(s).toMatchObject({ status: 'PARSED', lineCount: 3, matchedCount: 2 });
    expect((await request(app).get('/api/v1/dev/accounts/sample-statement')).status).toBe(400);
    expect(
      (await request(app).get('/api/v1/dev/accounts/sample-statement').query({ bankAccountId: 999999 }))
        .status,
    ).toBe(404);
  });
});
