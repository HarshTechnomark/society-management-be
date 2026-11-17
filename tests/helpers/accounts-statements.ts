import { randomBytes, randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
import { BankAccount, LedgerAccount, sequelize } from '../../src/models';
import { drainQueues } from '../../src/lib/queue';
import { registerAccounts } from '../../src/modules/accounts/accounts.public';
import { ensureBooks } from '../../src/modules/accounts/accounts.chart';
import { postJournal } from '../../src/modules/accounts/accounts.engine';
import { setAccountsPorts } from '../../src/modules/accounts/accounts.ports';
import { putPlaceholderFile } from '../../src/modules/society-setup/society-setup.ports';
import { systemCtx, type Ctx } from '../../src/types/context';
import { setNow } from '../../src/lib/clock';
import { resetSetup, setupSociety } from './society-setup';

export const idemH = (): Record<string, string> => ({ 'Idempotency-Key': randomUUID() });

export type StatementWorld = Awaited<ReturnType<typeof statementWorld>>;

/** A society with books, its chairman client and one bank account (ledger `1110-001`). */
export async function statementWorld(plan: string = 'PREMIUM', reset = true) {
  if (reset) {
    await resetSetup();
    setAccountsPorts();
    registerAccounts();
    setNow('2026-11-17T04:30:00Z');
  }
  const s = await setupSociety({ plan } as never);
  const societyId = Number(s.society.id);
  await sequelize.transaction(t => ensureBooks(t, societyId));
  const bank = await makeBank(societyId);
  const sys: Ctx = {
    ...systemCtx('t'),
    society: { id: societyId, name: 'T', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: plan },
  };
  return { ...s, societyId, bank, bankId: Number(bank.id), ledgerId: Number(bank.ledgerAccountId), sys };
}

export async function makeBank(societyId: number, code = '1110-001'): Promise<BankAccount> {
  const parent = (await LedgerAccount.findOne({ where: { societyId, code: '1110' } }))!;
  const ledger = await LedgerAccount.create({
    societyId,
    code,
    name: `Bank - ${code}`,
    accountType: 'ASSET',
    subtype: 'BANK',
    parentId: Number(parent.id),
    isSystem: true,
  } as never);
  return BankAccount.create({
    societyId,
    ledgerAccountId: Number(ledger.id),
    displayName: `Test ${code}`,
    bankName: 'Test Bank',
    branchName: null,
    ifsc: 'HDFC0001234',
    accountHolderName: 'Test CHS',
    accountNumberEnc: Buffer.from('enc'),
    accountNumberLast4: '4821',
    accountNumberHash: randomBytes(32).toString('hex'),
    openingBalanceDate: null,
    verifiedBy: null,
    verifiedAt: null,
    lastReconciledDate: null,
    lastReconciledBalancePaise: null,
    closedAt: null,
    createdBy: null,
    updatedBy: null,
  } as never);
}

let seq = 0;
/** Money in on the books: Dr bank, Cr 1300 (a resident payment). Returns the journal entry id. */
export async function bookIn(
  w: Pick<StatementWorld, 'sys' | 'bank'>,
  date: string,
  paise: number,
  o: { instrumentRef?: string; narration?: string } = {},
): Promise<number> {
  return (
    await sequelize.transaction(t =>
      postJournal(
        w.sys,
        {
          date,
          voucherType: 'RECEIPT',
          refType: 'test_in',
          refId: `in-${++seq}`,
          narration: o.narration ?? 'Maintenance received',
          instrumentRef: o.instrumentRef ?? null,
          lines: [
            { ledgerAccountCode: '1110-001', debitPaise: paise, creditPaise: 0 },
            { ledgerAccountCode: '1300', debitPaise: 0, creditPaise: paise },
          ],
        },
        t,
      ),
    )
  ).id;
}

/** Money out on the books: Dr 5600, Cr bank. */
export async function bookOut(
  w: Pick<StatementWorld, 'sys' | 'bank'>,
  date: string,
  paise: number,
  o: { instrumentRef?: string; narration?: string } = {},
): Promise<number> {
  return (
    await sequelize.transaction(t =>
      postJournal(
        w.sys,
        {
          date,
          voucherType: 'PAYMENT',
          refType: 'test_out',
          refId: `out-${++seq}`,
          narration: o.narration ?? 'Vendor paid',
          instrumentRef: o.instrumentRef ?? null,
          lines: [
            { ledgerAccountCode: '5600', debitPaise: paise, creditPaise: 0 },
            { ledgerAccountCode: '1110-001', debitPaise: 0, creditPaise: paise },
          ],
        },
        t,
      ),
    )
  ).id;
}

export async function lineIdOf(entryId: number, ledgerId: number): Promise<number> {
  const [r] = (await sequelize.query(
    'SELECT id FROM journal_lines WHERE journalEntryId = ? AND ledgerAccountId = ?',
    { replacements: [entryId, ledgerId] },
  )) as [{ id: number }[], unknown];
  return Number(r[0]!.id);
}

export const HEADER = 'Date,Description,Reference,Debit,Credit,Balance';
export const csv = (...rows: string[]): Buffer => Buffer.from([HEADER, ...rows].join('\n'), 'utf8');

/** Puts a file in the module 01 placeholder store, owned by the chairman. */
export const putFile = (
  w: Pick<StatementWorld, 'societyId' | 'user'>,
  content: Buffer,
  name = 'stmt.csv',
): number => putPlaceholderFile({ societyId: w.societyId, ownerUserId: Number(w.user.id), name, content });

/** Imports a file through the API and waits for the parse and auto-match jobs. */
export async function importFile(w: StatementWorld, content: Buffer, name?: string) {
  const fileId = putFile(w, content, name);
  const r = await w.c(
    'post',
    '/accounts/bank-statements',
    { bankAccountId: w.bankId, fileId },
    { headers: idemH() },
  );
  await drainQueues();
  return { r, fileId, id: r.body?.data?.id as number };
}

export async function xlsx(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Statement');
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Opening balance of the bank on the books (never on a statement): Dr bank, Cr 3900. */
export async function bookOpening(
  w: Pick<StatementWorld, 'sys'>,
  paise: number,
  date = '2026-04-01',
): Promise<void> {
  await sequelize.transaction(t =>
    postJournal(
      w.sys,
      {
        date,
        voucherType: 'OPENING_BALANCE',
        refType: 'opening',
        refId: `open-${++seq}`,
        narration: 'Opening balance',
        lines: [
          { ledgerAccountCode: '1110-001', debitPaise: paise, creditPaise: 0 },
          { ledgerAccountCode: '3900', debitPaise: 0, creditPaise: paise },
        ],
      },
      t,
    ),
  );
}

/** The standard four-line statement of the tests: a UTR credit, a cash deposit, a cheque debit and a bank charge. */
export const standardStatement = (): Buffer =>
  csv(
    '10-11-2026,NEFT-UTR1234567890-Society dues,UTR1234567890,,10000.00,110000.00',
    '11-11-2026,Cash deposit CDM,,,2500.00,112500.00',
    '12-11-2026,CHQ 123456 Vendor,123456,4000.00,,108500.00',
    '13-11-2026,Bank charges SMS,,23.60,,108476.40',
  );

/** Books matching `standardStatement` (opening 1,00,000 on the books too). */
export async function standardBooks(w: StatementWorld): Promise<{ utr: number; cash: number; chq: number }> {
  await bookOpening(w, 10_000_000);
  const utr = await bookIn(w, '2026-11-10', 1_000_000, { instrumentRef: 'UTR1234567890' });
  const cash = await bookIn(w, '2026-11-11', 250_000, { narration: 'Cash deposited' });
  const chq = await bookOut(w, '2026-11-12', 400_000, { instrumentRef: '123456' });
  return { utr, cash, chq };
}

/** The line of an entry on the ledger with `code`. */
export async function lineOnCode(entryId: number, societyId: number, code: string): Promise<number> {
  const l = (await LedgerAccount.findOne({ where: { societyId, code } }))!;
  return lineIdOf(entryId, Number(l.id));
}
