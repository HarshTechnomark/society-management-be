/** Reads of module 06 (8.1 to 8.4, 8.7, 8.8): billing summary, invoice lists and detail, PDF link, payments, credits, CSV export. */
import { Op, type WhereOptions } from 'sequelize';
import {
  DunningEvent,
  PlatformCredit,
  PlatformInvoice,
  PlatformInvoiceLine,
  PlatformPayment,
  Society,
  Subscription,
  User,
} from '../../models';
import { addHours, now } from '../../lib/clock';
import { enqueue } from '../../lib/queue';
import { audit } from '../../utils/audit';
import { pageMeta } from '../../utils/pagination';
import { AppError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { societyPorts } from '../societies/societies.ports';
import { OPEN_STATUSES } from './pricing';
import { billingSettings } from './platform-billing.settings';
import { creditBalance, getOutstanding, todayIst } from './platform-billing.settlement';
import { PLATFORM_BILLING_QUEUE, RENDER_PDF_JOB, invoiceNotFound } from './platform-billing.service';
import { lineDto } from './platform-billing.types';
import { num, paymentDetail, paymentItem } from './platform-billing.shared';
import { creditDto } from './platform-billing.credits';

/** Who is asking: a society (its own rows only, no drafts) or the platform. */
export type Audience = { societyId: number } | { societyId?: undefined };

const csvList = (v: string | undefined): string[] | undefined => v?.split(',').filter(Boolean);

// ------------------------------------------------------------------ 8.1
export async function billingSummary(societyId: number) {
  const s = await billingSettings();
  const society = await Society.findByPk(societyId, { attributes: ['id', 'status'] });
  if (!society) throw new NotFoundError('NOT_FOUND', 'Society not found');
  const { outstandingPaise, overduePaise } = await getOutstanding(societyId);
  const open = await PlatformInvoice.findAll({
    attributes: ['dueDate', 'suspendOn', 'amountDuePaise'],
    where: {
      societyId,
      documentType: 'INVOICE',
      status: OPEN_STATUSES as unknown as string[],
      amountDuePaise: { [Op.gt]: 0 },
    },
  });
  const today = todayIst();
  const min = Math.max(1, s['billing.dunningMinDuePaise']);
  const suspensions = open
    .filter(i => i.dueDate && i.dueDate < today && num(i.amountDuePaise) >= min && i.suspendOn)
    .map(i => i.suspendOn!)
    .sort();
  const sub = await Subscription.findOne({
    where: { societyId },
    order: [['id', 'DESC']],
    attributes: ['autopayStatus'],
  });
  const pending = await PlatformPayment.sum('amountPaise', {
    where: { societyId, kind: 'PAYMENT', status: 'PENDING_APPROVAL' },
  });
  return {
    outstandingPaise,
    overduePaise,
    openInvoiceCount: open.length,
    oldestDueDate: open.map(i => i.dueDate!).sort()[0] ?? null,
    nextSuspensionDate: suspensions[0] ?? null,
    creditBalancePaise: await creditBalance(societyId),
    societyStatus: society.status,
    autopayStatus: sub?.autopayStatus ?? 'NONE',
    pendingManualPaymentPaise: num(pending),
  };
}

// ------------------------------------------------------------------ 8.2
export interface InvoiceListQuery {
  page: number;
  limit: number;
  documentType?: 'INVOICE' | 'CREDIT_NOTE';
  status?: string;
  invoiceKind?: string;
  issueFrom?: string;
  issueTo?: string;
  q?: string;
  societyId?: number;
  taxType?: string;
  sortBy: 'issueDate' | 'dueDate' | 'totalPaise' | 'amountDuePaise' | 'invoiceNo';
  sortOrder: 'asc' | 'desc';
}

function invoiceWhere(a: Audience, q: Omit<InvoiceListQuery, 'page' | 'limit' | 'sortBy' | 'sortOrder'>) {
  const and: WhereOptions[] = [];
  if (a.societyId !== undefined)
    and.push({ societyId: a.societyId }, { status: { [Op.notIn]: ['DRAFT', 'REJECTED'] } });
  else if (q.societyId) and.push({ societyId: q.societyId });
  if (q.documentType) and.push({ documentType: q.documentType });
  const statuses = csvList(q.status);
  if (statuses) and.push({ status: { [Op.in]: statuses } });
  if (q.invoiceKind) and.push({ invoiceKind: q.invoiceKind });
  if (q.issueFrom) and.push({ issueDate: { [Op.gte]: q.issueFrom } });
  if (q.issueTo) and.push({ issueDate: { [Op.lte]: q.issueTo } });
  if (q.taxType && a.societyId === undefined) and.push({ taxType: q.taxType });
  if (q.q) {
    const like = `${q.q.replace(/[\\%_]/g, '\\$&')}%`;
    const byNo = { invoiceNo: { [Op.like]: like } };
    and.push(
      a.societyId === undefined
        ? { [Op.or]: [byNo, { '$Society.name$': { [Op.like]: `%${q.q.replace(/[\\%_]/g, '\\$&')}%` } }] }
        : byNo,
    );
  }
  return { [Op.and]: and };
}

const invoiceItem = (i: PlatformInvoice & { Society?: Society }) => ({
  id: i.id!,
  invoiceNo: i.invoiceNo,
  documentType: i.documentType,
  invoiceKind: i.invoiceKind,
  societyId: i.societyId,
  societyName: i.Society?.name ?? null,
  status: i.status,
  issueDate: i.issueDate,
  dueDate: i.dueDate,
  periodStart: i.periodStart,
  periodEnd: i.periodEnd,
  subtotalPaise: num(i.subtotalPaise),
  taxPaise: num(i.taxPaise),
  totalPaise: num(i.totalPaise),
  amountDuePaise: num(i.amountDuePaise),
  pdfStatus: i.pdfStatus,
});

export async function listInvoices(a: Audience, q: InvoiceListQuery) {
  const { rows, count } = await PlatformInvoice.findAndCountAll({
    where: invoiceWhere(a, q),
    include: [
      { model: Society, attributes: ['id', 'name'], required: a.societyId === undefined && Boolean(q.q) },
    ],
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
    distinct: true,
    subQuery: false,
  });
  return { data: rows.map(r => invoiceItem(r as never)), pagination: pageMeta(q.page, q.limit, count) };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const MAX_EXPORT_ROWS = 50_000;

/** 8.2 export: same filters, no paging, at most 50,000 rows. */
export async function exportInvoicesCsv(
  ctx: Ctx,
  q: Omit<InvoiceListQuery, 'page' | 'limit'>,
): Promise<string> {
  const where = invoiceWhere({}, q);
  const include = [{ model: Society, attributes: ['id', 'name'], required: Boolean(q.q) }];
  const total = await PlatformInvoice.count({ where, include, distinct: true });
  if (total > MAX_EXPORT_ROWS)
    throw new UnprocessableError('EXPORT_TOO_LARGE', 'More than 50,000 documents match. Narrow the filters.');
  const rows = await PlatformInvoice.findAll({
    where,
    include,
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ],
    subQuery: false,
  });
  const header = [
    'Invoice',
    'Type',
    'Society',
    'GSTIN',
    'Place of supply',
    'Issue date',
    'Due date',
    'Period',
    'Taxable',
    'CGST',
    'SGST',
    'IGST',
    'Total',
    'Paid',
    'TDS',
    'Credit applied',
    'Credit noted',
    'Written off',
    'Due',
    'Status',
  ];
  const rupees = (p: unknown) => (num(p) / 100).toFixed(2);
  const lines = [header.join(',')];
  for (const i of rows as (PlatformInvoice & { Society?: Society })[])
    lines.push(
      [
        i.invoiceNo,
        i.documentType,
        i.billingName,
        i.billingGstin,
        i.placeOfSupplyStateCode,
        i.issueDate,
        i.dueDate,
        i.periodStart ? `${i.periodStart} to ${i.periodEnd}` : '',
        rupees(i.subtotalPaise),
        rupees(i.cgstPaise),
        rupees(i.sgstPaise),
        rupees(i.igstPaise),
        rupees(i.totalPaise),
        rupees(i.paidPaise),
        rupees(i.tdsPaise),
        rupees(i.creditAppliedPaise),
        rupees(i.creditNotedPaise),
        rupees(i.writtenOffPaise),
        rupees(i.amountDuePaise),
        i.status,
      ]
        .map(csvCell)
        .join(','),
    );
  await audit(ctx, {
    action: 'platform_billing.invoice.exported',
    entityType: 'platform_invoice',
    entityId: 0,
    after: { rows: rows.length, filters: { ...q } },
  });
  return lines.join('\r\n');
}

// ------------------------------------------------------------------ 8.3
async function findDocument(a: Audience, id: number): Promise<PlatformInvoice> {
  const inv = await PlatformInvoice.findByPk(id);
  if (!inv) throw invoiceNotFound();
  if (
    a.societyId !== undefined &&
    (inv.societyId !== a.societyId || ['DRAFT', 'REJECTED'].includes(inv.status))
  )
    throw invoiceNotFound();
  return inv;
}

const visiblePayment = (a: Audience) => (p: PlatformPayment) =>
  a.societyId === undefined ||
  p.status !== 'CREATED' ||
  p.createdAt!.getTime() > addHours(now(), -24).getTime();

export async function invoiceDetail(a: Audience, id: number) {
  const inv = await findDocument(a, id);
  const lines = await PlatformInvoiceLine.findAll({ where: { invoiceId: id }, order: [['lineNo', 'ASC']] });
  const creditNotes = await PlatformInvoice.findAll({
    where: { originalInvoiceId: id, status: 'ISSUED' },
    order: [['id', 'ASC']],
  });
  const payments = (
    await PlatformPayment.findAll({ where: { invoiceId: id }, order: [['id', 'ASC']] })
  ).filter(visiblePayment(a));
  const original = inv.originalInvoiceId ? await PlatformInvoice.findByPk(inv.originalInvoiceId) : null;
  const base = {
    id: inv.id!,
    societyId: inv.societyId,
    invoiceNo: inv.invoiceNo,
    documentType: inv.documentType,
    invoiceKind: inv.invoiceKind,
    status: inv.status,
    financialYear: inv.financialYear,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    suspendOn: inv.suspendOn,
    periodStart: inv.periodStart,
    periodEnd: inv.periodEnd,
    planKey: inv.planKey,
    billingCycle: inv.billingCycle,
    supplier: {
      legalName: inv.supplierLegalName,
      gstin: inv.supplierGstin,
      stateCode: inv.supplierStateCode,
      address: inv.supplierAddress,
    },
    buyer: {
      name: inv.billingName,
      gstin: inv.billingGstin,
      address: inv.billingAddress,
      stateName: inv.billingStateName,
    },
    placeOfSupplyStateCode: inv.placeOfSupplyStateCode,
    taxType: inv.taxType,
    gstRatePct: String(inv.gstRatePct),
    sacCode: inv.sacCode,
    lines: lines.map(lineDto),
    subtotalPaise: num(inv.subtotalPaise),
    cgstPaise: num(inv.cgstPaise),
    sgstPaise: num(inv.sgstPaise),
    igstPaise: num(inv.igstPaise),
    taxPaise: num(inv.taxPaise),
    totalPaise: num(inv.totalPaise),
    creditAppliedPaise: num(inv.creditAppliedPaise),
    paidPaise: num(inv.paidPaise),
    tdsPaise: num(inv.tdsPaise),
    creditNotedPaise: num(inv.creditNotedPaise),
    writtenOffPaise: num(inv.writtenOffPaise),
    excessToCreditPaise: num(inv.excessToCreditPaise),
    amountDuePaise: num(inv.amountDuePaise),
    creditNoteReason: inv.creditNoteReason,
    notes: inv.notes,
    originalInvoice: original ? { id: original.id!, invoiceNo: original.invoiceNo } : null,
    creditNotes: creditNotes.map(c => ({
      id: c.id!,
      invoiceNo: c.invoiceNo,
      issueDate: c.issueDate,
      totalPaise: num(c.totalPaise),
      status: c.status,
    })),
    payments: payments.map(p => paymentItem(p, inv.invoiceNo)),
    pdfStatus: inv.pdfStatus,
    version: inv.version,
  };
  if (a.societyId !== undefined) return base;
  const events = await DunningEvent.findAll({ where: { invoiceId: id }, order: [['id', 'ASC']] });
  const names = async (ids: (number | null)[]) => {
    const list = ids.filter((x): x is number => x !== null);
    const users = list.length ? await User.findAll({ where: { id: list }, attributes: ['id', 'name'] }) : [];
    return new Map(users.map(u => [u.id!, u.name]));
  };
  const who = await names([inv.createdBy, inv.approvedBy, inv.writeOffRequestedBy, inv.writtenOffBy]);
  const person = (uid: number | null) => (uid === null ? null : { id: uid, name: who.get(uid) ?? null });
  return {
    ...base,
    createdBy: person(inv.createdBy),
    approvedBy: person(inv.approvedBy),
    rejectedReason: inv.rejectedReason,
    dunningEvents: events.map(e => ({
      id: e.id!,
      step: e.step,
      offsetDays: e.offsetDays,
      scheduledFor: e.scheduledFor,
      outcome: e.outcome,
      skipReason: e.skipReason,
      suspendOnBefore: e.suspendOnBefore,
      suspendOnAfter: e.suspendOnAfter,
      notes: e.notes,
    })),
    writeOff: {
      requestedBy: person(inv.writeOffRequestedBy),
      requestedAt: inv.writeOffRequestedAt?.toISOString() ?? null,
      reason: inv.writeOffReason,
      writtenOffBy: person(inv.writtenOffBy),
      writtenOffAt: inv.writtenOffAt?.toISOString() ?? null,
    },
  };
}

// ------------------------------------------------------------------ 8.4
export async function invoicePdfUrl(ctx: Ctx, a: Audience, id: number) {
  const inv = await findDocument(a, id);
  if (inv.pdfStatus !== 'READY' || !inv.pdfFileId) {
    if (inv.pdfStatus === 'FAILED')
      await enqueue(
        PLATFORM_BILLING_QUEUE,
        RENDER_PDF_JOB,
        { invoiceId: inv.id! },
        { jobId: `pdf-retry-${inv.id}-${Date.now()}` },
      );
    throw new AppError(409, 'PDF_NOT_READY', 'The PDF is not ready yet');
  }
  const link = await societyPorts().files.downloadUrl(inv.pdfFileId, 5);
  await audit(ctx, {
    action: 'platform_billing.invoice.pdf_downloaded',
    entityType: 'platform_invoice',
    entityId: inv.id!,
    entityLabel: inv.invoiceNo,
    societyId: inv.societyId,
  });
  return {
    url: link.url,
    expiresAt: link.expiresAt.toISOString(),
    fileName: `${(inv.invoiceNo ?? 'document').replace(/\//g, '-')}.pdf`,
  };
}

// ------------------------------------------------------------------ 8.7
export interface PaymentListQuery {
  page: number;
  limit: number;
  kind?: 'PAYMENT' | 'TDS' | 'REFUND';
  status?: string;
  method?: string;
  invoiceId?: number;
  from?: string;
  to?: string;
  societyId?: number;
  origin?: string;
  sortBy: 'createdAt' | 'amountPaise' | 'capturedAt';
  sortOrder: 'asc' | 'desc';
}

export async function listPayments(a: Audience, q: PaymentListQuery) {
  const and: WhereOptions[] = [];
  if (a.societyId !== undefined) {
    and.push({ societyId: a.societyId });
    and.push({
      [Op.or]: [{ status: { [Op.ne]: 'CREATED' } }, { createdAt: { [Op.gt]: addHours(now(), -24) } }],
    });
  } else if (q.societyId) and.push({ societyId: q.societyId });
  if (q.kind) and.push({ kind: q.kind });
  const statuses = csvList(q.status);
  if (statuses) and.push({ status: { [Op.in]: statuses } });
  if (q.method) and.push({ method: q.method });
  if (q.invoiceId) and.push({ invoiceId: q.invoiceId });
  if (q.from) and.push({ createdAt: { [Op.gte]: new Date(`${q.from}T00:00:00+05:30`) } });
  if (q.to)
    and.push({ createdAt: { [Op.lt]: new Date(new Date(`${q.to}T00:00:00+05:30`).getTime() + 86_400_000) } });
  if (q.origin && a.societyId === undefined) and.push({ origin: q.origin });
  const { rows, count } = await PlatformPayment.findAndCountAll({
    where: { [Op.and]: and },
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const ids = [...new Set(rows.map(r => r.invoiceId).filter((x): x is number => x !== null))];
  const invs = ids.length
    ? await PlatformInvoice.findAll({ where: { id: ids }, attributes: ['id', 'invoiceNo'] })
    : [];
  const no = new Map(invs.map(i => [i.id!, i.invoiceNo]));
  const societies =
    a.societyId === undefined && rows.length
      ? new Map(
          (
            await Society.findAll({
              where: { id: [...new Set(rows.map(r => r.societyId))] },
              attributes: ['id', 'name'],
            })
          ).map(s => [s.id!, s.name]),
        )
      : null;
  return {
    data: rows.map(r => {
      const invoiceNo = r.invoiceId ? (no.get(r.invoiceId) ?? null) : null;
      return a.societyId === undefined
        ? { ...paymentDetail(r, invoiceNo), societyName: societies?.get(r.societyId) ?? null }
        : paymentItem(r, invoiceNo);
    }),
    pagination: pageMeta(q.page, q.limit, count),
  };
}

// ------------------------------------------------------------------ 8.8
export interface CreditListQuery {
  page: number;
  limit: number;
  entryType?: string;
  status?: string;
  sortBy: 'createdAt';
  sortOrder: 'asc' | 'desc';
}

export async function listCredits(
  a: Audience & { societyId: number },
  platform: boolean,
  q: CreditListQuery,
) {
  const and: WhereOptions[] = [{ societyId: a.societyId }];
  if (platform) {
    const statuses = csvList(q.status);
    if (statuses) and.push({ status: { [Op.in]: statuses } });
  } else and.push({ status: 'POSTED' });
  if (q.entryType) and.push({ entryType: q.entryType });
  const { rows, count } = await PlatformCredit.findAndCountAll({
    where: { [Op.and]: and },
    order: [
      ['createdAt', q.sortOrder.toUpperCase()],
      ['id', q.sortOrder.toUpperCase()],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const ids = [...new Set(rows.map(r => r.invoiceId).filter((x): x is number => x !== null))];
  const invs = ids.length
    ? await PlatformInvoice.findAll({ where: { id: ids }, attributes: ['id', 'invoiceNo'] })
    : [];
  const no = new Map(invs.map(i => [i.id!, i.invoiceNo]));
  return {
    balancePaise: await creditBalance(a.societyId),
    items: rows.map(r => ({
      ...creditDto(r),
      invoiceNo: r.invoiceId ? (no.get(r.invoiceId) ?? null) : null,
    })),
    pagination: pageMeta(q.page, q.limit, count),
  };
}
