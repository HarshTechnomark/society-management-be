import { Op, UniqueConstraintError } from 'sequelize';
import { AuditLog, Collection, CollectionRequest, Payment } from '../../models';
import { audit } from '../../utils/audit';
import { formatRupees } from '../../lib/money';
import { logger } from '../../lib/logger';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../../utils/errors';
import { assertFeature } from '../subscriptions/entitlements.service';
import { residents } from '../residents/residents.public';
import { units } from '../society-setup/society-setup.public';
import { addDaysYmd } from '../billing/billing.calc.period';
import type { ApprovalRequestInput } from '../billing/billing.ports';
import {
  APPROVAL_TYPES,
  AUDIT,
  ENT,
  ENTITY,
  ERR,
  NOTIFY,
  REQUEST_MAX_PAISE,
  type PaymentMethod,
} from './payments.constants';
import { findDuplicateReference, referenceKeyOf } from './payments.duplicates';
import { paymentsPorts } from './payments.ports';
import { effectivatePending } from './payments.settle';
import {
  auditPayment,
  invalidState,
  moneyTx,
  n,
  paymentToAudit,
  setting,
  societyToday,
} from './payments.shared';
import { checkReference } from './payments.offline.validation';
import { proofFiles } from './payments.offline.proof';
import type { Ctx, Transaction } from './payments.types';

/**
 * 8.11 `POST /payments/offline` and 8.6 `POST /me/payments/declared` (BR-12-25 to BR-12-29, BR-12-32) and the module 14
 * callbacks of `OFFLINE_PAYMENT`. A payment is created `PENDING_APPROVAL` and nothing is allocated or receipted until the
 * approval: `onApproved` calls the core `effectivatePending`. `onRejected`, `onCancelled` and `onExpired` end it `REJECTED`.
 */
const BANK_METHODS: PaymentMethod[] = ['NEFT', 'IMPS', 'RTGS'];
/** BR-12-27 maxima (paise). */
export const CASH_DAY_LIMIT_PAISE = 19_999_999;
const MAX_CASH_CHEQUE_UPI = 50_000_000;
const MAX_BANK = 100_000_000;
const STALE_CHEQUE_DAYS = 90;

export interface OfflineInput {
  unitId: number;
  payingFor: 'DUES' | 'COLLECTION';
  collectionRequestId?: number;
  method: 'CASH' | 'CHEQUE' | 'NEFT' | 'IMPS' | 'RTGS' | 'UPI_TO_BANK';
  amountPaise: number;
  paymentDate: string;
  referenceNo?: string;
  cheque?: { bankName: string; chequeNo: string; chequeDate: string };
  payerName?: string;
  fileIds?: number[];
  notes?: string;
  confirmDuplicate?: boolean;
}
export interface DeclaredInput {
  unitId: number;
  method: 'NEFT' | 'IMPS' | 'RTGS' | 'UPI_TO_BANK';
  amountPaise: number;
  paymentDate: string;
  referenceNo: string;
  fileIds: number[];
  note?: string;
}

/** The allocation intent kept with the approval (read back by `onApproved` from the creation audit row). */
interface Intent {
  payingFor: 'DUES' | 'COLLECTION';
  collectionRequestId: number | null;
}

const monthsAgoYmd = (ymd: string, months: number): string => {
  const d = new Date(`${ymd}T00:00:00.000Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
};

/** BR-12-32: bounced cheques of the unit in the last 12 months reach the block count. */
async function assertChequesAllowed(societyId: number, unitId: number, today: string, t: Transaction) {
  const limit = Number(await setting(societyId, 'payments.chequeBounceBlockCount'));
  if (!(limit > 0)) return;
  const count = await Payment.count({
    where: {
      societyId,
      unitId,
      method: 'CHEQUE',
      status: 'BOUNCED',
      bouncedOn: { [Op.gte]: monthsAgoYmd(today, 12) },
    },
    transaction: t,
  });
  if (count >= limit)
    throw new UnprocessableError(
      ERR.chequePaymentsBlocked,
      'Cheques from this flat are not accepted after repeated bounces',
      [{ field: 'method', message: 'Take cash, a bank transfer or UPI instead' }],
    );
}

/** BR-12-18: the open request of this unit in a published optional collection, and the amount rules. */
async function checkCollectionRequest(
  societyId: number,
  unitId: number,
  requestId: number,
  amountPaise: number,
  t: Transaction,
): Promise<void> {
  const notFound = () => new NotFoundError(ERR.requestNotFound, 'Collection request not found');
  const r = await CollectionRequest.findOne({ where: { id: requestId, societyId, unitId }, transaction: t });
  if (!r || (r.status !== 'OPEN' && r.status !== 'PART_PAID')) throw notFound();
  const c = await Collection.findOne({ where: { id: r.collectionId, societyId }, transaction: t });
  if (!c || c.status !== 'PUBLISHED' || c.isMandatory) throw notFound();
  if (amountPaise > REQUEST_MAX_PAISE)
    throw new UnprocessableError(ERR.amountTooLarge, 'A collection payment is at most ₹1,00,000');
  if (c.amountMode === 'FIXED_PER_UNIT') {
    if (amountPaise > n(r.amountPaise) - n(r.paidPaise))
      throw new UnprocessableError(ERR.amountExceedsDue, 'More than the remaining amount of this collection');
  } else if (c.amountMode === 'MIN_PER_UNIT') {
    if (amountPaise < Math.max(100, n(r.minAmountPaise) - n(r.paidPaise)))
      throw new UnprocessableError(ERR.amountBelowMinimum, 'Below the minimum for this collection');
  }
}

interface CreateArgs {
  ctx: Ctx;
  societyId: number;
  source: 'OFFLINE' | 'RESIDENT_DECLARED';
  unitId: number;
  method: PaymentMethod;
  amountPaise: number;
  paymentDate: string;
  referenceNo: string | null;
  cheque: { bankName: string; chequeNo: string; chequeDate: string } | null;
  payerName?: string;
  payerUserId: number | null;
  fileIds: number[];
  notes: string | null;
  confirmDuplicate: boolean;
  intent: Intent;
  /** Declared transfers only: the unit must be one of the caller's. */
  requireOwnUnit?: boolean;
}

async function defaultPayerName(societyId: number, unitId: number, today: string): Promise<string> {
  try {
    const b = await residents.billToFor(unitId, today);
    if (b?.name) return b.name;
  } catch (err) {
    logger.warn({ err }, 'bill-to lookup failed for payer name');
  }
  const u = await units.get(societyId, unitId).catch(() => null);
  return u?.label ?? 'Unit';
}

/**
 * BR-12-28 soft duplicate: same unit, method, amount and `paymentDate` as a payment that is still live. Rejected, failed,
 * bounced and returned entries do not count (a re-presented cheque is recorded again, BR-12-26). `409 DUPLICATE_PAYMENT_SUSPECTED`
 * unless `confirmDuplicate`; returns the other payment when confirmed.
 */
async function findSuspect(
  societyId: number,
  q: { unitId: number; method: PaymentMethod; amountPaise: number; paymentDate: string },
  confirmDuplicate: boolean,
  t: Transaction,
): Promise<{ id: number } | null> {
  const other = await Payment.findOne({
    where: { societyId, ...q, status: { [Op.notIn]: ['REJECTED', 'FAILED', 'BOUNCED', 'RETURNED'] } },
    attributes: ['id'],
    order: [['id', 'ASC']],
    transaction: t,
  });
  if (!other) return null;
  if (!confirmDuplicate) {
    const err = new ConflictError(
      ERR.duplicatePaymentSuspected,
      'A payment with the same flat, method, amount and date is already recorded',
    ) as ConflictError & { errors?: unknown };
    (err as { errors?: unknown }).errors = [
      { field: 'paymentId', message: 'Already recorded', paymentId: n(other.id) },
    ];
    throw err;
  }
  return { id: n(other.id) };
}

async function createPending(a: CreateArgs) {
  const { ctx, societyId } = a;
  if (a.requireOwnUnit && !ctx.unitIds?.includes(a.unitId))
    throw new NotFoundError(ERR.unitNotFound, 'Unit not found');
  if (a.method === 'CHEQUE') await assertFeature(ctx, ENT.chequeLifecycle);
  const body = await moneyTx(async t => {
    const unit = await units.lockActive(societyId, a.unitId, t);
    const today = await societyToday(societyId);
    // BR-12-29 payment date
    if (a.paymentDate > today || a.paymentDate < addDaysYmd(today, -365))
      throw new UnprocessableError(
        ERR.paymentDateInvalid,
        'The payment date cannot be in the future or over a year old',
        [{ field: 'paymentDate', message: 'Between one year ago and today' }],
      );
    if (await paymentsPorts().journal.isDateLocked(societyId, a.paymentDate))
      throw new UnprocessableError(ERR.periodLocked, 'The books are locked for this date', [
        { field: 'paymentDate', message: 'Pick a date in an open period' },
      ]);
    // BR-12-27 amounts
    const max = BANK_METHODS.includes(a.method) ? MAX_BANK : MAX_CASH_CHEQUE_UPI;
    if (a.amountPaise > max)
      throw new UnprocessableError(ERR.amountTooLarge, `At most ${formatRupees(max)} for this method`, [
        { field: 'amountPaise', message: `At most ${formatRupees(max)}` },
      ]);
    if (a.method === 'CASH') {
      const already = Number(
        (await Payment.sum('amountPaise', {
          where: {
            societyId,
            unitId: a.unitId,
            method: 'CASH',
            paymentDate: a.paymentDate,
            status: { [Op.notIn]: ['REJECTED', 'FAILED'] },
          },
          transaction: t,
        })) ?? 0,
      );
      if (already + a.amountPaise > CASH_DAY_LIMIT_PAISE)
        throw new UnprocessableError(
          ERR.cashLimitExceeded,
          'Cash of ₹2,00,000 or more from one flat on one day is not allowed (Income-tax Act section 269ST)',
          [{ field: 'amountPaise', message: 'Take the rest by bank transfer or cheque' }],
        );
    }
    // BR-12-29 cheque date and BR-12-32 block
    if (a.cheque) {
      if (
        a.cheque.chequeDate < addDaysYmd(today, -STALE_CHEQUE_DAYS) ||
        a.cheque.chequeDate > addDaysYmd(today, STALE_CHEQUE_DAYS)
      )
        throw new UnprocessableError(
          ERR.chequeDateInvalid,
          'The cheque is stale or post-dated by more than 90 days',
          [{ field: 'cheque.chequeDate', message: 'Within 90 days before or after today' }],
        );
      await assertChequesAllowed(societyId, a.unitId, today, t);
    }
    // BR-12-26 reference and F22 duplicates
    const referenceKey = referenceKeyOf({
      method: a.method,
      referenceNo: a.cheque ? a.cheque.chequeNo : a.referenceNo,
      chequeBankName: a.cheque?.bankName,
    });
    if (await findDuplicateReference(societyId, referenceKey, t))
      throw new ConflictError(ERR.duplicateReference, 'This reference is already recorded');
    const suspect = await findSuspect(
      societyId,
      { unitId: a.unitId, method: a.method, amountPaise: a.amountPaise, paymentDate: a.paymentDate },
      a.confirmDuplicate,
      t,
    );
    if (a.intent.collectionRequestId)
      await checkCollectionRequest(societyId, a.unitId, a.intent.collectionRequestId, a.amountPaise, t);

    const payerName = (a.payerName ?? (await defaultPayerName(societyId, a.unitId, today))).slice(0, 120);
    const p = await Payment.create(
      {
        societyId,
        unitId: a.unitId,
        paymentOrderId: null,
        source: a.source,
        method: a.method,
        status: 'PENDING_APPROVAL',
        payerUserId: a.payerUserId,
        payerName,
        amountPaise: a.amountPaise,
        convenienceFeePaise: 0,
        convenienceFeeGstPaise: 0,
        grossAmountPaise: a.amountPaise,
        toInvoicesPaise: 0,
        toCollectionsPaise: 0,
        toAdvancePaise: 0,
        refundedPaise: 0,
        paymentDate: a.paymentDate,
        capturedAt: null,
        gatewayAccountId: null,
        gatewayPaymentId: null,
        gatewayMethodDetail: null,
        referenceNo: a.cheque ? a.cheque.chequeNo : a.referenceNo,
        referenceKey,
        chequeBankName: a.cheque?.bankName ?? null,
        chequeDate: a.cheque?.chequeDate ?? null,
        approvalRequestId: null,
        notes: a.notes,
        isDuplicateSuspect: Boolean(suspect),
        duplicateOfPaymentId: suspect ? suspect.id : null,
        createdBy: ctx.user?.id ?? null,
        updatedBy: null,
      } as never,
      { transaction: t },
    );
    if (a.fileIds.length) await proofFiles().link(ctx, a.fileIds, n(p.id), t);
    const verb = a.method === 'CHEQUE' ? 'Cheque' : a.method === 'CASH' ? 'Cash' : a.method.replace('_', ' ');
    const input = {
      type: APPROVAL_TYPES.offlinePayment,
      entityType: ENTITY.payment,
      entityId: n(p.id),
      title: `${verb} ${formatRupees(a.amountPaise)} from ${unit.label}`,
      amountPaise: a.amountPaise,
      payload: { unitId: a.unitId, method: a.method },
      // module 14 routes the rule by the method and the unit (BR-12-25)
      categoryKey: a.method,
      unitId: a.unitId,
    } as ApprovalRequestInput;
    const result = await paymentsPorts().approvals.request(ctx, input, t);
    await Payment.update({ approvalRequestId: result.id }, { where: { id: p.id }, transaction: t });
    // an auto-approval (BR-14-4) ran `onOfflineApproved` inside `request`
    await audit(
      ctx,
      {
        action: a.source === 'OFFLINE' ? AUDIT.paymentRecorded : AUDIT.paymentDeclared,
        entityType: 'payment',
        entityId: n(p.id),
        societyId,
        after: {
          ...paymentToAudit(p),
          payingFor: a.intent.payingFor,
          collectionRequestId: a.intent.collectionRequestId,
          fileIds: a.fileIds,
          ...(suspect ? { confirmDuplicate: true, duplicateOfPaymentId: suspect.id } : {}),
          approvalRequestId: result.id,
        },
      },
      t,
    );
    if (suspect)
      await audit(
        ctx,
        {
          action: AUDIT.paymentDuplicateFlagged,
          entityType: 'payment',
          entityId: n(p.id),
          societyId,
          after: { duplicateOfPaymentId: suspect.id, confirmDuplicate: true },
        },
        t,
      );
    return { id: n(p.id), approvalRequestId: result.id };
  }).catch(err => {
    if (err instanceof UniqueConstraintError)
      throw new ConflictError(ERR.duplicateReference, 'This reference is already recorded');
    throw err;
  });
  return paymentView(societyId, body.id, body.approvalRequestId);
}

/** The 8.11 response: the payment as it stands (auto-approval already made it effective). */
export async function paymentView(societyId: number, id: number, approvalRequestId?: number | null) {
  const p = await Payment.findOne({ where: { id, societyId } });
  if (!p) throw new NotFoundError(ERR.paymentNotFound, 'Payment not found');
  const reqId = approvalRequestId ?? (p.approvalRequestId ? n(p.approvalRequestId) : null);
  return {
    id: n(p.id),
    unitId: n(p.unitId),
    source: p.source,
    status: p.status,
    method: p.method,
    amountPaise: n(p.amountPaise),
    paymentDate: p.paymentDate,
    receiptNo: p.receiptNo,
    receiptStatus: p.receiptStatus,
    referenceNo: p.referenceNo,
    isDuplicateSuspect: Boolean(p.isDuplicateSuspect),
    approval: reqId
      ? {
          requestId: reqId,
          status:
            p.status === 'PENDING_APPROVAL' ? 'PENDING' : p.status === 'REJECTED' ? 'REJECTED' : 'APPROVED',
        }
      : null,
    version: n(p.version),
  };
}

export async function recordOffline(ctx: Ctx, input: OfflineInput) {
  const societyId = ctx.society!.id;
  const ref = checkReference(input.method, input.referenceNo);
  if (!ref.ok) throw new ValidationError([{ field: 'referenceNo', message: ref.message }]);
  return createPending({
    ctx,
    societyId,
    source: 'OFFLINE',
    unitId: input.unitId,
    method: input.method,
    amountPaise: input.amountPaise,
    paymentDate: input.paymentDate,
    referenceNo: ref.value,
    cheque: input.cheque ?? null,
    payerName: input.payerName,
    payerUserId: null,
    fileIds: input.fileIds ?? [],
    notes: input.notes ?? null,
    confirmDuplicate: input.confirmDuplicate ?? false,
    intent: { payingFor: input.payingFor, collectionRequestId: input.collectionRequestId ?? null },
  });
}

export async function declareTransfer(ctx: Ctx, input: DeclaredInput) {
  const societyId = ctx.society!.id;
  const ref = checkReference(input.method, input.referenceNo);
  if (!ref.ok) throw new ValidationError([{ field: 'referenceNo', message: ref.message }]);
  return createPending({
    ctx,
    societyId,
    source: 'RESIDENT_DECLARED',
    unitId: input.unitId,
    method: input.method,
    amountPaise: input.amountPaise,
    paymentDate: input.paymentDate,
    referenceNo: ref.value,
    cheque: null,
    payerName: ctx.user?.name ?? undefined,
    payerUserId: ctx.user?.id ?? null,
    fileIds: input.fileIds,
    notes: input.note ?? null,
    confirmDuplicate: false,
    intent: { payingFor: 'DUES', collectionRequestId: null },
    requireOwnUnit: true,
  });
}

// ------------------------------------------------------------------ module 14 callbacks

async function intentOf(societyId: number, paymentId: number, t: Transaction): Promise<Intent> {
  const row = await AuditLog.findOne({
    where: {
      societyId,
      entityType: 'payment',
      entityId: String(paymentId),
      action: { [Op.in]: [AUDIT.paymentRecorded, AUDIT.paymentDeclared] },
    },
    order: [['id', 'ASC']],
    transaction: t,
  });
  const after = (row?.after ?? {}) as Partial<Intent>;
  return {
    payingFor: after.payingFor === 'COLLECTION' ? 'COLLECTION' : 'DUES',
    collectionRequestId: after.collectionRequestId ? Number(after.collectionRequestId) : null,
  };
}

/** `onApproved`: runs in the approver's transaction (or the recorder's when module 14 auto-approves). Idempotent. */
export async function onOfflineApproved(ctx: Ctx, paymentId: number, t: Transaction): Promise<void> {
  const p = await Payment.findByPk(paymentId, { transaction: t });
  if (!p) throw new NotFoundError(ERR.paymentNotFound, 'Payment not found');
  if (p.status !== 'PENDING_APPROVAL') return;
  const societyId = n(p.societyId);
  const intent = await intentOf(societyId, paymentId, t);
  const status = p.method === 'CHEQUE' ? 'RECEIVED' : 'CONFIRMED';
  const spec =
    intent.payingFor === 'COLLECTION' && intent.collectionRequestId
      ? {
          mode: 'SELECTED' as const,
          selected: [
            {
              targetType: 'COLLECTION_REQUEST' as const,
              id: intent.collectionRequestId,
              amountPaise: n(p.amountPaise),
            },
          ],
        }
      : { mode: 'OLDEST_FIRST' as const };
  const { payment } = await effectivatePending(
    ctx,
    paymentId,
    { ...spec, status, approvedBy: ctx.user?.id ?? null },
    t,
  );
  if (status === 'RECEIVED') {
    const billTo = payment.payerUserId
      ? null
      : await residents.billToFor(n(payment.unitId), payment.paymentDate).catch(() => null);
    const to = payment.payerUserId ? n(payment.payerUserId) : (billTo?.userId ?? null);
    if (to)
      t.afterCommit(async () => {
        await paymentsPorts()
          .notifications.send(NOTIFY.chequeReceived, [to], {
            societyId,
            paymentId,
            chequeNo: payment.referenceNo,
            amountPaise: n(payment.amountPaise),
          })
          .catch(err => logger.error({ err }, 'cheque_received notification failed'));
      });
  }
}

/** `onRejected`, `onCancelled` (withdrawn by the recorder) and `onExpired`: the payment ends `REJECTED`, its reference is freed. */
export async function endPending(
  ctx: Ctx,
  paymentId: number,
  reason: string,
  how: 'rejected' | 'withdrawn' | 'expired',
  t: Transaction,
): Promise<void> {
  const p = await Payment.findOne({ where: { id: paymentId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!p) throw new NotFoundError(ERR.paymentNotFound, 'Payment not found');
  if (p.status !== 'PENDING_APPROVAL') throw invalidState('This payment is not waiting for approval');
  const before = paymentToAudit(p);
  await p.update(
    {
      status: 'REJECTED',
      referenceKey: null,
      rejectedReason: reason.slice(0, 500),
      updatedBy: ctx.user?.id ?? null,
      version: n(p.version) + 1,
    },
    { transaction: t },
  );
  await auditPayment(ctx, AUDIT.paymentRejected, p, before, t, `${how}: ${reason}`);
  const recorder = p.createdBy ? n(p.createdBy) : null;
  if (recorder)
    t.afterCommit(async () => {
      await paymentsPorts()
        .notifications.send(NOTIFY.offlineRejected, [recorder], {
          societyId: n(p.societyId),
          paymentId,
          amountPaise: n(p.amountPaise),
          reason,
        })
        .catch(err => logger.error({ err }, 'offline_rejected notification failed'));
    });
}

export const describeOfflinePayment = async (paymentId: number) => {
  const p = await Payment.findByPk(paymentId);
  if (!p) return [];
  return [
    { label: 'Method', value: p.method, kind: 'text' as const },
    { label: 'Amount', value: formatRupees(n(p.amountPaise)), kind: 'money' as const },
    { label: 'Payment date', value: p.paymentDate, kind: 'date' as const },
    { label: 'Paid by', value: p.payerName, kind: 'text' as const },
    ...(p.referenceNo ? [{ label: 'Reference', value: p.referenceNo, kind: 'text' as const }] : []),
  ];
};
