import { Expense } from '../../models';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { AUDIT, ERR, PERM, ENTITY, APPROVAL_TYPES } from './accounts.constants';
import { ensureBooks } from './accounts.chart';
import { accountsPorts } from './accounts.ports';
import { invalidState, n } from './accounts.shared';
import type { Transaction } from './accounts.types';
import { billFiles } from './accounts.expenses.files';
import {
  checkBillRequired,
  resolveExpense,
  type ExpenseValues,
  type Resolved,
} from './accounts.expenses.rules';
import { auditExpense, emitExpense, expenseToAudit, moneyTx } from './accounts.expenses.shared';
import { viewExpense } from './accounts.expenses.read';
import type { CreateExpenseBody, PatchExpenseBody } from './accounts.expenses.validation';

const stale = () =>
  new ConflictError(ERR.staleVersion, 'The expense was changed by someone else. Reload and try again');
const mustUser = (ctx: Ctx): number => {
  if (!ctx.user) throw new ForbiddenError('PERMISSION_DENIED', 'Sign in to continue');
  return ctx.user.id;
};

export const valuesOf = (e: Expense): ExpenseValues => ({
  expenseType: e.expenseType,
  expenseDate: e.expenseDate,
  payee: e.payee,
  ledgerAccountId: n(e.ledgerAccountId),
  description: e.description,
  grossAmountPaise: n(e.grossAmountPaise),
  gstPaise: n(e.gstPaise),
  tdsPaise: n(e.tdsPaise),
  tdsSection: e.tdsSection,
  challanNo: e.challanNo,
  paidFromLedgerAccountId: n(e.paidFromLedgerAccountId),
  paymentMode: e.paymentMode,
  paymentReference: e.paymentReference,
  fundId: e.fundId ? n(e.fundId) : null,
  collectionId: e.collectionId ? n(e.collectionId) : null,
  vendorId: e.vendorId ? n(e.vendorId) : null,
  vendorBillId: e.vendorBillId ? n(e.vendorBillId) : null,
});

export async function lockExpense(societyId: number, id: number, t: Transaction): Promise<Expense> {
  const e = await Expense.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!e) throw new NotFoundError(ERR.expenseNotFound, 'Expense not found');
  return e;
}

/** BR-13-30a: first the open approval request of the entity (module 14), then the expense row. */
async function lockOwned(ctx: Ctx, id: number, t: Transaction): Promise<Expense> {
  const societyId = ctx.society!.id;
  await accountsPorts().approvals.lockOpenForEntity(societyId, ENTITY.expense, id, t);
  return lockExpense(societyId, id, t);
}

const columnsOf = (r: Resolved) => ({
  ...r.values,
  netPaidPaise: r.values.grossAmountPaise - r.values.tdsPaise,
  bankAccountId: r.bankAccountId,
});

/** BR-13-25: bill check, status PENDING_APPROVAL, then the module 14 request (which may post the expense in this transaction). */
async function submitCore(ctx: Ctx, exp: Expense, r: Resolved, t: Transaction): Promise<void> {
  const societyId = n(exp.societyId);
  await checkBillRequired(societyId, n(exp.grossAmountPaise), n(exp.billFileCount));
  const resubmit = exp.status === 'CHANGES_REQUESTED' && exp.approvalRequestId !== null;
  const requestId = exp.approvalRequestId ? n(exp.approvalRequestId) : null;
  await exp.update(
    {
      status: 'PENDING_APPROVAL',
      rejectionReason: null,
      version: n(exp.version) + 1,
      updatedBy: ctx.user?.id ?? null,
    },
    { transaction: t },
  );
  const title = `${exp.payee} · ${r.head.name}`;
  const payload = {
    expenseType: exp.expenseType,
    paidFrom: r.paidFrom.code,
    fundId: exp.fundId ? n(exp.fundId) : null,
  };
  const approvals = accountsPorts().approvals;
  if (resubmit && requestId)
    await approvals.resubmit(ctx, requestId, { title, amountPaise: n(exp.grossAmountPaise), payload }, t);
  else {
    const res = await approvals.request(
      ctx,
      {
        type: APPROVAL_TYPES.expense,
        entityType: ENTITY.expense,
        entityId: n(exp.id),
        title,
        amountPaise: n(exp.grossAmountPaise),
        payload,
      },
      t,
    );
    await Expense.update({ approvalRequestId: res.id }, { where: { id: exp.id }, transaction: t });
  }
  await auditExpense(
    ctx,
    AUDIT.expenseSubmitted,
    exp,
    { status: resubmit ? 'CHANGES_REQUESTED' : 'DRAFT' },
    t,
  );
}

/** `POST /expenses` (8.6). */
export async function createExpense(ctx: Ctx, body: CreateExpenseBody) {
  const societyId = ctx.society!.id;
  const userId = mustUser(ctx);
  const needsHead = body.expenseType !== 'VENDOR_BILL';
  if (needsHead && !body.ledgerAccountId)
    throw new ValidationError([{ field: 'ledgerAccountId', message: 'Required' }]);
  if (body.expenseType !== 'VENDOR_BILL' && !body.payee)
    throw new ValidationError([{ field: 'payee', message: 'Required' }]);
  const out = await moneyTx(async t => {
    await ensureBooks(t, societyId);
    const input: ExpenseValues = {
      expenseType: body.expenseType,
      expenseDate: body.expenseDate,
      payee: body.payee ?? `Vendor ${body.vendorId ?? ''}`.trim(),
      ledgerAccountId: body.ledgerAccountId ?? 0,
      description: body.description ?? null,
      grossAmountPaise: body.grossAmountPaise,
      gstPaise: body.gstPaise,
      tdsPaise: body.tdsPaise,
      tdsSection: body.tdsSection ?? null,
      challanNo: body.challanNo ?? null,
      paidFromLedgerAccountId: body.paidFromLedgerAccountId,
      paymentMode: body.paymentMode,
      paymentReference: body.paymentReference ?? null,
      fundId: body.fundId ?? null,
      collectionId: body.collectionId ?? null,
      vendorId: body.vendorId ?? null,
      vendorBillId: body.vendorBillId ?? null,
    };
    const r = await resolveExpense(ctx, input, t, { gate: () => true, checkDate: true });
    const exp = await Expense.create(
      {
        societyId,
        ...columnsOf(r),
        billFileCount: 0,
        status: 'DRAFT',
        approvalRequestId: null,
        approvedBy: null,
        journalEntryId: null,
        voucherNo: null,
        reversalJournalEntryId: null,
        postedAt: null,
        rejectionReason: null,
        cancelReason: null,
        reversalReason: null,
        reversedBy: null,
        reversedAt: null,
        createdBy: userId,
        updatedBy: null,
      },
      { transaction: t },
    );
    const id = n(exp.id);
    if (body.fileIds.length) {
      await billFiles().link(ctx, body.fileIds, id, t);
      await exp.update({ billFileCount: body.fileIds.length }, { transaction: t });
    }
    await auditExpense(ctx, AUDIT.expenseCreated, exp, null, t, null, { fileIds: body.fileIds });
    if (body.submit) await submitCore(ctx, exp, r, t);
    const fresh = (await Expense.findByPk(id, { transaction: t }))!;
    emitExpense(t, fresh);
    return fresh;
  });
  return viewExpense(ctx, n(out.id));
}

const PATCHABLE = [
  'expenseType',
  'expenseDate',
  'payee',
  'ledgerAccountId',
  'description',
  'grossAmountPaise',
  'gstPaise',
  'tdsPaise',
  'tdsSection',
  'challanNo',
  'paidFromLedgerAccountId',
  'paymentMode',
  'paymentReference',
  'fundId',
  'collectionId',
  'vendorId',
  'vendorBillId',
] as const;

/** `PATCH /expenses/:id` (8.7): DRAFT, CHANGES_REQUESTED, or REJECTED (which goes back to DRAFT). */
export async function updateExpense(ctx: Ctx, id: number, body: PatchExpenseBody) {
  const userId = mustUser(ctx);
  await moneyTx(async t => {
    const exp = await lockOwned(ctx, id, t);
    const mine = n(exp.createdBy) === userId;
    if (!ctx.permissions?.has(PERM.expensesEdit) && !(mine && ctx.permissions?.has(PERM.expensesCreate)))
      throw new ForbiddenError('PERMISSION_DENIED', 'Only the person who entered it can edit this expense');
    if (!['DRAFT', 'CHANGES_REQUESTED', 'REJECTED'].includes(exp.status))
      throw invalidState('Only a draft, rejected or changes-requested expense can be edited');
    if (n(exp.version) !== body.version) throw stale();
    const before = expenseToAudit(exp);
    const merged: Record<string, unknown> = { ...valuesOf(exp) };
    const changed = new Set<string>();
    for (const k of PATCHABLE) {
      const v = body[k];
      if (v !== undefined && v !== merged[k]) {
        merged[k] = v;
        changed.add(k);
      }
    }
    const r = await resolveExpense(ctx, merged as unknown as ExpenseValues, t, {
      gate: f => changed.has(f),
      checkDate: changed.has('expenseDate'),
    });
    if (body.fileIds) {
      await billFiles().link(ctx, body.fileIds, id, t);
    }
    await exp.update(
      {
        ...columnsOf(r),
        ...(body.fileIds ? { billFileCount: body.fileIds.length } : {}),
        ...(exp.status === 'REJECTED' ? { status: 'DRAFT' as const, rejectionReason: null } : {}),
        version: n(exp.version) + 1,
        updatedBy: userId,
      },
      { transaction: t },
    );
    await auditExpense(
      ctx,
      AUDIT.expenseUpdated,
      exp,
      before,
      t,
      null,
      body.fileIds ? { fileIds: body.fileIds } : {},
    );
    emitExpense(t, exp);
  });
  return viewExpense(ctx, id);
}

/** `POST /expenses/:id/submit` (8.7). */
export async function submitExpense(ctx: Ctx, id: number, body: { version: number }) {
  mustUser(ctx);
  await moneyTx(async t => {
    const exp = await lockOwned(ctx, id, t);
    if (!['DRAFT', 'CHANGES_REQUESTED'].includes(exp.status))
      throw invalidState('Only a draft or changes-requested expense can be submitted');
    if (n(exp.version) !== body.version) throw stale();
    const r = await resolveExpense(ctx, valuesOf(exp), t, { gate: null, checkDate: true });
    await submitCore(ctx, exp, r, t);
    emitExpense(t, (await Expense.findByPk(id, { transaction: t }))!);
  });
  return viewExpense(ctx, id);
}

/** Ends a pending expense as CANCELLED (the maker withdrew it, or module 14 called `onCancelled`). Idempotent. */
export async function endAsCancelled(
  ctx: Ctx,
  exp: Expense,
  reason: string,
  action: string,
  t: Transaction,
): Promise<void> {
  if (!['PENDING_APPROVAL', 'CHANGES_REQUESTED', 'DRAFT'].includes(exp.status)) return;
  const before = { status: exp.status };
  await exp.update(
    {
      status: 'CANCELLED',
      cancelReason: reason.slice(0, 500),
      version: n(exp.version) + 1,
      updatedBy: ctx.user?.id ?? null,
    },
    { transaction: t },
  );
  billFiles().release(n(exp.id));
  await auditExpense(ctx, action, exp, before, t, reason);
  emitExpense(t, exp);
}

/** `POST /expenses/:id/withdraw` (8.7): the maker only. */
export async function withdrawExpense(ctx: Ctx, id: number, body: { version: number; reason: string }) {
  const userId = mustUser(ctx);
  await moneyTx(async t => {
    const exp = await lockOwned(ctx, id, t);
    if (n(exp.createdBy) !== userId)
      throw new ForbiddenError('PERMISSION_DENIED', 'Only the person who entered it can withdraw it');
    if (!['PENDING_APPROVAL', 'CHANGES_REQUESTED'].includes(exp.status))
      throw invalidState('Only a pending expense can be withdrawn');
    if (n(exp.version) !== body.version) throw stale();
    if (exp.approvalRequestId)
      await accountsPorts().approvals.cancel(ctx, n(exp.approvalRequestId), body.reason, t);
    // module 14 may already have called `onCancelled`; reload and finish the move if it has not
    await exp.reload({ transaction: t });
    await endAsCancelled(ctx, exp, body.reason, AUDIT.expenseWithdrawn, t);
  });
  return viewExpense(ctx, id);
}

/** `DELETE /expenses/:id` (8.7): DRAFT only; the maker or `finance.expenses.delete`. */
export async function deleteExpense(ctx: Ctx, id: number, body: { version: number; reason: string }) {
  const userId = mustUser(ctx);
  await moneyTx(async t => {
    const exp = await lockOwned(ctx, id, t);
    if (n(exp.createdBy) !== userId && !ctx.permissions?.has(PERM.expensesDelete))
      throw new ForbiddenError('PERMISSION_DENIED', 'You cannot cancel this expense');
    if (exp.status !== 'DRAFT') throw invalidState('Only a draft expense can be cancelled');
    if (n(exp.version) !== body.version) throw stale();
    await endAsCancelled(ctx, exp, body.reason, AUDIT.expenseCancelled, t);
  });
  return viewExpense(ctx, id);
}
