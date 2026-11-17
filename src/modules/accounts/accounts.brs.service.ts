import { Op, QueryTypes } from 'sequelize';
import { BankStatementImport, sequelize } from '../../models';
import { ValidationError } from '../../utils/errors';
import { n, societyToday } from './accounts.shared';
import { loadBank } from './accounts.statements.shared';

/**
 * Bank reconciliation statement (spec 8.14 route 38, Premium). At `asOf`:
 *   book balance = Σ(debit − credit) of POSTED lines on the bank's ledger dated up to `asOf`;
 *   uncleared debits (money in on the books, not on a statement) and uncleared credits (money out) = those lines not matched to a
 *   statement line (opening-balance vouchers are on no statement and are left out);
 *   unmatched statement credits and debits = lines of the account's statements (not failed) dated up to `asOf` not matched to a
 *   journal line (IGNORED lines are still bank items that are not in the books, so they count);
 *   computed bank balance = book − uncleared debits + uncleared credits + unmatched statement credits − unmatched statement debits;
 *   statement balance = closing balance of the latest statement ending on or before `asOf`; difference = statement − computed
 *   (0 when reconciled; `null` while no statement has been imported).
 */
const ITEM_CAP = 500;

export interface BrsItem {
  kind:
    'BOOK_UNCLEARED_IN' | 'BOOK_UNCLEARED_OUT' | 'STATEMENT_UNMATCHED_CREDIT' | 'STATEMENT_UNMATCHED_DEBIT';
  date: string;
  amountPaise: number;
  description: string;
  reference: string | null;
  journalLineId: number | null;
  journalEntryId: number | null;
  voucherNo: string | null;
  statementLineId: number | null;
  statementId: number | null;
  matchStatus: string | null;
}

export interface BrsDto {
  bankAccountId: number;
  asOf: string;
  bookBalancePaise: number;
  unclearedDebitsPaise: number;
  unclearedCreditsPaise: number;
  unmatchedStatementCreditsPaise: number;
  unmatchedStatementDebitsPaise: number;
  computedBankBalancePaise: number;
  statementBalancePaise: number | null;
  statementDate: string | null;
  statementId: number | null;
  differencePaise: number | null;
  lastReconciledDate: string | null;
  lastReconciledBalancePaise: number | null;
  itemsTruncated: boolean;
  items: BrsItem[];
}

export async function bankReconciliation(
  societyId: number,
  bankAccountId: number,
  asOfIn?: string,
): Promise<BrsDto> {
  const bank = await loadBank(societyId, bankAccountId);
  const today = await societyToday(societyId);
  const asOf = asOfIn ?? today;
  if (asOf > today)
    throw new ValidationError([{ field: 'asOf', message: 'The date cannot be in the future' }]);
  const ledgerId = n(bank.ledgerAccountId);
  const q = <T extends object>(sql: string, replacements: Record<string, unknown>): Promise<T[]> =>
    sequelize.query<T>(sql, { replacements, type: QueryTypes.SELECT });
  const rep = { societyId, ledgerId, bankAccountId, asOf };

  const [book] = await q<{ b: string | null }>(
    `SELECT COALESCE(SUM(jl.debitPaise - jl.creditPaise), 0) AS b FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journalEntryId
      WHERE jl.societyId = :societyId AND jl.ledgerAccountId = :ledgerId AND je.status = 'POSTED' AND jl.entryDate <= :asOf`,
    rep,
  );
  const bookRows = await q<{
    id: number;
    journalEntryId: number;
    entryDate: string;
    debitPaise: string;
    creditPaise: string;
    voucherNo: string | null;
    narration: string;
    instrumentRef: string | null;
  }>(
    `SELECT jl.id, jl.journalEntryId, jl.entryDate, jl.debitPaise, jl.creditPaise, je.voucherNo, je.narration, je.instrumentRef
       FROM journal_lines jl
       JOIN journal_entries je ON je.id = jl.journalEntryId
       LEFT JOIN bank_statement_lines sl ON sl.matchedJournalLineId = jl.id
      WHERE jl.societyId = :societyId AND jl.ledgerAccountId = :ledgerId AND je.status = 'POSTED'
        AND je.voucherType <> 'OPENING_BALANCE' AND sl.id IS NULL AND jl.entryDate <= :asOf
      ORDER BY jl.entryDate, jl.id`,
    rep,
  );
  const stmtRows = await q<{
    id: number;
    importId: number;
    txnDate: string;
    description: string;
    reference: string | null;
    debitPaise: string;
    creditPaise: string;
    matchStatus: string;
  }>(
    `SELECT sl.id, sl.importId, sl.txnDate, sl.description, sl.reference, sl.debitPaise, sl.creditPaise, sl.matchStatus
       FROM bank_statement_lines sl
       JOIN bank_statement_imports si ON si.id = sl.importId
      WHERE sl.societyId = :societyId AND sl.bankAccountId = :bankAccountId AND si.status <> 'FAILED'
        AND sl.matchStatus <> 'MATCHED' AND sl.txnDate <= :asOf
      ORDER BY sl.txnDate, sl.id`,
    rep,
  );
  const stmt = await BankStatementImport.findOne({
    where: {
      societyId,
      bankAccountId,
      status: ['PARSED', 'RECONCILED'],
      periodTo: { [Op.lte]: asOf },
      closingBalancePaise: { [Op.ne]: null },
    },
    order: [
      ['periodTo', 'DESC'],
      ['id', 'DESC'],
    ],
  });

  const items: BrsItem[] = [];
  let unclearedIn = 0;
  let unclearedOut = 0;
  let stmtCredits = 0;
  let stmtDebits = 0;
  for (const r of bookRows) {
    const debit = n(r.debitPaise);
    const credit = n(r.creditPaise);
    const amount = debit > 0 ? debit : credit;
    if (debit > 0) unclearedIn += debit;
    else unclearedOut += credit;
    items.push({
      kind: debit > 0 ? 'BOOK_UNCLEARED_IN' : 'BOOK_UNCLEARED_OUT',
      date: r.entryDate,
      amountPaise: amount,
      description: r.narration,
      reference: r.instrumentRef,
      journalLineId: n(r.id),
      journalEntryId: n(r.journalEntryId),
      voucherNo: r.voucherNo,
      statementLineId: null,
      statementId: null,
      matchStatus: null,
    });
  }
  for (const r of stmtRows) {
    const credit = n(r.creditPaise);
    const debit = n(r.debitPaise);
    if (credit > 0) stmtCredits += credit;
    else stmtDebits += debit;
    items.push({
      kind: credit > 0 ? 'STATEMENT_UNMATCHED_CREDIT' : 'STATEMENT_UNMATCHED_DEBIT',
      date: r.txnDate,
      amountPaise: credit > 0 ? credit : debit,
      description: r.description,
      reference: r.reference,
      journalLineId: null,
      journalEntryId: null,
      voucherNo: null,
      statementLineId: n(r.id),
      statementId: n(r.importId),
      matchStatus: r.matchStatus,
    });
  }
  const bookBalance = n(book?.b);
  const computed = bookBalance - unclearedIn + unclearedOut + stmtCredits - stmtDebits;
  const statementBalance = stmt ? n(stmt.closingBalancePaise) : null;
  return {
    bankAccountId,
    asOf,
    bookBalancePaise: bookBalance,
    unclearedDebitsPaise: unclearedIn,
    unclearedCreditsPaise: unclearedOut,
    unmatchedStatementCreditsPaise: stmtCredits,
    unmatchedStatementDebitsPaise: stmtDebits,
    computedBankBalancePaise: computed,
    statementBalancePaise: statementBalance,
    statementDate: stmt ? stmt.periodTo : null,
    statementId: stmt ? n(stmt.id) : null,
    differencePaise: statementBalance === null ? null : statementBalance - computed,
    lastReconciledDate: bank.lastReconciledDate,
    lastReconciledBalancePaise:
      bank.lastReconciledBalancePaise === null ? null : n(bank.lastReconciledBalancePaise),
    itemsTruncated: items.length > ITEM_CAP,
    items: items.slice(0, ITEM_CAP),
  };
}
