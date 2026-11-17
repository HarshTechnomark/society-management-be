import { Op, UniqueConstraintError, type WhereOptions } from 'sequelize';
import { Deposit, Invoice, LedgerAccount, PaymentOrder, Unit } from '../../models';
import type { DepositAdjustment } from '../../models/deposit.model';
import { now } from '../../lib/clock';
import { formatRupees } from '../../lib/money';
import { emitToRoom } from '../../lib/realtime';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import {
  AppError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../utils/errors';
import { systemCtx, type Ctx } from '../../types/context';
import { invoices } from '../billing/billing.public';
import { residents } from '../residents/residents.public';
import { units } from '../society-setup/society-setup.public';
import { createModuleOrder } from '../payments/payments.orders.create';
import { moneyTx, withSociety } from '../payments/payments.shared';
import {
  APPROVAL_TYPES,
  AUDIT,
  CODE,
  DEPOSIT_LEDGER,
  ENTITY,
  ERR,
  NOTIFY,
  RT,
  roomUnit,
  type DepositKind,
  type DepositRefundMode,
  type DepositStatus,
} from './accounts.constants';
import { ensureBooks, lockBooks } from './accounts.chart';
import { postJournal } from './accounts.engine';
import { ledgerAccountByCode } from './accounts.lookup';
import { accountsPorts } from './accounts.ports';
import { addDaysYmd, n, societyIdOf, societyToday } from './accounts.shared';
import type { Transaction } from './accounts.types';

/**
 * Refundable deposits (sections 5.6, 6.3, 8.17; BR-13-45 to BR-13-47). A deposit is a liability on its own ledger (2510 to 2550): the
 * charge is a module 11 ad-hoc invoice (Dr 1300, Cr the deposit ledger), a deduction moves the money to `4600`, a refund pays it out.
 * Every change locks the deposit row first and then posts through the engine; realtime, notifications and the payment order go
 * out after commit. Callers of the owner callbacks (module 09, 17, 18) register once through `deposits.registerOwner`.
 */
const iso = (d: Date | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
const depositNotFound = () => new NotFoundError(ERR.depositNotFound, 'Deposit not found');
const staleVersion = () =>
  new ConflictError(ERR.staleVersion, 'Someone else changed this deposit. Reload to see the change.');
const wrongState = (message: string) => new ConflictError(ERR.invalidState, message);
const KIND_LABEL: Record<DepositKind, string> = {
  MOVE: 'Move-in / move-out',
  RENOVATION: 'Renovation',
  AMENITY: 'Amenity booking',
  ACCESS_CARD: 'Access card',
  KEY: 'Key',
  OTHER: 'Other',
};

export const heldOf = (d: Pick<Deposit, 'receivedPaise' | 'deductedPaise' | 'refundedPaise'>): number =>
  n(d.receivedPaise) - n(d.deductedPaise) - n(d.refundedPaise);

// ------------------------------------------------------------------ owner callback registry (BR-13-45a)
export interface DepositOwnerHooks {
  onDepositPaid(
    ctx: Ctx,
    input: { refType: string; refId: number; depositId: number },
    t: Transaction,
  ): Promise<void>;
  onDepositRefunded(
    ctx: Ctx,
    input: { refType: string; refId: number; depositId: number; refundedPaise: number },
    t: Transaction,
  ): Promise<void>;
}
const owners = new Map<string, DepositOwnerHooks>();
/** One owner per refType; a duplicate registration throws at boot. */
export function registerOwner(refType: string, hooks: DepositOwnerHooks): void {
  if (owners.has(refType)) throw new Error(`deposits.registerOwner: ${refType} already has an owner`);
  owners.set(refType, hooks);
}
export const clearDepositOwners = (): void => owners.clear();

// ------------------------------------------------------------------ DTO
export interface DepositDto {
  id: number;
  code: string;
  unitId: number;
  unitLabel: string;
  residentId: number | null;
  kind: DepositKind;
  title: string;
  refType: string | null;
  refId: number | null;
  ledgerAccountId: number;
  amountPaise: number;
  receivedPaise: number;
  deductedPaise: number;
  refundedPaise: number;
  refundRequestedPaise: number;
  heldPaise: number;
  invoiceId: number | null;
  isOpening: boolean;
  dueDate: string | null;
  status: DepositStatus;
  adjustments: DepositAdjustment[];
  refundApprovalRequestId: number | null;
  refundMode: DepositRefundMode | null;
  refundReference: string | null;
  refundPaidFromLedgerAccountId: number | null;
  receivedAt: string | null;
  refundedAt: string | null;
  cancelReason: string | null;
  notes: string | null;
  createdAt: string;
  version: number;
  paymentOrderId?: number | null;
}

export function depositDto(d: Deposit, unitLabel: string): DepositDto {
  return {
    id: n(d.id),
    code: `DEP-${d.id}`,
    unitId: n(d.unitId),
    unitLabel,
    residentId: d.residentId === null ? null : n(d.residentId),
    kind: d.kind,
    title: d.title,
    refType: d.refType,
    refId: d.refId === null ? null : n(d.refId),
    ledgerAccountId: n(d.ledgerAccountId),
    amountPaise: n(d.amountPaise),
    receivedPaise: n(d.receivedPaise),
    deductedPaise: n(d.deductedPaise),
    refundedPaise: n(d.refundedPaise),
    refundRequestedPaise: n(d.refundRequestedPaise),
    heldPaise: heldOf(d),
    invoiceId: d.invoiceId === null ? null : n(d.invoiceId),
    isOpening: Boolean(d.isOpening),
    dueDate: d.dueDate,
    status: d.status,
    adjustments: d.adjustments ?? [],
    refundApprovalRequestId: d.refundApprovalRequestId === null ? null : n(d.refundApprovalRequestId),
    refundMode: d.refundMode,
    refundReference: d.refundReference,
    refundPaidFromLedgerAccountId:
      d.refundPaidFromLedgerAccountId === null ? null : n(d.refundPaidFromLedgerAccountId),
    receivedAt: iso(d.receivedAt),
    refundedAt: iso(d.refundedAt),
    cancelReason: d.cancelReason,
    notes: d.notes,
    createdAt: iso(d.createdAt)!,
    version: n(d.version),
  };
}

/** What a resident sees: no internal notes, no approval ids, no ledger or journal details. */
export function residentDepositDto(d: Deposit, unitLabel: string) {
  const full = depositDto(d, unitLabel);
  return {
    id: full.id,
    code: full.code,
    unitId: full.unitId,
    unitLabel: full.unitLabel,
    kind: full.kind,
    title: full.title,
    amountPaise: full.amountPaise,
    receivedPaise: full.receivedPaise,
    deductedPaise: full.deductedPaise,
    refundedPaise: full.refundedPaise,
    heldPaise: full.heldPaise,
    invoiceId: full.invoiceId,
    dueDate: full.dueDate,
    status: full.status,
    adjustments: full.adjustments.map(a => ({
      kind: a.kind,
      amountPaise: a.amountPaise,
      reason: a.reason,
      at: a.at,
    })),
    receivedAt: full.receivedAt,
    refundedAt: full.refundedAt,
    createdAt: full.createdAt,
  };
}

async function unitLabelOf(societyId: number, unitId: number, t?: Transaction): Promise<string> {
  const u = await Unit.findOne({ where: { id: unitId, societyId }, attributes: ['label'], transaction: t });
  return u?.label ?? '';
}

// ------------------------------------------------------------------ reads (8.17)
export interface DepositListQuery {
  status?: string;
  kind?: string;
  unitId?: number;
  q?: string;
  page: number;
  limit: number;
  sortBy: 'createdAt' | 'amountPaise';
}

export async function listDeposits(societyId: number, q: DepositListQuery) {
  const where: WhereOptions[] = [{ societyId }];
  if (q.status) where.push({ status: q.status });
  if (q.kind) where.push({ kind: q.kind });
  if (q.unitId) where.push({ unitId: q.unitId });
  if (q.q) {
    const m = /^dep-(\d+)$/i.exec(q.q.trim());
    if (m) where.push({ id: Number(m[1]) });
    else {
      const like = `%${q.q.trim().replace(/[%_\\]/g, '\\$&')}%`;
      const us = await Unit.findAll({
        where: { societyId, label: { [Op.like]: like } },
        attributes: ['id'],
        limit: 200,
      });
      where.push({ unitId: { [Op.in]: us.map(u => n(u.id)) } });
    }
  }
  const { rows, count } = await Deposit.findAndCountAll({
    where: { [Op.and]: where },
    order: [
      [q.sortBy, 'DESC'],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  const us = await Unit.findAll({
    where: { id: { [Op.in]: [...new Set(rows.map(r => n(r.unitId)))] } },
    attributes: ['id', 'label'],
  });
  const label = new Map(us.map(u => [n(u.id), u.label]));
  return {
    items: rows.map(r => depositDto(r, label.get(n(r.unitId)) ?? '')),
    pagination: {
      page: q.page,
      limit: q.limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / q.limit)),
    },
  };
}

/** Tiles of the deposits screen (additive to spec 8.17): held now, refunded so far, kept back by forfeit. All deposits, no filter. */
export async function depositSummary(societyId: number) {
  const rows = await Deposit.findAll({
    where: { societyId, status: { [Op.ne]: 'CANCELLED' } },
    attributes: ['status', 'receivedPaise', 'deductedPaise', 'refundedPaise', 'adjustments'],
  });
  let heldPaise = 0;
  let refundedPaise = 0;
  let forfeitedPaise = 0;
  for (const d of rows) {
    if (['HELD', 'REFUND_PENDING', 'REFUND_APPROVED'].includes(d.status)) heldPaise += heldOf(d);
    refundedPaise += n(d.refundedPaise);
    for (const a of d.adjustments ?? []) if (a.kind === 'FORFEIT') forfeitedPaise += n(a.amountPaise);
  }
  return { heldPaise, refundedPaise, forfeitedPaise };
}

export async function getDeposit(societyId: number, id: number): Promise<DepositDto> {
  const d = await Deposit.findOne({ where: { id, societyId } });
  if (!d) throw depositNotFound();
  return depositDto(d, await unitLabelOf(societyId, n(d.unitId)));
}

/** `GET /me/deposits`: the deposits of the caller's units. */
export async function listMyDeposits(ctx: Ctx) {
  const societyId = societyIdOf(ctx);
  const unitIds = ctx.unitIds ?? [];
  if (!unitIds.length) return [];
  const rows = await Deposit.findAll({
    where: { societyId, unitId: { [Op.in]: unitIds } },
    order: [
      ['createdAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });
  const us = await Unit.findAll({
    where: { id: { [Op.in]: unitIds } },
    attributes: ['id', 'label'],
  });
  const label = new Map(us.map(u => [n(u.id), u.label]));
  return rows.map(r => residentDepositDto(r, label.get(n(r.unitId)) ?? ''));
}

// ------------------------------------------------------------------ shared steps
async function lockDeposit(societyId: number, id: number, t: Transaction): Promise<Deposit> {
  const d = await Deposit.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!d) throw depositNotFound();
  return d;
}

const snap = (d: Deposit) => ({
  status: d.status,
  amountPaise: n(d.amountPaise),
  receivedPaise: n(d.receivedPaise),
  deductedPaise: n(d.deductedPaise),
  refundedPaise: n(d.refundedPaise),
  refundRequestedPaise: n(d.refundRequestedPaise),
});

async function auditDeposit(
  ctx: Ctx,
  action: string,
  d: Deposit,
  before: unknown,
  t: Transaction,
  reason?: string | null,
) {
  await audit(
    ctx,
    {
      action,
      entityType: 'deposit',
      entityId: n(d.id),
      entityLabel: `DEP-${d.id}`,
      societyId: n(d.societyId),
      before,
      after: snap(d),
      reason: reason ?? null,
    },
    t,
  );
}

function emitDeposit(t: Transaction, d: Deposit): void {
  const body = { id: n(d.id), status: d.status };
  const unitId = n(d.unitId);
  t.afterCommit(() => emitToRoom(roomUnit(unitId), RT.depositUpdated, body));
}

/** Notification to the unit's bill-to resident, after commit; a failure never breaks the money flow. */
function notifyDepositor(
  t: Transaction,
  societyId: number,
  unitId: number,
  template: string,
  data: Record<string, unknown>,
): void {
  t.afterCommit(async () => {
    try {
      const bt = await residents.billToFor(unitId, await societyToday(societyId));
      if (bt?.userId) await accountsPorts().notifications.send(template, [Number(bt.userId)], data);
    } catch (err) {
      logger.error({ err, template }, 'deposit notification failed');
    }
  });
}

async function assertPostingDate(societyId: number, date: string): Promise<void> {
  if (date > (await societyToday(societyId)))
    throw new UnprocessableError(ERR.dateOutOfRange, 'The date cannot be in the future', [
      { field: 'date', message: 'Today or earlier' },
    ]);
}

const ledgerCodeOf = async (d: Deposit, t: Transaction): Promise<string> => {
  const l = await LedgerAccount.findByPk(n(d.ledgerAccountId), { transaction: t });
  if (!l) throw new AppError(500, 'INTERNAL_ERROR', 'Deposit ledger missing');
  return l.code;
};

async function callOwnerRefunded(ctx: Ctx, d: Deposit, refundedPaise: number, t: Transaction) {
  const h = d.refType ? owners.get(d.refType) : undefined;
  if (h && d.refType && d.refId !== null)
    await h.onDepositRefunded(
      ctx,
      { refType: d.refType, refId: n(d.refId), depositId: n(d.id), refundedPaise },
      t,
    );
}

// ------------------------------------------------------------------ create (BR-13-45, 6.3)
export interface CreateDepositInput {
  unitId: number;
  residentId?: number;
  kind: DepositKind;
  title: string;
  amountPaise: number;
  dueDate?: string;
  isOpening?: boolean;
  openingDate?: string;
  refType?: string;
  refId?: number;
  notes?: string;
}

async function createIn(
  ctx: Ctx,
  societyId: number,
  input: CreateDepositInput,
  t: Transaction,
): Promise<Deposit> {
  if (input.amountPaise < 100 || input.amountPaise > 100_000_000)
    throw new ValidationError([{ field: 'amountPaise', message: '100 to 100,000,000 paise' }]);
  const today = await societyToday(societyId);
  await units.lockActive(societyId, input.unitId, t);
  await ensureBooks(t, societyId);
  if (input.residentId) {
    const links = await residents.listForUnit(societyId, input.unitId, {});
    if (!links.some(l => Number(l.residentId) === input.residentId))
      throw new NotFoundError('NOT_FOUND', 'That resident does not belong to this unit');
  }
  if (input.refType && input.refId !== undefined) {
    const dup = await Deposit.findOne({
      where: { societyId, refType: input.refType, refId: input.refId, kind: input.kind },
      attributes: ['id'],
      transaction: t,
    });
    if (dup) throw new ConflictError('DUPLICATE', 'A deposit already exists for this record and kind');
  }
  const ledger = await ledgerAccountByCode(societyId, DEPOSIT_LEDGER[input.kind], t);
  if (!ledger) throw new AppError(500, 'INTERNAL_ERROR', 'Deposit ledger missing');
  const opening = Boolean(input.isOpening);
  if (opening && (!input.openingDate || input.openingDate > today))
    throw new UnprocessableError(ERR.dateOutOfRange, 'The opening date cannot be in the future', [
      { field: 'openingDate', message: 'Today or earlier' },
    ]);
  if (!opening && (!input.dueDate || input.dueDate < today || input.dueDate > addDaysYmd(today, 90)))
    throw new ValidationError([{ field: 'dueDate', message: 'Today up to 90 days ahead' }]);
  let d: Deposit;
  try {
    d = await Deposit.create(
      {
        societyId,
        unitId: input.unitId,
        residentId: input.residentId ?? null,
        kind: input.kind,
        ledgerAccountId: n(ledger.id),
        title: input.title,
        refType: input.refType ?? null,
        refId: input.refId ?? null,
        amountPaise: input.amountPaise,
        receivedPaise: opening ? input.amountPaise : 0,
        isOpening: opening,
        dueDate: opening ? null : (input.dueDate ?? null),
        status: opening ? 'HELD' : 'AWAITING_PAYMENT',
        receivedAt: opening ? now() : null,
        adjustments: [],
        notes: input.notes ?? null,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
      } as never,
      { transaction: t },
    );
  } catch (err) {
    if (err instanceof UniqueConstraintError)
      throw new ConflictError('DUPLICATE', 'A deposit already exists for this record and kind');
    throw err;
  }
  const label = await unitLabelOf(societyId, input.unitId, t);
  if (opening) {
    await postJournal(
      ctx,
      {
        date: input.openingDate!,
        voucherType: 'OPENING_BALANCE',
        refType: 'deposit',
        refId: `${d.id}:open`,
        narration: `Opening deposit DEP-${d.id} ${label}`,
        lines: [
          { ledgerAccountCode: CODE.openingAdjustment, debitPaise: input.amountPaise, creditPaise: 0 },
          { ledgerAccountCode: ledger.code, debitPaise: 0, creditPaise: input.amountPaise },
        ],
      },
      t,
    );
  } else {
    const inv = await invoices.createAdHoc(
      ctx,
      {
        unitId: input.unitId,
        chargeHeadKey: `DEPOSIT_${input.kind}`,
        amountPaise: input.amountPaise,
        refType: 'deposit',
        refId: n(d.id),
        dueDate: input.dueDate!,
      },
      t,
    );
    await d.update({ invoiceId: inv.invoiceId }, { transaction: t });
  }
  await auditDeposit(ctx, AUDIT.depositCreated, d, null, t);
  if (opening) await auditDeposit(ctx, AUDIT.depositReceived, d, null, t);
  emitDeposit(t, d);
  return d;
}

/** Creates the module 12 order for the "Pay deposit" link after the deposit committed; never throws (the Pay list still works). */
export async function ensureDepositOrder(ctx: Ctx, d: Deposit): Promise<number | null> {
  if (!d.invoiceId || d.status !== 'AWAITING_PAYMENT') return null;
  try {
    const o = await createModuleOrder(ctx, {
      unitId: n(d.unitId),
      invoiceIds: [n(d.invoiceId)],
      sourceModule: '13',
      refType: 'deposit',
      refId: n(d.id),
      dedupeKey: `deposit:${d.id}`,
    });
    return o.orderId;
  } catch (err) {
    logger.warn({ err, depositId: d.id }, 'deposit payment order not created');
    return null;
  }
}

export async function createDeposit(ctx: Ctx, input: CreateDepositInput): Promise<DepositDto> {
  const societyId = societyIdOf(ctx);
  const d = await moneyTx(t => createIn(ctx, societyId, input, t));
  const dto = depositDto(d, await unitLabelOf(societyId, n(d.unitId)));
  dto.paymentOrderId = await ensureDepositOrder(ctx, d);
  return dto;
}

/** Public `deposits.request` (module 09, 17, 18): idempotent per (refType, refId, kind). The order follows after commit. */
export async function requestDeposit(
  ctx: Ctx,
  input: {
    unitId: number;
    kind: DepositKind;
    refType: string;
    refId: number;
    amountPaise: number;
    payerResidentId?: number;
    title?: string;
    dueDate?: string;
  },
  t: Transaction,
): Promise<{ depositId: number; invoiceId: number; paymentOrderId: number | null }> {
  const societyId = societyIdOf(ctx);
  const existing = await Deposit.findOne({
    where: { societyId, refType: input.refType, refId: input.refId, kind: input.kind },
    transaction: t,
  });
  if (existing) {
    const o = await PaymentOrder.findOne({
      where: { societyId, dedupeKey: `deposit:${existing.id}` },
      attributes: ['id'],
      transaction: t,
    });
    return {
      depositId: n(existing.id),
      invoiceId: n(existing.invoiceId),
      paymentOrderId: o ? n(o.id) : null,
    };
  }
  const today = await societyToday(societyId);
  const d = await createIn(
    ctx,
    societyId,
    {
      unitId: input.unitId,
      residentId: input.payerResidentId,
      kind: input.kind,
      title: input.title ?? `${KIND_LABEL[input.kind]} deposit`,
      amountPaise: input.amountPaise,
      dueDate: input.dueDate ?? addDaysYmd(today, 7),
      refType: input.refType,
      refId: input.refId,
    },
    t,
  );
  t.afterCommit(() => void ensureDepositOrder(ctx, d));
  return { depositId: n(d.id), invoiceId: n(d.invoiceId), paymentOrderId: null };
}

// ------------------------------------------------------------------ paid in full (module 12 hook, deposit-sync job)
/**
 * AWAITING_PAYMENT to HELD once the invoice is fully paid; HELD back to AWAITING_PAYMENT when the invoice is no longer fully paid
 * and nothing was deducted or refunded yet. The caller holds the deposit row lock; the invoice is read inside `t`, so a payment that
 * is being captured in the same transaction is seen.
 */
export async function applySync(
  ctx: Ctx,
  d: Deposit,
  t: Transaction,
): Promise<'HELD' | 'AWAITING_PAYMENT' | null> {
  if (!d.invoiceId || d.isOpening) return null;
  const inv = await Invoice.findByPk(n(d.invoiceId), { transaction: t });
  if (!inv) return null;
  const societyId = n(d.societyId);
  if (d.status === 'AWAITING_PAYMENT' && inv.status === 'PAID') {
    const before = snap(d);
    await d.update(
      { receivedPaise: n(d.amountPaise), status: 'HELD', receivedAt: now(), version: n(d.version) + 1 },
      { transaction: t },
    );
    await auditDeposit(withSociety(ctx, societyId), AUDIT.depositReceived, d, before, t);
    emitDeposit(t, d);
    notifyDepositor(t, societyId, n(d.unitId), NOTIFY.depositReceived, {
      depositId: n(d.id),
      amount: formatRupees(n(d.amountPaise)),
      title: d.title,
    });
    const h = d.refType ? owners.get(d.refType) : undefined;
    if (h && d.refType && d.refId !== null)
      await h.onDepositPaid(
        withSociety(ctx, societyId),
        { refType: d.refType, refId: n(d.refId), depositId: n(d.id) },
        t,
      );
    return 'HELD';
  }
  if (
    d.status === 'HELD' &&
    inv.status !== 'PAID' &&
    n(d.deductedPaise) === 0 &&
    n(d.refundedPaise) === 0 &&
    n(d.refundRequestedPaise) === 0
  ) {
    const before = snap(d);
    await d.update(
      { receivedPaise: 0, status: 'AWAITING_PAYMENT', receivedAt: null, version: n(d.version) + 1 },
      { transaction: t },
    );
    await auditDeposit(
      withSociety(ctx, societyId),
      AUDIT.depositCreated,
      d,
      before,
      t,
      'Payment reversed, deposit awaits payment again',
    );
    emitDeposit(t, d);
    return 'AWAITING_PAYMENT';
  }
  return null;
}

/** Module 12 `registerOrderHook('deposit', …)`: runs inside the capture transaction. */
export async function onDepositOrderPaid(
  ctx: Ctx,
  order: { societyId: number; refId: number | null },
  t: Transaction,
): Promise<void> {
  if (order.refId === null) return;
  const d = await Deposit.findOne({
    where: { id: n(order.refId), societyId: n(order.societyId) },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (d) await applySync(ctx, d, t);
}

/** One deposit of the sync job, re-read under the row lock. */
export async function syncDeposit(societyId: number, id: number): Promise<string | null> {
  return moneyTx(async t => {
    const d = await Deposit.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!d) return null;
    return applySync(withSociety(systemCtx('accounts:deposit-sync'), societyId), d, t);
  });
}

// ------------------------------------------------------------------ deduction, forfeit (BR-13-46)
/** Posts Dr deposit ledger, Cr 4600 and updates the row. The caller holds the row lock and checked the status. */
async function applyDeduction(
  ctx: Ctx,
  d: Deposit,
  o: { amountPaise: number; reason: string; date: string; kind: 'DEDUCTION' | 'FORFEIT' },
  t: Transaction,
): Promise<void> {
  const held = heldOf(d);
  if (o.amountPaise > held)
    throw new UnprocessableError(ERR.depositInsufficientHeld, 'The amount is more than the deposit holds', [
      { field: 'amountPaise', message: 'More than held', heldPaise: held },
    ]);
  const adjustments = [...(d.adjustments ?? [])];
  const code = await ledgerCodeOf(d, t);
  const label = await unitLabelOf(n(d.societyId), n(d.unitId), t);
  const j = await postJournal(
    ctx,
    {
      date: o.date,
      voucherType: 'JOURNAL',
      refType: 'deposit',
      refId: `${d.id}:${adjustments.length + 1}`,
      narration: `${o.kind === 'FORFEIT' ? 'Forfeit' : 'Deduction'} from deposit DEP-${d.id} ${label}`,
      lines: [
        { ledgerAccountCode: code, debitPaise: o.amountPaise, creditPaise: 0 },
        { ledgerAccountCode: CODE.depositDeductions, debitPaise: 0, creditPaise: o.amountPaise },
      ],
    },
    t,
  );
  adjustments.push({
    kind: o.kind,
    amountPaise: o.amountPaise,
    reason: o.reason,
    journalEntryId: j.id,
    at: now().toISOString(),
    by: ctx.user?.id ?? null,
  });
  const after = held - o.amountPaise;
  await d.update(
    {
      deductedPaise: n(d.deductedPaise) + o.amountPaise,
      adjustments,
      status: after === 0 ? 'FORFEITED' : 'HELD',
      version: n(d.version) + 1,
      updatedBy: ctx.user?.id ?? null,
    },
    { transaction: t },
  );
  notifyDepositor(t, n(d.societyId), n(d.unitId), NOTIFY.depositDeducted, {
    depositId: n(d.id),
    amount: formatRupees(o.amountPaise),
    reason: o.reason,
  });
  emitDeposit(t, d);
  if (after === 0) await callOwnerRefunded(ctx, d, 0, t);
}

function checkVersion(d: Deposit, version: number): void {
  if (n(d.version) !== version) throw staleVersion();
}

export async function deductDeposit(
  ctx: Ctx,
  id: number,
  input: { amountPaise: number; reason: string; date: string; version: number },
): Promise<DepositDto> {
  const societyId = societyIdOf(ctx);
  await assertPostingDate(societyId, input.date);
  return moneyTx(async t => {
    const d = await lockDeposit(societyId, id, t);
    checkVersion(d, input.version);
    if (d.status !== 'HELD') throw wrongState('Only a held deposit can have a deduction');
    const before = snap(d);
    await applyDeduction(
      ctx,
      d,
      { amountPaise: input.amountPaise, reason: input.reason, date: input.date, kind: 'DEDUCTION' },
      t,
    );
    await auditDeposit(
      ctx,
      (d.status as DepositStatus) === 'FORFEITED' ? AUDIT.depositForfeited : AUDIT.depositDeducted,
      d,
      before,
      t,
      input.reason,
    );
    return depositDto(d, await unitLabelOf(societyId, n(d.unitId), t));
  });
}

export async function forfeitDeposit(
  ctx: Ctx,
  id: number,
  input: { reason: string; date: string; version: number },
): Promise<DepositDto> {
  const societyId = societyIdOf(ctx);
  await assertPostingDate(societyId, input.date);
  return moneyTx(async t => {
    const d = await lockDeposit(societyId, id, t);
    checkVersion(d, input.version);
    if (d.status !== 'HELD') throw wrongState('Only a held deposit can be forfeited');
    const before = snap(d);
    await applyDeduction(
      ctx,
      d,
      { amountPaise: heldOf(d), reason: input.reason, date: input.date, kind: 'FORFEIT' },
      t,
    );
    await auditDeposit(ctx, AUDIT.depositForfeited, d, before, t, input.reason);
    return depositDto(d, await unitLabelOf(societyId, n(d.unitId), t));
  });
}

// ------------------------------------------------------------------ refund request and approval (BR-13-47)
async function raiseRefund(ctx: Ctx, d: Deposit, reason: string | null, t: Transaction): Promise<void> {
  const societyId = n(d.societyId);
  const held = heldOf(d);
  const label = await unitLabelOf(societyId, n(d.unitId), t);
  const before = snap(d);
  await d.update(
    { refundRequestedPaise: held, status: 'REFUND_PENDING', version: n(d.version) + 1 },
    { transaction: t },
  );
  const approval = await accountsPorts().approvals.request(
    ctx,
    {
      type: APPROVAL_TYPES.depositRefund,
      entityType: ENTITY.deposit,
      entityId: n(d.id),
      title: `Refund ${formatRupees(held)} deposit to ${label}`,
      amountPaise: held,
      summary: reason ?? undefined,
      payload: { unitId: n(d.unitId), kind: d.kind, categoryKey: d.kind },
    },
    t,
  );
  await d.update({ refundApprovalRequestId: approval.id }, { transaction: t });
  await auditDeposit(ctx, AUDIT.depositRefundRequested, d, before, t, reason);
  emitDeposit(t, d);
  if (approval.status === 'APPROVED') await onRefundApproved(ctx, n(d.id), t);
}

export async function requestDepositRefund(
  ctx: Ctx,
  id: number,
  input: { reason?: string; version: number },
): Promise<DepositDto> {
  const societyId = societyIdOf(ctx);
  return moneyTx(async t => {
    const open = await accountsPorts().approvals.lockOpenForEntity(societyId, ENTITY.deposit, id, t);
    const d = await lockDeposit(societyId, id, t);
    checkVersion(d, input.version);
    if (open || d.status !== 'HELD')
      throw wrongState('Only a held deposit with no open request can be refunded');
    if (heldOf(d) <= 0) throw wrongState('Nothing is held on this deposit');
    await raiseRefund(ctx, d, input.reason ?? null, t);
    await d.reload({ transaction: t });
    return depositDto(d, await unitLabelOf(societyId, n(d.unitId), t));
  });
}

/** Public `deposits.requestRefund` for owner modules (BR-13-45a). */
export async function requestRefundForOwner(
  ctx: Ctx,
  depositId: number,
  input: { deductionPaise: number; reason: string },
  t: Transaction,
): Promise<void> {
  const societyId = societyIdOf(ctx);
  const open = await accountsPorts().approvals.lockOpenForEntity(societyId, ENTITY.deposit, depositId, t);
  const d = await lockDeposit(societyId, depositId, t);
  if (d.status === 'AWAITING_PAYMENT') {
    const before = snap(d);
    if (d.invoiceId)
      await invoices.cancelBySource(
        ctx,
        n(d.invoiceId),
        { refType: 'deposit', refId: n(d.id), reason: input.reason },
        t,
      );
    await d.update(
      { status: 'CANCELLED', cancelReason: input.reason, version: n(d.version) + 1 },
      { transaction: t },
    );
    await auditDeposit(ctx, AUDIT.depositCancelled, d, before, t, input.reason);
    emitDeposit(t, d);
    return;
  }
  if (open || d.status !== 'HELD')
    throw wrongState('Only a held deposit with no open request can be refunded');
  const held = heldOf(d);
  if (input.deductionPaise > held)
    throw new UnprocessableError(
      ERR.depositInsufficientHeld,
      'The deduction is more than the deposit holds',
      [{ field: 'deductionPaise', message: 'More than held', heldPaise: held }],
    );
  const before = snap(d);
  if (input.deductionPaise > 0) {
    await applyDeduction(
      ctx,
      d,
      {
        amountPaise: input.deductionPaise,
        reason: input.reason,
        date: await societyToday(societyId),
        kind: input.deductionPaise === held ? 'FORFEIT' : 'DEDUCTION',
      },
      t,
    );
    await auditDeposit(
      ctx,
      (d.status as DepositStatus) === 'FORFEITED' ? AUDIT.depositForfeited : AUDIT.depositDeducted,
      d,
      before,
      t,
      input.reason,
    );
  }
  if (d.status === 'HELD') await raiseRefund(ctx, d, input.reason, t);
}

/** Module 14 `onApproved` of `DEPOSIT_REFUND` (entity `deposit`). */
export async function onRefundApproved(ctx: Ctx, id: number, t: Transaction): Promise<void> {
  const d = await Deposit.findOne({ where: { id }, transaction: t, lock: t.LOCK.UPDATE });
  if (!d) throw depositNotFound();
  if (d.status !== 'REFUND_PENDING') return;
  const before = snap(d);
  await d.update({ status: 'REFUND_APPROVED', version: n(d.version) + 1 }, { transaction: t });
  await auditDeposit(withSociety(ctx, n(d.societyId)), AUDIT.depositRefundApproved, d, before, t);
  emitDeposit(t, d);
}

async function backToHeld(ctx: Ctx, id: number, reason: string | null, t: Transaction): Promise<void> {
  const d = await Deposit.findOne({ where: { id }, transaction: t, lock: t.LOCK.UPDATE });
  if (!d) throw depositNotFound();
  if (d.status !== 'REFUND_PENDING') return;
  const before = snap(d);
  await d.update({ status: 'HELD', refundRequestedPaise: 0, version: n(d.version) + 1 }, { transaction: t });
  await auditDeposit(withSociety(ctx, n(d.societyId)), AUDIT.depositRefundRejected, d, before, t, reason);
  emitDeposit(t, d);
}
export const onRefundRejected = (ctx: Ctx, id: number, reason: string, t: Transaction) =>
  backToHeld(ctx, id, reason, t);
export const onRefundCancelled = (ctx: Ctx, id: number, t: Transaction) =>
  backToHeld(ctx, id, 'Refund request withdrawn', t);

export async function describeRefund(id: number) {
  const d = await Deposit.findByPk(id);
  if (!d) return [];
  const label = await unitLabelOf(n(d.societyId), n(d.unitId));
  return [
    { label: 'Flat', value: label, kind: 'text' as const },
    { label: 'Deposit', value: `DEP-${d.id} ${d.title}`, kind: 'text' as const },
    { label: 'Refund amount', value: String(heldOf(d)), kind: 'money' as const },
    { label: 'Deducted so far', value: String(n(d.deductedPaise)), kind: 'money' as const },
  ];
}

// ------------------------------------------------------------------ refund paid (BR-13-47)
const REFERENCE_MODES = ['CHEQUE', 'NEFT', 'RTGS', 'IMPS'];

export async function markRefundPaid(
  ctx: Ctx,
  id: number,
  input: {
    paidFromLedgerAccountId: number;
    refundMode: DepositRefundMode;
    refundReference?: string;
    date: string;
    version: number;
  },
): Promise<DepositDto> {
  const societyId = societyIdOf(ctx);
  await assertPostingDate(societyId, input.date);
  if (REFERENCE_MODES.includes(input.refundMode)) {
    const ref = input.refundReference?.trim() ?? '';
    if (ref.length < 6 || ref.length > 30)
      throw new UnprocessableError(
        ERR.invalidPaymentSource,
        'A payment reference of 6 to 30 characters is required',
        [{ field: 'refundReference', message: '6 to 30 characters' }],
      );
  }
  return moneyTx(async t => {
    const d = await lockDeposit(societyId, id, t);
    checkVersion(d, input.version);
    if (d.status !== 'REFUND_APPROVED') throw wrongState('The refund is not approved yet');
    const src = await LedgerAccount.findOne({
      where: { id: input.paidFromLedgerAccountId, societyId },
      transaction: t,
    });
    const cash = src?.subtype === 'CASH' || src?.subtype === 'PETTY_CASH';
    const bank = src?.subtype === 'BANK';
    if (!src || src.isGroup || !src.isActive || (!cash && !bank))
      throw new UnprocessableError(
        ERR.invalidPaymentSource,
        'Pay from an active bank, cash or petty cash account',
        [{ field: 'paidFromLedgerAccountId', message: 'Not a bank or cash account' }],
      );
    if ((input.refundMode === 'CASH') !== cash)
      throw new UnprocessableError(ERR.invalidPaymentSource, 'The payment mode does not fit the account', [
        { field: 'refundMode', message: 'Cash goes with a cash account, other modes with a bank account' },
      ]);
    // lock order: books row, then the ledger row (BR-13-26 balance check)
    await lockBooks(t, societyId);
    const locked = await LedgerAccount.findByPk(n(src.id), { transaction: t, lock: t.LOCK.UPDATE });
    const amount = n(d.refundRequestedPaise);
    if (n(locked!.balancePaise) < amount)
      throw new UnprocessableError(
        ERR.insufficientBalance,
        'The account does not hold enough for this refund',
        [
          {
            field: 'paidFromLedgerAccountId',
            message: 'Balance too low',
            balancePaise: n(locked!.balancePaise),
          },
        ],
      );
    const before = snap(d);
    const label = await unitLabelOf(societyId, n(d.unitId), t);
    const j = await postJournal(
      ctx,
      {
        date: input.date,
        voucherType: 'PAYMENT',
        refType: 'deposit',
        refId: `${d.id}:refund`,
        narration: `Refund of deposit DEP-${d.id} ${label}`,
        lines: [
          { ledgerAccountCode: await ledgerCodeOf(d, t), debitPaise: amount, creditPaise: 0 },
          { ledgerAccountCode: src.code, debitPaise: 0, creditPaise: amount },
        ],
      },
      t,
    );
    const adjustments = [...(d.adjustments ?? [])];
    adjustments.push({
      kind: 'REFUND',
      amountPaise: amount,
      reason: 'Deposit refunded',
      journalEntryId: j.id,
      at: now().toISOString(),
      by: ctx.user?.id ?? null,
    });
    await d.update(
      {
        refundedPaise: n(d.refundedPaise) + amount,
        refundRequestedPaise: 0,
        status: 'REFUNDED',
        refundMode: input.refundMode,
        refundReference: input.refundReference?.trim() || null,
        refundPaidFromLedgerAccountId: n(src.id),
        refundedAt: now(),
        adjustments,
        version: n(d.version) + 1,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
    await auditDeposit(ctx, AUDIT.depositRefunded, d, before, t);
    notifyDepositor(t, societyId, n(d.unitId), NOTIFY.depositRefunded, {
      depositId: n(d.id),
      amount: formatRupees(amount),
    });
    emitDeposit(t, d);
    await callOwnerRefunded(ctx, d, amount, t);
    return depositDto(d, label);
  });
}

// ------------------------------------------------------------------ cancel (staff)
export async function cancelDeposit(
  ctx: Ctx,
  id: number,
  input: { reason: string; version: number },
): Promise<DepositDto> {
  const societyId = societyIdOf(ctx);
  return moneyTx(async t => {
    const d = await lockDeposit(societyId, id, t);
    checkVersion(d, input.version);
    if (d.status !== 'AWAITING_PAYMENT')
      throw wrongState('Only a deposit that is awaiting payment can be cancelled');
    if (d.invoiceId) {
      const inv = await Invoice.findByPk(n(d.invoiceId), { transaction: t });
      if (inv && (n(inv.paidPaise) > 0 || inv.status === 'PAID'))
        throw wrongState('A payment was already made against the deposit invoice');
      await invoices.requestCancel(ctx, n(d.invoiceId), input.reason, t);
    }
    const before = snap(d);
    await d.update(
      {
        status: 'CANCELLED',
        cancelReason: input.reason,
        version: n(d.version) + 1,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: t },
    );
    await auditDeposit(ctx, AUDIT.depositCancelled, d, before, t, input.reason);
    emitDeposit(t, d);
    return depositDto(d, await unitLabelOf(societyId, n(d.unitId), t));
  });
}

// ------------------------------------------------------------------ job
/** `accounts:deposit-sync`: every deposit whose invoice state may have changed, one transaction each. Returns the number changed. */
export async function depositSyncJob(data: Record<string, unknown>): Promise<number> {
  const where: WhereOptions = {
    invoiceId: { [Op.ne]: null },
    isOpening: false,
    [Op.or]: [
      { status: 'AWAITING_PAYMENT' },
      { status: 'HELD', deductedPaise: 0, refundedPaise: 0, refundRequestedPaise: 0 },
    ],
  };
  if (data.societyId) Object.assign(where, { societyId: Number(data.societyId) });
  const rows = await Deposit.findAll({ where, attributes: ['id', 'societyId'], order: [['id', 'ASC']] });
  let changed = 0;
  for (const r of rows) {
    try {
      if (await syncDeposit(n(r.societyId), n(r.id))) changed += 1;
    } catch (err) {
      logger.error({ err, depositId: r.id }, 'deposit-sync failed for one deposit');
    }
  }
  return changed;
}
