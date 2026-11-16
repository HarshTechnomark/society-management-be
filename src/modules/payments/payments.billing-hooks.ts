import { QueryTypes } from 'sequelize';
import { CollectionRequest, Collection, PaymentAllocation, sequelize } from '../../models';
import { invoices, setBillingPorts } from '../billing/billing.public';
import {
  advanceBalance,
  applyAdvanceToInvoice,
  creditOpeningAdvance,
  queueAdvanceApply,
} from './payments.advances';
import { onInvoiceCancelled } from './payments.reverse.core';
import { n } from './payments.shared';

/** BR-12-56: the invoice's allocation events, negative for releases and reversals. */
export async function listAllocationsForInvoice(societyId: number, invoiceId: number) {
  const rows = await PaymentAllocation.findAll({
    where: { societyId, invoiceId },
    order: [
      ['allocatedOn', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return rows.map(r => ({
    ...(r.paymentId ? { paymentId: n(r.paymentId) } : {}),
    allocatedOn: r.allocatedOn,
    amountPaise: n(r.amountPaise),
  }));
}

/** Cheque payments of the units with status BOUNCED or RETURNED since `since`; units with none are present with 0 (module 11 paymentBehaviour). */
export async function chequeReturnCounts(
  societyId: number,
  unitIds: number[],
  since: string,
): Promise<Map<number, number>> {
  const out = new Map<number, number>(unitIds.map(id => [id, 0]));
  if (!unitIds.length) return out;
  const rows = await sequelize.query<{ unitId: number; c: string }>(
    `SELECT unitId, COUNT(*) AS c FROM payments
      WHERE societyId = :societyId AND unitId IN (:unitIds) AND method = 'CHEQUE' AND status IN ('BOUNCED','RETURNED')
        AND COALESCE(bouncedOn, DATE(updatedAt)) >= :since
      GROUP BY unitId`,
    { replacements: { societyId, unitIds, since }, type: QueryTypes.SELECT },
  );
  for (const r of rows) out.set(n(r.unitId), n(r.c));
  return out;
}
export async function chequeReturnCount(societyId: number, unitId: number, since: string): Promise<number> {
  return (await chequeReturnCounts(societyId, [unitId], since)).get(unitId) ?? 0;
}

/** BR-12-55: a mandatory collection's invoice is credited to the collection's fund. */
export async function fundOfRequest(_societyId: number, requestId: number): Promise<number | null> {
  const r = await CollectionRequest.findByPk(requestId, { attributes: ['collectionId', 'societyId'] });
  if (!r || n(r.societyId) !== _societyId) return null;
  const c = await Collection.findByPk(r.collectionId, { attributes: ['fundId'], paranoid: false });
  return c?.fundId ? n(c.fundId) : null;
}

/** Replaces the module 11 placeholders that wait for module 12 (advances, invoice cancel hook, allocations, cheque returns). */
export function registerBillingHooks(): void {
  invoices.registerFundResolver('collection_request', fundOfRequest);
  setBillingPorts({
    payments: {
      advanceBalance: (societyId, unitId) => advanceBalance(societyId, unitId),
      applyAdvanceToInvoice: (ctx, input, t) => applyAdvanceToInvoice(ctx, input, t),
      creditOpeningAdvance: async (ctx, input, t) => {
        const r = await creditOpeningAdvance(ctx, input.unitId, input.amountPaise, t);
        return r;
      },
      queueAdvanceApply,
      onInvoiceCancelled: (ctx, invoiceId, t) => onInvoiceCancelled(ctx, invoiceId, t),
      listAllocationsForInvoice,
      chequeReturnCount,
    },
  });
}
