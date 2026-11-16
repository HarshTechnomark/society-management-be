import { Op } from 'sequelize';
import { Payment, Refund, Unit } from '../../models';
import type { Ctx } from '../../types/context';
import { audit } from '../../utils/audit';
import { UnprocessableError, ValidationError } from '../../utils/errors';
import { toCsv } from '../society-setup/society-setup.csv';
import { REFUND_STATUSES, AUDIT, ERR } from './payments.constants';
import { dateOnly } from './payments.admin.dto';
import {
  paymentWhere,
  sortOrderOf,
  type PaymentFilters,
  type PaymentListQuery,
} from './payments.admin.queries';
import { n } from './payments.shared';

/** `GET /payments/export` (8.17): CSV of payments or refunds, at most 50,000 rows, audited. */
export const EXPORT_MAX_ROWS = 50_000;
const BATCH = 1000;

export const rupees = (paise: number): string => {
  const abs = Math.abs(paise);
  return `${paise < 0 ? '-' : ''}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

export interface ExportInput extends Omit<PaymentFilters, 'status'> {
  type: 'PAYMENTS' | 'REFUNDS';
  status?: string;
  sortBy: PaymentListQuery['sortBy'];
  sortOrder: 'asc' | 'desc';
}

const PAYMENT_STATUS = new Set([
  'PENDING_APPROVAL',
  'REJECTED',
  'CAPTURED',
  'FAILED',
  'CONFIRMED',
  'RECEIVED',
  'DEPOSITED',
  'CLEARED',
  'BOUNCED',
  'RETURNED',
  'REVERSED',
]);

function statusList(v: string | undefined, allowed: ReadonlySet<string>): string[] | undefined {
  if (!v) return undefined;
  const list = v.split(',').map(s => s.trim());
  const bad = list.find(s => !allowed.has(s));
  if (bad) throw new ValidationError([{ field: 'status', message: `Unknown status ${bad}` }]);
  return list;
}

export async function exportPayments(ctx: Ctx, societyId: number, q: ExportInput): Promise<Buffer> {
  const refunds = q.type === 'REFUNDS';
  const status = statusList(q.status, refunds ? new Set<string>(REFUND_STATUSES) : PAYMENT_STATUS);
  let file: Buffer;
  let count: number;
  if (!refunds) {
    const where = paymentWhere(societyId, { ...q, status });
    count = await Payment.count({
      where,
      include: [{ model: Unit, attributes: [], required: false }],
      distinct: true,
    });
    if (count > EXPORT_MAX_ROWS)
      throw new UnprocessableError(ERR.exportTooLarge, 'Too many rows: narrow the filters');
    const rows: (string | number | null)[][] = [];
    for (let offset = 0; offset < count; offset += BATCH) {
      const page = await Payment.findAll({
        where,
        include: [{ model: Unit, attributes: ['label'], required: false }],
        order: sortOrderOf(q.sortBy, q.sortOrder),
        limit: BATCH,
        offset,
      });
      for (const p of page)
        rows.push([
          p.receiptNo,
          dateOnly(p.paymentDate),
          (p as unknown as { Unit?: { label: string } }).Unit?.label ?? '',
          p.payerName,
          p.method,
          p.referenceNo,
          rupees(n(p.amountPaise)),
          rupees(n(p.convenienceFeePaise)),
          rupees(n(p.convenienceFeeGstPaise)),
          rupees(n(p.toInvoicesPaise)),
          rupees(n(p.toCollectionsPaise)),
          rupees(n(p.toAdvancePaise)),
          rupees(n(p.refundedPaise)),
          p.status,
        ]);
    }
    file = toCsv(
      [
        'Receipt no',
        'Date',
        'Flat',
        'Payer',
        'Method',
        'Reference',
        'Amount',
        'Fee',
        'Fee GST',
        'To bills',
        'To contributions',
        'To advance',
        'Refunded',
        'Status',
      ],
      rows,
    );
  } else {
    const and: Record<string, unknown>[] = [{ societyId }];
    if (q.unitId) and.push({ unitId: q.unitId });
    if (status) and.push({ status: { [Op.in]: status } });
    if (q.from) and.push({ createdAt: { [Op.gte]: new Date(`${q.from}T00:00:00+05:30`) } });
    if (q.to)
      and.push({ createdAt: { [Op.lt]: new Date(Date.parse(`${q.to}T00:00:00+05:30`) + 86_400_000) } });
    const where = { [Op.and]: and };
    count = await Refund.count({ where });
    if (count > EXPORT_MAX_ROWS)
      throw new UnprocessableError(ERR.exportTooLarge, 'Too many rows: narrow the filters');
    const rows: (string | number | null)[][] = [];
    for (let offset = 0; offset < count; offset += BATCH) {
      const page = await Refund.findAll({
        where,
        include: [
          { model: Unit, attributes: ['label'], required: false },
          { model: Payment, attributes: ['receiptNo', 'payerName'], required: false },
        ],
        order: [['id', 'DESC']],
        limit: BATCH,
        offset,
      });
      for (const r of page) {
        const x = r as unknown as {
          Unit?: { label: string };
          Payment?: { receiptNo: string | null; payerName: string };
        };
        rows.push([
          r.refundNo,
          r.createdAt.toISOString().slice(0, 10),
          x.Unit?.label ?? '',
          x.Payment?.payerName ?? '',
          x.Payment?.receiptNo ?? '',
          r.mode,
          r.bankReference ?? r.gatewayRefundId,
          rupees(n(r.amountPaise)),
          r.status,
          dateOnly(r.paidOutOn),
        ]);
      }
    }
    file = toCsv(
      [
        'Refund no',
        'Requested on',
        'Flat',
        'Payer',
        'Receipt no',
        'Mode',
        'Reference',
        'Amount',
        'Status',
        'Paid out on',
      ],
      rows,
    );
  }
  await audit(ctx, {
    action: AUDIT.paymentExported,
    entityType: 'payment_export',
    entityId: societyId,
    societyId,
    after: { type: q.type, rows: count, from: q.from ?? null, to: q.to ?? null },
  });
  return file;
}
