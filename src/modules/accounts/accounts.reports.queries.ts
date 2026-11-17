import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';
import { ReadTimeoutError } from './accounts.readers';
import type { ReadOpts } from './accounts.types';
import { n } from './accounts.shared';

/**
 * SQL of the 8.19 reports and the 8.21 readers (13.4b). Every statement is read-only, scoped by `societyId`, counts POSTED entries
 * only and runs with the optimizer deadline of `opts.deadlineMs` (MySQL `MAX_EXECUTION_TIME`); a timeout becomes `ReadTimeoutError`.
 */
const TIMEOUT_CODES = new Set([3024, 1317, 1969]);
const isTimeout = (err: unknown): boolean => {
  const e = err as { original?: { errno?: number }; parent?: { errno?: number }; errno?: number };
  return TIMEOUT_CODES.has(Number(e?.original?.errno ?? e?.parent?.errno ?? e?.errno));
};

export const DEFAULT_DEADLINE_MS = 20_000;

/** A SELECT with the read deadline. The statement must start with `SELECT`. */
export async function readRows<T extends object>(
  sql: string,
  replacements: Record<string, unknown>,
  opts: Partial<ReadOpts> = {},
): Promise<T[]> {
  const deadline = Math.floor(opts.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const text = sql.replace(/^\s*SELECT\b/i, `SELECT /*+ MAX_EXECUTION_TIME(${deadline}) */`);
  try {
    return await sequelize.query<T>(text, { replacements, type: QueryTypes.SELECT });
  } catch (err) {
    if (isTimeout(err)) throw new ReadTimeoutError(deadline);
    throw err;
  }
}

export const CASH_SUBTYPES = "('BANK','CASH','PETTY_CASH')";

// ------------------------------------------------------------------ the chart as a tree
export interface AccountNode {
  id: number;
  code: string;
  name: string;
  accountType: 'ASSET' | 'LIABILITY' | 'FUND' | 'INCOME' | 'EXPENSE';
  subtype: string;
  parentId: number | null;
  isGroup: boolean;
  transparencyCategory: string | null;
  depth: number;
  /** Debit and credit sums of the node and all leaves below it. */
  debit: number;
  credit: number;
}

export async function loadChart(
  societyId: number,
  opts: Partial<ReadOpts>,
): Promise<Map<number, AccountNode>> {
  const rows = await readRows<Record<string, unknown>>(
    `SELECT id, code, name, accountType, subtype, parentId, isGroup, transparencyCategory
       FROM ledger_accounts WHERE societyId = :societyId ORDER BY code`,
    { societyId },
    opts,
  );
  const map = new Map<number, AccountNode>();
  for (const r of rows)
    map.set(n(r.id), {
      id: n(r.id),
      code: String(r.code),
      name: String(r.name),
      accountType: r.accountType as AccountNode['accountType'],
      subtype: String(r.subtype),
      parentId: r.parentId === null ? null : n(r.parentId),
      isGroup: Boolean(n(r.isGroup)),
      transparencyCategory: (r.transparencyCategory as string | null) ?? null,
      depth: 1,
      debit: 0,
      credit: 0,
    });
  for (const a of map.values()) {
    let d = 1;
    for (let p = a.parentId; p !== null; p = map.get(p)?.parentId ?? null) d++;
    a.depth = d;
  }
  return map;
}

export interface SumFilter {
  societyId: number;
  from?: string;
  to?: string;
  /** Leave the `CLOSING` voucher out (income and expenditure of a period). */
  noClosing?: boolean;
  fundId?: number;
}

/** Debit and credit sums per ledger account of POSTED lines in the window. */
export async function sumsByAccount(
  f: SumFilter,
  opts: Partial<ReadOpts>,
): Promise<Map<number, { debit: number; credit: number }>> {
  const rows = await readRows<{ id: number; d: string; c: string }>(
    `SELECT l.ledgerAccountId AS id, SUM(l.debitPaise) AS d, SUM(l.creditPaise) AS c
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId
      WHERE l.societyId = :societyId AND e.societyId = :societyId AND e.status = 'POSTED'
        ${f.from ? 'AND l.entryDate >= :from' : ''} ${f.to ? 'AND l.entryDate <= :to' : ''}
        ${f.noClosing ? "AND e.voucherType <> 'CLOSING'" : ''} ${f.fundId ? 'AND l.fundId = :fundId' : ''}
      GROUP BY l.ledgerAccountId`,
    { societyId: f.societyId, from: f.from, to: f.to, fundId: f.fundId },
    opts,
  );
  return new Map(rows.map(r => [n(r.id), { debit: n(r.d), credit: n(r.c) }]));
}

/** Rolls the leaf sums up into every group of the tree (fills `debit` and `credit`). */
export function rollUp(
  chart: Map<number, AccountNode>,
  sums: Map<number, { debit: number; credit: number }>,
): void {
  for (const a of chart.values()) {
    a.debit = 0;
    a.credit = 0;
  }
  for (const [id, s] of sums) {
    for (let a = chart.get(id); a; a = a.parentId === null ? undefined : chart.get(a.parentId)) {
      a.debit += s.debit;
      a.credit += s.credit;
    }
  }
}

/** The nodes to show at `level`: leaves of depth at most `level` and the groups at exactly `level`, by code. */
export function visibleNodes(chart: Map<number, AccountNode>, level: number): AccountNode[] {
  return [...chart.values()]
    .filter(a => a.depth <= level && (!a.isGroup || a.depth === level))
    .sort((x, y) => (x.code < y.code ? -1 : x.code > y.code ? 1 : 0));
}

/** All leaf ledger ids at or below `id` (the account itself when it is a leaf). */
export function leavesUnder(chart: Map<number, AccountNode>, id: number): number[] {
  const out: number[] = [];
  const walk = (node: AccountNode) => {
    if (!node.isGroup) out.push(node.id);
    else for (const c of chart.values()) if (c.parentId === node.id) walk(c);
  };
  const root = chart.get(id);
  if (root) walk(root);
  return out;
}
