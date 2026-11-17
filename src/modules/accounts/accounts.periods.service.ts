import { Op, QueryTypes } from 'sequelize';
import {
  AuditLog,
  Deposit,
  Expense,
  JournalEntry,
  Settlement,
  SocietyBalance,
  sequelize,
} from '../../models';
import { now, addHours } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { ConflictError, UnprocessableError, ValidationError } from '../../utils/errors';
import { financialYearOf } from '../../utils/numberSequences';
import { systemCtx, type Ctx } from '../../types/context';
import { enqueue } from '../../lib/queue';
import { usersWithPermission } from '../access-control/access-control.public';
import { settings } from '../society-setup/society-setup.public';
import { moneyTx, withSociety } from '../payments/payments.shared';
import {
  ACCOUNTS_QUEUE,
  APPROVAL_TYPES,
  AUDIT,
  CODE,
  ENTITY,
  ERR,
  JOBS,
  NOTIFY,
  PERM,
  SETTING_DEFAULTS,
} from './accounts.constants';
import { lockBooks } from './accounts.chart';
import { postJournal } from './accounts.engine';
import { accountsPorts } from './accounts.ports';
import { addDaysYmd, n, societyIdOf, societyToday, startOfYearAfter } from './accounts.shared';
import type { PostJournalInput, Transaction } from './accounts.types';

/**
 * Period lock, temporary unlock and financial year close (sections 5.6, 6.7, 8.18; BR-13-8, BR-13-48 to BR-13-50). Every change locks
 * the `society_balances` row through `lockBooks` (the same row the engine locks for each posting) and bumps its `version`.
 * The engine already refuses a USER posting into a locked date (`409 PERIOD_LOCKED`) and re-dates a SYSTEM posting to the first open
 * date; this file only moves the control columns.
 */
const staleVersion = () =>
  new ConflictError(ERR.staleVersion, 'Someone else changed the period settings. Reload to see the change.');
const lockDateInvalid = (message: string) =>
  new UnprocessableError(ERR.lockDateInvalid, message, [{ field: 'lockThrough', message }]);

const monthStart = (ymd: string): string => `${ymd.slice(0, 7)}-01`;
const monthEnd = (ymd: string): string => {
  const d = new Date(Date.UTC(Number(ymd.slice(0, 4)), Number(ymd.slice(5, 7)), 0));
  return d.toISOString().slice(0, 10);
};
const fyStart = (fy: string): string => `${fy.slice(0, 4)}-04-01`;
/** 31 March that ends `fy`. */
export const fyEnd = (fy: string): string => `${Number(fy.slice(0, 4)) + 1}-03-31`;
const nextFy = (fy: string): string => {
  const y = Number(fy.slice(0, 4)) + 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
};
const prevFy = (fy: string): string => {
  const y = Number(fy.slice(0, 4)) - 1;
  return `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
};

const unlockActive = (b: Pick<SocietyBalance, 'unlockFromDate' | 'unlockUntil'>): boolean =>
  Boolean(b.unlockFromDate && b.unlockUntil && now() < b.unlockUntil);

// ------------------------------------------------------------------ read (8.18 GET)
export interface PeriodYear {
  financialYear: string;
  start: string;
  end: string;
  status: 'OPEN' | 'CLOSED';
  canClose: boolean;
  blockers: string[];
}
export interface PeriodState {
  booksLockedThrough: string | null;
  unlock: { fromDate: string; until: string; approvalRequestId: number | null } | null;
  lastClosedFinancialYear: string | null;
  version: number;
  years: PeriodYear[];
}

/** BR-13-50 checks, as readable reasons (empty = the year can be closed). */
export async function closeBlockers(
  societyId: number,
  fy: string,
  books: Pick<
    SocietyBalance,
    'booksLockedThrough' | 'unlockFromDate' | 'unlockUntil' | 'lastClosedFinancialYear'
  >,
  t?: Transaction,
): Promise<string[]> {
  const out: string[] = [];
  const end = fyEnd(fy);
  const today = await societyToday(societyId);
  if (today <= end) out.push(`Financial year ${fy} has not ended yet`);
  const prev = prevFy(fy);
  if (!(books.lastClosedFinancialYear && books.lastClosedFinancialYear >= prev)) {
    const [older] = await sequelize.query<{ c: number }>(
      `SELECT COUNT(*) AS c FROM journal_entries WHERE societyId = :societyId AND status = 'POSTED' AND financialYear < :fy`,
      { replacements: { societyId, fy }, type: QueryTypes.SELECT, transaction: t },
    );
    if (n(older?.c) > 0) out.push(`Financial year ${prev} must be closed first`);
  }
  if (!books.booksLockedThrough || books.booksLockedThrough < end)
    out.push(`Lock the books through ${end} first`);
  if (unlockActive(books) && books.unlockFromDate! <= end)
    out.push('A temporary unlock is open for this year; lock it again first');
  const [tb] = await sequelize.query<{ s: string | null }>(
    'SELECT SUM(balancePaise) AS s FROM ledger_accounts WHERE societyId = :societyId',
    { replacements: { societyId }, type: QueryTypes.SELECT, transaction: t },
  );
  if (n(tb?.s) !== 0) out.push('The trial balance does not balance');
  const pendingExpenses = await Expense.count({
    where: { societyId, status: { [Op.in]: ['DRAFT', 'PENDING_APPROVAL'] }, expenseDate: { [Op.lte]: end } },
    transaction: t,
  });
  if (pendingExpenses) out.push(`${pendingExpenses} expense(s) are still waiting`);
  const pendingJournals = await JournalEntry.count({
    where: {
      societyId,
      status: { [Op.in]: ['DRAFT', 'PENDING_APPROVAL'] },
      entryDate: { [Op.lte]: end },
    },
    transaction: t,
  });
  if (pendingJournals) out.push(`${pendingJournals} journal(s) are still waiting`);
  const pendingRefunds = await Deposit.count({
    where: {
      societyId,
      status: 'REFUND_PENDING',
      createdAt: { [Op.lt]: new Date(`${addDaysYmd(end, 1)}T00:00:00+05:30`) },
    },
    transaction: t,
  });
  if (pendingRefunds) out.push(`${pendingRefunds} deposit refund(s) are waiting for approval`);
  const mismatches = await Settlement.count({
    where: { societyId, status: 'MISMATCH', settlementDate: { [Op.lte]: end } },
    transaction: t,
  });
  if (mismatches) out.push(`${mismatches} settlement(s) do not match`);
  return out;
}

async function firstPostedFy(societyId: number): Promise<string | null> {
  const [r] = await sequelize.query<{ fy: string | null }>(
    `SELECT MIN(financialYear) AS fy FROM journal_entries WHERE societyId = :societyId AND status = 'POSTED'`,
    { replacements: { societyId }, type: QueryTypes.SELECT },
  );
  return r?.fy ?? null;
}

export async function getPeriods(societyId: number): Promise<PeriodState> {
  const b = await SocietyBalance.findOne({ where: { societyId } });
  const books = {
    booksLockedThrough: b?.booksLockedThrough ?? null,
    unlockFromDate: b?.unlockFromDate ?? null,
    unlockUntil: b?.unlockUntil ?? null,
    lastClosedFinancialYear: b?.lastClosedFinancialYear ?? null,
  };
  const current = financialYearOf(await societyToday(societyId));
  const first = (await firstPostedFy(societyId)) ?? current;
  const years: PeriodYear[] = [];
  for (let fy = first; fy <= current; fy = nextFy(fy)) {
    const closed = Boolean(books.lastClosedFinancialYear && fy <= books.lastClosedFinancialYear);
    const blockers = closed ? [] : await closeBlockers(societyId, fy, books);
    years.push({
      financialYear: fy,
      start: fyStart(fy),
      end: fyEnd(fy),
      status: closed ? 'CLOSED' : 'OPEN',
      canClose: !closed && blockers.length === 0,
      blockers,
    });
  }
  return {
    booksLockedThrough: books.booksLockedThrough,
    unlock: unlockActive(books)
      ? {
          fromDate: books.unlockFromDate!,
          until: books.unlockUntil!.toISOString(),
          approvalRequestId: b?.unlockApprovalRequestId ?? null,
        }
      : null,
    lastClosedFinancialYear: books.lastClosedFinancialYear,
    version: n(b?.version ?? 1),
    years,
  };
}

// ------------------------------------------------------------------ notices
function notifyCommittee(
  t: Transaction,
  societyId: number,
  template: string,
  permission: string,
  data: Record<string, unknown>,
): void {
  t.afterCommit(async () => {
    try {
      const users = await usersWithPermission(societyId, permission);
      if (users.length) await accountsPorts().notifications.send(template, users, data);
    } catch {
      // a notification never breaks the books
    }
  });
}

// ------------------------------------------------------------------ lock (BR-13-48)
export async function lockPeriod(
  ctx: Ctx,
  input: { lockThrough: string; version: number },
): Promise<PeriodState> {
  const societyId = societyIdOf(ctx);
  const today = await societyToday(societyId);
  await moneyTx(async t => {
    const books = await lockBooks(t, societyId);
    if (n(books.version) !== input.version) throw staleVersion();
    const to = input.lockThrough;
    if (to !== monthEnd(to)) throw lockDateInvalid('The lock date must be the last day of a month');
    if (to >= monthStart(today)) throw lockDateInvalid('Only months before the current month can be locked');
    if (books.booksLockedThrough && to <= books.booksLockedThrough)
      throw lockDateInvalid(`The books are already locked through ${books.booksLockedThrough}`);
    const exp = await Expense.findAll({
      where: { societyId, status: { [Op.in]: ['DRAFT', 'PENDING_APPROVAL'] }, expenseDate: { [Op.lte]: to } },
      attributes: ['id', 'expenseDate', 'status'],
      limit: 50,
      transaction: t,
    });
    const jnl = await JournalEntry.findAll({
      where: { societyId, status: { [Op.in]: ['DRAFT', 'PENDING_APPROVAL'] }, entryDate: { [Op.lte]: to } },
      attributes: ['id', 'entryDate', 'status'],
      limit: 50,
      transaction: t,
    });
    if (exp.length || jnl.length)
      throw new UnprocessableError(
        ERR.lockPreconditionFailed,
        'Finish or cancel the pending items before locking',
        [
          ...exp.map(e => ({
            field: 'expenses',
            message: `Expense ${e.id} is ${e.status}, dated ${e.expenseDate}`,
            type: 'expense',
            id: n(e.id),
            date: e.expenseDate,
          })),
          ...jnl.map(j => ({
            field: 'journals',
            message: `Journal ${j.id} is ${j.status}, dated ${j.entryDate}`,
            type: 'journal',
            id: n(j.id),
            date: j.entryDate,
          })),
        ],
      );
    const before = { booksLockedThrough: books.booksLockedThrough };
    await books.update(
      { booksLockedThrough: to, version: n(books.version) + 1, updatedBy: ctx.user?.id ?? null },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.periodLocked,
        entityType: 'society_balance',
        entityId: n(books.id),
        societyId,
        before,
        after: { booksLockedThrough: to },
      },
      t,
    );
    notifyCommittee(t, societyId, NOTIFY.periodLocked, PERM.accountsView, { societyId, lockedThrough: to });
  });
  return getPeriods(societyId);
}

// ------------------------------------------------------------------ temporary unlock (BR-13-49)
export async function requestUnlock(
  ctx: Ctx,
  input: { fromDate: string; hours: number; reason: string },
): Promise<{ approvalRequestId: number; status: string; periods: PeriodState }> {
  const societyId = societyIdOf(ctx);
  let maxHours: number = SETTING_DEFAULTS['finance.maxUnlockHours'];
  try {
    maxHours = Number(await settings.get(societyId, 'finance.maxUnlockHours' as never)) || maxHours;
  } catch {
    // default
  }
  if (input.hours < 1 || input.hours > maxHours)
    throw new ValidationError([{ field: 'hours', message: `Between 1 and ${maxHours} hours` }]);
  const r = await moneyTx(async t => {
    const books = await lockBooks(t, societyId);
    const pending = await accountsPorts().approvals.lockOpenForEntity(
      societyId,
      ENTITY.societyBalance,
      n(books.id),
      t,
    );
    if (pending || unlockActive(books))
      throw new ConflictError(
        ERR.unlockAlreadyActive,
        'A temporary unlock is already open or waiting for approval',
      );
    if (input.fromDate !== monthStart(input.fromDate))
      throw lockDateInvalid('The unlock must start on the first day of a month');
    if (books.lastClosedFinancialYear && input.fromDate < startOfYearAfter(books.lastClosedFinancialYear))
      throw lockDateInvalid('A closed financial year cannot be unlocked');
    if (!books.booksLockedThrough || input.fromDate > books.booksLockedThrough)
      throw lockDateInvalid('That date is not locked');
    const approval = await accountsPorts().approvals.request(
      ctx,
      {
        type: APPROVAL_TYPES.periodUnlock,
        entityType: ENTITY.societyBalance,
        entityId: n(books.id),
        title: `Unlock books from ${input.fromDate} for ${input.hours} hours`,
        summary: input.reason,
        payload: { fromDate: input.fromDate, hours: input.hours, categoryKey: 'PERIOD_UNLOCK' },
      },
      t,
    );
    await books.update(
      { unlockApprovalRequestId: approval.id, version: n(books.version) + 1 },
      { transaction: t },
    );
    await audit(
      ctx,
      {
        action: AUDIT.periodUnlockRequested,
        entityType: 'society_balance',
        entityId: n(books.id),
        societyId,
        after: { approvalRequestId: approval.id, fromDate: input.fromDate, hours: input.hours },
        reason: input.reason,
      },
      t,
    );
    if (approval.status === 'APPROVED') await onUnlockApproved(ctx, n(books.id), t);
    return approval;
  });
  return { approvalRequestId: r.id, status: r.status, periods: await getPeriods(societyId) };
}

/** Module 14 `onApproved` of `PERIOD_UNLOCK` (entity `society_balance`): opens the window the request asked for. */
export async function onUnlockApproved(ctx: Ctx, booksId: number, t: Transaction): Promise<void> {
  const books = await SocietyBalance.findOne({ where: { id: booksId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!books) return;
  const societyId = n(books.societyId);
  if (unlockActive(books))
    throw new ConflictError(ERR.unlockAlreadyActive, 'A temporary unlock is already open');
  const requestId = books.unlockApprovalRequestId;
  const rows = await AuditLog.findAll({
    where: {
      societyId,
      action: AUDIT.periodUnlockRequested,
      entityType: 'society_balance',
      entityId: String(booksId),
    },
    order: [['id', 'DESC']],
    limit: 20,
    transaction: t,
  });
  const found = rows
    .map(r => r.after as { approvalRequestId?: number; fromDate?: string; hours?: number } | null)
    .find(a => a && Number(a.approvalRequestId) === Number(requestId));
  if (!found?.fromDate || !found.hours)
    throw new ConflictError(ERR.invalidState, 'The unlock request details were not found');
  const until = addHours(now(), found.hours);
  await books.update(
    {
      unlockFromDate: found.fromDate,
      unlockUntil: until,
      version: n(books.version) + 1,
    },
    { transaction: t },
  );
  await audit(
    withSociety(ctx, societyId),
    {
      action: AUDIT.periodUnlocked,
      entityType: 'society_balance',
      entityId: n(books.id),
      societyId,
      after: { fromDate: found.fromDate, until: until.toISOString(), approvalRequestId: requestId },
    },
    t,
  );
  t.afterCommit(async () => {
    try {
      const users = [...new Set([...(await usersWithPermission(societyId, PERM.accountsApprove))])];
      if (users.length)
        await accountsPorts().notifications.send(NOTIFY.periodUnlocked, users, {
          societyId,
          fromDate: found.fromDate,
          until: until.toISOString(),
        });
    } catch {
      // never breaks the books
    }
  });
}

async function unlockDecided(ctx: Ctx, booksId: number, reason: string, t: Transaction): Promise<void> {
  const books = await SocietyBalance.findOne({ where: { id: booksId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!books) return;
  if (!unlockActive(books))
    await books.update({ unlockApprovalRequestId: null, version: n(books.version) + 1 }, { transaction: t });
  await audit(
    withSociety(ctx, n(books.societyId)),
    {
      action: AUDIT.periodUnlockRequested,
      entityType: 'society_balance',
      entityId: n(books.id),
      societyId: n(books.societyId),
      after: { decision: 'NOT_UNLOCKED' },
      reason,
    },
    t,
  );
}
export const onUnlockRejected = (ctx: Ctx, booksId: number, reason: string, t: Transaction) =>
  unlockDecided(ctx, booksId, reason, t);
export const onUnlockCancelled = (ctx: Ctx, booksId: number, t: Transaction) =>
  unlockDecided(ctx, booksId, 'Request withdrawn', t);

export async function describeUnlock(booksId: number) {
  const books = await SocietyBalance.findByPk(booksId);
  const rows = books
    ? await AuditLog.findAll({
        where: {
          societyId: n(books.societyId),
          action: AUDIT.periodUnlockRequested,
          entityType: 'society_balance',
          entityId: String(booksId),
        },
        order: [['id', 'DESC']],
        limit: 5,
      })
    : [];
  const a = rows
    .map(r => r.after as { approvalRequestId?: number; fromDate?: string; hours?: number } | null)
    .find(x => x && Number(x.approvalRequestId) === Number(books?.unlockApprovalRequestId));
  return [
    { label: 'Unlock from', value: a?.fromDate ?? '', kind: 'date' as const },
    { label: 'Hours', value: String(a?.hours ?? ''), kind: 'text' as const },
  ];
}

// ------------------------------------------------------------------ relock
async function relockIn(ctx: Ctx, books: SocietyBalance, t: Transaction, why: string): Promise<void> {
  const before = { unlockFromDate: books.unlockFromDate, unlockUntil: books.unlockUntil };
  await books.update(
    { unlockFromDate: null, unlockUntil: null, unlockApprovalRequestId: null, version: n(books.version) + 1 },
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: AUDIT.periodRelocked,
      entityType: 'society_balance',
      entityId: n(books.id),
      societyId: n(books.societyId),
      before,
      after: { unlockFromDate: null, unlockUntil: null },
      reason: why,
    },
    t,
  );
}

export async function relockPeriod(ctx: Ctx, input: { version: number }): Promise<PeriodState> {
  const societyId = societyIdOf(ctx);
  await moneyTx(async t => {
    const books = await lockBooks(t, societyId);
    if (n(books.version) !== input.version) throw staleVersion();
    if (!books.unlockFromDate)
      throw new ConflictError(ERR.invalidState, 'There is no temporary unlock to end');
    await relockIn(ctx, books, t, 'Locked again by hand');
  });
  return getPeriods(societyId);
}

/** `accounts:relock` (every 15 minutes, all societies): clears the windows whose time has passed, re-checked under the row lock. */
export async function relockJob(): Promise<number> {
  const rows = await SocietyBalance.findAll({
    where: { unlockUntil: { [Op.lt]: now() } },
    attributes: ['societyId'],
  });
  let done = 0;
  for (const r of rows) {
    const societyId = n(r.societyId);
    const changed = await moneyTx(async t => {
      const books = await lockBooks(t, societyId);
      if (!books.unlockUntil || books.unlockUntil >= now()) return false;
      await relockIn(withSociety(systemCtx('accounts:relock'), societyId), books, t, 'Unlock window ended');
      return true;
    });
    if (changed) done += 1;
  }
  return done;
}

// ------------------------------------------------------------------ year close (BR-13-50)
export async function requestYearClose(
  ctx: Ctx,
  fy: string,
  input: { confirm: true; version: number },
): Promise<{ jobId: string }> {
  const societyId = societyIdOf(ctx);
  const books = await SocietyBalance.findOne({ where: { societyId } });
  if (!books) throw new ConflictError(ERR.invalidState, 'The books are not set up yet');
  if (n(books.version) !== input.version) throw staleVersion();
  if (books.lastClosedFinancialYear && fy <= books.lastClosedFinancialYear)
    throw new ConflictError(ERR.yearAlreadyClosed, `Financial year ${fy} is already closed`);
  const reasons = await closeBlockers(societyId, fy, books);
  if (reasons.length)
    throw new UnprocessableError(
      ERR.yearClosePrecondition,
      'The year cannot be closed yet',
      reasons.map(message => ({ field: 'financialYear', message })),
    );
  const jobId = `year-close:${societyId}:${fy}`;
  await enqueue(
    ACCOUNTS_QUEUE,
    JOBS.yearClose,
    { societyId, financialYear: fy, userId: ctx.user?.id ?? null, requestId: ctx.requestId },
    { jobId },
  );
  return { jobId };
}

const CLOSING_BATCH = 199;

/**
 * `accounts:year-close`: one transaction. Zeroes the year's net of every income and expense leaf into `3100` with `CLOSING` vouchers
 * dated 31 March (several when above 199 leaves; each balances on its own), then sets `lastClosedFinancialYear`. The `CLOSING`
 * voucher is the one writer allowed into a locked period (`skipLockCheck`). Aborts when the year is already closed.
 */
export async function yearCloseJob(
  data: Record<string, unknown>,
): Promise<{ vouchers: number; closed: boolean }> {
  const societyId = Number(data.societyId);
  const fy = String(data.financialYear);
  const requestedBy = data.userId ? Number(data.userId) : null;
  const ctx = withSociety(systemCtx(String(data.requestId ?? 'accounts:year-close')), societyId);
  return moneyTx(async t => {
    const books = await lockBooks(t, societyId);
    if (books.lastClosedFinancialYear && fy <= books.lastClosedFinancialYear)
      return { vouchers: 0, closed: false };
    const reasons = await closeBlockers(societyId, fy, books, t);
    if (reasons.length)
      throw new UnprocessableError(
        ERR.yearClosePrecondition,
        'The year cannot be closed yet',
        reasons.map(message => ({ field: 'financialYear', message })),
      );
    const nets = await sequelize.query<{ code: string; net: string }>(
      `SELECT l.code AS code, SUM(jl.debitPaise) - SUM(jl.creditPaise) AS net
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.journalEntryId
         JOIN ledger_accounts l ON l.id = jl.ledgerAccountId
        WHERE je.societyId = :societyId AND je.financialYear = :fy AND je.status = 'POSTED'
          AND l.accountType IN ('INCOME', 'EXPENSE')
        GROUP BY l.id, l.code
       HAVING net <> 0
        ORDER BY l.code`,
      { replacements: { societyId, fy }, type: QueryTypes.SELECT, transaction: t },
    );
    const date = fyEnd(fy);
    let vouchers = 0;
    let surplusPaise = 0;
    for (let i = 0; i < nets.length; i += CLOSING_BATCH) {
      const chunk = nets.slice(i, i + CLOSING_BATCH);
      const lines: PostJournalInput['lines'] = chunk.map(r => {
        const net = n(r.net); // debit balance (expense) > 0, credit balance (income) < 0
        return net > 0
          ? { ledgerAccountCode: r.code, debitPaise: 0, creditPaise: net }
          : { ledgerAccountCode: r.code, debitPaise: -net, creditPaise: 0 };
      });
      const debit = lines.reduce((a, l) => a + l.debitPaise, 0);
      const credit = lines.reduce((a, l) => a + l.creditPaise, 0);
      if (debit > credit)
        lines.push({ ledgerAccountCode: CODE.surplus, debitPaise: 0, creditPaise: debit - credit });
      else if (credit > debit)
        lines.push({ ledgerAccountCode: CODE.surplus, debitPaise: credit - debit, creditPaise: 0 });
      surplusPaise += debit - credit;
      await postJournal(
        ctx,
        {
          date,
          voucherType: 'CLOSING',
          refType: 'year_close',
          refId: `${fy}:${vouchers + 1}`,
          narration: `Closing of financial year ${fy}`,
          lines,
          skipLockCheck: true,
        },
        t,
      );
      vouchers += 1;
    }
    const before = { lastClosedFinancialYear: books.lastClosedFinancialYear };
    await books.update({ lastClosedFinancialYear: fy, version: n(books.version) + 1 }, { transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.financialYearClosed,
        entityType: 'society_balance',
        entityId: n(books.id),
        societyId,
        before,
        after: { lastClosedFinancialYear: fy, vouchers, surplusPaise, requestedBy },
      },
      t,
    );
    notifyCommittee(t, societyId, NOTIFY.yearClosed, PERM.accountsView, { societyId, financialYear: fy });
    return { vouchers, closed: true };
  });
}
