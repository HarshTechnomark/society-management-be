import { BillingNote, Invoice } from '../../models';
import { formatRupees } from '../../lib/money';
import type { Ctx } from '../../types/context';
import { APPROVAL_TYPES } from './billing.constants';
import { onCancelApproved } from './billing.notes.cancel';
import { onNoteApproved, onNoteChangesRequested, onNoteRejected, releaseNote } from './billing.notes.credit';
import { billingPorts } from './billing.ports';

/**
 * Approval types of sub-module 11.4 (BR-11-43, section 9.2): `CREDIT_NOTE` and `WRITE_OFF` (entity `billing_note`) and
 * `INVOICE_CANCEL` (entity `invoice`). `registerNoteApprovalTypes()` registers them with module 14 through the approvals port;
 * decisions come from the module 14 inbox.
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
