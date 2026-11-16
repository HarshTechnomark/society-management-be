import { notImplemented } from './accounts.shared';
import type { ReadOpts } from './accounts.types';

/**
 * Section 8.21 read-only readers for module 24 (and the 8.19 report endpoints). Foundation: the signatures and `ReadTimeoutError`;
 * the bodies throw `501 NOT_IMPLEMENTED_IN_FOUNDATION` until part 13.4 (reports) fills them. All are read-only, scope every query
 * by `societyId`, use POSTED lines only and do not check plan entitlements or permissions.
 */
export class ReadTimeoutError extends Error {
  constructor(public readonly deadlineMs: number) {
    super(`Report read exceeded ${deadlineMs} ms`);
    this.name = 'ReadTimeoutError';
  }
}

export interface ReportRow {
  [key: string]: unknown;
}
export interface ReportQuery {
  asOf?: string;
  from?: string;
  to?: string;
  financialYear?: string;
  ledgerAccountId?: number;
  fundId?: number;
  level?: number;
  includeZero?: boolean;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
}
export type ReportName = 'trial-balance' | 'income-expenditure' | 'balance-sheet' | 'general-ledger';

export const accountReports = {
  /** 13.4 */
  run: async (
    _societyId: number,
    _report: ReportName,
    _query: ReportQuery,
    _opts: ReadOpts,
  ): Promise<{ rows: ReportRow[]; total: number; totals?: { debitPaise: number; creditPaise: number } }> => {
    throw notImplemented('accountReports.run');
  },
  /** 13.4 */
  fundStatement: async (
    _societyId: number,
    _fundId: number,
    _from: string,
    _to: string,
    _opts: ReadOpts,
  ): Promise<{
    rows: {
      date: string;
      voucherNo: string;
      narration: string;
      inPaise: number;
      outPaise: number;
      runningPaise: number;
    }[];
    total: number;
    totals: { openingPaise: number; closingPaise: number };
  }> => {
    throw notImplemented('accountReports.fundStatement');
  },
};

export const cashBook = {
  /** 13.4: month = 'YYYY-MM'; money in and out of BANK, CASH and PETTY_CASH ledgers, contra moves excluded; range at most 36 months. */
  monthlyTotals: async (
    _societyId: number,
    _from: string,
    _to: string,
    _opts: ReadOpts,
  ): Promise<{
    rows: { month: string; inPaise: number; outPaise: number; closingPaise: number }[];
    total: number;
  }> => {
    throw notImplemented('cashBook.monthlyTotals');
  },
};

export const expenseReports = {
  /** 13.4 (POSTED expenses by `expenseDate` grouped by head; reversed expenses excluded). */
  byHead: async (
    _societyId: number,
    _q: {
      from: string;
      to: string;
      fundId?: number;
      collectionId?: number;
      page?: number;
      limit?: number;
      sortBy?: 'amountPaise' | 'head' | 'count';
      sortDir?: 'asc' | 'desc';
    },
    _opts: ReadOpts,
  ): Promise<{
    rows: {
      ledgerAccountId: number;
      code: string;
      head: string;
      transparencyCategory: string | null;
      count: number;
      amountPaise: number;
    }[];
    total: number;
    totals: { count: number; amountPaise: number };
  }> => {
    throw notImplemented('expenseReports.byHead');
  },
  /** 13.4 (one row per TDS section). */
  tdsDeposited: async (
    _societyId: number,
    _q: {
      from: string;
      to: string;
      vendorId?: number;
      page?: number;
      limit?: number;
      sortBy?: 'tdsSection' | 'deductedPaise' | 'depositedPaise';
      sortDir?: 'asc' | 'desc';
      piiClass?: 'masked' | 'unmasked';
    },
    _opts: ReadOpts,
  ): Promise<{
    rows: { tdsSection: string; deductedPaise: number; depositedPaise: number; challanNo?: string | null }[];
    total: number;
    totals: { deductedPaise: number; depositedPaise: number };
  }> => {
    throw notImplemented('expenseReports.tdsDeposited');
  },
};
