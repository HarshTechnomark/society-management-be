import { Op } from 'sequelize';
import { BillingNote, ChargeHead, Invoice, InvoiceLine } from '../../models';
import { billingPorts } from './billing.ports';
import type { BalanceEvent } from './billing.latefee.calc';

/**
 * The dated balance events of an invoice (BR-11-53, 8.25): the invoice itself, its issued debit and credit notes by `noteDate`
 * and the module 12 allocations by `allocatedOn`. Used by the late fee job (interest principal) and by the past-date readers of
 * module 24 (outstanding at an earlier day), so both rebuild balances the same way.
 */
interface LineFacts {
  lineKind: string;
  amountPaise: number;
  chargeHeadId: number | null;
  nonInterestBearing: boolean;
  refInvoiceLineId: number | null;
  invoiceId: number | null;
  billingNoteId: number | null;
  id: number;
}

/** BR-11-47: INTEREST and LATE_FEE lines and the CHARGE lines of heads that do not bear interest. */
async function lineFacts(societyId: number, invoiceIds: number[], noteIds: number[]): Promise<LineFacts[]> {
  const or: Record<string, unknown>[] = [];
  if (invoiceIds.length) or.push({ invoiceId: { [Op.in]: invoiceIds } });
  if (noteIds.length) or.push({ billingNoteId: { [Op.in]: noteIds } });
  if (!or.length) return [];
  const lines = await InvoiceLine.findAll({ where: { societyId, [Op.or]: or }, order: [['id', 'ASC']] });
  const heads = new Map(
    (
      await ChargeHead.findAll({
        where: {
          societyId,
          id: {
            [Op.in]: [...new Set(lines.map(l => l.chargeHeadId).filter((x): x is number => x !== null))],
          },
        },
        attributes: ['id', 'interestBearing'],
      })
    ).map(h => [Number(h.id), Boolean(h.interestBearing)]),
  );
  return lines.map(l => ({
    id: Number(l.id),
    lineKind: l.lineKind,
    amountPaise: Number(l.amountPaise),
    chargeHeadId: l.chargeHeadId ? Number(l.chargeHeadId) : null,
    refInvoiceLineId: l.refInvoiceLineId ? Number(l.refInvoiceLineId) : null,
    invoiceId: l.invoiceId ? Number(l.invoiceId) : null,
    billingNoteId: l.billingNoteId ? Number(l.billingNoteId) : null,
    nonInterestBearing:
      l.lineKind === 'INTEREST' ||
      l.lineKind === 'LATE_FEE' ||
      (l.lineKind === 'CHARGE' && l.chargeHeadId !== null && heads.get(Number(l.chargeHeadId)) === false),
  }));
}

const isChargeLike = (k: string): boolean => k === 'CHARGE' || k === 'INTEREST' || k === 'LATE_FEE';

/**
 * Events for the invoices (one list per invoice id). A debit note of only interest or fees counts in full as non-interest-bearing
 * (example G: debit note total 9,200); a mixed one counts its non-interest-bearing lines; a credit note counts the credited
 * part of such lines. Module 12 allocations come from the port (negative for releases and reversals).
 */
export async function balanceEventsFor(
  societyId: number,
  invoices: Pick<Invoice, 'id' | 'invoiceDate' | 'totalPaise'>[],
): Promise<Map<number, BalanceEvent[]>> {
  const out = new Map<number, BalanceEvent[]>();
  const invoiceIds = invoices.map(i => Number(i.id));
  if (!invoiceIds.length) return out;
  const notes = await BillingNote.findAll({
    where: { societyId, invoiceId: { [Op.in]: invoiceIds }, status: 'ISSUED' },
    order: [['id', 'ASC']],
  });
  const facts = await lineFacts(
    societyId,
    invoiceIds,
    notes.map(n => Number(n.id)),
  );
  const byId = new Map(facts.map(f => [f.id, f]));
  for (const inv of invoices) {
    const list: BalanceEvent[] = [];
    const own = facts.filter(f => f.invoiceId === Number(inv.id));
    list.push({
      date: inv.invoiceDate,
      dOutstanding: Number(inv.totalPaise),
      dNonInterestBearing: own.filter(f => f.nonInterestBearing).reduce((a, f) => a + f.amountPaise, 0),
      dPaid: 0,
    });
    for (const n of notes.filter(x => Number(x.invoiceId) === Number(inv.id))) {
      const lines = facts.filter(f => f.billingNoteId === Number(n.id) && isChargeLike(f.lineKind));
      const date = n.noteDate ?? n.issuedAt?.toISOString().slice(0, 10) ?? inv.invoiceDate;
      if (n.noteType === 'DEBIT') {
        const ib = lines.filter(f => !f.nonInterestBearing);
        list.push({
          date,
          dOutstanding: Number(n.totalPaise),
          dNonInterestBearing: ib.length
            ? lines.filter(f => f.nonInterestBearing).reduce((a, f) => a + f.amountPaise, 0)
            : Number(n.totalPaise),
          dPaid: 0,
        });
      } else {
        const credited = lines.reduce(
          (a, f) =>
            a + (f.refInvoiceLineId && byId.get(f.refInvoiceLineId)?.nonInterestBearing ? f.amountPaise : 0),
          0,
        );
        list.push({
          date,
          dOutstanding: -Number(n.appliedToInvoicePaise),
          dNonInterestBearing: -credited,
          dPaid: 0,
        });
      }
    }
    for (const a of await billingPorts().payments.listAllocationsForInvoice(societyId, Number(inv.id)))
      list.push({
        date: a.allocatedOn,
        dOutstanding: -a.amountPaise,
        dNonInterestBearing: 0,
        dPaid: a.amountPaise,
      });
    out.set(Number(inv.id), list);
  }
  return out;
}

/** Outstanding of an invoice on `asOf`, rebuilt from its events (BR-11-7 identity at that day). */
export const outstandingAsOf = (events: readonly BalanceEvent[], asOf: string): number =>
  Math.max(
    0,
    events.filter(e => e.date <= asOf).reduce((a, e) => a + e.dOutstanding, 0),
  );

/** True when the invoice has an interest-bearing `CHARGE` line (flat fee condition of BR-11-52). */
export async function interestBearingInvoiceIds(
  societyId: number,
  invoiceIds: number[],
): Promise<Set<number>> {
  const facts = await lineFacts(societyId, invoiceIds, []);
  return new Set(
    facts.filter(f => f.lineKind === 'CHARGE' && !f.nonInterestBearing && f.invoiceId).map(f => f.invoiceId!),
  );
}
