import { Invoice } from '../../models';
import { UnprocessableError, ValidationError } from '../../utils/errors';
import { audit } from '../../utils/audit';
import { AUDIT } from './billing.constants';
import { billingPorts } from './billing.ports';
import { emitInvoiceChanged } from './billing.invoices.effects';
import { invalidState, lockInvoice, rebalance, societyIdOfInvoice } from './billing.invoices.shared';
import { societyToday } from './billing.runs.shared';
import type { Ctx, InvoiceBalanceDto, SystemCtx, Transaction } from './billing.types';

/**
 * `invoices.applyAllocation`, `reverseAllocation` and `setDisputed` (section 8.24). Module 12 calls the first two inside its
 * own transaction; neither audits (the calling module audits its own action). Lock order: open `INVOICE_CANCEL` request, then the
 * invoice row.
 */
export const balanceDto = (inv: Invoice): InvoiceBalanceDto => ({
  id: Number(inv.id),
  invoiceNo: inv.invoiceNo,
  status: inv.status,
  totalPaise: Number(inv.totalPaise),
  paidPaise: Number(inv.paidPaise),
  creditedPaise: Number(inv.creditedPaise),
  debitedPaise: Number(inv.debitedPaise),
  outstandingPaise: Number(inv.outstandingPaise),
  settledOn: inv.settledOn,
});

const checkAmount = (amountPaise: number) => {
  if (!Number.isSafeInteger(amountPaise) || amountPaise < 1)
    throw new ValidationError([
      { field: 'amountPaise', message: 'The amount must be a whole number of paise, 1 or more' },
    ]);
};

async function lockForAllocation(
  ctx: Ctx | SystemCtx,
  invoiceId: number,
  t: Transaction,
): Promise<{ inv: Invoice; societyId: number }> {
  const societyId = await societyIdOfInvoice(ctx, invoiceId);
  await billingPorts().approvals.lockOpenForEntity(societyId, 'invoice', invoiceId, t);
  return { inv: await lockInvoice(societyId, invoiceId, t), societyId };
}

/** `paidPaise += amount` (BR-11-40); status and `settledOn` follow. Allowed on `ISSUED` and `PARTIALLY_PAID`. */
export async function applyAllocation(
  ctx: Ctx | SystemCtx,
  invoiceId: number,
  amountPaise: number,
  t: Transaction,
): Promise<InvoiceBalanceDto> {
  checkAmount(amountPaise);
  const { inv, societyId } = await lockForAllocation(ctx, invoiceId, t);
  if (inv.status !== 'ISSUED' && inv.status !== 'PARTIALLY_PAID')
    throw invalidState('This invoice cannot take a payment in its current state');
  if (amountPaise > Number(inv.outstandingPaise))
    throw new UnprocessableError(
      'ALLOCATION_EXCEEDS_OUTSTANDING',
      'The amount is more than the invoice still owes',
      [
        {
          field: 'amountPaise',
          message: 'More than the outstanding amount',
          maxAllowedPaise: Number(inv.outstandingPaise),
        },
      ],
    );
  inv.paidPaise = Number(inv.paidPaise) + amountPaise;
  rebalance(inv, await societyToday(societyId), ctx.user?.id ?? null);
  await inv.save({ transaction: t });
  emitInvoiceChanged(t, { ...inv.get(), societyId });
  return balanceDto(inv);
}

/**
 * `paidPaise -= amount`; a `PAID` invoice reopens (`settledOn` NULL). A `CANCELLED` invoice never takes a reversal: module 12
 * releases its allocations through `payments.onInvoiceCancelled` before the cancellation note is issued.
 */
export async function reverseAllocation(
  ctx: Ctx | SystemCtx,
  invoiceId: number,
  amountPaise: number,
  t: Transaction,
): Promise<InvoiceBalanceDto> {
  checkAmount(amountPaise);
  const { inv, societyId } = await lockForAllocation(ctx, invoiceId, t);
  if (inv.status === 'CANCELLED') throw invalidState('A cancelled invoice cannot take a reversal');
  if (amountPaise > Number(inv.paidPaise))
    throw new UnprocessableError('REVERSAL_EXCEEDS_PAID', 'The amount is more than was paid', [
      { field: 'amountPaise', message: 'More than the paid amount', maxAllowedPaise: Number(inv.paidPaise) },
    ]);
  inv.paidPaise = Number(inv.paidPaise) - amountPaise;
  rebalance(inv, await societyToday(societyId), ctx.user?.id ?? null);
  await inv.save({ transaction: t });
  emitInvoiceChanged(t, { ...inv.get(), societyId });
  return balanceDto(inv);
}

/** Module 15 sets the disputed flag when a billing dispute ticket opens or closes (audit `billing.invoice.dispute_flag_changed`). */
export async function setDisputed(
  ctx: Ctx | SystemCtx,
  invoiceId: number,
  isDisputed: boolean,
  t: Transaction,
): Promise<void> {
  const societyId = await societyIdOfInvoice(ctx, invoiceId);
  const inv = await lockInvoice(societyId, invoiceId, t);
  if (Boolean(inv.isDisputed) === isDisputed) return;
  inv.isDisputed = isDisputed;
  inv.updatedBy = ctx.user?.id ?? null;
  inv.version = Number(inv.version) + 1;
  await inv.save({ transaction: t });
  await audit(
    ctx,
    {
      action: AUDIT.invoiceDisputeFlagChanged,
      entityType: 'invoice',
      entityId: invoiceId,
      entityLabel: inv.invoiceNo,
      societyId,
      before: { isDisputed: !isDisputed },
      after: { isDisputed },
    },
    t,
  );
  emitInvoiceChanged(t, { ...inv.get(), societyId });
}
