import { Op, type WhereOptions } from 'sequelize';
import { Expense, JournalLine, LedgerAccount, User } from '../../models';
import type { Ctx } from '../../types/context';
import { audit } from '../../utils/audit';
import { NotFoundError } from '../../utils/errors';
import { toCsv } from '../society-setup/society-setup.csv';
import { AUDIT, ERR, PERM } from './accounts.constants';
import { placeholderAccountsApprovals } from './accounts.ports';
import { n } from './accounts.shared';
import { billFileInfo, billFiles } from './accounts.expenses.files';
import { displayId, ledgerLabels } from './accounts.expenses.shared';
import type { ExpenseListQuery } from './accounts.expenses.validation';

export const EXPORT_MAX_ROWS = 50_000;

export async function loadExpense(societyId: number, id: number): Promise<Expense> {
  const e = await Expense.findOne({ where: { id, societyId } });
  if (!e) throw new NotFoundError(ERR.expenseNotFound, 'Expense not found');
  return e;
}

type Labels = Awaited<ReturnType<typeof ledgerLabels>>;
export function expenseDto(e: Expense, labels: Labels, makers?: Map<number, string>) {
  const head = labels.get(n(e.ledgerAccountId)) ?? null;
  const paidFrom = labels.get(n(e.paidFromLedgerAccountId)) ?? null;
  return {
    id: n(e.id),
    displayId: displayId(n(e.id)),
    status: e.status,
    voucherNo: e.voucherNo,
    expenseType: e.expenseType,
    expenseDate: e.expenseDate,
    payee: e.payee,
    description: e.description,
    ledgerAccount: head,
    grossAmountPaise: n(e.grossAmountPaise),
    gstPaise: n(e.gstPaise),
    tdsPaise: n(e.tdsPaise),
    tdsSection: e.tdsSection,
    challanNo: e.challanNo,
    netPaidPaise: n(e.netPaidPaise),
    paidFrom,
    bankAccountId: e.bankAccountId ? n(e.bankAccountId) : null,
    paymentMode: e.paymentMode,
    paymentReference: e.paymentReference,
    fundId: e.fundId ? n(e.fundId) : null,
    collectionId: e.collectionId ? n(e.collectionId) : null,
    vendorId: e.vendorId ? n(e.vendorId) : null,
    vendorBillId: e.vendorBillId ? n(e.vendorBillId) : null,
    billFileCount: n(e.billFileCount),
    approvalRequestId: e.approvalRequestId ? n(e.approvalRequestId) : null,
    rejectionReason: e.rejectionReason,
    cancelReason: e.cancelReason,
    reversalReason: e.reversalReason,
    postedAt: e.postedAt ? e.postedAt.toISOString() : null,
    reversedAt: e.reversedAt ? e.reversedAt.toISOString() : null,
    createdBy: n(e.createdBy),
    createdByName: makers?.get(n(e.createdBy)) || null,
    createdAt: e.createdAt.toISOString(),
    version: n(e.version),
  };
}

const labelIds = (rows: Expense[]): number[] =>
  rows.flatMap(e => [n(e.ledgerAccountId), n(e.paidFromLedgerAccountId)]);

/** The names of the makers, so the list can say who entered each expense. */
async function makerNames(rows: Expense[]): Promise<Map<number, string>> {
  const ids = [...new Set(rows.map(e => n(e.createdBy)).filter(Boolean))];
  if (!ids.length) return new Map();
  const users = await User.findAll({ where: { id: ids }, attributes: ['id', 'name'] });
  return new Map(users.map(u => [n(u.id), u.name ?? '']));
}

/** The list item shape, or the same plus the 8.5 detail parts. */
export async function viewExpense(ctx: Ctx, id: number, detail = false) {
  const e = await loadExpense(ctx.society!.id, id);
  const labels = await ledgerLabels(labelIds([e]));
  const makers = await makerNames([e]);
  const dto = expenseDto(e, labels, makers);
  if (!detail) return dto;

  const files = billFiles()
    .list(id)
    .map(billFileInfo)
    .filter((f): f is NonNullable<typeof f> => f !== null);
  const lines = e.journalEntryId
    ? await JournalLine.findAll({
        where: { journalEntryId: n(e.journalEntryId) },
        order: [['lineNo', 'ASC']],
      })
    : [];
  const lineLabels = await ledgerLabels(lines.map(l => n(l.ledgerAccountId)));
  const req = e.approvalRequestId ? placeholderAccountsApprovals.get(n(e.approvalRequestId)) : undefined;
  const mine = ctx.user?.id === n(e.createdBy);
  const canApprove = e.status === 'PENDING_APPROVAL' && ctx.permissions?.has(PERM.expensesApprove) && !mine;
  const canReverse = e.status === 'POSTED' && ctx.permissions?.has(PERM.expensesApprove) && !mine;
  return {
    ...dto,
    files,
    approval: e.approvalRequestId ? { requestId: n(e.approvalRequestId), status: req?.status ?? null } : null,
    journal: e.journalEntryId
      ? {
          id: n(e.journalEntryId),
          voucherNo: e.voucherNo,
          reversalJournalEntryId: e.reversalJournalEntryId ? n(e.reversalJournalEntryId) : null,
          lines: lines.map(l => ({
            ledgerAccount: lineLabels.get(n(l.ledgerAccountId)) ?? null,
            debitPaise: n(l.debitPaise),
            creditPaise: n(l.creditPaise),
            fundId: l.fundId ? n(l.fundId) : null,
          })),
        }
      : null,
    canApprove,
    canReverse,
  };
}

async function where(ctx: Ctx, q: Omit<ExpenseListQuery, 'page' | 'limit'>): Promise<WhereOptions> {
  const societyId = ctx.society!.id;
  const w: Record<string | symbol, unknown> = { societyId };
  if (q.status) w.status = q.status;
  if (q.expenseType) w.expenseType = q.expenseType;
  if (q.from || q.to)
    w.expenseDate = { ...(q.from ? { [Op.gte]: q.from } : {}), ...(q.to ? { [Op.lte]: q.to } : {}) };
  if (q.ledgerAccountId) w.ledgerAccountId = q.ledgerAccountId;
  if (q.fundId) w.fundId = q.fundId;
  if (q.collectionId) w.collectionId = q.collectionId;
  if (q.vendorId) w.vendorId = q.vendorId;
  if (q.createdByMe) w.createdBy = ctx.user?.id ?? 0;
  if (q.paidFrom) {
    const ids = (
      await LedgerAccount.findAll({ where: { societyId, subtype: q.paidFrom }, attributes: ['id'] })
    ).map(l => n(l.id));
    w.paidFromLedgerAccountId = { [Op.in]: ids.length ? ids : [0] };
  }
  const and: WhereOptions[] = [w];
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, m => `\\${m}`)}%`;
    const m = /^EXP-(\d+)$/i.exec(q.q);
    and.push({
      [Op.or]: [
        { payee: { [Op.like]: like } },
        { description: { [Op.like]: like } },
        { voucherNo: { [Op.like]: like } },
        ...(m ? [{ id: Number(m[1]) }] : []),
      ],
    });
  }
  return { [Op.and]: and };
}

export async function listExpenses(ctx: Ctx, q: ExpenseListQuery) {
  const w = await where(ctx, q);
  const order: [string, string][] = [[q.sortBy, q.sortOrder.toUpperCase()]];
  if (q.sortBy !== 'expenseDate') order.push(['expenseDate', 'DESC']);
  order.push(['id', 'DESC']);
  const { rows, count } = await Expense.findAndCountAll({
    where: w,
    order,
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const labels = await ledgerLabels(labelIds(rows));
  const makers = await makerNames(rows);
  return {
    data: rows.map(e => expenseDto(e, labels, makers)),
    pagination: {
      page: q.page,
      limit: q.limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / q.limit)),
    },
  };
}

const rupees = (paise: number): string => {
  const abs = Math.abs(paise);
  return `${paise < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

/** 8.9: the filtered expenses as CSV (synchronous here; the `accounts:report-export` job belongs to 13.4), at most 50,000 rows, audited. */
export async function exportExpenses(ctx: Ctx, q: Omit<ExpenseListQuery, 'page' | 'limit'>): Promise<Buffer> {
  const w = await where(ctx, q);
  const rows = await Expense.findAll({
    where: w,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ],
    limit: EXPORT_MAX_ROWS,
  });
  const labels = await ledgerLabels(labelIds(rows));
  const file = toCsv(
    [
      'Expense',
      'Date',
      'Status',
      'Type',
      'Payee',
      'Head code',
      'Head',
      'Gross (INR)',
      'GST (INR)',
      'TDS (INR)',
      'TDS section',
      'Net paid (INR)',
      'Paid from',
      'Mode',
      'Reference',
      'Fund id',
      'Voucher',
    ],
    rows.map(e => {
      const d = expenseDto(e, labels);
      return [
        d.displayId,
        d.expenseDate,
        d.status,
        d.expenseType,
        d.payee,
        d.ledgerAccount?.code ?? '',
        d.ledgerAccount?.name ?? '',
        rupees(d.grossAmountPaise),
        rupees(d.gstPaise),
        rupees(d.tdsPaise),
        d.tdsSection ?? '',
        rupees(d.netPaidPaise),
        d.paidFrom?.name ?? '',
        d.paymentMode,
        d.paymentReference ?? '',
        d.fundId ?? '',
        d.voucherNo ?? '',
      ];
    }),
  );
  await audit(ctx, {
    action: AUDIT.expenseExported,
    entityType: 'expense',
    entityId: 0,
    societyId: ctx.society!.id,
    after: { rows: rows.length, filters: { ...q } },
  });
  return file;
}

/** Section 8.20 `expenses.listForCollection`: POSTED expenses of a collection; no bills, no payee contact. */
export async function listForCollection(societyId: number, collectionId: number) {
  const rows = await Expense.findAll({
    where: { societyId, collectionId, status: 'POSTED' },
    order: [
      ['expenseDate', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const heads = await LedgerAccount.findAll({
    where: { id: [...new Set(rows.map(e => n(e.ledgerAccountId)))] },
    attributes: ['id', 'name', 'transparencyCategory'],
  });
  const byId = new Map(heads.map(h => [n(h.id), h]));
  return rows.map(e => {
    const h = byId.get(n(e.ledgerAccountId));
    return {
      id: n(e.id),
      title: e.payee,
      category: h?.transparencyCategory ?? h?.name ?? '',
      date: e.expenseDate,
      amountPaise: n(e.grossAmountPaise),
    };
  });
}
