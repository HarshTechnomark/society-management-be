import { BillingNote, Invoice, sequelize } from '../../models';
import { formatRupees } from '../../lib/money';
import type { Ctx } from '../../types/context';
import { ConflictError, NotFoundError } from '../../utils/errors';
import { APPROVAL_TYPES } from './billing.constants';
import { onCancelApproved } from './billing.notes.cancel';
import { onNoteApproved, onNoteChangesRequested, onNoteRejected, releaseNote } from './billing.notes.credit';
import { billingPorts, placeholderApprovalRequests, placeholderApprovalTypes } from './billing.ports';

/**
 * Approval types of sub-module 11.4 (BR-11-43, section 9.2): `CREDIT_NOTE` and `WRITE_OFF` (entity `billing_note`) and
 * `INVOICE_CANCEL` (entity `invoice`). `registerNoteApprovalTypes()` registers them through the approvals port. `approve`,
 * `reject` and `requestChanges` do what module 14's inbox callback will do for a request made through the placeholder: run the
 * type's callback in one transaction. The coordinator can wire a development route to them. The placeholder enforces
 * maker-checker (`409 MAKER_CHECKER_VIOLATION`).
 */
async function describeNote(noteId: number) {
  const n = await BillingNote.findByPk(noteId);
  if (!n) return [];
  const inv = await Invoice.findByPk(n.invoiceId, {
    attributes: ['invoiceNo', 'unitLabel', 'outstandingPaise'],
  });
  const common = [
    { label: 'Invoice', value: inv?.invoiceNo ?? '', kind: 'text' as const },
    { label: 'Flat', value: inv?.unitLabel ?? '', kind: 'text' as const },
  ];
  return n.reasonCode === 'WRITE_OFF'
    ? [
        ...common,
        {
          label: 'Outstanding',
          value: formatRupees(Number(inv?.outstandingPaise ?? 0)),
          kind: 'money' as const,
        },
        { label: 'Amount', value: formatRupees(Number(n.totalPaise)), kind: 'money' as const },
      ]
    : [
        ...common,
        { label: 'Amount', value: formatRupees(Number(n.totalPaise)), kind: 'money' as const },
        { label: 'Reason', value: n.reasonCode, kind: 'text' as const },
      ];
}

export function registerNoteApprovalTypes(): void {
  const approvals = billingPorts().approvals;
  const noteHooks = {
    onApproved: onNoteApproved,
    onRejected: onNoteRejected,
    onChangesRequested: onNoteChangesRequested,
    onCancelled: async (ctx: Ctx, noteId: number, t: import('sequelize').Transaction) => {
      const n = await BillingNote.findByPk(noteId, { transaction: t, lock: t.LOCK.UPDATE });
      if (n) await releaseNote(ctx, Number(n.societyId), n, 'Withdrawn', t);
    },
    describe: describeNote,
  };
  approvals.registerType({ type: APPROVAL_TYPES.creditNote, ...noteHooks });
  approvals.registerType({ type: APPROVAL_TYPES.writeOff, ...noteHooks });
  approvals.registerType({
    type: APPROVAL_TYPES.invoiceCancel,
    onApproved: onCancelApproved,
    onRejected: async () => undefined,
    describe: async invoiceId => {
      const inv = await Invoice.findByPk(invoiceId);
      if (!inv) return [];
      return [
        { label: 'Invoice', value: inv.invoiceNo, kind: 'text' },
        { label: 'Flat', value: inv.unitLabel, kind: 'text' },
        { label: 'Total', value: formatRupees(Number(inv.totalPaise)), kind: 'money' },
        { label: 'Paid', value: formatRupees(Number(inv.paidPaise)), kind: 'money' },
      ];
    },
  });
}

async function decide(
  approvalRequestId: number,
  ctx: Ctx,
  action: 'approve' | 'reject' | 'changes',
  reason: string | null,
): Promise<{ type: string; entityId: number; status: string }> {
  const req = placeholderApprovalRequests.get(approvalRequestId);
  const hooks = req ? placeholderApprovalTypes.get(req.type) : undefined;
  if (!req || !hooks) throw new NotFoundError('APPROVAL_NOT_FOUND', 'Approval request not found');
  if (req.status !== 'PENDING') return { type: req.type, entityId: req.entityId, status: req.status };
  if (action === 'approve' && ctx.user?.id !== undefined && ctx.user.id === req.requestedBy)
    throw new ConflictError('MAKER_CHECKER_VIOLATION', 'The person who requested this cannot approve it');
  await sequelize.transaction(async t => {
    const c: Ctx =
      req.societyId && !ctx.society
        ? {
            ...ctx,
            society: { id: req.societyId, name: '', status: 'ACTIVE', timezone: 'Asia/Kolkata', planKey: '' },
          }
        : ctx;
    if (action === 'approve') await hooks.onApproved(c, req.entityId, t);
    else if (action === 'reject') await hooks.onRejected(c, req.entityId, reason ?? '', t);
    else await hooks.onChangesRequested?.(c, req.entityId, t);
  });
  req.status = action === 'approve' ? 'APPROVED' : action === 'reject' ? 'REJECTED' : 'CHANGES_REQUESTED';
  return { type: req.type, entityId: req.entityId, status: req.status };
}

export const approve = (approvalRequestId: number, ctx: Ctx) =>
  decide(approvalRequestId, ctx, 'approve', null);
export const reject = (approvalRequestId: number, reason: string, ctx: Ctx) =>
  decide(approvalRequestId, ctx, 'reject', reason);
export const requestChanges = (approvalRequestId: number, ctx: Ctx) =>
  decide(approvalRequestId, ctx, 'changes', null);
