import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, BankStatementImport, BankStatementLine, closeDb } from '../../../src/models';
import { accountsPortCalls } from '../../../src/modules/accounts/accounts.ports';
import {
  extractCheque,
  extractReference,
  parseStatementAmount,
  parseStatementDate,
  parseStatementFile,
} from '../../../src/modules/accounts/accounts.statements.parse';
import { drainQueues } from '../../../src/lib/queue';
import {
  csv,
  idemH,
  importFile,
  putFile,
  standardStatement,
  statementWorld,
  xlsx,
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

describe('statement parser (8.16)', () => {
  it('reads the four date formats and converts amounts to paise exactly', () => {
    expect(parseStatementDate('05/11/2026')).toBe('2026-11-05');
    expect(parseStatementDate('05-11-2026')).toBe('2026-11-05');
    expect(parseStatementDate('05-Nov-2026')).toBe('2026-11-05');
    expect(parseStatementDate('2026-11-05')).toBe('2026-11-05');
    expect(parseStatementDate('31/02/2026')).toBeNull();
    expect(parseStatementAmount('1,23,456.70')).toBe(12_345_670);
    expect(parseStatementAmount('0.29')).toBe(29);
    expect(parseStatementAmount('19.9')).toBe(1990);
    expect(parseStatementAmount('')).toBe(0);
    expect(parseStatementAmount('12.345')).toBeNaN();
    expect(parseStatementAmount('abc')).toBeNaN();
  });

  it('extracts a UTR by the spec regex and a 6 to 10 digit cheque number', () => {
    expect(extractReference('', 'NEFT-HDFCN52026111012-Dues')).toBe('HDFCN52026111012');
    expect(extractReference('', 'REFUND to member')).toBeNull();
    expect(extractReference('UTR1234567890', '')).toBe('UTR1234567890');
    expect(extractReference('', 'IMPS/UTR 8877665544/x')).toBe('8877665544');
    expect(extractCheque('123456', '', 'x')).toBe('123456');
    expect(extractCheque('', '', 'CHQ NO 0012345')).toBe('0012345');
    expect(extractCheque('12345', '', 'x')).toBeNull();
  });

  it('finds the header after a bank preamble and maps bank column names (HDFC style)', async () => {
    const file = Buffer.from(
      [
        'Statement of account,,,,,,',
        'Account 50100012345678,,,,,,',
        'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance',
        '10/11/26,NEFT-UTR9988776655-DUES,UTR9988776655,10/11/26,,"12,000.00","1,12,000.00"',
        '11/11/26,CHQ PAID,000123,11/11/26,500.00,,"1,11,500.00"',
        ',Total,,,500.00,"12,000.00",',
      ].join('\n'),
    );
    const p = await parseStatementFile(file);
    expect(p.lines).toHaveLength(2);
    expect(p.lines[0]).toMatchObject({
      lineNo: 4,
      creditPaise: 1_200_000,
      reference: 'UTR9988776655',
      runningBalancePaise: 11_200_000,
    });
    expect(p.lines[1]).toMatchObject({ debitPaise: 50_000, chequeNumber: '000123', valueDate: '2026-11-11' });
  });

  it('reads XLSX (exceljs is a project dependency)', async () => {
    const buf = await xlsx([
      ['Date', 'Description', 'Reference', 'Debit', 'Credit', 'Balance'],
      ['10-11-2026', 'Society dues', 'UTR1234567890', '', '1000.50', '1000.50'],
    ]);
    const p = await parseStatementFile(buf);
    expect(p.fileFormat).toBe('XLSX');
    expect(p.lines[0]).toMatchObject({ creditPaise: 100_050, reference: 'UTR1234567890' });
  });

  it('rejects a row with both debit and credit, a bad date and too many rows with the row number', async () => {
    await expect(parseStatementFile(csv('10-11-2026,X,,5.00,5.00,'))).rejects.toThrow(/Row 2.*exactly one/);
    await expect(parseStatementFile(csv('xx,X,,5.00,,'))).rejects.toThrow(/Row 2.*not a valid date/);
    await expect(parseStatementFile(Buffer.from('a,b\n1,2'))).rejects.toThrow(/No header/);
    const many = Array.from({ length: 5001 }, (_, i) => `10-11-2026,Row ${i},,1.00,,`);
    await expect(parseStatementFile(csv(...many))).rejects.toThrow(/more than 5000/);
  });

  it('two identical rows in one file both import (occurrence number in the hash)', async () => {
    const p = await parseStatementFile(csv('10-11-2026,Same,,5.00,,', '10-11-2026,Same,,5.00,,'));
    expect(new Set(p.lines.map(l => l.dedupeHash)).size).toBe(2);
  });
});

describe('POST /accounts/bank-statements (8.16, BR-13-40, section 6.5)', () => {
  it('answers 202 UPLOADED, then the parse job makes it PARSED with lines, period and balances; notifies the importer', async () => {
    const fileId = putFile(w, standardStatement());
    const r = await w.c(
      'post',
      '/accounts/bank-statements',
      { bankAccountId: w.bankId, fileId },
      { headers: idemH() },
    );
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body.data).toMatchObject({
      status: 'UPLOADED',
      fileFormat: 'CSV',
      parserKey: 'GENERIC_CSV',
      lineCount: 0,
    });
    await drainQueues();
    const g = await w.c('get', `/accounts/bank-statements/${r.body.data.id}`);
    expect(g.body.data).toMatchObject({
      status: 'PARSED',
      lineCount: 4,
      duplicateCount: 0,
      periodFrom: '2026-11-10',
      periodTo: '2026-11-13',
      openingBalancePaise: 10_000_000,
      closingBalancePaise: 10_847_640,
      creditTotalPaise: 1_250_000,
      debitTotalPaise: 402_360,
    });
    const note = accountsPortCalls.find(c => c.fn === 'notifications.send')!;
    expect(note.input).toMatchObject({
      template: 'accounts.statement_imported',
      userIds: [Number(w.user.id)],
    });
    expect(await AuditLog.count({ where: { action: 'accounts.statement.imported' } })).toBe(1);
  });

  it('the same file twice is 409 STATEMENT_ALREADY_IMPORTED; an overlapping file counts duplicates and skips them', async () => {
    const a = await importFile(w, standardStatement());
    expect(a.r.status).toBe(202);
    const again = await w.c(
      'post',
      '/accounts/bank-statements',
      { bankAccountId: w.bankId, fileId: putFile(w, standardStatement(), 'again.csv') },
      { headers: idemH() },
    );
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('STATEMENT_ALREADY_IMPORTED');
    const overlap = await importFile(
      w,
      csv(
        '12-11-2026,CHQ 123456 Vendor,123456,4000.00,,108500.00',
        '13-11-2026,Bank charges SMS,,23.60,,108476.40',
        '14-11-2026,Interest credit,,,150.00,108626.40',
      ),
    );
    const s = await BankStatementImport.findByPk(overlap.id);
    expect(s).toMatchObject({ status: 'PARSED', lineCount: 1, duplicateCount: 2 });
    expect(await BankStatementLine.count({ where: { bankAccountId: w.bankId } })).toBe(5);
  });

  it('an unreadable file ends FAILED with the row number and notifies the importer', async () => {
    const bad = await importFile(w, csv('10-11-2026,Ok,,5.00,,', 'not-a-date,Bad,,5.00,,'));
    const g = await w.c('get', `/accounts/bank-statements/${bad.id}`);
    expect(g.body.data.status).toBe('FAILED');
    expect(g.body.data.errorMessage).toMatch(/Row 3/);
    expect(await BankStatementLine.count({ where: { importId: bad.id } })).toBe(0);
    const note = accountsPortCalls.filter(c => c.fn === 'notifications.send').pop()!;
    expect((note.input as any).data).toMatchObject({ status: 'FAILED' });
  });

  it('imports an XLSX file', async () => {
    const buf = await xlsx([
      ['Date', 'Description', 'Reference', 'Debit', 'Credit', 'Balance'],
      ['10-11-2026', 'Society dues', 'UTR1234567890', '', '1000.50', '1000.50'],
    ]);
    const x = await importFile(w, buf, 'stmt.xlsx');
    expect(x.r.body.data.fileFormat).toBe('XLSX');
    expect((await BankStatementImport.findByPk(x.id))!.status).toBe('PARSED');
  });

  it('validates the body, the bank account and the file', async () => {
    const fileId = putFile(w, standardStatement());
    expect(
      (await w.c('post', '/accounts/bank-statements', { bankAccountId: w.bankId }, { headers: idemH() }))
        .status,
    ).toBe(400);
    const nb = await w.c(
      'post',
      '/accounts/bank-statements',
      { bankAccountId: 999999, fileId },
      { headers: idemH() },
    );
    expect(nb.status).toBe(404);
    expect(nb.body.code).toBe('BANK_ACCOUNT_NOT_FOUND');
    const nf = await w.c(
      'post',
      '/accounts/bank-statements',
      { bankAccountId: w.bankId, fileId: 999999 },
      { headers: idemH() },
    );
    expect(nf.status).toBe(404);
  });

  it('the same Idempotency-Key twice gives one import', async () => {
    const fileId = putFile(w, standardStatement());
    const h = idemH();
    const a = await w.c(
      'post',
      '/accounts/bank-statements',
      { bankAccountId: w.bankId, fileId },
      { headers: h },
    );
    const b = await w.c(
      'post',
      '/accounts/bank-statements',
      { bankAccountId: w.bankId, fileId },
      { headers: h },
    );
    expect(b.body.data.id).toBe(a.body.data.id);
    await drainQueues();
    expect(await BankStatementImport.count()).toBe(1);
  });

  it('lists imports and lines with filters (matchStatus, direction, q, sort by amount)', async () => {
    const a = await importFile(w, standardStatement());
    const list = await w.c('get', '/accounts/bank-statements', undefined, {
      query: { bankAccountId: String(w.bankId) },
    });
    expect(list.body.pagination.total).toBe(1);
    const lines = (q: Record<string, string>) =>
      w.c('get', `/accounts/bank-statements/${a.id}/lines`, undefined, { query: q });
    expect((await lines({})).body.data.map((l: any) => l.lineNo)).toEqual([2, 3, 4, 5]);
    expect((await lines({ direction: 'DEBIT' })).body.data).toHaveLength(2);
    expect((await lines({ q: 'cheque' })).body.data).toHaveLength(0);
    expect((await lines({ q: 'CHQ' })).body.data).toHaveLength(1);
    expect((await lines({ sortBy: 'amount', sortOrder: 'desc' })).body.data[0].creditPaise).toBe(1_000_000);
    expect((await lines({ matchStatus: 'UNMATCHED' })).body.data).toHaveLength(4);
    expect((await w.c('get', '/accounts/bank-statements/999999')).body.code).toBe('STATEMENT_NOT_FOUND');
  });
});
