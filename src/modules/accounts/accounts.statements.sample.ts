import { QueryTypes } from 'sequelize';
import { BankAccount, sequelize } from '../../models';
import { istDate, now } from '../../lib/clock';
import { toCsv } from '../society-setup/society-setup.csv';
import { n } from './accounts.shared';
import { bankNotFound } from './accounts.statements.shared';

/**
 * Dev only (`GET /api/v1/dev/accounts/sample-statement?bankAccountId=`): a statement CSV built from the last 60 days of posted lines on
 * the bank's ledger (payments, settlements, expenses...), so a browser test can import it and see auto-match work. Lines that carry
 * an instrument reference (UTR, cheque number) appear with it (pass 1), the rest by amount and date (pass 2). One bank charge line
 * is added that matches nothing, so "Create entry" (5600) can be shown. Columns: Date, Description, Reference, Debit, Credit, Balance.
 */
const HEADER = ['Date', 'Description', 'Reference', 'Debit', 'Credit', 'Balance'];

const rupees = (p: number): string =>
  `${Math.trunc(Math.abs(p) / 100)}.${String(Math.abs(p) % 100).padStart(2, '0')}`;
const ddmmyyyy = (ymd: string): string => `${ymd.slice(8, 10)}-${ymd.slice(5, 7)}-${ymd.slice(0, 4)}`;

export async function sampleStatementCsv(bankAccountId: number): Promise<{ csv: Buffer; lines: number }> {
  const bank = await BankAccount.findByPk(bankAccountId);
  if (!bank) throw bankNotFound();
  const today = istDate(now());
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 60 * 86_400_000).toISOString().slice(0, 10);
  const rows = await sequelize.query<{
    entryDate: string;
    debitPaise: string;
    creditPaise: string;
    narration: string;
    instrumentRef: string | null;
    voucherType: string;
  }>(
    `SELECT jl.entryDate, jl.debitPaise, jl.creditPaise, je.narration, je.instrumentRef, je.voucherType
       FROM journal_lines jl JOIN journal_entries je ON je.id = jl.journalEntryId
      WHERE jl.societyId = :societyId AND jl.ledgerAccountId = :ledger AND je.status = 'POSTED'
        AND je.voucherType <> 'OPENING_BALANCE' AND jl.entryDate >= :from
      ORDER BY jl.entryDate, jl.id LIMIT 200`,
    {
      replacements: { societyId: bank.societyId, ledger: bank.ledgerAccountId, from },
      type: QueryTypes.SELECT,
    },
  );
  const [before] = await sequelize.query<{ b: string | null }>(
    `SELECT COALESCE(SUM(jl.debitPaise - jl.creditPaise), 0) AS b FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journalEntryId
      WHERE jl.societyId = :societyId AND jl.ledgerAccountId = :ledger AND je.status = 'POSTED' AND jl.entryDate < :from`,
    {
      replacements: { societyId: bank.societyId, ledger: bank.ledgerAccountId, from },
      type: QueryTypes.SELECT,
    },
  );
  let balance = n(before?.b);
  const out: string[][] = [];
  for (const r of rows) {
    const debit = n(r.debitPaise); // money in on the books = statement credit
    const credit = n(r.creditPaise);
    balance += debit - credit;
    const ref = r.instrumentRef ?? '';
    const text = ref ? `NEFT-${ref}-${r.narration}` : r.narration;
    out.push([
      ddmmyyyy(r.entryDate),
      text.slice(0, 200),
      ref,
      credit > 0 ? rupees(credit) : '',
      debit > 0 ? rupees(debit) : '',
      rupees(balance),
    ]);
  }
  // one bank charge on the last day that matches nothing in the books (₹23.60)
  const chargeDate = rows.length ? rows[rows.length - 1]!.entryDate : today;
  balance -= 2360;
  out.push([
    ddmmyyyy(chargeDate),
    'Bank charges - SMS and service charges',
    '',
    '23.60',
    '',
    rupees(balance),
  ]);
  return { csv: toCsv(HEADER, out), lines: out.length };
}
