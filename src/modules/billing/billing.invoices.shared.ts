import { Op } from 'sequelize';
import { ChargeHead, Invoice, InvoiceLine, Society, Unit } from '../../models';
import { AppError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx, SystemCtx } from '../../types/context';
import type { Transaction } from './billing.types';
import { CYCLE_MONTHS, type BillingCycle, type InvoiceStatus } from './billing.constants';
import { periodLabelOf } from './billing.calc.period';
import { fundResolvers } from './billing.invoices.funds';
import type { JournalLine } from './billing.ports';

/** Helpers shared by the invoice, note, cancellation and PDF services of sub-module 11.4. */

export const invoiceNotFound = () => new NotFoundError('INVOICE_NOT_FOUND', 'Invoice not found');
export const noteNotFound = () => new NotFoundError('NOTE_NOT_FOUND', 'Note not found');
export const invalidState = (message: string) => new AppError(409, 'INVALID_STATE', message);
export const staleVersion = () =>
  new AppError(409, 'STALE_VERSION', 'This row was changed by someone else. Reload and try again.');
export const cancelPending = () =>
  new AppError(409, 'INVOICE_CANCEL_PENDING', 'A cancellation request is open for this invoice');

/** Society of a call: the context's, else the society of the given unit (jobs and other modules acting as the system). */
export async function societyIdOfCall(ctx: Ctx | SystemCtx, unitId?: number): Promise<number> {
  if (ctx.society?.id) return ctx.society.id;
  if (unitId) {
    const u = await Unit.findByPk(unitId, { attributes: ['societyId'] });
    if (u) return Number(u.societyId);
  }
  throw new NotFoundError('INVOICE_NOT_FOUND', 'Invoice not found');
}

/** Society of an invoice id for a call whose context may have no society (module 12 reaches us with a system context). */
export async function societyIdOfInvoice(ctx: Ctx | SystemCtx, invoiceId: number): Promise<number> {
  if (ctx.society?.id) return ctx.society.id;
  const inv = await Invoice.findByPk(invoiceId, { attributes: ['societyId'] });
  if (!inv) throw invoiceNotFound();
  return Number(inv.societyId);
}

/** `FOR UPDATE` read of an invoice of the society; `404 INVOICE_NOT_FOUND` otherwise (another society's id included). */
export async function lockInvoice(societyId: number, id: number, t: Transaction): Promise<Invoice> {
  const inv = await Invoice.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!inv) throw invoiceNotFound();
  return inv;
}

/** Lock order step 2 (section 13): the unit row of the invoice, whatever its status (notes on an archived flat are allowed). */
export async function lockUnitRow(societyId: number, unitId: number, t: Transaction): Promise<void> {
  await Unit.findOne({
    where: { id: unitId, societyId },
    attributes: ['id'],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
}

/**
 * BR-11-40: re-derives the balance columns after a change of `debited`, `credited` or `paid`:
 * `outstanding = total + debited - credited - paid`; status `PAID` at zero, `PARTIALLY_PAID` when something was paid, else
 * `ISSUED`; `CANCELLED` is never derived. `settledOn` is the society-local date the invoice became settled, NULL again when
 * it reopens. The caller saves the row.
 */
export function rebalance(inv: Invoice, today: string, userId: number | null): void {
  const outstanding =
    Number(inv.totalPaise) + Number(inv.debitedPaise) - Number(inv.creditedPaise) - Number(inv.paidPaise);
  inv.outstandingPaise = outstanding;
  if (inv.status !== 'CANCELLED') {
    const status: InvoiceStatus =
      outstanding === 0 ? 'PAID' : Number(inv.paidPaise) > 0 ? 'PARTIALLY_PAID' : 'ISSUED';
    inv.status = status;
    inv.settledOn = outstanding === 0 ? (inv.settledOn ?? today) : null;
  }
  inv.updatedBy = userId;
  inv.version = Number(inv.version) + 1;
}

const MONTHS_TO_CYCLE: Record<number, BillingCycle> = Object.fromEntries(
  (Object.entries(CYCLE_MONTHS) as [BillingCycle, number][]).map(([c, m]) => [m, c]),
);

/** "Nov 2026" for a regular or supplementary invoice, the description for ad-hoc and opening invoices. */
export function periodLabelOfInvoice(inv: {
  periodStart: string | null;
  periodEnd: string | null;
  description: string | null;
}): string {
  if (inv.periodStart && inv.periodEnd) {
    const months =
      (Number(inv.periodEnd.slice(0, 4)) - Number(inv.periodStart.slice(0, 4))) * 12 +
      Number(inv.periodEnd.slice(5, 7)) -
      Number(inv.periodStart.slice(5, 7)) +
      1;
    return periodLabelOf(MONTHS_TO_CYCLE[months] ?? 'MONTHLY', inv.periodStart);
  }
  return inv.description ?? '';
}

/** Journal fund of a line: the head's own fund; for a `COLLECTION` head the fund the module 12 resolver gives (BR-11-49a). */
export async function fundFor(
  societyId: number,
  head: Pick<ChargeHead, 'headType' | 'fundId'>,
  ref: { refType: string | null; refId: number | null },
): Promise<number | null> {
  if (head.headType === 'COLLECTION') {
    const resolve = ref.refType ? fundResolvers.get(ref.refType) : undefined;
    const fund = resolve && ref.refId ? await resolve(societyId, ref.refId) : null;
    if (!fund)
      throw new UnprocessableError('FUND_NOT_RESOLVED', 'The fund of this collection could not be found');
    return fund;
  }
  return head.fundId ?? null;
}

/**
 * BR-11-70 posting of an invoice or debit note: Dr 1300 total; Cr each charge, interest and late fee line to its account
 * (with the fund), Cr 2310 and 2320 for the tax lines, round-off Cr 4990 when positive and Dr 4990 when negative.
 */
export function debitDocumentJournal(
  unitId: number,
  total: number,
  lines: { lineKind: string; amountPaise: number; ledgerAccountCode: string; fundId?: number | null }[],
): JournalLine[] {
  const out: JournalLine[] = [{ accountCode: '1300', debitPaise: total, creditPaise: 0, unitId }];
  for (const l of lines) {
    if (l.lineKind === 'ROUND_OFF' && l.amountPaise < 0)
      out.push({ accountCode: l.ledgerAccountCode, debitPaise: -l.amountPaise, creditPaise: 0, unitId });
    else
      out.push({
        accountCode: l.ledgerAccountCode,
        debitPaise: 0,
        creditPaise: l.amountPaise,
        unitId,
        ...(l.fundId ? { fundId: l.fundId } : {}),
      });
  }
  return out;
}

/** The mirror image for a credit note: Dr each credited line and tax account, Cr 1300 total; a write-off line is Dr 5900. */
export function creditDocumentJournal(
  unitId: number,
  total: number,
  lines: { lineKind: string; amountPaise: number; ledgerAccountCode: string; fundId?: number | null }[],
): JournalLine[] {
  const out: JournalLine[] = [{ accountCode: '1300', debitPaise: 0, creditPaise: total, unitId }];
  for (const l of lines) {
    if (l.lineKind === 'ROUND_OFF' && l.amountPaise < 0)
      out.push({ accountCode: l.ledgerAccountCode, debitPaise: 0, creditPaise: -l.amountPaise, unitId });
    else
      out.push({
        accountCode: l.ledgerAccountCode,
        debitPaise: l.amountPaise,
        creditPaise: 0,
        unitId,
        ...(l.fundId ? { fundId: l.fundId } : {}),
      });
  }
  return out;
}

/** The society's GSTIN, read only when a document carries tax. */
export async function gstinOf(societyId: number, t: Transaction): Promise<string | null> {
  const s = await Society.findByPk(societyId, { attributes: ['gstin'], transaction: t });
  return s?.gstin ?? null;
}

/**
 * Previous dues printed on a new bill (BR-11-37): the open balance of the same flat and party's other invoices.
 */
export async function previousDuesOf(
  societyId: number,
  unitId: number,
  billToResidentId: number,
  t: Transaction,
): Promise<number> {
  return (
    Number(
      await Invoice.sum('outstandingPaise', {
        where: {
          societyId,
          unitId,
          billToResidentId,
          status: { [Op.in]: ['ISSUED', 'PARTIALLY_PAID'] },
        },
        transaction: t,
      }),
    ) || 0
  );
}

/** Lines of invoices keyed by id. */
export async function linesOf(invoiceId: number, t?: Transaction): Promise<InvoiceLine[]> {
  return InvoiceLine.findAll({ where: { invoiceId }, order: [['lineNo', 'ASC']], transaction: t });
}
