import { Op, QueryTypes, type Order, type Transaction, type WhereOptions } from 'sequelize';
import { AuditLog, Fund, JournalEntry, JournalLine, LedgerAccount, User, sequelize } from '../../models';
import { NotFoundError } from '../../utils/errors';
import { ERR } from './accounts.constants';
import { n } from './accounts.shared';
import type { ListJournalsQuery } from './accounts.journal.validation';

/** Reads of 13.1b (section 8.11): the voucher list and the voucher detail. */

export interface JournalListItem {
  id: number;
  voucherNo: string | null;
  voucherType: string;
  entryDate: string;
  documentDate: string;
  narration: string;
  refType: string;
  refId: string;
  source: string;
  status: string;
  totalPaise: number;
  reversalOfId: number | null;
  reversedByEntryId: number | null;
  createdBy: number | null;
  postedAt: string | null;
  version: number;
}

const toItem = (e: JournalEntry): JournalListItem => ({
  id: n(e.id),
  voucherNo: e.voucherNo,
  voucherType: e.voucherType,
  entryDate: e.entryDate,
  documentDate: e.documentDate,
  narration: e.narration,
  refType: e.refType,
  refId: e.refId,
  source: e.source,
  status: e.status,
  totalPaise: n(e.totalPaise),
  reversalOfId: e.reversalOfId ? n(e.reversalOfId) : null,
  reversedByEntryId: e.reversedByEntryId ? n(e.reversedByEntryId) : null,
  createdBy: e.createdBy ? n(e.createdBy) : null,
  postedAt: e.postedAt ? e.postedAt.toISOString() : null,
  version: n(e.version),
});

const SORT: Record<ListJournalsQuery['sortBy'], string> = {
  entryDate: 'entryDate',
  voucherNo: 'voucherNo',
  totalPaise: 'totalPaise',
  createdAt: 'createdAt',
};

/** `GET /accounts/journals`: every voucher of the society, system and manual, with filters and pagination. */
export async function listJournals(societyId: number, q: ListJournalsQuery) {
  const and: WhereOptions[] = [{ societyId }];
  if (q.from) and.push({ entryDate: { [Op.gte]: q.from } });
  if (q.to) and.push({ entryDate: { [Op.lte]: q.to } });
  if (q.voucherType) and.push({ voucherType: q.voucherType });
  if (q.status) and.push({ status: { [Op.in]: q.status } });
  if (q.source) and.push({ source: q.source });
  if (q.refType) and.push({ refType: q.refType });
  if (q.minAmountPaise !== undefined) and.push({ totalPaise: { [Op.gte]: q.minAmountPaise } });
  if (q.maxAmountPaise !== undefined) and.push({ totalPaise: { [Op.lte]: q.maxAmountPaise } });
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    and.push({ [Op.or]: [{ voucherNo: { [Op.like]: like } }, { narration: { [Op.like]: like } }] });
  }
  // lines are filtered through a parameterised sub-select on the indexed columns
  const lineFilter: string[] = [];
  const repl: Record<string, number> = { societyId };
  if (q.ledgerAccountId) {
    lineFilter.push('jl.ledgerAccountId = :ledgerAccountId');
    repl.ledgerAccountId = q.ledgerAccountId;
  }
  if (q.fundId) {
    lineFilter.push('jl.fundId = :fundId');
    repl.fundId = q.fundId;
  }
  if (lineFilter.length) {
    const rows = await sequelize.query<{ id: number }>(
      `SELECT DISTINCT jl.journalEntryId AS id FROM journal_lines jl WHERE jl.societyId = :societyId AND ${lineFilter.join(' AND ')}`,
      { replacements: repl, type: QueryTypes.SELECT },
    );
    and.push({ id: { [Op.in]: rows.length ? rows.map(r => n(r.id)) : [0] } });
  }
  const order: Order = [
    [SORT[q.sortBy], q.sortOrder.toUpperCase()],
    ['id', q.sortOrder.toUpperCase()],
  ];
  const { rows, count } = await JournalEntry.findAndCountAll({
    where: { [Op.and]: and },
    order,
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return {
    data: rows.map(toItem),
    pagination: { page: q.page, limit: q.limit, total: count, totalPages: Math.ceil(count / q.limit) },
  };
}

/** `{ refType, refId, label }` of section 8.11: what the voucher was posted for. */
export function sourceLink(e: Pick<JournalEntry, 'refType' | 'refId' | 'narration'>) {
  const names: Record<string, string> = {
    invoice: 'Invoice',
    credit_note: 'Credit note',
    payment: 'Payment',
    payment_reversal: 'Payment reversal',
    cheque_clearance: 'Cheque clearance',
    payment_realloc: 'Payment reallocation',
    refund: 'Refund',
    expense: 'Expense',
    settlement: 'Settlement',
    deposit: 'Deposit',
    fund_transfer: 'Fund transfer',
    statement_line: 'Bank statement line',
    opening: 'Opening balances',
    closing: 'Year-end closing',
    vendor_bill: 'Vendor bill',
  };
  if (e.refType === 'manual_journal') return { refType: e.refType, refId: e.refId, label: 'Manual journal' };
  const name = names[e.refType] ?? e.refType.replace(/_/g, ' ');
  return { refType: e.refType, refId: e.refId, label: `${name} ${e.refId}` };
}

const brief = (e: JournalEntry | null) =>
  e ? { id: n(e.id), voucherNo: e.voucherNo, entryDate: e.entryDate, narration: e.narration } : null;

/** `GET /accounts/journals/:id`: entry, lines with account code and name, reversal links, source link and timeline. */
export async function getJournal(societyId: number, id: number, t?: Transaction) {
  const e = await JournalEntry.findOne({ where: { id, societyId }, transaction: t });
  if (!e) throw new NotFoundError(ERR.journalNotFound, 'Journal entry not found');
  const lines = await JournalLine.findAll({
    where: { journalEntryId: id },
    order: [['lineNo', 'ASC']],
    transaction: t,
  });
  const accountIds = [...new Set(lines.map(l => n(l.ledgerAccountId)))];
  const fundIds = [...new Set(lines.filter(l => l.fundId).map(l => n(l.fundId)))];
  const [accounts, funds, reversedBy, reversalOf, timeline] = await Promise.all([
    accountIds.length
      ? LedgerAccount.findAll({
          where: { societyId, id: accountIds },
          attributes: ['id', 'code', 'name'],
          transaction: t,
        })
      : [],
    fundIds.length
      ? Fund.findAll({ where: { societyId, id: fundIds }, attributes: ['id', 'name'], transaction: t })
      : [],
    e.reversedByEntryId
      ? JournalEntry.findOne({ where: { id: e.reversedByEntryId, societyId }, transaction: t })
      : null,
    e.reversalOfId
      ? JournalEntry.findOne({ where: { id: e.reversalOfId, societyId }, transaction: t })
      : null,
    AuditLog.findAll({
      where: { societyId, entityType: 'journal_entry', entityId: String(id) },
      order: [
        ['createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
      transaction: t,
    }),
  ]);
  const acc = new Map(accounts.map(a => [n(a.id), a]));
  const fund = new Map(funds.map(f => [n(f.id), f]));
  const userIds = [...new Set([e.createdBy, e.postedBy].filter((v): v is number => Boolean(v)))];
  const users = userIds.length
    ? await User.findAll({ where: { id: userIds }, attributes: ['id', 'name'], transaction: t })
    : [];
  const nameOf = (uid: number | null) => (uid ? (users.find(u => n(u.id) === uid)?.name ?? null) : null);
  const debit = lines.reduce((s, l) => s + n(l.debitPaise), 0);
  const credit = lines.reduce((s, l) => s + n(l.creditPaise), 0);
  return {
    ...toItem(e),
    financialYear: e.financialYear,
    instrumentRef: e.instrumentRef,
    approvalRequestId: e.approvalRequestId ? n(e.approvalRequestId) : null,
    rejectionReason: e.rejectionReason,
    reversedAt: e.reversedAt ? e.reversedAt.toISOString() : null,
    reversalReason: e.reversalReason,
    createdByName: nameOf(e.createdBy ? n(e.createdBy) : null),
    postedByName: nameOf(e.postedBy ? n(e.postedBy) : null),
    difference: debit - credit,
    debitPaise: debit,
    creditPaise: credit,
    lines: lines.map(l => ({
      lineNo: n(l.lineNo),
      ledgerAccountId: n(l.ledgerAccountId),
      ledgerAccountCode: acc.get(n(l.ledgerAccountId))?.code ?? null,
      ledgerAccountName: acc.get(n(l.ledgerAccountId))?.name ?? null,
      fundId: l.fundId ? n(l.fundId) : null,
      fundName: l.fundId ? (fund.get(n(l.fundId))?.name ?? null) : null,
      debitPaise: n(l.debitPaise),
      creditPaise: n(l.creditPaise),
      lineNarration: l.lineNarration,
    })),
    reversalOf: brief(reversalOf),
    reversedBy: brief(reversedBy),
    sourceLink: sourceLink(e),
    timeline: timeline.map(a => ({
      at: a.createdAt?.toISOString() ?? null,
      action: a.action,
      actorName: a.actorName,
      actorRole: a.actorRole,
      reason: a.reason,
    })),
  };
}
export type JournalDetail = Awaited<ReturnType<typeof getJournal>>;
