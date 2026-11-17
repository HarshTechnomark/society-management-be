import { daysInclusive } from '../billing/billing.calc.period';
import { financialYearOf } from '../../utils/numberSequences';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { CODE, ERR } from './accounts.constants';
import { n, societyToday } from './accounts.shared';
import {
  CASH_SUBTYPES,
  leavesUnder,
  loadChart,
  readRows,
  rollUp,
  sumsByAccount,
  visibleNodes,
  type AccountNode,
} from './accounts.reports.queries';
import type { ReadOpts } from './accounts.types';

/**
 * The seven reports of section 8.19 and the shared logic behind the 8.21 readers. Figures are paise from POSTED lines only.
 * `runReport` returns the full envelope (the HTTP body); `accountReports.run` wraps it into `{ rows, total, totals }`.
 */
export const REPORT_NAMES = [
  'trial-balance',
  'income-expenditure',
  'balance-sheet',
  'general-ledger',
  'receipts-payments',
  'gst-summary',
  'tds-register',
] as const;
export type AnyReport = (typeof REPORT_NAMES)[number];

export interface RunQuery {
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

export interface ReportResult {
  report: AnyReport;
  body: Record<string, unknown> & { rows: Record<string, unknown>[] };
  totals: { debitPaise: number; creditPaise: number };
  /** Total rows before paging (general ledger) or the row count. */
  total: number;
}

export const fyRange = (fy: string): { from: string; to: string } => {
  const y = Number(fy.slice(0, 4));
  return { from: `${y}-04-01`, to: `${y + 1}-03-31` };
};

const ASOF_REPORTS = new Set<AnyReport>(['trial-balance', 'balance-sheet']);
export const MAX_RANGE_DAYS = 366;

/** Resolves the period of a report: `asOf` for the two point-in-time reports, `from`/`to` for the others. */
export async function resolvePeriod(
  societyId: number,
  report: AnyReport,
  q: RunQuery,
): Promise<{ asOf?: string; from?: string; to?: string; financialYear: string }> {
  const today = await societyToday(societyId);
  if (ASOF_REPORTS.has(report)) {
    const asOf = q.asOf ?? (q.financialYear ? fyRange(q.financialYear).to : today);
    return { asOf, financialYear: financialYearOf(asOf) };
  }
  const fy = q.financialYear ? fyRange(q.financialYear) : null;
  const from = q.from ?? fy?.from ?? fyRange(financialYearOf(today)).from;
  const to = q.to ?? fy?.to ?? today;
  if (to < from) throw new ValidationError([{ field: 'to', message: 'to must not be before from' }]);
  if (daysInclusive(from, to) > MAX_RANGE_DAYS)
    throw new ValidationError([{ field: 'to', message: `The range is at most ${MAX_RANGE_DAYS} days` }]);
  return { from, to, financialYear: financialYearOf(from) };
}

const row = (a: AccountNode, extra: Record<string, unknown>): Record<string, unknown> => ({
  ledgerAccountId: a.id,
  code: a.code,
  name: a.name,
  ...extra,
});

// ------------------------------------------------------------------ trial balance
async function trialBalance(
  societyId: number,
  q: RunQuery,
  p: { asOf?: string; financialYear: string },
  opts: ReadOpts,
) {
  const chart = await loadChart(societyId, opts);
  rollUp(chart, await sumsByAccount({ societyId, to: p.asOf, fundId: q.fundId }, opts));
  const rows = visibleNodes(chart, q.level ?? 4)
    .filter(a => q.includeZero || a.debit - a.credit !== 0)
    .map(a => {
      const net = a.debit - a.credit;
      return row(a, {
        accountType: a.accountType,
        isGroup: a.isGroup,
        debitPaise: net > 0 ? net : 0,
        creditPaise: net < 0 ? -net : 0,
      });
    });
  const totals = {
    debitPaise: rows.reduce((s, r) => s + (r.debitPaise as number), 0),
    creditPaise: rows.reduce((s, r) => s + (r.creditPaise as number), 0),
  };
  return {
    body: {
      asOf: p.asOf,
      financialYear: p.financialYear,
      balanced: totals.debitPaise === totals.creditPaise,
      rows,
      totals,
    },
    totals,
    total: rows.length,
  };
}

// ------------------------------------------------------------------ income and expenditure
async function incomeExpenditure(
  societyId: number,
  q: RunQuery,
  p: { from?: string; to?: string; financialYear: string },
  opts: ReadOpts,
) {
  const chart = await loadChart(societyId, opts);
  rollUp(
    chart,
    await sumsByAccount(
      { societyId, from: p.from, to: p.to, noClosing: true, noFundConsumption: true, fundId: q.fundId },
      opts,
    ),
  );
  const rows = visibleNodes(chart, q.level ?? 4)
    .filter(a => a.accountType === 'INCOME' || a.accountType === 'EXPENSE')
    .filter(a => q.includeZero || a.debit - a.credit !== 0)
    .map(a =>
      row(a, {
        section: a.accountType === 'INCOME' ? 'INCOME' : 'EXPENDITURE',
        isGroup: a.isGroup,
        amountPaise: a.accountType === 'INCOME' ? a.credit - a.debit : a.debit - a.credit,
      }),
    );
  const sum = (s: string) =>
    rows.filter(r => r.section === s).reduce((t, r) => t + (r.amountPaise as number), 0);
  const incomePaise = sum('INCOME');
  const expenditurePaise = sum('EXPENDITURE');
  const summary = { incomePaise, expenditurePaise, surplusPaise: incomePaise - expenditurePaise };
  return {
    body: { from: p.from, to: p.to, financialYear: p.financialYear, rows, totals: summary },
    totals: { debitPaise: expenditurePaise, creditPaise: incomePaise },
    total: rows.length,
  };
}

// ------------------------------------------------------------------ balance sheet
async function balanceSheet(
  societyId: number,
  q: RunQuery,
  p: { asOf?: string; financialYear: string },
  opts: ReadOpts,
) {
  const chart = await loadChart(societyId, opts);
  const asOf = p.asOf!;
  rollUp(chart, await sumsByAccount({ societyId, to: asOf }, opts));
  const sectionOf = (a: AccountNode): string | null =>
    a.accountType === 'ASSET'
      ? 'ASSETS'
      : a.accountType === 'LIABILITY'
        ? 'LIABILITIES'
        : a.accountType === 'FUND'
          ? a.subtype === 'FUND'
            ? 'FUNDS'
            : 'RESERVES'
          : null;
  const rows: Record<string, unknown>[] = visibleNodes(chart, q.level ?? 4)
    .filter(a => sectionOf(a) !== null)
    .filter(a => q.includeZero || a.debit - a.credit !== 0)
    .map(a =>
      row(a, {
        section: sectionOf(a),
        isGroup: a.isGroup,
        amountPaise: a.accountType === 'ASSET' ? a.debit - a.credit : a.credit - a.debit,
      }),
    );
  // surplus of the current financial year and of earlier years not yet moved to 3100 by the year close
  const fyStart = fyRange(financialYearOf(asOf)).from;
  let current = 0;
  let earlier = 0;
  const pl = (from: string | undefined, to: string) => sumsByAccount({ societyId, from, to }, opts);
  const yearLines = await pl(fyStart, asOf);
  for (const [id, s] of yearLines) {
    const a = chart.get(id);
    if (a && (a.accountType === 'INCOME' || a.accountType === 'EXPENSE')) current += s.credit - s.debit;
  }
  const before = await pl(undefined, previousDay(fyStart));
  for (const [id, s] of before) {
    const a = chart.get(id);
    if (a && (a.accountType === 'INCOME' || a.accountType === 'EXPENSE')) earlier += s.credit - s.debit;
  }
  if (earlier !== 0 || q.includeZero)
    rows.push({
      code: null,
      name: 'Surplus (deficit) of earlier years not yet closed',
      section: 'RESERVES',
      isGroup: false,
      amountPaise: earlier,
    });
  rows.push({
    code: null,
    name: 'Surplus (deficit) of the current year',
    section: 'RESERVES',
    isGroup: false,
    amountPaise: current,
  });
  const sum = (...s: string[]) =>
    rows.filter(r => s.includes(r.section as string)).reduce((t, r) => t + (r.amountPaise as number), 0);
  const assetsPaise = sum('ASSETS');
  const liabilitiesPaise = sum('LIABILITIES');
  const fundsPaise = sum('FUNDS');
  const reservesPaise = sum('RESERVES');
  const totals = {
    assetsPaise,
    liabilitiesPaise,
    fundsPaise,
    reservesPaise,
    liabilitiesAndFundsPaise: liabilitiesPaise + fundsPaise + reservesPaise,
  };
  return {
    body: {
      asOf,
      financialYear: p.financialYear,
      balanced: assetsPaise === totals.liabilitiesAndFundsPaise,
      currentYearSurplusPaise: current,
      rows,
      totals,
    },
    totals: { debitPaise: assetsPaise, creditPaise: totals.liabilitiesAndFundsPaise },
    total: rows.length,
  };
}

function previousDay(ymd: string): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ------------------------------------------------------------------ general ledger
async function generalLedger(
  societyId: number,
  q: RunQuery,
  p: { from?: string; to?: string; financialYear: string },
  opts: ReadOpts,
) {
  if (!q.ledgerAccountId)
    throw new ValidationError([{ field: 'ledgerAccountId', message: 'Required for the general ledger' }]);
  const chart = await loadChart(societyId, opts);
  const account = chart.get(q.ledgerAccountId);
  if (!account) throw new NotFoundError(ERR.ledgerAccountNotFound, 'Ledger account not found');
  const ids = leavesUnder(chart, account.id);
  const debitNormal = account.accountType === 'ASSET' || account.accountType === 'EXPENSE';
  const sign = debitNormal ? 1 : -1;
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
  const page = Math.max(q.page ?? 1, 1);
  const fundSql = q.fundId ? 'AND l.fundId = :fundId' : '';
  const base = { societyId, ids: ids.length ? ids : [0], from: p.from, to: p.to, fundId: q.fundId };
  const [open] = await readRows<{ d: string | null; c: string | null }>(
    `SELECT SUM(l.debitPaise) AS d, SUM(l.creditPaise) AS c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId
      WHERE l.societyId = :societyId AND e.status = 'POSTED' AND l.ledgerAccountId IN (:ids) AND l.entryDate < :from ${fundSql}`,
    base,
    opts,
  );
  const openingPaise = sign * (n(open?.d) - n(open?.c));
  const [agg] = await readRows<{ cnt: string; d: string | null; c: string | null }>(
    `SELECT COUNT(*) AS cnt, SUM(l.debitPaise) AS d, SUM(l.creditPaise) AS c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId
      WHERE l.societyId = :societyId AND e.status = 'POSTED' AND l.ledgerAccountId IN (:ids)
        AND l.entryDate BETWEEN :from AND :to ${fundSql}`,
    base,
    opts,
  );
  const totals = { debitPaise: n(agg?.d), creditPaise: n(agg?.c) };
  const lines = await readRows<Record<string, unknown>>(
    `SELECT * FROM (
       SELECT l.id AS lineId, e.id AS entryId, l.entryDate AS date, e.voucherNo, e.voucherType, e.narration,
              a.code AS accountCode, l.lineNarration, l.debitPaise, l.creditPaise, e.refType, e.refId,
              :opening + SUM(:sign * (l.debitPaise - l.creditPaise)) OVER (ORDER BY l.entryDate, e.id, l.id) AS runningPaise
         FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId
         JOIN ledger_accounts a ON a.id = l.ledgerAccountId
        WHERE l.societyId = :societyId AND e.status = 'POSTED' AND l.ledgerAccountId IN (:ids)
          AND l.entryDate BETWEEN :from AND :to ${fundSql}
     ) x ORDER BY date, entryId, lineId LIMIT :limit OFFSET :offset`,
    { ...base, opening: openingPaise, sign, limit, offset: (page - 1) * limit },
    opts,
  );
  const rows = lines.map(r => ({
    entryId: n(r.entryId),
    date: ymdOf(r.date),
    voucherNo: r.voucherNo as string | null,
    voucherType: r.voucherType as string,
    narration: r.narration as string,
    accountCode: r.accountCode as string,
    lineNarration: (r.lineNarration as string | null) ?? null,
    debitPaise: n(r.debitPaise),
    creditPaise: n(r.creditPaise),
    runningPaise: n(r.runningPaise),
    refType: r.refType as string,
    refId: r.refId as string,
  }));
  const closingPaise = openingPaise + sign * (totals.debitPaise - totals.creditPaise);
  return {
    body: {
      ledgerAccount: {
        id: account.id,
        code: account.code,
        name: account.name,
        accountType: account.accountType,
        isGroup: account.isGroup,
      },
      from: p.from,
      to: p.to,
      normalSide: debitNormal ? 'DEBIT' : 'CREDIT',
      openingPaise,
      closingPaise,
      rows,
      totals,
      pagination: { page, limit, total: n(agg?.cnt) },
    },
    totals,
    total: n(agg?.cnt),
  };
}

export const ymdOf = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);

// ------------------------------------------------------------------ receipts and payments
async function receiptsPayments(
  societyId: number,
  _q: RunQuery,
  p: { from?: string; to?: string; financialYear: string },
  opts: ReadOpts,
) {
  const [open] = await readRows<{ d: string | null; c: string | null }>(
    `SELECT SUM(l.debitPaise) AS d, SUM(l.creditPaise) AS c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId JOIN ledger_accounts a ON a.id = l.ledgerAccountId
      WHERE l.societyId = :societyId AND e.status = 'POSTED' AND a.subtype IN ${CASH_SUBTYPES} AND l.entryDate < :from`,
    { societyId, from: p.from },
    opts,
  );
  const openingPaise = n(open?.d) - n(open?.c);
  const lines = await readRows<{
    id: number;
    code: string;
    name: string;
    receipts: string;
    payments: string;
  }>(
    `SELECT a.id, a.code, a.name,
            SUM(CASE WHEN x.net > 0 THEN l.creditPaise - l.debitPaise ELSE 0 END) AS receipts,
            SUM(CASE WHEN x.net < 0 THEN l.debitPaise - l.creditPaise ELSE 0 END) AS payments
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId JOIN ledger_accounts a ON a.id = l.ledgerAccountId
       JOIN (SELECT l2.journalEntryId AS entryId, SUM(l2.debitPaise - l2.creditPaise) AS net
               FROM journal_lines l2 JOIN ledger_accounts a2 ON a2.id = l2.ledgerAccountId
              WHERE l2.societyId = :societyId AND a2.subtype IN ${CASH_SUBTYPES} AND l2.entryDate BETWEEN :from AND :to
              GROUP BY l2.journalEntryId) x ON x.entryId = e.id
      WHERE l.societyId = :societyId AND e.status = 'POSTED' AND a.subtype NOT IN ${CASH_SUBTYPES} AND x.net <> 0
        AND NOT (a.code = '${CODE.fundTransferIn}' OR (a.accountType = 'FUND' AND EXISTS (
              SELECT 1 FROM journal_lines f JOIN ledger_accounts fa ON fa.id = f.ledgerAccountId
               WHERE f.journalEntryId = e.id AND fa.code = '${CODE.fundTransferIn}')))
      GROUP BY a.id, a.code, a.name ORDER BY a.code`,
    { societyId, from: p.from, to: p.to },
    opts,
  );
  // an account that is a cost inside a receipt (gateway charges netted from a settlement) or a recovery inside a payment (TDS held back)
  // ends negative on its side: it moves to the other side as a positive amount
  for (const l of lines) {
    let r = n(l.receipts);
    let q = n(l.payments);
    if (r < 0) [r, q] = [0, q - r];
    if (q < 0) [r, q] = [r - q, 0];
    l.receipts = String(r);
    l.payments = String(q);
  }
  const rows: Record<string, unknown>[] = [];
  for (const l of lines)
    if (n(l.receipts) !== 0)
      rows.push({ side: 'RECEIPT', code: l.code, name: l.name, amountPaise: n(l.receipts) });
  for (const l of lines)
    if (n(l.payments) !== 0)
      rows.push({ side: 'PAYMENT', code: l.code, name: l.name, amountPaise: n(l.payments) });
  const receiptsPaise = lines.reduce((s, l) => s + n(l.receipts), 0);
  const paymentsPaise = lines.reduce((s, l) => s + n(l.payments), 0);
  const closingPaise = openingPaise + receiptsPaise - paymentsPaise;
  const totals = { openingPaise, receiptsPaise, paymentsPaise, closingPaise };
  return {
    body: { from: p.from, to: p.to, financialYear: p.financialYear, rows, totals },
    totals: { debitPaise: openingPaise + receiptsPaise, creditPaise: paymentsPaise + closingPaise },
    total: rows.length,
  };
}

// ------------------------------------------------------------------ GST summary
async function gstSummary(
  societyId: number,
  _q: RunQuery,
  p: { from?: string; to?: string; financialYear: string },
  opts: ReadOpts,
) {
  const lines = await readRows<{ month: string; code: string; d: string; c: string }>(
    `SELECT DATE_FORMAT(l.entryDate, '%Y-%m') AS month, a.code, SUM(l.debitPaise) AS d, SUM(l.creditPaise) AS c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId JOIN ledger_accounts a ON a.id = l.ledgerAccountId
      WHERE l.societyId = :societyId AND e.status = 'POSTED' AND a.code IN ('2310','2320','2330','1410')
        AND l.entryDate BETWEEN :from AND :to
      GROUP BY month, a.code ORDER BY month`,
    { societyId, from: p.from, to: p.to },
    opts,
  );
  const byMonth = new Map<string, Record<string, number>>();
  for (const l of lines) {
    const m = byMonth.get(l.month) ?? {
      outputCgstPaise: 0,
      outputSgstPaise: 0,
      outputIgstPaise: 0,
      outputTotalPaise: 0,
      inputCreditPaise: 0,
      netPayablePaise: 0,
    };
    const out = n(l.c) - n(l.d);
    if (l.code === '2310') m.outputCgstPaise = out;
    else if (l.code === '2320') m.outputSgstPaise = out;
    else if (l.code === '2330') m.outputIgstPaise = out;
    else m.inputCreditPaise = n(l.d) - n(l.c);
    byMonth.set(l.month, m);
  }
  const rows = [...byMonth.entries()].map(([month, m]) => {
    m.outputTotalPaise = m.outputCgstPaise! + m.outputSgstPaise! + m.outputIgstPaise!;
    m.netPayablePaise = m.outputTotalPaise - m.inputCreditPaise!;
    return { ...m, month } as Record<string, number | string>;
  });
  const totals = {
    outputCgstPaise: 0,
    outputSgstPaise: 0,
    outputIgstPaise: 0,
    outputTotalPaise: 0,
    inputCreditPaise: 0,
    netPayablePaise: 0,
  };
  for (const r of rows)
    for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += r[k] as number;
  return {
    body: { from: p.from, to: p.to, financialYear: p.financialYear, rows, totals },
    totals: { debitPaise: totals.inputCreditPaise, creditPaise: totals.outputTotalPaise },
    total: rows.length,
  };
}

// ------------------------------------------------------------------ TDS register
async function tdsRegister(
  societyId: number,
  _q: RunQuery,
  p: { from?: string; to?: string; financialYear: string },
  opts: ReadOpts,
) {
  const lines = await readRows<Record<string, unknown>>(
    `SELECT l.entryDate AS date, e.voucherNo, e.id AS entryId, x.id AS expenseId, x.payee, x.tdsSection, x.grossAmountPaise,
            x.vendorId, x.challanNo, l.creditPaise, l.debitPaise
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId
       JOIN ledger_accounts a ON a.id = l.ledgerAccountId AND a.code = '2140'
       LEFT JOIN expenses x ON x.societyId = :societyId AND x.journalEntryId = e.id
      WHERE l.societyId = :societyId AND e.status = 'POSTED' AND e.reversalOfId IS NULL AND e.reversedByEntryId IS NULL
        AND l.entryDate BETWEEN :from AND :to
      ORDER BY l.entryDate, e.id, l.id`,
    { societyId, from: p.from, to: p.to },
    opts,
  );
  const rows = lines.map(r => ({
    date: ymdOf(r.date),
    voucherNo: r.voucherNo as string | null,
    expenseId: r.expenseId === null ? null : n(r.expenseId),
    payee: (r.payee as string | null) ?? null,
    vendorId: r.vendorId === null || r.vendorId === undefined ? null : n(r.vendorId),
    tdsSection: (r.tdsSection as string | null) ?? null,
    grossAmountPaise: r.grossAmountPaise === null ? null : n(r.grossAmountPaise),
    deductedPaise: n(r.creditPaise),
    depositedPaise: n(r.debitPaise),
    challanNo: (r.challanNo as string | null) ?? null,
  }));
  const totals = {
    deductedPaise: rows.reduce((s, r) => s + r.deductedPaise, 0),
    depositedPaise: rows.reduce((s, r) => s + r.depositedPaise, 0),
  };
  return {
    body: { from: p.from, to: p.to, financialYear: p.financialYear, rows, totals },
    totals: { debitPaise: totals.depositedPaise, creditPaise: totals.deductedPaise },
    total: rows.length,
  };
}

/** Runs one report with the 8.19 envelope. Used by the endpoint, the export job and `accountReports.run`. */
export async function runReport(
  societyId: number,
  report: AnyReport,
  q: RunQuery,
  opts: ReadOpts,
): Promise<ReportResult> {
  const p = await resolvePeriod(societyId, report, q);
  const run =
    report === 'trial-balance'
      ? trialBalance
      : report === 'income-expenditure'
        ? incomeExpenditure
        : report === 'balance-sheet'
          ? balanceSheet
          : report === 'general-ledger'
            ? generalLedger
            : report === 'receipts-payments'
              ? receiptsPayments
              : report === 'gst-summary'
                ? gstSummary
                : tdsRegister;
  const r = await (
    run as (
      s: number,
      q: RunQuery,
      p: never,
      o: ReadOpts,
    ) => Promise<{ body: ReportResult['body']; totals: ReportResult['totals']; total: number }>
  )(societyId, q, p as never, opts);
  return { report, ...r };
}
