import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';
import type { PAYMENTS_TABLES } from './payments.exports';

/**
 * Module 05 purge handler of module 12 (order 120, runs before module 11's 110). BR-05-21 forbids purge handlers to touch the
 * financial tables (`payment_orders`, `payments`, `payment_allocations`, `refunds`, `unit_advances`, `collections`), so this handler
 * only handles the non-financial ones: webhook events are deleted, mandates lose their instrument references. Every financial row
 * and the `RECEIPT_PDF` files stay until the end of financial retention, when `deleteRetainedPayments` removes all 9 tables.
 */
export const PURGE_TABLES = ['payment_webhook_events', 'autopay_mandates'];

export async function purgePayments(societyId: number): Promise<{ deleted: number; anonymised: number }> {
  const [, del] = await sequelize.query('DELETE FROM payment_webhook_events WHERE societyId = :societyId', {
    replacements: { societyId },
  });
  const [, anon] = await sequelize.query(
    `UPDATE autopay_mandates SET payerInstrumentMasked = NULL, gatewayCustomerId = NULL
      WHERE societyId = :societyId AND (payerInstrumentMasked IS NOT NULL OR gatewayCustomerId IS NOT NULL)`,
    { replacements: { societyId }, type: QueryTypes.UPDATE },
  );
  return {
    deleted: Number((del as { affectedRows?: number })?.affectedRows ?? 0),
    anonymised: Number(anon ?? 0),
  };
}

/** Children first (BR-05-38). */
const DELETE_ORDER: readonly (typeof PAYMENTS_TABLES)[number][] = [
  'payment_webhook_events',
  'payment_allocations',
  'unit_advances',
  'refunds',
  'payments',
  'payment_orders',
  'autopay_mandates',
  'collection_requests',
  'collections',
];
const BATCH = 1000;

export async function deleteRetainedPayments(societyId: number): Promise<{ deleted: number }> {
  let deleted = 0;
  // `id DESC` keeps self references (reversal rows, duplicate payments) valid inside a batch
  for (const table of DELETE_ORDER) {
    for (;;) {
      const [, meta] = await sequelize.query(
        `DELETE FROM ${table} WHERE societyId = :societyId ORDER BY id DESC LIMIT ${BATCH}`,
        { replacements: { societyId } },
      );
      const n = Number((meta as { affectedRows?: number })?.affectedRows ?? 0);
      deleted += n;
      if (n < BATCH) break;
    }
  }
  return { deleted };
}
