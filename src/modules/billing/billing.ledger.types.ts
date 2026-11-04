import type { LedgerEntryType, LedgerRefType } from './billing.constants';

/** Types, limits and names of sub-module 11.2 (unit ledger, statement of account, opening balances). */

/** BR-11-59: a statement covers at most this many days (both end dates counted). */
export const STATEMENT_MAX_DAYS = 1100;
/** Section 8.23: the opening balance file has at most this many rows. */
export const OPENING_MAX_ROWS = 5000;
/** Section 8.23: posting runs in batches of this many rows, each in its own transaction. */
export const OPENING_POST_BATCH = 200;
/** The header of the opening balance file (section 8.23). */
export const OPENING_HEADER = ['unit', 'arrears_principal', 'arrears_interest', 'advance'] as const;

/** Audit actions of 11.2 that section 9.3 does not list (the statement CSV export is audited by BR-13 "CSV exports are audited"). */
export const LEDGER_AUDIT = {
  statementExported: 'billing.statement.exported',
} as const;

/** Entity names used in audit rows. */
export const LEDGER_ENTITY = {
  openingBalance: 'opening_balance',
  openingImport: 'opening_balance_import',
  statement: 'unit_statement',
} as const;

/** System charge head keys the opening arrears invoice uses (section 7.13; `SYSTEM_HEAD_KEYS`). */
export const OPENING_ARREARS_HEAD = 'OPENING_ARREARS';
export const OPENING_INTEREST_HEAD = 'INTEREST';

/** Ledger accounts of BR-11-70. */
export const ACCOUNT = {
  receivable: '1300',
  advances: '2210',
  openingAdjustment: '3900',
} as const;

export interface StatementEntryDto {
  id: number;
  entryDate: string;
  entryType: LedgerEntryType;
  refType: LedgerRefType;
  refId: number;
  narration: string;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number;
}

export interface StatementDto {
  unit: { id: number; label: string };
  from: string;
  to: string;
  openingBalancePaise: number;
  entries: StatementEntryDto[];
  closingBalancePaise: number;
}

export interface OpeningBalanceRowDto {
  id: number;
  unitId: number | null;
  unitLabel: string;
  unitLabelInput: string;
  importRowNo: number;
  asOfDate: string;
  arrearsPrincipalPaise: number;
  arrearsInterestPaise: number;
  advancePaise: number;
  status: 'DRAFT' | 'INVALID' | 'POSTED' | 'REVERSED';
  validationError: string | null;
  invoiceId: number | null;
  postedAt: string | null;
  reversedAt: string | null;
  version: number;
}

export interface OpeningTotals {
  draftArrearsPaise: number;
  draftAdvancePaise: number;
  invalidCount: number;
  postedCount: number;
}
