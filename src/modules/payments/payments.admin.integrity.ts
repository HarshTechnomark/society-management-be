import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';
import { n } from './payments.shared';

/**
 * Job `payments:integrity-check` (9.1): read-only invariants of the money tables. Every check returns the offending ids; the job
 * throws when there is any (module 07 shows a failed job with the details) and returns the empty report otherwise.
 *  1. effective payments: toInvoices + toCollections + toAdvance = amount (CHECK `ck_payments_split`, here re-verified)
 *  2. invoices with allocations: net allocations = invoice `paidPaise`
 *  3. unit advances: `balanceAfterPaise` is the running sum of the amounts per unit, never negative
 *  4. collection requests: `paidPaise` = net allocations (of the request, or of its invoice for a mandatory collection)
 *  5. collections: totals = sums of their requests
 */
export interface IntegrityIssue {
  check: string;
  ids: number[];
}
const EFFECTIVE = "('CAPTURED','CONFIRMED','RECEIVED','DEPOSITED','CLEARED')";

async function ids(sql: string, societyId?: number): Promise<number[]> {
  const rows = await sequelize.query<{ id: number }>(
    sql.replace(/:scope/g, societyId ? `AND x.societyId = ${Number(societyId)}` : ''),
    {
      type: QueryTypes.SELECT,
    },
  );
  return rows.map(r => n(r.id));
}

export async function runIntegrityCheck(societyId?: number): Promise<IntegrityIssue[]> {
  const checks: [string, string][] = [
    [
      'payment_split',
      `SELECT x.id FROM payments x WHERE x.status IN ${EFFECTIVE} :scope
         AND x.toInvoicesPaise + x.toCollectionsPaise + x.toAdvancePaise <> x.amountPaise`,
    ],
    [
      'invoice_allocations_vs_paid',
      `SELECT x.id FROM invoices x JOIN (SELECT invoiceId, SUM(amountPaise) AS net FROM payment_allocations
          WHERE invoiceId IS NOT NULL GROUP BY invoiceId) a ON a.invoiceId = x.id
        WHERE x.paidPaise <> a.net :scope`,
    ],
    [
      'advance_chain',
      `SELECT x.id FROM (SELECT id, societyId, balanceAfterPaise,
             SUM(amountPaise) OVER (PARTITION BY societyId, unitId ORDER BY id) AS running FROM unit_advances) x
        WHERE x.running <> x.balanceAfterPaise OR x.balanceAfterPaise < 0 :scope`,
    ],
    [
      'request_paid_vs_allocations',
      `SELECT x.id FROM collection_requests x
         LEFT JOIN (SELECT collectionRequestId, SUM(amountPaise) AS net FROM payment_allocations
                     WHERE collectionRequestId IS NOT NULL GROUP BY collectionRequestId) a ON a.collectionRequestId = x.id
         LEFT JOIN (SELECT invoiceId, SUM(amountPaise) AS net FROM payment_allocations
                     WHERE invoiceId IS NOT NULL GROUP BY invoiceId) i ON i.invoiceId = x.invoiceId
        WHERE x.paidPaise <> COALESCE(CASE WHEN x.invoiceId IS NULL THEN a.net ELSE i.net END, 0) :scope`,
    ],
    [
      'collection_totals',
      `SELECT x.id FROM collections x
         LEFT JOIN (SELECT collectionId, SUM(paidPaise) AS paid, SUM(status <> 'CANCELLED') AS cnt, COUNT(*) AS total
                      FROM collection_requests GROUP BY collectionId) r ON r.collectionId = x.id
        WHERE (x.collectedPaise <> COALESCE(r.paid, 0) OR x.requestCount <> COALESCE(CASE WHEN x.status = 'CLOSED' THEN r.total ELSE r.cnt END, 0)) :scope`,
    ],
  ];
  const issues: IntegrityIssue[] = [];
  for (const [check, sql] of checks) {
    const found = await ids(sql, societyId);
    if (found.length) issues.push({ check, ids: found.slice(0, 200) });
  }
  return issues;
}
