import { Op } from 'sequelize';
import { BillingNote, ChargeHead, Invoice, InvoiceLine, Unit } from '../../models';
import { NotFoundError } from '../../utils/errors';
import type { Ctx, SystemCtx } from '../../types/context';
import type { LineKind, NoteReasonCode, NoteStatus, NoteType, PdfStatus } from './billing.constants';
import { fundFor, noteNotFound } from './billing.invoices.shared';
import type { Transaction } from './billing.types';

/** Types, loaders and the response shape of billing notes (sub-module 11.4, sections 7.9 and 8.15 to 8.19). */

export interface NoteLineDto {
  id: number;
  lineNo: number;
  lineKind: LineKind;
  chargeHeadId: number | null;
  headKey: string | null;
  description: string;
  amountPaise: number;
  refInvoiceLineId: number | null;
}

export interface NoteDto {
  id: number;
  noteType: NoteType;
  noteNo: string | null;
  status: NoteStatus;
  reasonCode: NoteReasonCode;
  invoiceId: number;
  invoiceNo: string;
  unitId: number;
  unitLabel: string;
  billToResidentId: number;
  billToName: string;
  noteDate: string | null;
  subtotalPaise: number;
  cgstPaise: number;
  sgstPaise: number;
  taxPaise: number;
  roundOffPaise: number;
  totalPaise: number;
  appliedToInvoicePaise: number;
  excessToAdvancePaise: number;
  remarks: string;
  rejectedReason: string | null;
  approvalType: string | null;
  approvalRequestId: number | null;
  pdfStatus: PdfStatus;
  createdBy: number | null;
  issuedAt: string | null;
  createdAt: string;
  version: number;
  lines?: NoteLineDto[];
}

const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);

export function noteDto(
  n: BillingNote,
  ctx: { invoiceNo: string; unitLabel: string },
  lines?: InvoiceLine[],
): NoteDto {
  return {
    id: Number(n.id),
    noteType: n.noteType,
    noteNo: n.noteNo,
    status: n.status,
    reasonCode: n.reasonCode,
    invoiceId: Number(n.invoiceId),
    invoiceNo: ctx.invoiceNo,
    unitId: Number(n.unitId),
    unitLabel: ctx.unitLabel,
    billToResidentId: Number(n.billToResidentId),
    billToName: n.billToName,
    noteDate: n.noteDate,
    subtotalPaise: Number(n.subtotalPaise),
    cgstPaise: Number(n.cgstPaise),
    sgstPaise: Number(n.sgstPaise),
    taxPaise: Number(n.taxPaise),
    roundOffPaise: Number(n.roundOffPaise),
    totalPaise: Number(n.totalPaise),
    appliedToInvoicePaise: Number(n.appliedToInvoicePaise),
    excessToAdvancePaise: Number(n.excessToAdvancePaise),
    remarks: n.remarks,
    rejectedReason: n.rejectedReason,
    approvalType: n.approvalType,
    approvalRequestId: n.approvalRequestId === null ? null : Number(n.approvalRequestId),
    pdfStatus: n.pdfStatus,
    createdBy: n.createdBy === null ? null : Number(n.createdBy),
    issuedAt: iso(n.issuedAt),
    createdAt: iso(n.createdAt)!,
    version: Number(n.version),
    ...(lines
      ? {
          lines: lines.map(l => ({
            id: Number(l.id),
            lineNo: l.lineNo,
            lineKind: l.lineKind,
            chargeHeadId: l.chargeHeadId === null ? null : Number(l.chargeHeadId),
            headKey: l.headKey,
            description: l.description,
            amountPaise: Number(l.amountPaise),
            refInvoiceLineId: l.refInvoiceLineId === null ? null : Number(l.refInvoiceLineId),
          })),
        }
      : {}),
  };
}

/** The note with its invoice number and unit label, for the response. */
export async function loadNoteDto(
  societyId: number,
  noteId: number,
  withLines = true,
  t?: Transaction,
): Promise<NoteDto> {
  const n = await BillingNote.findOne({ where: { id: noteId, societyId }, transaction: t });
  if (!n) throw noteNotFound();
  const inv = await Invoice.findByPk(n.invoiceId, { attributes: ['invoiceNo', 'unitLabel'], transaction: t });
  const lines = withLines
    ? await InvoiceLine.findAll({
        where: { billingNoteId: n.id! },
        order: [['lineNo', 'ASC']],
        transaction: t,
      })
    : undefined;
  return noteDto(n, { invoiceNo: inv?.invoiceNo ?? '', unitLabel: inv?.unitLabel ?? '' }, lines);
}

/** `FOR UPDATE` read of a note of the society, `404 NOTE_NOT_FOUND` otherwise. */
export async function lockNote(societyId: number, id: number, t: Transaction): Promise<BillingNote> {
  const n = await BillingNote.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!n) throw noteNotFound();
  return n;
}

/** Unlocked read of a note for the lock order (unit, invoice, then the note); `404 NOTE_NOT_FOUND` for other societies. */
export async function peekNote(societyId: number, id: number, t: Transaction): Promise<BillingNote> {
  const n = await BillingNote.findOne({ where: { id, societyId }, transaction: t });
  if (!n) throw noteNotFound();
  return n;
}

/** Locks the unit row, the invoice and the note of a note id, in that order (section 13). */
export async function lockNoteChain(
  societyId: number,
  noteId: number,
  t: Transaction,
): Promise<{ note: BillingNote; invoice: Invoice }> {
  const peek = await peekNote(societyId, noteId, t);
  await Unit.findOne({
    where: { id: peek.unitId, societyId },
    attributes: ['id'],
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  const invoice = await Invoice.findOne({
    where: { id: peek.invoiceId, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!invoice) throw new NotFoundError('INVOICE_NOT_FOUND', 'Invoice not found');
  const note = await lockNote(societyId, noteId, t);
  return { note, invoice };
}

/** Heads of the lines by id. */
export async function headsById(
  societyId: number,
  ids: number[],
  t: Transaction,
): Promise<Map<number, ChargeHead>> {
  if (!ids.length) return new Map();
  const rows = await ChargeHead.findAll({
    where: { societyId, id: { [Op.in]: [...new Set(ids)] } },
    transaction: t,
  });
  return new Map(rows.map(h => [Number(h.id), h]));
}

/** Journal fund of each line of a document (head fund, or the collection's fund through the resolver). */
export async function journalLinesWithFunds(
  societyId: number,
  invoice: Pick<Invoice, 'refType' | 'refId'>,
  lines: Pick<InvoiceLine, 'lineKind' | 'amountPaise' | 'ledgerAccountCode' | 'chargeHeadId'>[],
  t: Transaction,
): Promise<{ lineKind: string; amountPaise: number; ledgerAccountCode: string; fundId: number | null }[]> {
  const heads = await headsById(
    societyId,
    lines.map(l => l.chargeHeadId).filter((x): x is number => x !== null && x !== undefined),
    t,
  );
  const out = [];
  for (const l of lines) {
    const head = l.chargeHeadId ? heads.get(Number(l.chargeHeadId)) : undefined;
    out.push({
      lineKind: l.lineKind,
      amountPaise: Number(l.amountPaise),
      ledgerAccountCode: l.ledgerAccountCode,
      fundId: head
        ? await fundFor(societyId, head, { refType: invoice.refType, refId: invoice.refId })
        : null,
    });
  }
  return out;
}

export type CallCtx = Ctx | SystemCtx;
