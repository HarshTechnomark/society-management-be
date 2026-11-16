import { createHash } from 'node:crypto';
import { Op } from 'sequelize';
import { Collection, CollectionRequest, PaymentOrder, Unit } from '../../models';
import { now } from '../../lib/clock';
import { NotFoundError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { invoices } from '../billing/billing.public';
import { ERR, REQUEST_MAX_PAISE, REQUEST_MIN_PAISE, type FeeMethod } from './payments.constants';
import { requestOutstanding } from './payments.alloc.plan';
import { advanceBalance } from './payments.advances';
import { checkoutOf, feeRatesOf } from './payments.orders.gateway';
import { assertAutopayAvailable } from './payments.autopay.service';
import { paymentsPorts } from './payments.ports';
import { n, setting, societyToday } from './payments.shared';

/**
 * The pay list of one unit (8.2): open invoices the payer may pay, open collection requests, the advance balance, the fee
 * settings and the live order. `payListVersion` (BR-12-5) is the SHA-256 of the sorted open item ids and outstanding amounts.
 */
export interface PayableEntry {
  type: 'INVOICE' | 'COLLECTION_REQUEST';
  id: number;
  /** Invoices: outstanding. Requests: paid so far (changes whenever the request changes). */
  amountPaise: number;
}

/** BR-12-5, T12-03: stable for the same items in any order. */
export function payListVersionOf(entries: PayableEntry[]): string {
  const key = entries
    .map(e => `${e.type}:${e.id}:${e.amountPaise}`)
    .sort()
    .join('|');
  return createHash('sha256').update(key).digest('hex');
}

export const FEE_METHOD_LIST: FeeMethod[] = ['UPI', 'CARD', 'NETBANKING', 'WALLET'];

export interface PayableRequest {
  request: CollectionRequest;
  collection: Collection;
  outstandingPaise: number;
  minPaise: number;
  maxPaise: number;
}

/** BR-12-18 per-payment bounds of a collection request. */
export function requestBounds(
  r: { amountPaise: number; minAmountPaise: number; paidPaise: number },
  mode: string,
  allowPartial: boolean,
): { minPaise: number; maxPaise: number } {
  if (mode === 'FIXED_PER_UNIT') {
    const remaining = Math.max(0, r.amountPaise - r.paidPaise);
    return {
      minPaise: allowPartial ? Math.min(REQUEST_MIN_PAISE, remaining) : remaining,
      maxPaise: remaining,
    };
  }
  if (mode === 'MIN_PER_UNIT')
    return {
      minPaise: Math.max(REQUEST_MIN_PAISE, r.minAmountPaise - r.paidPaise),
      maxPaise: REQUEST_MAX_PAISE,
    };
  return { minPaise: REQUEST_MIN_PAISE, maxPaise: REQUEST_MAX_PAISE };
}

/** Open, non-mandatory requests of a unit whose collection is published (8.2). */
export async function openRequests(
  societyId: number,
  unitId: number,
  allowPartial: boolean,
): Promise<PayableRequest[]> {
  const reqs = await CollectionRequest.findAll({
    where: { societyId, unitId, status: { [Op.in]: ['OPEN', 'PART_PAID'] } },
    order: [['id', 'ASC']],
  });
  if (!reqs.length) return [];
  const cols = await Collection.findAll({
    where: {
      societyId,
      id: { [Op.in]: [...new Set(reqs.map(r => n(r.collectionId)))] },
      status: 'PUBLISHED',
    },
  });
  const out: PayableRequest[] = [];
  for (const r of reqs) {
    const c = cols.find(x => n(x.id) === n(r.collectionId));
    if (!c || c.isMandatory) continue;
    const outstandingPaise = requestOutstanding(
      { amountPaise: n(r.amountPaise), paidPaise: n(r.paidPaise), status: r.status },
      c.amountMode,
    );
    if (outstandingPaise <= 0) continue;
    const b = requestBounds(
      { amountPaise: n(r.amountPaise), minAmountPaise: n(r.minAmountPaise), paidPaise: n(r.paidPaise) },
      c.amountMode,
      allowPartial,
    );
    out.push({ request: r, collection: c, outstandingPaise, ...b });
  }
  return out;
}

export async function payPolicy(societyId: number) {
  const [allowPartial, allowAdvance, mode, methods] = await Promise.all([
    setting(societyId, 'payments.allowPartialPayments') as Promise<boolean>,
    setting(societyId, 'payments.allowAdvancePayments') as Promise<boolean>,
    setting(societyId, 'payments.convenienceFeeMode') as Promise<string>,
    setting(societyId, 'payments.convenienceFeeMethods') as Promise<FeeMethod[]>,
  ]);
  return {
    allowPartial,
    allowAdvance,
    feeMode: (mode === 'PASS_TO_PAYER' ? 'PASS_TO_PAYER' : 'SOCIETY_ABSORBS') as
      'PASS_TO_PAYER' | 'SOCIETY_ABSORBS',
    feeMethods: methods,
  };
}

/** The live checkout of BR-12-6: a `PAY_LIST` order of this unit and payer that is open and not expired. */
export const liveOrderOf = (societyId: number, unitId: number, payerUserId: number) =>
  PaymentOrder.findOne({
    where: {
      societyId,
      unitId,
      payerUserId,
      sourceType: 'PAY_LIST',
      status: { [Op.in]: ['CREATED', 'ATTEMPTED'] },
      expiresAt: { [Op.gt]: now() },
    },
    order: [['id', 'DESC']],
  });

export function assertUnit(ctx: Ctx, unitId: number): void {
  if (!(ctx.unitIds ?? []).includes(unitId)) throw new NotFoundError(ERR.unitNotFound, 'Unit not found');
}

/** `GET /me/payables`. */
export async function getPayables(ctx: Ctx, unitId: number) {
  assertUnit(ctx, unitId);
  const societyId = ctx.society!.id;
  const userId = ctx.user!.id;
  const unit = await Unit.findOne({ where: { id: unitId, societyId }, attributes: ['id', 'label'] });
  if (!unit) throw new NotFoundError(ERR.unitNotFound, 'Unit not found');
  const policy = await payPolicy(societyId);
  const today = await societyToday(societyId);
  const open = await invoices.listOpen(societyId, unitId, { payerUserId: userId });
  const reqs = await openRequests(societyId, unitId, policy.allowPartial);
  const items = [
    ...open.map(i => ({
      type: 'INVOICE' as const,
      id: i.id,
      label: `${i.invoiceNo} · ${i.periodLabel}`,
      dueDate: i.dueDate,
      outstandingPaise: i.outstandingPaise,
      isOverdue: i.dueDate < today,
      isDisputed: i.isDisputed,
      minPaise: i.isDisputed
        ? 0
        : policy.allowPartial
          ? Math.min(100, i.outstandingPaise)
          : i.outstandingPaise,
      maxPaise: i.isDisputed ? 0 : i.outstandingPaise,
    })),
    ...reqs.map(r => ({
      type: 'COLLECTION_REQUEST' as const,
      id: n(r.request.id),
      label: `${r.collection.title}${r.collection.amountMode === 'VOLUNTARY' ? ' (optional)' : ''}`,
      dueDate: r.collection.dueDate,
      suggestedPaise:
        r.collection.amountMode === 'FIXED_PER_UNIT'
          ? r.outstandingPaise
          : n(r.request.amountPaise) > 0
            ? Math.max(n(r.request.amountPaise), r.minPaise)
            : null,
      minPaise: r.minPaise,
      maxPaise: r.maxPaise,
      paidPaise: n(r.request.paidPaise),
    })),
  ];
  const version = payListVersionOf([
    ...open.map(i => ({ type: 'INVOICE' as const, id: i.id, amountPaise: i.outstandingPaise })),
    ...reqs.map(r => ({
      type: 'COLLECTION_REQUEST' as const,
      id: n(r.request.id),
      amountPaise: n(r.request.paidPaise),
    })),
  ]);
  const account = await paymentsPorts().gateways.accountFor(societyId);
  const rates = account ? feeRatesOf(account) : null;
  const live = await liveOrderOf(societyId, unitId, userId);
  return {
    unit: { id: n(unit.id), label: unit.label },
    items,
    totalDuesPaise: open.filter(i => !i.isDisputed).reduce((a, i) => a + i.outstandingPaise, 0),
    advanceBalancePaise: await advanceBalance(societyId, unitId),
    payListVersion: version,
    allowPartial: policy.allowPartial,
    allowAdvance: policy.allowAdvance,
    fee: {
      mode: policy.feeMode,
      methods: Object.fromEntries(
        FEE_METHOD_LIST.map(m => [m, rates && policy.feeMethods.includes(m) ? rates[m] : 0]),
      ),
    },
    gatewayReady: Boolean(account?.isActive),
    autopayAvailable: await assertAutopayAvailable(societyId, undefined, 'read').then(
      () => true,
      () => false,
    ),
    offlineInstructions: account?.isActive
      ? null
      : 'Online payment is not available. Pay by bank transfer or cheque and ask the treasurer for the account details.',
    liveOrder: live
      ? {
          orderId: n(live.id),
          status: live.status,
          grossAmountPaise: n(live.grossAmountPaise),
          expiresAt: live.expiresAt,
          checkout: account ? await checkoutOf(live, account) : null,
        }
      : null,
  };
}
