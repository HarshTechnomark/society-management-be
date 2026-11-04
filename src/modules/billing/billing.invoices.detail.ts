import { Op, QueryTypes, type WhereOptions } from 'sequelize';
import {
  BillingNote,
  Invoice,
  InvoiceLine,
  Resident,
  Unit,
  UnitLedgerEntry,
  UnitResident,
  sequelize,
} from '../../models';
import { ValidationError, UnprocessableError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import { csvLine } from '../society-setup/society-setup.csv';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { FEATURES } from './billing.constants';
import { addDaysYmd } from './billing.calc.period';
import { invoiceNotFound, periodLabelOfInvoice } from './billing.invoices.shared';
import { billingPorts } from './billing.ports';
import { rupeeText } from './billing.statement.service';
import { societyToday } from './billing.runs.shared';
import type { InvoiceDto, OpenInvoiceDto } from './billing.types';

/** Invoice reads (8.11, 8.12) and the read functions of section 8.24 (`get`, `listOpen`, `billedForMonth`). */

export interface InvoiceListQuery {
  page: number;
  limit: number;
  status?: 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED' | 'OVERDUE' | 'OPEN';
  unitId?: number;
  buildingId?: number;
  invoiceType?: string;
  financialYear?: string;
  periodStart?: string;
  billingRunId?: number;
  billToResidentId?: number;
  isDisputed?: boolean;
  dueFrom?: string;
  dueTo?: string;
  q?: string;
  sortBy: 'invoiceDate' | 'dueDate' | 'totalPaise' | 'outstandingPaise' | 'unitLabel' | 'invoiceNo';
  sortOrder: 'asc' | 'desc';
}

export const EXPORT_MAX_ROWS = 50_000;
/** UTF-8 byte order mark so Excel reads the file as UTF-8. */
const BOM = String.fromCharCode(0xfeff);

const escapeLike = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);

/** The `where` of the list and the export for the admin side (the caller adds `societyId`). */
async function listWhere(societyId: number, q: Partial<InvoiceListQuery>): Promise<WhereOptions> {
  const today = await societyToday(societyId);
  const and: WhereOptions[] = [{ societyId }];
  if (q.status === 'OVERDUE') and.push({ outstandingPaise: { [Op.gt]: 0 }, dueDate: { [Op.lt]: today } });
  else if (q.status === 'OPEN') and.push({ outstandingPaise: { [Op.gt]: 0 } });
  else if (q.status) and.push({ status: q.status });
  if (q.unitId) and.push({ unitId: q.unitId });
  if (q.buildingId) {
    const ids = (await Unit.findAll({
      where: { societyId, buildingId: q.buildingId },
      attributes: ['id'],
      raw: true,
    })) as unknown as { id: number }[];
    and.push({ unitId: { [Op.in]: ids.map(i => Number(i.id)) } });
  }
  if (q.invoiceType) and.push({ invoiceType: q.invoiceType });
  if (q.financialYear) and.push({ financialYear: q.financialYear });
  if (q.periodStart) and.push({ periodStart: q.periodStart });
  if (q.billingRunId) and.push({ billingRunId: q.billingRunId });
  if (q.billToResidentId) and.push({ billToResidentId: q.billToResidentId });
  if (q.isDisputed !== undefined) and.push({ isDisputed: q.isDisputed });
  if (q.dueFrom) and.push({ dueDate: { [Op.gte]: q.dueFrom } });
  if (q.dueTo) and.push({ dueDate: { [Op.lte]: q.dueTo } });
  if (q.q) {
    const like = escapeLike(q.q);
    and.push({
      [Op.or]: [
        { invoiceNo: { [Op.like]: `%${like}%` } },
        { unitLabel: { [Op.like]: `${like}%` } },
        { billToName: { [Op.like]: `%${like}%` } },
      ],
    });
  }
  return { [Op.and]: and };
}

const listItem = (i: Invoice, today: string) => ({
  id: Number(i.id),
  invoiceNo: i.invoiceNo,
  invoiceType: i.invoiceType,
  unitId: Number(i.unitId),
  unitLabel: i.unitLabel,
  billToName: i.billToName,
  billToRelation: i.billToRelation,
  periodLabel: periodLabelOfInvoice(i),
  invoiceDate: i.invoiceDate,
  dueDate: i.dueDate,
  totalPaise: Number(i.totalPaise),
  paidPaise: Number(i.paidPaise),
  outstandingPaise: Number(i.outstandingPaise),
  status: i.status,
  isOverdue: Number(i.outstandingPaise) > 0 && today > i.dueDate,
  isDisputed: Boolean(i.isDisputed),
});

const ORDER: Record<InvoiceListQuery['sortBy'], string> = {
  invoiceDate: 'invoiceDate',
  dueDate: 'dueDate',
  totalPaise: 'totalPaise',
  outstandingPaise: 'outstandingPaise',
  unitLabel: 'unitLabel',
  invoiceNo: 'invoiceNo',
};

export async function listInvoices(societyId: number, q: InvoiceListQuery) {
  const where = await listWhere(societyId, q);
  const today = await societyToday(societyId);
  const dir = q.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const { rows, count } = await Invoice.findAndCountAll({
    where,
    order: [
      [ORDER[q.sortBy], dir],
      ['id', dir],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: rows.map(i => listItem(i, today)), pagination: pageMeta(q.page, q.limit, count) };
}

/** CSV of the filtered invoices (8.11): at most 50,000 rows, text cells go through the injection-safe helper. */
export async function exportInvoices(
  societyId: number,
  q: Partial<InvoiceListQuery>,
): Promise<{ csv: Buffer; rows: number }> {
  const where = await listWhere(societyId, q);
  const total = await Invoice.count({ where });
  if (total > EXPORT_MAX_ROWS)
    throw new UnprocessableError('EXPORT_TOO_LARGE', `More than ${EXPORT_MAX_ROWS} rows; narrow the filter`);
  const today = await societyToday(societyId);
  const dir = (q.sortOrder ?? 'desc') === 'asc' ? 'ASC' : 'DESC';
  const rows = await Invoice.findAll({
    where,
    order: [
      [ORDER[q.sortBy ?? 'invoiceDate'], dir],
      ['id', dir],
    ],
  });
  const lines = [
    csvLine([
      'Invoice no',
      'Type',
      'Flat',
      'Bill to',
      'Relation',
      'Period',
      'Invoice date',
      'Due date',
      'Total',
      'Paid',
      'Outstanding',
      'Status',
      'Overdue',
      'Disputed',
    ]),
    ...rows.map(i => {
      const r = listItem(i, today);
      return csvLine([
        r.invoiceNo,
        r.invoiceType,
        r.unitLabel,
        r.billToName,
        r.billToRelation,
        r.periodLabel,
        r.invoiceDate,
        r.dueDate,
        rupeeText(r.totalPaise),
        rupeeText(r.paidPaise),
        rupeeText(r.outstandingPaise),
        r.status,
        r.isOverdue ? 'Y' : 'N',
        r.isDisputed ? 'Y' : 'N',
      ]);
    }),
  ];
  return { csv: Buffer.from(`${BOM}${lines.join('\r\n')}\r\n`, 'utf8'), rows: rows.length };
}

// ------------------------------------------------------------------ 8.12

export interface InvoiceLineView {
  id: number;
  lineNo: number;
  lineKind: string;
  chargeHeadId: number | null;
  headKey: string | null;
  description: string;
  quantity: string | null;
  ratePaise: number | null;
  amountPaise: number;
  isTaxable: boolean;
  creditedPaise: number;
  periodFrom: string | null;
  periodTo: string | null;
  prorationDays: number | null;
  periodDays: number | null;
  computation?: unknown;
}

const lineView = (l: InvoiceLine, explain: boolean): InvoiceLineView => ({
  id: Number(l.id),
  lineNo: l.lineNo,
  lineKind: l.lineKind,
  chargeHeadId: l.chargeHeadId === null ? null : Number(l.chargeHeadId),
  headKey: l.headKey,
  description: l.description,
  quantity: l.quantity,
  ratePaise: l.ratePaise === null ? null : Number(l.ratePaise),
  amountPaise: Number(l.amountPaise),
  isTaxable: Boolean(l.isTaxable),
  creditedPaise: Number(l.creditedPaise),
  periodFrom: l.periodFrom,
  periodTo: l.periodTo,
  prorationDays: l.prorationDays,
  periodDays: l.periodDays,
  ...(explain && l.computation ? { computation: l.computation } : {}),
});

/**
 * The invoice of 8.12: lines, notes, allocations (module 12 port) and the ledger entries that refer to the invoice and its
 * notes. `computation` is omitted when `billing.explain_my_bill` is off. The resident variant (11.5) can reuse it.
 */
export async function loadInvoiceDetail(
  societyId: number,
  id: number,
  opts: { withAllocations?: boolean } = {},
) {
  const inv = await Invoice.findOne({ where: { id, societyId } });
  if (!inv) throw invoiceNotFound();
  const today = await societyToday(societyId);
  const explain = await isFeatureOn(societyId, FEATURES.explainMyBill);
  const lines = await InvoiceLine.findAll({ where: { invoiceId: inv.id! }, order: [['lineNo', 'ASC']] });
  const notes = await BillingNote.findAll({
    where: { societyId, invoiceId: inv.id! },
    order: [['id', 'ASC']],
  });
  const allocations =
    opts.withAllocations === false
      ? []
      : await billingPorts().payments.listAllocationsForInvoice(societyId, Number(inv.id));
  const noteIds = notes.map(n => Number(n.id));
  const ledger = await UnitLedgerEntry.findAll({
    where: {
      societyId,
      unitId: inv.unitId,
      [Op.or]: [
        { refType: 'invoice', refId: inv.id! },
        ...(noteIds.length ? [{ refType: 'billing_note', refId: { [Op.in]: noteIds } }] : []),
      ],
    },
    order: [['id', 'ASC']],
  });
  return {
    id: Number(inv.id),
    invoiceNo: inv.invoiceNo,
    invoiceType: inv.invoiceType,
    status: inv.status,
    financialYear: inv.financialYear,
    unit: { id: Number(inv.unitId), label: inv.unitLabel },
    billTo: { residentId: Number(inv.billToResidentId), name: inv.billToName, relation: inv.billToRelation },
    billingRunId: inv.billingRunId === null ? null : Number(inv.billingRunId),
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    periodLabel: periodLabelOfInvoice(inv),
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate,
    description: inv.description,
    refType: inv.refType,
    refId: inv.refId === null ? null : Number(inv.refId),
    isOverdue: Number(inv.outstandingPaise) > 0 && today > inv.dueDate,
    isDisputed: Boolean(inv.isDisputed),
    gstApplied: Boolean(inv.gstApplied),
    societyGstin: inv.societyGstin,
    thresholdBasePaise: Number(inv.thresholdBasePaise),
    taxableValuePaise: Number(inv.taxableValuePaise),
    subtotalPaise: Number(inv.subtotalPaise),
    cgstPaise: Number(inv.cgstPaise),
    sgstPaise: Number(inv.sgstPaise),
    taxPaise: Number(inv.taxPaise),
    roundOffPaise: Number(inv.roundOffPaise),
    totalPaise: Number(inv.totalPaise),
    debitedPaise: Number(inv.debitedPaise),
    creditedPaise: Number(inv.creditedPaise),
    writtenOffPaise: Number(inv.writtenOffPaise),
    paidPaise: Number(inv.paidPaise),
    outstandingPaise: Number(inv.outstandingPaise),
    previousDuesPaise: Number(inv.previousDuesPaise),
    settledOn: inv.settledOn,
    lines: lines.map(l => lineView(l, explain)),
    notes: notes.map(n => ({
      id: Number(n.id),
      noteType: n.noteType,
      noteNo: n.noteNo,
      status: n.status,
      reasonCode: n.reasonCode,
      noteDate: n.noteDate,
      totalPaise: Number(n.totalPaise),
      pdfStatus: n.pdfStatus,
    })),
    allocations,
    ledger: ledger.map(e => ({
      id: Number(e.id),
      entryType: e.entryType,
      refType: e.refType,
      refId: Number(e.refId),
      entryDate: e.entryDate,
      debitPaise: Number(e.debitPaise),
      creditPaise: Number(e.creditPaise),
    })),
    pdfStatus: inv.pdfStatus,
    version: Number(inv.version),
  };
}

// ------------------------------------------------------------------ section 8.24 readers

/** `invoices.get` for modules 09, 15, 23, 24, 25: the flat invoice with lines (no explain data), or null. */
export async function getInvoice(societyId: number, invoiceId: number): Promise<InvoiceDto | null> {
  const inv = await Invoice.findOne({ where: { id: invoiceId, societyId } });
  if (!inv) return null;
  const lines = await InvoiceLine.findAll({ where: { invoiceId: inv.id! }, order: [['lineNo', 'ASC']] });
  return {
    id: Number(inv.id),
    invoiceNo: inv.invoiceNo,
    status: inv.status,
    totalPaise: Number(inv.totalPaise),
    paidPaise: Number(inv.paidPaise),
    creditedPaise: Number(inv.creditedPaise),
    debitedPaise: Number(inv.debitedPaise),
    outstandingPaise: Number(inv.outstandingPaise),
    settledOn: inv.settledOn,
    societyId: Number(inv.societyId),
    invoiceType: inv.invoiceType,
    financialYear: inv.financialYear,
    billingRunId: inv.billingRunId === null ? null : Number(inv.billingRunId),
    unitId: Number(inv.unitId),
    unitLabel: inv.unitLabel,
    billToResidentId: Number(inv.billToResidentId),
    billToRelation: inv.billToRelation,
    billToName: inv.billToName,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    invoiceDate: inv.invoiceDate,
    dueDate: inv.dueDate,
    description: inv.description,
    refType: inv.refType,
    refId: inv.refId === null ? null : Number(inv.refId),
    gstApplied: Boolean(inv.gstApplied),
    taxableValuePaise: Number(inv.taxableValuePaise),
    subtotalPaise: Number(inv.subtotalPaise),
    cgstPaise: Number(inv.cgstPaise),
    sgstPaise: Number(inv.sgstPaise),
    taxPaise: Number(inv.taxPaise),
    roundOffPaise: Number(inv.roundOffPaise),
    previousDuesPaise: Number(inv.previousDuesPaise),
    writtenOffPaise: Number(inv.writtenOffPaise),
    isDisputed: Boolean(inv.isDisputed),
    pdfStatus: inv.pdfStatus,
    lines: lines.map(l => ({
      id: Number(l.id),
      lineNo: l.lineNo,
      lineKind: l.lineKind,
      chargeHeadId: l.chargeHeadId === null ? null : Number(l.chargeHeadId),
      headKey: l.headKey,
      description: l.description,
      quantity: l.quantity,
      ratePaise: l.ratePaise === null ? null : Number(l.ratePaise),
      amountPaise: Number(l.amountPaise),
      creditedPaise: Number(l.creditedPaise),
      isTaxable: Boolean(l.isTaxable),
      periodFrom: l.periodFrom,
      periodTo: l.periodTo,
      prorationDays: l.prorationDays,
      periodDays: l.periodDays,
    })),
  };
}

/** BR-11-61 (a) and (b) for one user and one flat: ids of residents the user is, and whether the user owns the flat. */
async function visibilityOf(societyId: number, unitId: number, userId: number) {
  const mine = (
    await Resident.findAll({ where: { societyId, userId }, attributes: ['id'], paranoid: false })
  ).map(r => Number(r.id));
  const owner = mine.length
    ? (await UnitResident.count({
        where: {
          societyId,
          unitId,
          residentId: { [Op.in]: mine },
          relation: { [Op.in]: ['OWNER', 'CO_OWNER'] },
          toDate: null,
        },
      })) > 0
    : false;
  return { mine, owner };
}

/** `invoices.listOpen` for module 12: open invoices of a flat, oldest due first; `payerUserId` limits it to what that user sees. */
export async function listOpen(
  societyId: number,
  unitId: number,
  opts: { payerUserId?: number } = {},
): Promise<OpenInvoiceDto[]> {
  const where: WhereOptions[] = [
    { societyId, unitId, outstandingPaise: { [Op.gt]: 0 }, status: { [Op.ne]: 'CANCELLED' } },
  ];
  if (opts.payerUserId) {
    const v = await visibilityOf(societyId, unitId, opts.payerUserId);
    if (!v.owner) where.push({ billToResidentId: { [Op.in]: v.mine.length ? v.mine : [0] } });
  }
  const rows = await Invoice.findAll({
    where: { [Op.and]: where },
    order: [
      ['dueDate', 'ASC'],
      ['invoiceDate', 'ASC'],
      ['id', 'ASC'],
    ],
  });
  return rows.map(i => ({
    id: Number(i.id),
    invoiceNo: i.invoiceNo,
    periodLabel: periodLabelOfInvoice(i),
    issueDate: i.invoiceDate,
    dueDate: i.dueDate,
    outstandingPaise: Number(i.outstandingPaise),
    isDisputed: Boolean(i.isDisputed),
  }));
}

/** `invoices.billedForMonth`: Σ total of non-cancelled regular and supplementary invoices whose period starts in the month (8.22). */
export async function billedForMonth(
  societyId: number,
  month: string,
): Promise<{ billedPaise: number; invoiceIds: number[] }> {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month))
    throw new ValidationError([{ field: 'month', message: 'Use YYYY-MM' }]);
  const from = `${month}-01`;
  const next = addDaysYmd(`${month}-28`, 4).slice(0, 7);
  const rows = await sequelize.query<{ id: number; totalPaise: string | number }>(
    `SELECT id, totalPaise FROM invoices WHERE societyId = :societyId AND status <> 'CANCELLED'
        AND invoiceType IN ('REGULAR', 'SUPPLEMENTARY') AND periodStart >= :from AND periodStart < :to ORDER BY id`,
    { replacements: { societyId, from, to: `${next}-01` }, type: QueryTypes.SELECT },
  );
  return {
    billedPaise: rows.reduce((a, r) => a + Number(r.totalPaise), 0),
    invoiceIds: rows.map(r => Number(r.id)),
  };
}
