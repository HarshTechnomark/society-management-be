import { NotFoundError, ValidationError } from '../../utils/errors';
import { ERR } from './accounts.constants';
import { n } from './accounts.shared';
import type { ReadOpts } from './accounts.types';
import { CASH_SUBTYPES, readRows } from './accounts.reports.queries';
import { runReport, ymdOf, type AnyReport } from './accounts.reports.service';
import { diffDays } from '../billing/billing.calc.period';

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

const page = <T>(rows: T[], p?: number, l?: number): T[] =>
  l ? rows.slice(((p ?? 1) - 1) * l, (p ?? 1) * l) : rows;
const sortBy = <T>(rows: T[], key: keyof T, dir: 'asc' | 'desc' = 'asc'): T[] =>
  [...rows].sort((a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0) * (dir === 'desc' ? -1 : 1));

export const accountReports = {
  /** Section 8.21: the same logic as `GET /accounts/reports/:report` (`rows` and `totals`; the endpoint adds the envelope). */
  run: async (
    societyId: number,
    report: ReportName,
    query: ReportQuery,
    opts: ReadOpts,
  ): Promise<{ rows: ReportRow[]; total: number; totals?: { debitPaise: number; creditPaise: number } }> => {
    const r = await runReport(societyId, report as AnyReport, query, opts);
    return { rows: r.body.rows, total: r.total, totals: r.totals };
  },
  /** Section 8.13 and 8.21: the lines on the fund's ledger (in = credit, out = debit) with the running balance. */
  fundStatement: async (
    societyId: number,
    fundId: number,
    from: string,
    to: string,
    opts: ReadOpts,
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
    if (to < from) throw new ValidationError([{ field: 'to', message: 'to must not be before from' }]);
    if (diffDays(from, to) + 1 > 366)
      throw new ValidationError([{ field: 'to', message: 'The range is at most 366 days' }]);
    const [fund] = await readRows<{ ledgerAccountId: number }>(
      'SELECT ledgerAccountId FROM funds WHERE id = :fundId AND societyId = :societyId',
      { fundId, societyId },
      opts,
    );
    if (!fund) throw new NotFoundError(ERR.fundNotFound, 'Fund not found');
    const ledgerId = n(fund.ledgerAccountId);
    const [open] = await readRows<{ net: string | null }>(
      `SELECT SUM(l.creditPaise - l.debitPaise) AS net FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId
        WHERE l.societyId = :societyId AND e.status = 'POSTED' AND l.ledgerAccountId = :ledgerId AND l.entryDate < :from`,
      { societyId, ledgerId, from },
      opts,
    );
    const openingPaise = n(open?.net);
    const lines = await readRows<Record<string, unknown>>(
      `SELECT * FROM (
         SELECT l.id AS lineId, e.id AS entryId, l.entryDate AS date, e.voucherNo, e.narration, l.creditPaise AS inPaise,
                l.debitPaise AS outPaise,
                :opening + SUM(l.creditPaise - l.debitPaise) OVER (ORDER BY l.entryDate, e.id, l.id) AS runningPaise
           FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId
          WHERE l.societyId = :societyId AND e.status = 'POSTED' AND l.ledgerAccountId = :ledgerId
            AND l.entryDate BETWEEN :from AND :to
       ) x ORDER BY date, entryId, lineId`,
      { societyId, ledgerId, from, to, opening: openingPaise },
      opts,
    );
    const rows = lines.map(r => ({
      date: ymdOf(r.date),
      voucherNo: String(r.voucherNo ?? ''),
      narration: String(r.narration),
      inPaise: n(r.inPaise),
      outPaise: n(r.outPaise),
      runningPaise: n(r.runningPaise),
    }));
    const closingPaise = rows.length ? rows[rows.length - 1]!.runningPaise : openingPaise;
    return { rows, total: rows.length, totals: { openingPaise, closingPaise } };
  },
};

export const cashBook = {
  /** Month = 'YYYY-MM'; money in and out of BANK, CASH and PETTY_CASH ledgers; entries that only move between those ledgers are left out; at most 36 months. */
  monthlyTotals: async (
    societyId: number,
    from: string,
    to: string,
    opts: ReadOpts,
  ): Promise<{
    rows: { month: string; inPaise: number; outPaise: number; closingPaise: number }[];
    total: number;
  }> => {
    if (to < from) throw new ValidationError([{ field: 'to', message: 'to must not be before from' }]);
    const months =
      (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 +
      Number(to.slice(5, 7)) -
      Number(from.slice(5, 7)) +
      1;
    if (months > 36) throw new ValidationError([{ field: 'to', message: 'The range is at most 36 months' }]);
    const [open] = await readRows<{ net: string | null }>(
      `SELECT SUM(l.debitPaise - l.creditPaise) AS net
         FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId JOIN ledger_accounts a ON a.id = l.ledgerAccountId
        WHERE l.societyId = :societyId AND e.status = 'POSTED' AND a.subtype IN ${CASH_SUBTYPES} AND l.entryDate < :first`,
      { societyId, first: `${from.slice(0, 7)}-01` },
      opts,
    );
    const lines = await readRows<{ month: string; d: string; c: string }>(
      `SELECT DATE_FORMAT(l.entryDate, '%Y-%m') AS month, SUM(l.debitPaise) AS d, SUM(l.creditPaise) AS c
         FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId JOIN ledger_accounts a ON a.id = l.ledgerAccountId
        WHERE l.societyId = :societyId AND e.status = 'POSTED' AND a.subtype IN ${CASH_SUBTYPES}
          AND l.entryDate BETWEEN :first AND :to
          AND EXISTS (SELECT 1 FROM journal_lines o JOIN ledger_accounts oa ON oa.id = o.ledgerAccountId
                       WHERE o.journalEntryId = e.id AND oa.subtype NOT IN ${CASH_SUBTYPES})
        GROUP BY month`,
      { societyId, first: `${from.slice(0, 7)}-01`, to },
      opts,
    );
    const byMonth = new Map(lines.map(l => [l.month, l]));
    let running = n(open?.net);
    const rows: { month: string; inPaise: number; outPaise: number; closingPaise: number }[] = [];
    let y = Number(from.slice(0, 4));
    let m = Number(from.slice(5, 7));
    for (let i = 0; i < months; i++) {
      const key = `${y}-${String(m).padStart(2, '0')}`;
      const l = byMonth.get(key);
      const inPaise = n(l?.d);
      const outPaise = n(l?.c);
      running += inPaise - outPaise;
      rows.push({ month: key, inPaise, outPaise, closingPaise: running });
      if (++m > 12) {
        m = 1;
        y++;
      }
    }
    return { rows, total: rows.length };
  },
};

export const expenseReports = {
  /** POSTED expenses by `expenseDate` grouped by head; reversed expenses are not POSTED and so left out. */
  byHead: async (
    societyId: number,
    q: {
      from: string;
      to: string;
      fundId?: number;
      collectionId?: number;
      page?: number;
      limit?: number;
      sortBy?: 'amountPaise' | 'head' | 'count';
      sortDir?: 'asc' | 'desc';
    },
    opts: ReadOpts,
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
    const raw = await readRows<Record<string, unknown>>(
      `SELECT a.id AS ledgerAccountId, a.code, a.name AS head, a.transparencyCategory, COUNT(*) AS cnt,
              SUM(x.grossAmountPaise) AS amount
         FROM expenses x JOIN ledger_accounts a ON a.id = x.ledgerAccountId
        WHERE x.societyId = :societyId AND x.status = 'POSTED' AND x.expenseDate BETWEEN :from AND :to
          ${q.fundId ? 'AND x.fundId = :fundId' : ''} ${q.collectionId ? 'AND x.collectionId = :collectionId' : ''}
        GROUP BY a.id, a.code, a.name, a.transparencyCategory`,
      { societyId, from: q.from, to: q.to, fundId: q.fundId, collectionId: q.collectionId },
      opts,
    );
    const all = raw.map(r => ({
      ledgerAccountId: n(r.ledgerAccountId),
      code: String(r.code),
      head: String(r.head),
      transparencyCategory: (r.transparencyCategory as string | null) ?? null,
      count: n(r.cnt),
      amountPaise: n(r.amount),
    }));
    const sorted = sortBy(
      all,
      q.sortBy ?? 'amountPaise',
      q.sortDir ?? (q.sortBy === 'head' ? 'asc' : 'desc'),
    );
    return {
      rows: page(sorted, q.page, q.limit),
      total: all.length,
      totals: {
        count: all.reduce((s, r) => s + r.count, 0),
        amountPaise: all.reduce((s, r) => s + r.amountPaise, 0),
      },
    };
  },
  /** One row per TDS section (8.21, module 21 `vendorReports.paymentsAndTds`). */
  tdsDeposited: async (
    societyId: number,
    q: {
      from: string;
      to: string;
      vendorId?: number;
      page?: number;
      limit?: number;
      sortBy?: 'tdsSection' | 'deductedPaise' | 'depositedPaise';
      sortDir?: 'asc' | 'desc';
      piiClass?: 'masked' | 'unmasked';
    },
    opts: ReadOpts,
  ): Promise<{
    rows: { tdsSection: string; deductedPaise: number; depositedPaise: number; challanNo?: string | null }[];
    total: number;
    totals: { deductedPaise: number; depositedPaise: number };
  }> => {
    const ded = await readRows<{ tdsSection: string; amount: string }>(
      `SELECT x.tdsSection, SUM(x.tdsPaise) AS amount FROM expenses x
        WHERE x.societyId = :societyId AND x.status = 'POSTED' AND x.expenseDate BETWEEN :from AND :to
          AND x.tdsPaise > 0 AND x.tdsSection IS NOT NULL ${q.vendorId ? 'AND x.vendorId = :vendorId' : ''}
        GROUP BY x.tdsSection`,
      { societyId, from: q.from, to: q.to, vendorId: q.vendorId },
      opts,
    );
    const dep = q.vendorId
      ? []
      : await readRows<{ tdsSection: string; amount: string; cnt: string; challan: string | null }>(
          `SELECT x.tdsSection, SUM(x.grossAmountPaise) AS amount, COUNT(*) AS cnt, MAX(x.challanNo) AS challan
             FROM expenses x JOIN ledger_accounts a ON a.id = x.ledgerAccountId AND a.code = '2140'
            WHERE x.societyId = :societyId AND x.status = 'POSTED' AND x.expenseType = 'STATUTORY_DUE'
              AND x.expenseDate BETWEEN :from AND :to AND x.tdsSection IS NOT NULL
            GROUP BY x.tdsSection`,
          { societyId, from: q.from, to: q.to },
          opts,
        );
    const sections = new Map<
      string,
      { tdsSection: string; deductedPaise: number; depositedPaise: number; challanNo: string | null }
    >();
    const slot = (s: string) => {
      let r = sections.get(s);
      if (!r) sections.set(s, (r = { tdsSection: s, deductedPaise: 0, depositedPaise: 0, challanNo: null }));
      return r;
    };
    for (const d of ded) slot(d.tdsSection).deductedPaise = n(d.amount);
    for (const d of dep) {
      const r = slot(d.tdsSection);
      r.depositedPaise = n(d.amount);
      r.challanNo = n(d.cnt) === 1 ? d.challan : null;
    }
    const all = [...sections.values()];
    const sorted = sortBy(all, q.sortBy ?? 'tdsSection', q.sortDir ?? 'asc');
    return {
      rows: page(sorted, q.page, q.limit),
      total: all.length,
      totals: {
        deductedPaise: all.reduce((s, r) => s + r.deductedPaise, 0),
        depositedPaise: all.reduce((s, r) => s + r.depositedPaise, 0),
      },
    };
  },
};
