import { QueryTypes } from 'sequelize';
import { BankAccount, LedgerAccount, sequelize } from '../../models';
import { NotFoundError, ValidationError } from '../../utils/errors';
import { ERR } from './accounts.constants';
import { n } from './accounts.shared';
import type { CashBookQuery } from './accounts.expenses.validation';

const DAY = 86_400_000;

/** The ledger ids behind `account` (`ALL`, `CASH`, `PETTY_CASH`, `BANK:<id>`) of 8.4. */
async function ledgerIds(societyId: number, account: string): Promise<number[]> {
  if (account.startsWith('BANK:')) {
    const b = await BankAccount.findOne({
      where: { id: Number(account.slice(5)), societyId },
      attributes: ['ledgerAccountId'],
    });
    if (!b) throw new NotFoundError(ERR.bankAccountNotFound, 'Bank account not found');
    return [n(b.ledgerAccountId)];
  }
  const subtypes = account === 'ALL' ? ['BANK', 'CASH', 'PETTY_CASH'] : [account];
  const rows = await LedgerAccount.findAll({
    where: { societyId, subtype: subtypes, isGroup: false },
    attributes: ['id'],
  });
  return rows.map(r => n(r.id));
}

interface Row {
  entryDate: string;
  voucherNo: string | null;
  voucherType: string;
  narration: string;
  account: string;
  inPaise: string;
  outPaise: string;
  runningPaise: string;
  refType: string;
  refId: string;
}

/**
 * `GET /accounts/cash-book` (8.4): the POSTED lines on BANK, CASH and PETTY_CASH ledgers with a running balance. The opening
 * figure is every earlier line of the selected ledgers; the running balance counts all lines, also when `direction` hides some.
 */
export async function cashBook(societyId: number, q: CashBookQuery) {
  const days = (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / DAY;
  if (days < 0) throw new ValidationError([{ field: 'to', message: 'to must not be before from' }]);
  if (days > 366) throw new ValidationError([{ field: 'to', message: 'The range is at most 366 days' }]);
  const ids = await ledgerIds(societyId, q.account);
  const empty = { openingPaise: 0, closingPaise: 0, rows: [] as unknown[] };
  const pagination = (total: number) => ({
    page: q.page,
    limit: q.limit,
    total,
    totalPages: Math.max(1, Math.ceil(total / q.limit)),
  });
  if (!ids.length) return { data: empty, pagination: pagination(0) };

  const [{ opening }] = await sequelize.query<{ opening: string | null }>(
    `SELECT COALESCE(SUM(l.debitPaise - l.creditPaise), 0) AS opening
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId
      WHERE l.societyId = :societyId AND l.ledgerAccountId IN (:ids) AND e.status = 'POSTED' AND l.entryDate < :from`,
    { replacements: { societyId, ids, from: q.from }, type: QueryTypes.SELECT },
  );
  const openingPaise = n(opening);
  const base = `
    SELECT l.id AS lineId, l.entryDate, e.id AS entryId, e.voucherNo, e.voucherType, e.narration, a.name AS account,
           l.debitPaise AS inPaise, l.creditPaise AS outPaise, e.refType, e.refId,
           :opening + SUM(l.debitPaise - l.creditPaise) OVER (ORDER BY l.entryDate, e.id, l.id) AS runningPaise
      FROM journal_lines l
      JOIN journal_entries e ON e.id = l.journalEntryId
      JOIN ledger_accounts a ON a.id = l.ledgerAccountId
     WHERE l.societyId = :societyId AND l.ledgerAccountId IN (:ids) AND e.status = 'POSTED'
       AND l.entryDate BETWEEN :from AND :to`;
  const dir =
    q.direction === 'IN' ? 'WHERE x.inPaise > 0' : q.direction === 'OUT' ? 'WHERE x.outPaise > 0' : '';
  const rep = { societyId, ids, from: q.from, to: q.to, opening: openingPaise };
  const [{ total }] = await sequelize.query<{ total: number }>(
    `SELECT COUNT(*) AS total FROM (${base}) x ${dir}`,
    { replacements: rep, type: QueryTypes.SELECT },
  );
  const [{ net }] = await sequelize.query<{ net: string | null }>(
    `SELECT COALESCE(SUM(l.debitPaise - l.creditPaise), 0) AS net FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId
      WHERE l.societyId = :societyId AND l.ledgerAccountId IN (:ids) AND e.status = 'POSTED' AND l.entryDate BETWEEN :from AND :to`,
    { replacements: rep, type: QueryTypes.SELECT },
  );
  const rows = await sequelize.query<Row>(
    `SELECT * FROM (${base}) x ${dir} ORDER BY x.entryDate, x.entryId, x.lineId LIMIT :limit OFFSET :offset`,
    { replacements: { ...rep, limit: q.limit, offset: (q.page - 1) * q.limit }, type: QueryTypes.SELECT },
  );
  return {
    data: {
      openingPaise,
      closingPaise: openingPaise + n(net),
      rows: rows.map(r => ({
        date: r.entryDate,
        voucherNo: r.voucherNo,
        voucherType: r.voucherType,
        narration: r.narration,
        account: r.account,
        inPaise: n(r.inPaise),
        outPaise: n(r.outPaise),
        runningPaise: n(r.runningPaise),
        refType: r.refType,
        refId: r.refId,
      })),
    },
    pagination: pagination(n(total)),
  };
}
