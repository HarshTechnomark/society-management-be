import { User } from '../../models';
import { now } from '../../lib/clock';
import { formatRupees } from '../../lib/money';
import { AppError, ConflictError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { AUDIT, ERR, NOTIFY } from './accounts.constants';
import { reverseEntry } from './accounts.engine';
import { accountsPorts } from './accounts.ports';
import { invalidState, n, societyToday } from './accounts.shared';
import { lockExpense } from './accounts.expenses.service';
import { viewExpense } from './accounts.expenses.read';
import { auditExpense, displayId, emitExpense, expenseToAudit, moneyTx } from './accounts.expenses.shared';

/** `POST /expenses/:id/reverse` (8.8, BR-13-29). Route guards: `finance.expenses.approve`, step-up, `Idempotency-Key`. */
export async function reverseExpense(
  ctx: Ctx,
  id: number,
  body: { reversalDate?: string; reason: string; version: number },
) {
  const societyId = ctx.society!.id;
  const userId = ctx.user!.id;
  const notice = await moneyTx(async t => {
    const exp = await lockExpense(societyId, id, t);
    if (exp.status !== 'POSTED' || !exp.journalEntryId)
      throw invalidState('Only a posted expense can be reversed');
    if (n(exp.createdBy) === userId)
      throw new ConflictError(ERR.makerChecker, 'The person who entered the expense cannot reverse it');
    if (n(exp.version) !== body.version)
      throw new ConflictError(
        ERR.staleVersion,
        'The expense was changed by someone else. Reload and try again',
      );
    const today = await societyToday(societyId);
    const date = body.reversalDate ?? today;
    if (date < exp.expenseDate || date > today)
      throw new UnprocessableError(
        ERR.dateOutOfRange,
        'The reversal date must be between the expense date and today',
        [{ field: 'reversalDate', message: 'Out of range' }],
      );
    const before = expenseToAudit(exp);
    const rev = await reverseEntry(ctx, n(exp.journalEntryId), { date, reason: body.reason }, t);
    if (exp.expenseType === 'VENDOR_BILL' && exp.vendorBillId) {
      try {
        await accountsPorts().vendors.reversePayment(ctx, n(exp.vendorBillId), n(exp.id), t);
      } catch (err) {
        if (err instanceof AppError && err.status === 422)
          throw new UnprocessableError(ERR.vendorBillNotPayable, err.message, err.errors);
        throw err;
      }
    }
    await exp.update(
      {
        status: 'REVERSED',
        reversalJournalEntryId: rev.id,
        reversalReason: body.reason,
        reversedBy: userId,
        reversedAt: now(),
        version: n(exp.version) + 1,
        updatedBy: userId,
      },
      { transaction: t },
    );
    await auditExpense(ctx, AUDIT.expenseReversed, exp, before, t, body.reason, {
      reversalVoucherNo: rev.voucherNo,
      reversalDate: date,
    });
    emitExpense(t, exp);
    const recipients = [
      ...new Set([n(exp.createdBy), exp.approvedBy ? n(exp.approvedBy) : 0].filter(Boolean)),
    ];
    const who = await User.findByPk(userId, { attributes: ['name'], transaction: t });
    t.afterCommit(() =>
      accountsPorts().notifications.send(NOTIFY.expenseReversed, recipients, {
        displayId: displayId(id),
        payee: exp.payee,
        amount: formatRupees(n(exp.grossAmountPaise)),
        reason: body.reason,
        reversalVoucherNo: rev.voucherNo,
        reversedByName: who?.name ?? 'an approver',
      }),
    );
    return rev.voucherNo;
  });
  return { ...(await viewExpense(ctx, id)), reversalVoucherNo: notice };
}
