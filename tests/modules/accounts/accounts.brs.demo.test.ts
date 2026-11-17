import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BankStatementLine, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { sampleStatementCsv } from '../../../src/modules/accounts/accounts.statements.sample';
import {
  bookIn,
  bookOpening,
  bookOut,
  idemH,
  importFile,
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
});

const brs = async () => (await w.c('get', `/accounts/bank-accounts/${w.bankId}/brs`)).body.data;
const post = (path: string, body: Record<string, unknown>) => w.c('post', path, body, { headers: idemH() });

describe('demo statement and the BRS (module 13 demo data)', () => {
  it('the statement starts before the earliest bank posting: +Rs 1,018.40 before the two entries, 0 after', async () => {
    await bookOpening(w, 11_020_000, '2026-04-01');
    // postings far older than 60 days and a mix of in and out, as in the demo data
    for (let i = 0; i < 12; i++) await bookIn(w, '2026-09-03', 850_000, { instrumentRef: `UPIDEMOREF${i}` });
    await bookOut(w, '2026-10-11', 3_845_000, { instrumentRef: 'UTR202610110457' });
    await bookIn(w, '2026-11-05', 500_000);
    const { csv, lines } = await sampleStatementCsv(w.bankId);
    expect(lines).toBe(16);
    const { id, r } = await importFile(w, csv, 'demo.csv');
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    const stmt = (await w.c('get', `/accounts/bank-statements/${id}`)).body.data;
    expect(stmt.periodFrom).toBe('2026-09-03');
    expect(stmt.openingBalancePaise).toBe(11_020_000);
    // pass 1 and 2 match the 14 postings; two lines stay unmatched
    const unmatched = await BankStatementLine.findAll({ where: { importId: id, matchStatus: 'UNMATCHED' } });
    expect(unmatched).toHaveLength(2);
    const before = await brs();
    expect(before).toMatchObject({
      unclearedDebitsPaise: 0,
      unclearedCreditsPaise: 0,
      unmatchedStatementCreditsPaise: 104_200,
      unmatchedStatementDebitsPaise: 2_360,
      differencePaise: 0,
    });
    expect(before.statementBalancePaise - before.bookBalancePaise).toBe(101_840); // +Rs 1,018.40 explained by the two lines
    for (const l of unmatched) {
      const credit = Number(l.creditPaise) > 0;
      const res = await post(`/accounts/bank-statement-lines/${l.id}/create-entry`, {
        ledgerAccountCode: credit ? '4300' : '5600',
        version: l.version,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
    }
    const after = await brs();
    expect(after).toMatchObject({
      unclearedDebitsPaise: 0,
      unmatchedStatementCreditsPaise: 0,
      unmatchedStatementDebitsPaise: 0,
      differencePaise: 0,
      items: [],
    });
    expect(after.bookBalancePaise).toBe(after.statementBalancePaise);
  });

  it('a book entry dated before the statement period start is in its opening balance, not an uncleared item', async () => {
    await bookOpening(w, 10_000_000);
    await bookIn(w, '2026-10-01', 700_000); // in the statement opening of 1,07,00.00
    const { id } = await importFile(
      w,
      Buffer.from(
        'Date,Description,Reference,Debit,Credit,Balance\n05-11-2026,Cash deposit,,,1000.00,108000.00\n',
      ),
    );
    expect(id).toBeGreaterThan(0);
    // the statement's opening is 1,07,000.00 (first balance minus its credit): the 7,000 of 1 Oct is in it
    const b = await brs();
    expect(b.unclearedDebitsPaise).toBe(0);
    expect(b.items.filter((i: { kind: string }) => i.kind === 'BOOK_UNCLEARED_IN')).toEqual([]);
    expect(b.unmatchedStatementCreditsPaise).toBe(100_000);
  });
});
