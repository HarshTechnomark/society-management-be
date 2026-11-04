import { Op } from 'sequelize';
import { BillingNote, BillingRuleVersion, Invoice, InvoiceLine } from '../../models';
import { invoicePeriodLabel } from './billing.dues.shared';

/**
 * The invoice shapes of sections 8.11 and 8.12 used by the resident routes (8.21) and available to the admin detail: list item,
 * and detail with lines, issued notes and (when `billing.explain_my_bill` is on) the explain-my-bill `computation` of each
 * line: method, rule version id and number, inputs, formula and text. Without the feature `computation` is omitted.
 */
const n = (v: unknown): number => Number(v ?? 0);

export const isOverdueOn = (
  inv: Pick<Invoice, 'outstandingPaise' | 'dueDate' | 'status'>,
  today: string,
): boolean => inv.status !== 'CANCELLED' && n(inv.outstandingPaise) > 0 && today > inv.dueDate;

export const invoiceItemDto = (inv: Invoice, today: string) => ({
  id: n(inv.id),
  invoiceNo: inv.invoiceNo,
  invoiceType: inv.invoiceType,
  unitId: n(inv.unitId),
  unitLabel: inv.unitLabel,
  billToName: inv.billToName,
  billToRelation: inv.billToRelation,
  periodLabel: invoicePeriodLabel(inv),
  invoiceDate: inv.invoiceDate,
  dueDate: inv.dueDate,
  totalPaise: n(inv.totalPaise),
  paidPaise: n(inv.paidPaise),
  outstandingPaise: n(inv.outstandingPaise),
  status: inv.status,
  isOverdue: isOverdueOn(inv, today),
  isDisputed: Boolean(inv.isDisputed),
});

export async function invoiceDetailDto(inv: Invoice, today: string, opts: { explain: boolean }) {
  const lines = await InvoiceLine.findAll({
    where: { societyId: inv.societyId, invoiceId: inv.id! },
    order: [['lineNo', 'ASC']],
  });
  const versionIds = [
    ...new Set(lines.map(l => l.billingRuleVersionId).filter((x): x is number => x !== null)),
  ];
  const versions = new Map(
    (versionIds.length
      ? await BillingRuleVersion.findAll({
          where: { societyId: inv.societyId, id: { [Op.in]: versionIds } },
          attributes: ['id', 'versionNo', 'effectiveFrom'],
        })
      : []
    ).map(v => [n(v.id), v]),
  );
  const notes = await BillingNote.findAll({
    where: { societyId: inv.societyId, invoiceId: inv.id!, status: 'ISSUED' },
    order: [['id', 'ASC']],
  });
  return {
    id: n(inv.id),
    invoiceNo: inv.invoiceNo,
    invoiceType: inv.invoiceType,
    status: inv.status,
    unit: { id: n(inv.unitId), label: inv.unitLabel },
    billTo: { residentId: n(inv.billToResidentId), name: inv.billToName, relation: inv.billToRelation },
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    periodLabel: invoicePeriodLabel(inv),
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate,
    isOverdue: isOverdueOn(inv, today),
    isDisputed: Boolean(inv.isDisputed),
    gstApplied: Boolean(inv.gstApplied),
    societyGstin: inv.societyGstin,
    thresholdBasePaise: n(inv.thresholdBasePaise),
    taxableValuePaise: n(inv.taxableValuePaise),
    subtotalPaise: n(inv.subtotalPaise),
    cgstPaise: n(inv.cgstPaise),
    sgstPaise: n(inv.sgstPaise),
    taxPaise: n(inv.taxPaise),
    roundOffPaise: n(inv.roundOffPaise),
    totalPaise: n(inv.totalPaise),
    debitedPaise: n(inv.debitedPaise),
    creditedPaise: n(inv.creditedPaise),
    paidPaise: n(inv.paidPaise),
    outstandingPaise: n(inv.outstandingPaise),
    previousDuesPaise: n(inv.previousDuesPaise),
    lines: lines.map(l => {
      const base = {
        id: n(l.id),
        lineNo: l.lineNo,
        lineKind: l.lineKind,
        headKey: l.headKey,
        description: l.description,
        amountPaise: n(l.amountPaise),
      };
      if (l.lineKind !== 'CHARGE' && l.lineKind !== 'INTEREST' && l.lineKind !== 'LATE_FEE') return base;
      const v = l.billingRuleVersionId ? versions.get(n(l.billingRuleVersionId)) : undefined;
      return {
        ...base,
        quantity: l.quantity,
        ratePaise: l.ratePaise === null ? null : n(l.ratePaise),
        isTaxable: Boolean(l.isTaxable),
        creditedPaise: n(l.creditedPaise),
        periodFrom: l.periodFrom,
        periodTo: l.periodTo,
        prorationDays: l.prorationDays,
        periodDays: l.periodDays,
        ...(opts.explain && l.computation
          ? {
              computation: {
                ...l.computation,
                ruleVersionId: l.billingRuleVersionId ? n(l.billingRuleVersionId) : null,
                ruleVersionNo: v ? v.versionNo : null,
                ruleEffectiveFrom: v ? v.effectiveFrom : null,
              },
            }
          : {}),
      };
    }),
    notes: notes.map(x => ({
      id: n(x.id),
      noteType: x.noteType,
      noteNo: x.noteNo,
      noteDate: x.noteDate,
      reasonCode: x.reasonCode,
      totalPaise: n(x.totalPaise),
    })),
    pdfStatus: inv.pdfStatus,
    version: n(inv.version),
  };
}
