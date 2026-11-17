import { Expense, LedgerAccount } from '../../models';
import { now } from '../../lib/clock';
import { formatRupees } from '../../lib/money';
import { AppError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { AUDIT, CODE, ERR } from './accounts.constants';
import { ensureBooks } from './accounts.chart';
import { postJournal } from './accounts.engine';
import { fundLedger } from './accounts.lookup';
import { accountsPorts } from './accounts.ports';
import { n } from './accounts.shared';
import type { JournalLineInput, Transaction } from './accounts.types';
import { billFileInfo, billFiles } from './accounts.expenses.files';
import { resolveExpense } from './accounts.expenses.rules';
import { endAsCancelled, lockExpense, valuesOf } from './accounts.expenses.service';
import { auditExpense, emitExpense, ledgerLabels, setting, withSociety } from './accounts.expenses.shared';

/** BR-13-27: the lines of the payment journal. */
export async function expenseLines(
  e: Expense,
  head: LedgerAccount,
  paidFrom: LedgerAccount,
  fundCode: string | null,
  claimable: boolean,
): Promise<JournalLineInput[]> {
  const gross = n(e.grossAmountPaise);
  const gst = claimable ? n(e.gstPaise) : 0;
  const tds = n(e.tdsPaise);
  const headAmount = gross - gst;
  const fundId = e.fundId ? n(e.fundId) : undefined;
  const lines: JournalLineInput[] = [
    { ledgerAccountCode: head.code, debitPaise: headAmount, creditPaise: 0 },
  ];
  if (gst > 0) lines.push({ ledgerAccountCode: CODE.gstInput, debitPaise: gst, creditPaise: 0 });
  lines.push({ ledgerAccountCode: paidFrom.code, debitPaise: 0, creditPaise: n(e.netPaidPaise) });
  if (tds > 0) lines.push({ ledgerAccountCode: CODE.tdsPayable, debitPaise: 0, creditPaise: tds });
  if (fundId && fundCode) {
    lines.push({ ledgerAccountCode: fundCode, debitPaise: headAmount, creditPaise: 0, fundId });
    lines.push({ ledgerAccountCode: CODE.fundTransferIn, debitPaise: 0, creditPaise: headAmount, fundId });
  }
  return lines;
}

/**
 * Module 14 `onApproved` for `EXPENSE` (6.8), inside the approver's (or the auto-approving maker's) transaction. Any error rolls the
 * approval action back, so the request stays pending (`422 INSUFFICIENT_BALANCE`). BR-13-32 is not enforced for fund-sourced expenses:
 * T13-16 expects a Repair-fund expense to take the fund negative.
 */
export async function onExpenseApproved(baseCtx: Ctx, expenseId: number, t: Transaction): Promise<void> {
  const row = await Expense.findByPk(expenseId, { attributes: ['societyId'], transaction: t });
  if (!row) return;
  const societyId = n(row.societyId);
  const ctx = withSociety(baseCtx, societyId);
  const exp = await lockExpense(societyId, expenseId, t);
  if (exp.status !== 'PENDING_APPROVAL') return;
  const r = await resolveExpense(ctx, valuesOf(exp), t, { gate: null, checkDate: true });
  await ensureBooks(t, societyId);
  const source = await LedgerAccount.findByPk(r.paidFrom.id, { transaction: t, lock: t.LOCK.UPDATE });
  if (!source || n(source.balancePaise) < n(exp.netPaidPaise))
    throw new UnprocessableError(ERR.insufficientBalance, `${r.paidFrom.name} has too little balance`, [
      { field: 'paidFromLedgerAccountId', message: 'The balance is below the amount to pay' },
    ]);
  const claimable = Boolean(await setting(societyId, 'finance.gstInputClaimable'));
  const fund = exp.fundId ? await fundLedger(societyId, n(exp.fundId), t) : null;
  const lines = await expenseLines(exp, r.head, r.paidFrom, fund?.ledger.code ?? null, claimable);
  const narration = `${exp.payee}: ${exp.description ?? r.head.name}`;
  const posted = await postJournal(
    ctx,
    {
      date: exp.expenseDate,
      voucherType: 'PAYMENT',
      refType: 'expense',
      refId: n(exp.id),
      narration,
      lines,
      instrumentRef: exp.paymentReference,
      label: `Expense EXP-${n(exp.id)}`,
    },
    t,
  );
  if (exp.expenseType === 'VENDOR_BILL' && exp.vendorBillId) {
    try {
      await accountsPorts().vendors.recordPayment(
        ctx,
        n(exp.vendorBillId),
        { expenseId: n(exp.id), amountPaise: n(exp.grossAmountPaise) },
        t,
      );
    } catch (err) {
      if (err instanceof AppError && err.status === 422)
        throw new UnprocessableError(ERR.vendorBillNotPayable, err.message, err.errors);
      throw err;
    }
  }
  const before = { status: exp.status };
  const auto = ctx.user?.id === n(exp.createdBy);
  await exp.update(
    {
      status: 'POSTED',
      journalEntryId: posted.id,
      voucherNo: posted.voucherNo,
      postedAt: now(),
      approvedBy: auto ? null : (ctx.user?.id ?? null),
      version: n(exp.version) + 1,
    },
    { transaction: t },
  );
  await auditExpense(ctx, AUDIT.expensePosted, exp, before, t);
  emitExpense(t, exp);
}

/** `onRejected`: REJECTED with the reason (module 14 tells the maker). */
export async function onExpenseRejected(baseCtx: Ctx, expenseId: number, reason: string, t: Transaction) {
  const row = await Expense.findByPk(expenseId, { attributes: ['societyId'], transaction: t });
  if (!row) return;
  const ctx = withSociety(baseCtx, n(row.societyId));
  const exp = await lockExpense(n(row.societyId), expenseId, t);
  if (!['PENDING_APPROVAL', 'CHANGES_REQUESTED'].includes(exp.status)) return;
  const before = { status: exp.status };
  await exp.update(
    { status: 'REJECTED', rejectionReason: reason.slice(0, 500), version: n(exp.version) + 1 },
    { transaction: t },
  );
  await auditExpense(ctx, AUDIT.expenseRejected, exp, before, t, reason);
  emitExpense(t, exp);
}

/** `onChangesRequested`: CHANGES_REQUESTED; the maker edits and resubmits. */
export async function onExpenseChangesRequested(baseCtx: Ctx, expenseId: number, t: Transaction) {
  const row = await Expense.findByPk(expenseId, { attributes: ['societyId'], transaction: t });
  if (!row) return;
  const ctx = withSociety(baseCtx, n(row.societyId));
  const exp = await lockExpense(n(row.societyId), expenseId, t);
  if (exp.status !== 'PENDING_APPROVAL') return;
  await exp.update({ status: 'CHANGES_REQUESTED', version: n(exp.version) + 1 }, { transaction: t });
  await auditExpense(ctx, AUDIT.expenseUpdated, exp, { status: 'PENDING_APPROVAL' }, t, 'Changes requested');
  emitExpense(t, exp);
}

/** `onCancelled`: CANCELLED (module 14 withdrawal or expiry). */
export async function onExpenseCancelled(baseCtx: Ctx, expenseId: number, t: Transaction) {
  const row = await Expense.findByPk(expenseId, { attributes: ['societyId'], transaction: t });
  if (!row) return;
  const ctx = withSociety(baseCtx, n(row.societyId));
  const exp = await lockExpense(n(row.societyId), expenseId, t);
  await endAsCancelled(ctx, exp, 'Withdrawn', AUDIT.expenseWithdrawn, t);
}

/** `describe(req)` for the approvals inbox: payee, head, paid from, fund and the bill files. */
export async function describeExpense(expenseId: number) {
  const e = await Expense.findByPk(expenseId);
  if (!e) return [];
  const labels = await ledgerLabels([n(e.ledgerAccountId), n(e.paidFromLedgerAccountId)]);
  const facts: { label: string; value: string; kind?: 'money' | 'date' | 'text' }[] = [
    { label: 'Payee', value: e.payee, kind: 'text' },
    { label: 'Head', value: labels.get(n(e.ledgerAccountId))?.name ?? '', kind: 'text' },
    { label: 'Amount', value: formatRupees(n(e.grossAmountPaise)), kind: 'money' },
    { label: 'Paid from', value: labels.get(n(e.paidFromLedgerAccountId))?.name ?? '', kind: 'text' },
    { label: 'Date', value: e.expenseDate, kind: 'date' },
  ];
  if (e.fundId) facts.push({ label: 'Fund', value: String(n(e.fundId)), kind: 'text' });
  for (const id of billFiles().list(n(e.id)))
    if (billFileInfo(id)) facts.push({ label: 'Bill', value: String(id), kind: 'file' as never });
  return facts;
}
