import { addMinutes, now } from '../../lib/clock';
import { PaymentOrder } from '../../models';
import { audit } from '../../utils/audit';
import {
  AppError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { assertFeature } from '../subscriptions/entitlements.service';
import { invoices } from '../billing/billing.public';
import { env } from '../../lib/env';
import { AUDIT, ENT, ERR, type FeeMethod, type FeeMode } from './payments.constants';
import { buildPlan } from './payments.alloc.plan';
import { grossUp } from './payments.orders.fee';
import {
  activeAccount,
  checkoutOf,
  ensureGatewayOrder,
  feeRatesOf,
  linesOf,
} from './payments.orders.gateway';
import {
  liveOrderOf,
  openRequests,
  payListVersionOf,
  payPolicy,
  assertUnit,
} from './payments.orders.payables';
import type { CheckoutBlock, OrderLine } from './payments.orders.types';
import type { GatewayAccountDto } from './payments.ports';
import { lockUnit, moneyTx, n, setting } from './payments.shared';
import type { OpenTarget, OrderItem, Transaction } from './payments.types';

export const MAX_BASE_PAISE = 100_000_000;
export const MIN_ITEM_PAISE = 100;

export interface PayListInput {
  unitId: number;
  allocationMode: 'OLDEST_FIRST' | 'SELECTED';
  duesAmountPaise?: number;
  items?: { type: 'INVOICE' | 'COLLECTION_REQUEST'; id: number; amountPaise: number }[];
  advancePaise?: number;
  methodHint?: FeeMethod;
  payListVersion: string;
  device?: 'PHONE' | 'DESKTOP';
}

/** The fee of BR-12-37 for a base amount, the mode and the method. `PASS_TO_PAYER` needs the method (BR-12-38). */
export function feeFor(
  base: number,
  mode: FeeMode,
  feeMethods: FeeMethod[],
  methodHint: FeeMethod | null,
  account: GatewayAccountDto,
) {
  if (methodHint && !account.enabledMethods.includes(methodHint))
    throw new UnprocessableError(ERR.methodNotEnabled, 'That payment method is not enabled', [
      { field: 'methodHint', message: 'Not enabled for this society' },
    ]);
  let rateBp = 0;
  if (mode === 'PASS_TO_PAYER') {
    if (!methodHint) throw new ValidationError([{ field: 'methodHint', message: 'Choose how you will pay' }]);
    if (feeMethods.includes(methodHint)) rateBp = feeRatesOf(account)[methodHint];
  }
  return { ...grossUp(base, rateBp), rateBp };
}

export interface NewOrder {
  societyId: number;
  unitId: number;
  payerUserId: number | null;
  createdBy: number | null;
  sourceType: 'PAY_LIST' | 'MODULE' | 'PAYMENT_LINK';
  allocationMode: 'OLDEST_FIRST' | 'SELECTED';
  items: OrderItem[];
  base: number;
  fee: ReturnType<typeof feeFor>;
  feeMode: FeeMode;
  methodHint: FeeMethod | null;
  account: GatewayAccountDto;
  expiresAt: Date;
  payListVersion?: string | null;
  sourceModule?: string;
  refType?: string;
  refId?: number;
  dedupeKey?: string;
  returnUrl?: string | null;
  link?: { tokenHash: string; shortCode: string };
}

/** Inserts the `CREATED` order (transaction A of 6.7, no gateway order yet) and audits it. */
export async function insertOrder(ctx: Ctx, o: NewOrder, t: Transaction): Promise<PaymentOrder> {
  const order = await PaymentOrder.create(
    {
      societyId: o.societyId,
      unitId: o.unitId,
      payerUserId: o.payerUserId,
      sourceType: o.sourceType,
      sourceModule: o.sourceModule ?? null,
      refType: o.refType ?? null,
      refId: o.refId ?? null,
      dedupeKey: o.dedupeKey ?? null,
      allocationMode: o.allocationMode,
      items: o.items,
      payListVersion: o.payListVersion ?? null,
      basePaise: o.base,
      convenienceFeePaise: o.fee.feePaise,
      convenienceFeeGstPaise: o.fee.feeGstPaise,
      grossAmountPaise: o.fee.grossPaise,
      feeMode: o.feeMode,
      feeRateBp: o.fee.rateBp,
      methodHint: o.methodHint,
      gatewayAccountId: o.account.id,
      gatewayOrderId: null,
      status: 'CREATED',
      expiresAt: o.expiresAt,
      nextCheckAt: addMinutes(now(), 3),
      linkTokenHash: o.link?.tokenHash ?? null,
      linkShortCode: o.link?.shortCode ?? null,
      returnUrl: o.returnUrl ?? null,
      createdBy: o.createdBy,
      updatedBy: null,
    } as never,
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: AUDIT.orderCreated,
      entityType: 'payment_order',
      entityId: n(order.id),
      entityLabel: `PO-${order.id}`,
      societyId: o.societyId,
      before: null,
      after: {
        id: n(order.id),
        unitId: o.unitId,
        sourceType: o.sourceType,
        basePaise: o.base,
        grossAmountPaise: o.fee.grossPaise,
        feeMode: o.feeMode,
      },
      reason: null,
    },
    t,
  );
  return order;
}

/** BR-12-18 per payment bounds of one collection request, with the error codes of 8.3. */
function checkRequestAmount(
  amount: number,
  b: { minPaise: number; maxPaise: number },
  fixedRemaining: number | null,
  allowPartial: boolean,
  field: string,
): void {
  if (amount < b.minPaise)
    throw new UnprocessableError(ERR.amountBelowMinimum, 'The amount is below the minimum', [
      { field, message: `At least ${b.minPaise} paise` },
    ]);
  if (amount > b.maxPaise)
    throw new UnprocessableError(ERR.amountExceedsDue, 'The amount is more than can be paid', [
      { field, message: `At most ${b.maxPaise} paise` },
    ]);
  if (fixedRemaining !== null && !allowPartial && amount !== fixedRemaining)
    throw new UnprocessableError(ERR.partialNotAllowed, 'Part payment is not allowed; pay the full amount', [
      { field, message: `Pay ${fixedRemaining} paise` },
    ]);
}

export interface PayListResult {
  orderId: number;
  status: string;
  basePaise: number;
  convenienceFeePaise: number;
  convenienceFeeGstPaise: number;
  grossAmountPaise: number;
  expiresAt: Date;
  lines: OrderLine[];
  checkout: CheckoutBlock | null;
}

/** `POST /me/payables/payment-orders` (8.3, 6.7 steps 2 to 4). */
export async function createPayListOrder(ctx: Ctx, input: PayListInput): Promise<PayListResult> {
  const societyId = ctx.society!.id;
  const userId = ctx.user!.id;
  assertUnit(ctx, input.unitId);
  if (ctx.membership?.roleKey === 'family_member') await assertFeature(ctx, ENT.familyPay);
  const account = await activeAccount(societyId);
  const policy = await payPolicy(societyId);
  const expiryMin = Number(await setting(societyId, 'payments.orderExpiryMinutes')) || 30;

  const order = await moneyTx(async t => {
    await lockUnit(societyId, input.unitId, t); // BR-12-19: the unit row first, then the checks below see a stable pay list
    const live = await liveOrderOf(societyId, input.unitId, userId);
    if (live)
      throw new AppError(409, ERR.paymentInProgress, 'A payment for this flat is already in progress', [
        { field: 'orderId', message: 'Resume or cancel the open payment', orderId: n(live.id) },
      ]);
    const open = await invoices.listOpen(societyId, input.unitId, { payerUserId: userId });
    const reqs = await openRequests(societyId, input.unitId, policy.allowPartial);
    const version = payListVersionOf([
      ...open.map(i => ({ type: 'INVOICE' as const, id: i.id, amountPaise: i.outstandingPaise })),
      ...reqs.map(r => ({
        type: 'COLLECTION_REQUEST' as const,
        id: n(r.request.id),
        amountPaise: n(r.request.paidPaise),
      })),
    ]);
    if (version !== input.payListVersion)
      throw new AppError(409, ERR.payableChanged, 'Your dues changed. Reload and check the amounts.');

    const asked =
      (input.duesAmountPaise ?? 0) +
      (input.advancePaise ?? 0) +
      (input.items ?? []).reduce((a, i) => a + i.amountPaise, 0);
    if (asked <= 0) throw new UnprocessableError(ERR.nothingToPay, 'There is nothing to pay');
    const snapshot: OrderItem[] = [];
    const invOpen = new Map(open.filter(i => !i.isDisputed).map(i => [i.id, i]));
    const totalDues = [...invOpen.values()].reduce((a, i) => a + i.outstandingPaise, 0);
    const seen = new Set<string>();
    for (const [idx, it] of (input.items ?? []).entries()) {
      const field = `items[${idx}].amountPaise`;
      const key = `${it.type}:${it.id}`;
      if (seen.has(key))
        throw new ValidationError([{ field: `items[${idx}].id`, message: 'Duplicate item' }]);
      seen.add(key);
      if (it.type === 'INVOICE') {
        const inv = invOpen.get(it.id);
        if (!inv) throw new NotFoundError(ERR.payableNotFound, 'One of the items is not payable');
        if (it.amountPaise < MIN_ITEM_PAISE && it.amountPaise !== inv.outstandingPaise)
          throw new UnprocessableError(ERR.amountBelowMinimum, 'The amount is below the minimum', [
            { field, message: 'At least 100 paise' },
          ]);
        if (it.amountPaise > inv.outstandingPaise)
          throw new UnprocessableError(ERR.amountExceedsDue, 'The amount is more than the outstanding', [
            { field, message: `At most ${inv.outstandingPaise} paise` },
          ]);
        if (!policy.allowPartial && it.amountPaise !== inv.outstandingPaise)
          throw new UnprocessableError(
            ERR.partialNotAllowed,
            'Part payment is not allowed; pay the full amount',
            [{ field, message: `Pay ${inv.outstandingPaise} paise` }],
          );
        snapshot.push({
          itemType: 'INVOICE',
          itemId: inv.id,
          label: inv.invoiceNo,
          amountPaise: it.amountPaise,
        });
      } else {
        const r = reqs.find(x => n(x.request.id) === it.id);
        if (!r) throw new NotFoundError(ERR.payableNotFound, 'One of the items is not payable');
        checkRequestAmount(
          it.amountPaise,
          r,
          r.collection.amountMode === 'FIXED_PER_UNIT' ? r.outstandingPaise : null,
          policy.allowPartial,
          field,
        );
        snapshot.push({
          itemType: 'COLLECTION_REQUEST',
          itemId: n(r.request.id),
          label: r.collection.title,
          amountPaise: it.amountPaise,
        });
      }
    }
    if (input.allocationMode === 'OLDEST_FIRST') {
      const dues = input.duesAmountPaise ?? 0;
      if (dues > 0) {
        if (dues > totalDues && !policy.allowAdvance)
          throw new UnprocessableError(ERR.advanceNotAllowed, 'Advance payment is switched off', [
            { field: 'duesAmountPaise', message: `At most ${totalDues} paise` },
          ]);
        const targets: OpenTarget[] = [...invOpen.values()].map(i => ({
          targetType: 'INVOICE',
          id: i.id,
          label: i.invoiceNo,
          dueDate: i.dueDate,
          issueDate: i.issueDate,
          outstandingPaise: i.outstandingPaise,
        }));
        if (!policy.allowPartial) {
          const plan = buildPlan(targets, { mode: 'OLDEST_FIRST', amountPaise: dues });
          const partial = plan.lines.some(l => l.amountPaise < (invOpen.get(l.id)?.outstandingPaise ?? 0));
          if (partial)
            throw new UnprocessableError(ERR.partialNotAllowed, 'Part payment is not allowed; pay in full', [
              { field: 'duesAmountPaise', message: 'Pay whole bills' },
            ]);
        }
        snapshot.unshift({
          itemType: 'OLDEST_FIRST_DUES',
          itemId: null,
          label: 'Dues, oldest first',
          amountPaise: dues,
        });
      }
    }
    const advance = input.allocationMode === 'SELECTED' ? (input.advancePaise ?? 0) : 0;
    if (advance > 0) {
      if (!policy.allowAdvance)
        throw new UnprocessableError(ERR.advanceNotAllowed, 'Advance payment is switched off', [
          { field: 'advancePaise', message: 'Not allowed' },
        ]);
      snapshot.push({ itemType: 'ADVANCE', itemId: null, label: 'Advance', amountPaise: advance });
    }
    const base = snapshot.reduce((a, i) => a + i.amountPaise, 0);
    if (base <= 0) throw new UnprocessableError(ERR.nothingToPay, 'There is nothing to pay');
    if (base > MAX_BASE_PAISE)
      throw new UnprocessableError(ERR.amountTooLarge, 'The amount is too large for one payment');
    if (base < MIN_ITEM_PAISE)
      throw new UnprocessableError(ERR.amountBelowMinimum, 'The amount is below the minimum');
    const fee = feeFor(base, policy.feeMode, policy.feeMethods, input.methodHint ?? null, account);
    return insertOrder(
      ctx,
      {
        societyId,
        unitId: input.unitId,
        payerUserId: userId,
        createdBy: userId,
        sourceType: 'PAY_LIST',
        allocationMode: input.allocationMode,
        items: snapshot,
        base,
        fee,
        feeMode: policy.feeMode,
        methodHint: input.methodHint ?? null,
        account,
        expiresAt: addMinutes(now(), expiryMin),
        payListVersion: version,
      },
      t,
    );
  });
  const withGateway = await ensureGatewayOrder(order, account, { failOrder: true });
  return {
    orderId: n(withGateway.id),
    status: withGateway.status,
    basePaise: n(withGateway.basePaise),
    convenienceFeePaise: n(withGateway.convenienceFeePaise),
    convenienceFeeGstPaise: n(withGateway.convenienceFeeGstPaise),
    grossAmountPaise: n(withGateway.grossAmountPaise),
    expiresAt: withGateway.expiresAt,
    lines: linesOf(withGateway),
    checkout: await checkoutOf(withGateway, account, input.device ?? 'PHONE'),
  };
}

// ---------------------------------------------------------------- 8.26 createOrder for other modules
export interface CreateOrderInput {
  unitId: number;
  invoiceIds: number[];
  sourceModule: string;
  refType: string;
  refId: number;
  dedupeKey: string;
  expiresInMinutes?: number;
  methodHint?: FeeMethod;
  returnUrl?: string;
}

const DEDUPE = /^[a-z_]+:\d+(:[a-z0-9_]+)?$/;

/**
 * 8.26 `createOrder`: a `MODULE` order for 1 to 20 open invoices of a unit, at their full outstanding amounts. The same
 * `dedupeKey` returns the same order (`409 DUPLICATE_ORDER` when the invoices differ). The gateway order is created after the
 * transaction.
 */
export async function createModuleOrder(ctx: Ctx, input: CreateOrderInput) {
  const societyId = ctx.society?.id;
  if (!societyId) throw new ValidationError([{ field: 'society', message: 'A society context is required' }]);
  const bad = (field: string, message: string) => new ValidationError([{ field, message }]);
  if (!DEDUPE.test(input.dedupeKey)) throw bad('dedupeKey', 'Use name:number or name:number:part');
  if (!/^\d{2}$/.test(input.sourceModule)) throw bad('sourceModule', 'Use the two-digit module number');
  const ids = [...new Set(input.invoiceIds)];
  if (ids.length < 1 || ids.length > 20) throw bad('invoiceIds', '1 to 20 invoices');
  if (input.expiresInMinutes !== undefined && (input.expiresInMinutes < 5 || input.expiresInMinutes > 1440))
    throw bad('expiresInMinutes', '5 to 1440');
  if (input.returnUrl && !env().appOrigins.some(o => input.returnUrl!.startsWith(o)))
    throw bad('returnUrl', 'Must start with an app address');
  const account = await activeAccount(societyId);
  const policy = await payPolicy(societyId);
  const expiryMin =
    input.expiresInMinutes ?? (Number(await setting(societyId, 'payments.orderExpiryMinutes')) || 30);

  const sameItems = (o: PaymentOrder) => {
    const have = ((o.items ?? []) as OrderItem[])
      .map(i => i.itemId)
      .sort()
      .join(',');
    return have === [...ids].sort((a, b) => a - b).join(',');
  };
  const existing = await PaymentOrder.findOne({ where: { societyId, dedupeKey: input.dedupeKey } });
  const respond = async (o: PaymentOrder) => {
    const live = o.status === 'CREATED' || o.status === 'ATTEMPTED';
    const full = live && !o.gatewayOrderId ? await ensureGatewayOrder(o, account, { failOrder: true }) : o;
    return {
      orderId: n(full.id),
      status: (full.status === 'PAID' ? 'PAID' : 'CREATED') as 'CREATED' | 'PAID',
      grossAmountPaise: n(full.grossAmountPaise),
      expiresAt: full.expiresAt,
      checkout: live ? await checkoutOf(full, account) : null,
    };
  };
  if (existing) {
    if (!sameItems(existing))
      throw new ConflictError(ERR.duplicateOrder, 'An order with this key already exists for other invoices');
    return respond(existing);
  }
  const order = await moneyTx(async t => {
    await lockUnit(societyId, input.unitId, t);
    const dup = await PaymentOrder.findOne({
      where: { societyId, dedupeKey: input.dedupeKey },
      transaction: t,
    });
    if (dup) return dup;
    const open = await invoices.listOpen(societyId, input.unitId);
    const byId = new Map(open.map(i => [i.id, i]));
    const items: OrderItem[] = [];
    for (const id of ids) {
      const inv = byId.get(id);
      if (!inv) throw new NotFoundError(ERR.payableNotFound, 'An invoice is not open for this unit');
      items.push({
        itemType: 'INVOICE',
        itemId: id,
        label: inv.invoiceNo,
        amountPaise: inv.outstandingPaise,
      });
    }
    const base = items.reduce((a, i) => a + i.amountPaise, 0);
    if (base < MIN_ITEM_PAISE)
      throw new UnprocessableError(ERR.amountBelowMinimum, 'The amount is below the minimum');
    if (base > MAX_BASE_PAISE) throw new UnprocessableError(ERR.amountTooLarge, 'The amount is too large');
    const fee = feeFor(base, policy.feeMode, policy.feeMethods, input.methodHint ?? null, account);
    return insertOrder(
      ctx,
      {
        societyId,
        unitId: input.unitId,
        payerUserId: ctx.user?.id ?? null,
        createdBy: ctx.user?.id ?? null,
        sourceType: 'MODULE',
        allocationMode: 'SELECTED',
        items,
        base,
        fee,
        feeMode: policy.feeMode,
        methodHint: input.methodHint ?? null,
        account,
        expiresAt: addMinutes(now(), expiryMin),
        sourceModule: input.sourceModule,
        refType: input.refType,
        refId: input.refId,
        dedupeKey: input.dedupeKey,
        returnUrl: input.returnUrl ?? null,
      },
      t,
    );
  });
  return respond(order);
}
