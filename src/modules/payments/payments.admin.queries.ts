import { Op, QueryTypes, type WhereOptions } from 'sequelize';
import { AuditLog, Payment, Refund, Unit, sequelize } from '../../models';
import { NotFoundError } from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import { ERR } from './payments.constants';
import { adminItem, dateOnly, isoOrNull, landsIn } from './payments.admin.dto';
import { n } from './payments.shared';

/** `GET /payments` and `GET /payments/:id` (section 8.10). */
export interface PaymentFilters {
  q?: string;
  unitId?: number;
  status?: string[];
  method?: string[];
  source?: string;
  from?: string;
  to?: string;
  needsReview?: boolean;
  isDuplicateSuspect?: boolean;
  chequeStatus?: 'PENDING';
}
export interface PaymentListQuery extends PaymentFilters {
  sortBy: 'paymentDate' | 'createdAt' | 'amountPaise' | 'receiptNo';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

const likeEscape = (s: string): string => s.replace(/[\\%_]/g, c => `\\${c}`);

/** The `where` of the list and export filters (`societyId` always set). */
export function paymentWhere(societyId: number, f: PaymentFilters): WhereOptions {
  const and: WhereOptions[] = [{ societyId }];
  if (f.unitId) and.push({ unitId: f.unitId });
  if (f.status) and.push({ status: { [Op.in]: f.status } });
  if (f.method) and.push({ method: { [Op.in]: f.method } });
  if (f.source) and.push({ source: f.source });
  if (f.from) and.push({ paymentDate: { [Op.gte]: f.from } });
  if (f.to) and.push({ paymentDate: { [Op.lte]: f.to } });
  if (f.needsReview) and.push({ needsReview: true });
  if (f.isDuplicateSuspect) and.push({ isDuplicateSuspect: true });
  if (f.chequeStatus === 'PENDING')
    and.push({ method: 'CHEQUE', status: { [Op.in]: ['RECEIVED', 'DEPOSITED'] } });
  if (f.q) {
    const like = `%${likeEscape(f.q)}%`;
    and.push({
      [Op.or]: [
        { receiptNo: { [Op.like]: like } },
        { payerName: { [Op.like]: like } },
        { referenceNo: { [Op.like]: like } },
        { '$Unit.label$': { [Op.like]: like } },
      ],
    });
  }
  return { [Op.and]: and };
}

export const sortOrderOf = (by: PaymentListQuery['sortBy'], dir: 'asc' | 'desc') =>
  [
    [by, dir.toUpperCase()],
    ['id', 'DESC'],
  ] as [string, string][];

export async function listPayments(societyId: number, q: PaymentListQuery) {
  const { rows, count } = await Payment.findAndCountAll({
    where: paymentWhere(societyId, q),
    include: [{ model: Unit, attributes: ['label'], required: false }],
    order: sortOrderOf(q.sortBy, q.sortOrder),
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
    distinct: true,
  });
  return { items: rows.map(p => adminItem(p as never)), pagination: pageMeta(q.page, q.limit, count) };
}

const notFound = () => new NotFoundError(ERR.paymentNotFound, 'Payment not found');

export async function allocationsOf(paymentId: number) {
  const rows = await sequelize.query<Record<string, unknown>>(
    `SELECT a.id, a.source, a.targetType, a.invoiceId, i.invoiceNo, a.collectionRequestId, c.title AS collectionTitle,
            a.amountPaise, a.reasonCode, a.reversalOfId, a.allocatedOn
       FROM payment_allocations a
       LEFT JOIN invoices i ON i.id = a.invoiceId
       LEFT JOIN collection_requests r ON r.id = a.collectionRequestId
       LEFT JOIN collections c ON c.id = r.collectionId
      WHERE a.paymentId = :paymentId ORDER BY a.id`,
    { replacements: { paymentId }, type: QueryTypes.SELECT },
  );
  return rows.map(r => ({
    id: n(r.id),
    source: r.source,
    targetType: r.targetType,
    invoiceId: r.invoiceId == null ? null : n(r.invoiceId),
    invoiceNo: (r.invoiceNo as string | null) ?? null,
    collectionRequestId: r.collectionRequestId == null ? null : n(r.collectionRequestId),
    collectionTitle: (r.collectionTitle as string | null) ?? null,
    amountPaise: n(r.amountPaise),
    reasonCode: r.reasonCode,
    reversalOfId: r.reversalOfId == null ? null : n(r.reversalOfId),
    allocatedOn: dateOnly(r.allocatedOn),
  }));
}

/** Detail of 8.1 (admin). `404 PAYMENT_NOT_FOUND` for another society's id. */
export async function getPayment(societyId: number, id: number) {
  const p = await Payment.findOne({
    where: { id, societyId },
    include: [{ model: Unit, attributes: ['label'], required: false }],
  });
  if (!p) throw notFound();
  const [allocations, refunds, audits] = await Promise.all([
    allocationsOf(n(p.id)),
    Refund.findAll({ where: { societyId, paymentId: id }, order: [['id', 'ASC']] }),
    AuditLog.findAll({
      where: { societyId, entityType: 'payment', entityId: String(id) },
      order: [['id', 'ASC']],
      attributes: ['createdAt', 'action', 'actorName', 'reason'],
    }),
  ]);
  return {
    ...adminItem(p as never),
    landsIn: landsIn(p),
    receiptRevision: n(p.receiptRevision),
    receiptPdfStatus: p.receiptPdfStatus,
    notes: p.notes,
    reviewReason: p.reviewReason,
    duplicateOfPaymentId: p.duplicateOfPaymentId,
    reversalReasonCode: p.reversalReasonCode,
    reversalReason: p.reversalReason,
    reversedAt: isoOrNull(p.reversedAt),
    allocations,
    cheque:
      p.method === 'CHEQUE'
        ? {
            bankName: p.chequeBankName,
            chequeNo: p.referenceNo,
            chequeDate: dateOnly(p.chequeDate),
            depositedOn: dateOnly(p.depositedOn),
            depositBankAccountId: p.depositBankAccountId,
            clearedOn: dateOnly(p.clearedOn),
            bouncedOn: dateOnly(p.bouncedOn),
            bounceReason: p.bounceReason,
            bounceChargeInvoiceId: p.bounceChargeInvoiceId,
          }
        : null,
    refunds: refunds.map(r => ({
      id: n(r.id),
      refundNo: r.refundNo,
      amountPaise: n(r.amountPaise),
      mode: r.mode,
      status: r.status,
      createdAt: isoOrNull(r.createdAt),
    })),
    // proof files are linked by the offline part (12.2) through the files service; nothing is stored on the payment row
    proofFiles: [] as unknown[],
    approval: p.approvalRequestId
      ? {
          requestId: n(p.approvalRequestId),
          status: p.rejectedReason
            ? 'REJECTED'
            : p.approvedBy || p.status !== 'PENDING_APPROVAL'
              ? 'APPROVED'
              : 'PENDING',
        }
      : null,
    timeline: audits.map(a => ({ at: isoOrNull(a.createdAt), event: a.action, by: a.actorName })),
  };
}
