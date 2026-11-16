import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';
import { diffDays } from '../billing/billing.calc.period';
import { ReadTimeoutError, invoices } from '../billing/billing.public';
import { paymentsPorts } from './payments.ports';
import { n } from './payments.shared';

/**
 * Report readers for module 24 (section 8.27). Read-only, no audit, `societyId` from the caller; a read that cannot finish in
 * `deadlineMs` throws `ReadTimeoutError` (MySQL `MAX_EXECUTION_TIME`). There is no read replica yet: `opts.replica` is accepted
 * and ignored. `GET /payments/summary` and `GET /payments/export` use the same aggregate functions, so endpoint and reader
 * cannot drift.
 */
export { ReadTimeoutError };
export interface ReadOpts {
  deadlineMs: number;
  replica?: boolean;
}
export interface RegisterQuery {
  from: string;
  to: string;
  method?: string[];
  status?: string[];
  unitId?: number;
  piiClass?: 'masked' | 'unmasked';
  page: number;
  limit: number;
  sortBy: 'paymentDate' | 'amountPaise' | 'receiptNo';
  sortDir: 'asc' | 'desc';
  buildingIds?: number[];
}
export interface CollectionProgressQuery {
  status?: string[];
  kind?: string[];
  page: number;
  limit: number;
  sortBy: 'dueDate' | 'title' | 'collectedPaise' | 'percent';
  sortDir: 'asc' | 'desc';
  buildingIds?: number[];
}

const TIMEOUT_CODES = new Set([3024, 1317, 1969]);
const isTimeout = (err: unknown): boolean => {
  const e = err as { original?: { errno?: number }; parent?: { errno?: number }; errno?: number };
  return TIMEOUT_CODES.has(Number(e?.original?.errno ?? e?.parent?.errno ?? e?.errno));
};

/** A SELECT with the optimizer deadline; the timeout error becomes `ReadTimeoutError`. */
export async function readRows<T extends object>(
  sql: string,
  replacements: Record<string, unknown>,
  opts: Partial<ReadOpts> = {},
): Promise<T[]> {
  const text = opts.deadlineMs
    ? sql.replace(/^\s*SELECT\b/i, `SELECT /*+ MAX_EXECUTION_TIME(${Math.floor(opts.deadlineMs)}) */`)
    : sql;
  try {
    return await sequelize.query<T>(text, { replacements, type: QueryTypes.SELECT });
  } catch (err) {
    if (isTimeout(err)) throw new ReadTimeoutError();
    throw err;
  }
}

const EFFECTIVE_SQL = "('CAPTURED','CONFIRMED','RECEIVED','DEPOSITED','CLEARED')";
/** Date a payment was taken out: reversal timestamp, bounce date or (returned to payer) the last update, all in IST. */
const REVERSAL_DATE_SQL = `COALESCE(DATE(DATE_ADD(p.reversedAt, INTERVAL 330 MINUTE)), p.bouncedOn, DATE(DATE_ADD(p.updatedAt, INTERVAL 330 MINUTE)))`;
const IST = (col: string) => `DATE(DATE_ADD(${col}, INTERVAL 330 MINUTE))`;

export interface Totals {
  receivedPaise: number;
  paymentCount: number;
  byMethod: Record<string, number>;
  reversedPaise: number;
  reversedByMethod: Record<string, number>;
  /** Taken out in the window but dated before it: the part of `reversedPaise` that lowers this window's cash (8.13). */
  carriedPaise: number;
  carriedByMethod: Record<string, number>;
}

/** Effective payments by `paymentDate` in `[from, to]` and the payments taken out in the same window (8.13, 8.27). */
export async function paymentTotals(
  societyId: number,
  from: string,
  to: string,
  opts: Partial<ReadOpts> = {},
): Promise<Totals> {
  const rec = await readRows<{ method: string; amount: string; cnt: string }>(
    `SELECT p.method AS method, SUM(p.amountPaise) AS amount, COUNT(*) AS cnt FROM payments p
      WHERE p.societyId = :societyId AND p.status IN ${EFFECTIVE_SQL} AND p.paymentDate BETWEEN :from AND :to
      GROUP BY p.method`,
    { societyId, from, to },
    opts,
  );
  const rev = await readRows<{ method: string; amount: string; carried: string }>(
    `SELECT p.method AS method, SUM(p.amountPaise) AS amount,
            SUM(CASE WHEN p.paymentDate BETWEEN :from AND :to THEN 0 ELSE p.amountPaise END) AS carried
       FROM payments p
      WHERE p.societyId = :societyId AND p.status IN ('REVERSED','BOUNCED','RETURNED')
        AND ${REVERSAL_DATE_SQL} BETWEEN :from AND :to
      GROUP BY p.method`,
    { societyId, from, to },
    opts,
  );
  const t: Totals = {
    receivedPaise: 0,
    paymentCount: 0,
    byMethod: {},
    reversedPaise: 0,
    reversedByMethod: {},
    carriedPaise: 0,
    carriedByMethod: {},
  };
  for (const r of rec) {
    t.receivedPaise += n(r.amount);
    t.paymentCount += n(r.cnt);
    t.byMethod[r.method] = n(r.amount);
  }
  for (const r of rev) {
    t.reversedPaise += n(r.amount);
    t.reversedByMethod[r.method] = n(r.amount);
    t.carriedPaise += n(r.carried);
    t.carriedByMethod[r.method] = n(r.carried);
  }
  return t;
}

/** Collected against the invoices billed for a month: net allocations (reversals are negative rows) on those invoices. */
export async function efficiencyForMonth(
  societyId: number,
  month: string,
  opts: Partial<ReadOpts> = {},
): Promise<{ billedPaise: number; collectedPaise: number; percent: number }> {
  const { billedPaise, invoiceIds } = await invoices.billedForMonth(societyId, month);
  let collected = 0;
  for (let i = 0; i < invoiceIds.length; i += 1000) {
    const [r] = await readRows<{ amount: string | null }>(
      `SELECT SUM(a.amountPaise) AS amount FROM payment_allocations a
        WHERE a.societyId = :societyId AND a.invoiceId IN (:ids)`,
      { societyId, ids: invoiceIds.slice(i, i + 1000) },
      opts,
    );
    collected += n(r?.amount);
  }
  collected = Math.max(0, collected);
  return {
    billedPaise,
    collectedPaise: collected,
    percent: billedPaise > 0 ? Math.round((collected * 100) / billedPaise) : 0,
  };
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
function checkRange(from: string, to: string): void {
  if (!YMD.test(from) || !YMD.test(to) || from > to) throw new Error('paymentsReports: invalid date range');
  if (diffDays(from, to) > 3 * 366) throw new Error('paymentsReports: range above 3 years');
}
const monthsBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  let m = from.slice(0, 7);
  while (m <= to.slice(0, 7)) {
    out.push(m);
    const [y, mo] = m.split('-').map(Number) as [number, number];
    m = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
  }
  return out;
};

/** `R*** S****`: the first letter of each word followed by asterisks (8.27). */
export const maskName = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => `${[...w][0]}${'*'.repeat(Math.max(3, [...w].length - 1))}`)
    .join(' ');

const REGISTER_SORT = {
  paymentDate: 'p.paymentDate',
  amountPaise: 'p.amountPaise',
  receiptNo: 'p.receiptNo',
};
const PROGRESS_SORT = {
  dueDate: 'dueDate',
  title: 'title',
  collectedPaise: 'collectedPaise',
  percent: 'percent',
};

export const paymentsReports = {
  summary: async (societyId: number, from: string, to: string, opts: Partial<ReadOpts> = {}) => {
    checkRange(from, to);
    const t = await paymentTotals(societyId, from, to, opts);
    const [ref] = await readRows<{ amount: string | null }>(
      `SELECT SUM(r.amountPaise) AS amount FROM refunds r
        WHERE r.societyId = :societyId AND r.status = 'PROCESSED' AND ${IST('r.processedAt')} BETWEEN :from AND :to`,
      { societyId, from, to },
      opts,
    );
    const [adv] = await readRows<{ amount: string | null }>(
      `SELECT SUM(a.amountPaise) AS amount FROM unit_advances a
        WHERE a.societyId = :societyId AND a.entryType = 'PAYMENT_EXCESS' AND ${IST('a.createdAt')} BETWEEN :from AND :to`,
      { societyId, from, to },
      opts,
    );
    let billed = 0;
    let collected = 0;
    for (const m of monthsBetween(from, to)) {
      const e = await efficiencyForMonth(societyId, m, opts);
      billed += e.billedPaise;
      collected += e.collectedPaise;
    }
    return {
      receivedPaise: t.receivedPaise,
      reversedPaise: t.reversedPaise,
      refundedPaise: n(ref?.amount),
      paymentCount: t.paymentCount,
      byMethod: t.byMethod,
      advanceCreditedPaise: n(adv?.amount),
      efficiencyPercent: billed > 0 ? Math.round((collected * 100) / billed) : null,
    };
  },

  register: async (societyId: number, q: RegisterQuery, opts: Partial<ReadOpts> = {}) => {
    checkRange(q.from, q.to);
    if (!(q.sortBy in REGISTER_SORT)) throw new Error(`paymentsReports.register: sortBy ${q.sortBy}`);
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 1000)
      throw new Error('paymentsReports.register: limit must be 1 to 1000');
    if (!Number.isInteger(q.page) || q.page < 1) throw new Error('paymentsReports.register: bad page');
    const rep: Record<string, unknown> = { societyId, from: q.from, to: q.to };
    let where = 'p.societyId = :societyId AND p.paymentDate BETWEEN :from AND :to';
    if (q.method?.length) {
      where += ' AND p.method IN (:methods)';
      rep.methods = q.method;
    }
    if (q.status?.length) {
      where += ' AND p.status IN (:statuses)';
      rep.statuses = q.status;
    }
    if (q.unitId) {
      where += ' AND p.unitId = :unitId';
      rep.unitId = q.unitId;
    }
    if (q.buildingIds?.length) {
      where += ' AND u.buildingId IN (:buildingIds)';
      rep.buildingIds = q.buildingIds;
    }
    const from = 'FROM payments p JOIN units u ON u.id = p.unitId';
    const [tot] = await readRows<{ total: string; amount: string | null; refunded: string | null }>(
      `SELECT COUNT(*) AS total, SUM(p.amountPaise) AS amount, SUM(p.refundedPaise) AS refunded ${from} WHERE ${where}`,
      rep,
      opts,
    );
    const dir = q.sortDir === 'asc' ? 'ASC' : 'DESC';
    const rows = await readRows<Record<string, unknown>>(
      `SELECT p.id, p.receiptNo, DATE_FORMAT(p.paymentDate, '%Y-%m-%d') AS paymentDate, u.label AS unitLabel, p.payerName,
              p.method, p.status, p.referenceNo, p.amountPaise, p.convenienceFeePaise, p.toInvoicesPaise,
              p.toCollectionsPaise, p.toAdvancePaise, p.refundedPaise
         ${from} WHERE ${where} ORDER BY ${REGISTER_SORT[q.sortBy]} ${dir}, p.id ${dir}
        LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
      rep,
      opts,
    );
    const unmasked = q.piiClass === 'unmasked';
    return {
      rows: rows.map(r => ({
        id: n(r.id),
        receiptNo: (r.receiptNo as string | null) ?? null,
        paymentDate: r.paymentDate as string,
        unitLabel: r.unitLabel as string,
        payerName: unmasked ? (r.payerName as string) : maskName(String(r.payerName ?? '')),
        method: r.method as string,
        status: r.status as string,
        referenceNo: (r.referenceNo as string | null) ?? null,
        amountPaise: n(r.amountPaise),
        convenienceFeePaise: n(r.convenienceFeePaise),
        toInvoicesPaise: n(r.toInvoicesPaise),
        toCollectionsPaise: n(r.toCollectionsPaise),
        toAdvancePaise: n(r.toAdvancePaise),
        refundedPaise: n(r.refundedPaise),
      })),
      total: n(tot?.total),
      totals: { amountPaise: n(tot?.amount), refundedPaise: n(tot?.refunded) },
    };
  },

  collectionProgress: async (societyId: number, q: CollectionProgressQuery, opts: Partial<ReadOpts> = {}) => {
    if (!(q.sortBy in PROGRESS_SORT))
      throw new Error(`paymentsReports.collectionProgress: sortBy ${q.sortBy}`);
    if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > 1000)
      throw new Error('paymentsReports.collectionProgress: limit must be 1 to 1000');
    const rep: Record<string, unknown> = { societyId };
    let where = 'c.societyId = :societyId AND c.deletedAt IS NULL';
    if (q.status?.length) {
      where += ' AND c.status IN (:statuses)';
      rep.statuses = q.status;
    }
    if (q.kind?.length) {
      where += ' AND c.kind IN (:kinds)';
      rep.kinds = q.kind;
    }
    const scoped = Boolean(q.buildingIds?.length);
    if (scoped) rep.buildingIds = q.buildingIds;
    // with buildings, the counts and money are recomputed from the requests of those buildings and flats without requests are left out
    const joinReq = scoped
      ? `JOIN collection_requests r ON r.collectionId = c.id AND r.status <> 'CANCELLED'
         JOIN units u ON u.id = r.unitId AND u.buildingId IN (:buildingIds)`
      : `LEFT JOIN collection_requests r ON r.collectionId = c.id AND r.status <> 'CANCELLED'`;
    const base = `FROM collections c ${joinReq} WHERE ${where} GROUP BY c.id`;
    const select = `SELECT c.id, c.title, c.kind, c.isMandatory, c.status, c.targetPaise, c.fundId,
        DATE_FORMAT(c.dueDate, '%Y-%m-%d') AS dueDate, COUNT(r.id) AS requestCount,
        COALESCE(SUM(r.status = 'PAID'), 0) AS paidCount, COALESCE(SUM(r.paidPaise > 0), 0) AS contributorCount,
        COALESCE(SUM(r.paidPaise), 0) AS collectedPaise,
        CASE WHEN c.targetPaise > 0 THEN ROUND(COALESCE(SUM(r.paidPaise), 0) * 100 / c.targetPaise) ELSE 0 END AS percent`;
    const dir = q.sortDir === 'asc' ? 'ASC' : 'DESC';
    const all = await readRows<Record<string, unknown>>(
      `${select} ${base} ORDER BY ${PROGRESS_SORT[q.sortBy]} ${dir}, c.id ${dir}`,
      rep,
      opts,
    );
    const pageRows = all.slice((q.page - 1) * q.limit, q.page * q.limit);
    const rows = [];
    for (const r of pageRows) {
      const fund = await paymentsPorts()
        .funds.name(societyId, n(r.fundId))
        .catch(() => null);
      rows.push({
        id: n(r.id),
        title: r.title as string,
        kind: r.kind as string,
        isMandatory: Boolean(r.isMandatory),
        status: r.status as string,
        targetPaise: n(r.targetPaise),
        collectedPaise: n(r.collectedPaise),
        percent: n(r.percent),
        requestCount: n(r.requestCount),
        paidCount: n(r.paidCount),
        contributorCount: n(r.contributorCount),
        dueDate: r.dueDate as string,
        fundName: fund ?? '',
        // module 13 `expenses.listForCollection` is not built yet: null means "cannot answer"
        spentPaise: null as number | null,
      });
    }
    return {
      rows,
      total: all.length,
      totals: {
        targetPaise: all.reduce((a, r) => a + n(r.targetPaise), 0),
        collectedPaise: all.reduce((a, r) => a + n(r.collectedPaise), 0),
      },
    };
  },
};
