import { Resident } from '../../models';
import { enqueueAfterCommit } from '../../lib/queue';
import { emitToRoom } from '../../lib/realtime';
import { logger } from '../../lib/logger';
import { residents } from '../residents/residents.public';
import { BILLING_QUEUE, JOBS, REALTIME } from './billing.constants';
import { billingPorts } from './billing.ports';
import type { Transaction } from './billing.types';
import './billing.invoices.templates';

/** Side effects of invoices and notes (sections 9.1, 9.4 and 10): all of them run after the transaction commits. */

/** `billing.invoice.updated` to the finance room and `billing.dues.changed` (no amounts) to the unit room. */
export function emitInvoiceChanged(
  t: Transaction,
  inv: { id?: number; societyId: number; unitId: number; status: string; outstandingPaise: number },
): void {
  t.afterCommit(() => {
    emitToRoom(`society:${inv.societyId}:finance`, REALTIME.invoiceUpdated, {
      invoiceId: inv.id,
      unitId: inv.unitId,
      status: inv.status,
      outstandingPaise: Number(inv.outstandingPaise),
    });
    emitToRoom(`unit:${inv.unitId}`, REALTIME.duesChanged, { unitId: inv.unitId });
  });
}

/** `billing:render-pdf` for an invoice or a note, after commit (BR-11-67: rendered once). */
export function enqueueRenderPdf(
  t: Transaction,
  doc: { kind: 'invoice' | 'note'; id: number; societyId: number },
): void {
  enqueueAfterCommit(
    t,
    BILLING_QUEUE,
    JOBS.renderPdf,
    { kind: doc.kind, id: doc.id, societyId: doc.societyId },
    { jobId: `pdf:${doc.kind}:${doc.id}` },
  );
}

/** Module 12 `payments.queueAdvanceApply` after commit (F18, BR-11-42). A failure is logged: money is already booked. */
export function queueAdvanceApplyAfterCommit(t: Transaction, societyId: number, unitIds: number[]): void {
  t.afterCommit(async () => {
    try {
      await billingPorts().payments.queueAdvanceApply(societyId, unitIds);
    } catch (err) {
      logger.error({ err, societyId }, 'billing queueAdvanceApply failed');
    }
  });
}

/** Users to tell about a bill: the bill-to resident and, for an owner bill, the owners of the flat who have a login. */
export async function billRecipients(
  societyId: number,
  unitId: number,
  residentId: number,
  relation: string,
  date: string,
): Promise<number[]> {
  const ids = new Set<number>();
  const r = await Resident.findOne({
    where: { id: residentId, societyId },
    attributes: ['userId'],
    paranoid: false,
  });
  if (r?.userId) ids.add(r.userId);
  if (relation !== 'TENANT') {
    const owners = await residents.listForUnit(societyId, unitId, { relation: ['OWNER', 'CO_OWNER'], date });
    for (const o of owners) if (o.userId) ids.add(o.userId);
  }
  return [...ids];
}

/** Sends a billing template to the recipients of a bill after commit; never throws. */
export function notifyBillAfterCommit(
  t: Transaction,
  template: string,
  to: { societyId: number; unitId: number; residentId: number; relation: string; date: string },
  data: Record<string, unknown>,
): void {
  t.afterCommit(async () => {
    try {
      const ids = await billRecipients(to.societyId, to.unitId, to.residentId, to.relation, to.date);
      if (ids.length) await billingPorts().notifications.send(template, ids, data);
    } catch (err) {
      logger.error({ err, template }, 'billing notification failed');
    }
  });
}
