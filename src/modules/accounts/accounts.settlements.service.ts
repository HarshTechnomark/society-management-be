import { Op, QueryTypes, type WhereOptions } from 'sequelize';
import { Payment, Settlement, sequelize } from '../../models';
import type { SettlementItem } from '../../models/settlement.model';
import { enqueue } from '../../lib/queue';
import { emitToRoom } from '../../lib/realtime';
import { logger } from '../../lib/logger';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { AppError, ConflictError, NotFoundError, UnprocessableError } from '../../utils/errors';
import { systemCtx, type Ctx } from '../../types/context';
import { settings } from '../society-setup/society-setup.public';
import { payments } from '../payments/payments.public';
import { moneyTx, withSociety } from '../payments/payments.shared';
import { AUDIT, CODE, ACCOUNTS_QUEUE, ERR, JOBS, NOTIFY, RT, roomFinance } from './accounts.constants';
import { postJournal } from './accounts.engine';
import { collectionBank } from './accounts.lookup';
import { accountsPorts } from './accounts.ports';
import { n, societyIdOf } from './accounts.shared';
import type { Transaction } from './accounts.types';

/** Item cap of table 7.9. */
export const MAX_SETTLEMENT_ITEMS = 10_000;
/** Settlements older than this many days are no longer retried by the 30 minute job (section 9.1). */
export const RETRY_DAYS = 7;

export interface SettlementIngestItem {
  type: 'payment' | 'refund';
  gatewayPaymentId: string;
  gatewayRefundId?: string;
  amountPaise: number;
  feePaise: number;
  taxPaise: number;
}
/** Section 8.15 ingest contract (`sourceFileId`, `skipEnqueue` and `source` are internal extras). */
export interface SettlementIngestInput {
  gatewayProvider: string;
  gatewaySettlementId: string;
  settlementDate: string;
  utr?: string;
  feePaise: number;
  feeGstPaise: number;
  adjustmentPaise: number;
  netPaise: number;
  items: SettlementIngestItem[];
  sourceFileId?: number | null;
  source?: 'REPORT_UPLOAD' | 'GATEWAY_FETCH';
  skipEnqueue?: boolean;
}

const notFound = () => new NotFoundError(ERR.settlementNotFound, 'Settlement not found');

// ------------------------------------------------------------------ ingest
/** `settlements.ingest` (8.15, 8.20): idempotent by `gatewaySettlementId`; RECEIVED; the reconcile job follows after commit. */
export async function ingestSettlement(
  ctx: Ctx,
  input: SettlementIngestInput,
  t: Transaction,
): Promise<{ settlementId: number; created: boolean }> {
  const societyId = societyIdOf(ctx);
  const existing = await Settlement.findOne({
    where: { societyId, gatewaySettlementId: input.gatewaySettlementId },
    transaction: t,
  });
  if (existing) return { settlementId: n(existing.id), created: false };
  if (input.items.length > MAX_SETTLEMENT_ITEMS)
    throw new UnprocessableError(
      ERR.settlementTotalsInvalid,
      `A settlement holds at most ${MAX_SETTLEMENT_ITEMS} items`,
    );
  const gross = input.items.filter(i => i.type === 'payment').reduce((a, i) => a + i.amountPaise, 0);
  const refunds = input.items.filter(i => i.type === 'refund').reduce((a, i) => a + i.amountPaise, 0);
  const expected = gross - refunds - input.feePaise - input.feeGstPaise + input.adjustmentPaise;
  if (expected !== input.netPaise)
    throw new UnprocessableError(
      ERR.settlementTotalsInvalid,
      'The net amount does not match gross, refunds, fee, GST on fee and adjustment',
      [
        {
          field: 'netPaise',
          message: `Expected ${expected} paise from the items, got ${input.netPaise}`,
          gatewaySettlementId: input.gatewaySettlementId,
        } as never,
      ],
    );
  const row = await Settlement.create(
    {
      societyId,
      gatewayProvider: input.gatewayProvider,
      gatewaySettlementId: input.gatewaySettlementId,
      bankAccountId: null,
      settlementDate: input.settlementDate,
      utr: input.utr ?? null,
      grossPaise: gross,
      refundsPaise: refunds,
      feePaise: input.feePaise,
      feeGstPaise: input.feeGstPaise,
      adjustmentPaise: input.adjustmentPaise,
      netPaise: input.netPaise,
      paymentCount: input.items.filter(i => i.type === 'payment').length,
      items: input.items,
      unmatchedItems: null,
      source: input.source ?? 'REPORT_UPLOAD',
      sourceFileId: input.sourceFileId ?? null,
      status: 'RECEIVED',
      createdBy: ctx.user?.id ?? null,
      updatedBy: ctx.user?.id ?? null,
    },
    { transaction: t },
  );
  const id = n(row.id);
  await audit(
    ctx,
    {
      action: AUDIT.settlementReceived,
      entityType: 'settlement',
      entityId: id,
      societyId,
      after: {
        gatewaySettlementId: input.gatewaySettlementId,
        netPaise: input.netPaise,
        items: input.items.length,
      },
    },
    t,
  );
  t.afterCommit(() => {
    emitToRoom(roomFinance(societyId), RT.settlementUpdated, { id, status: 'RECEIVED' });
    if (!input.skipEnqueue)
      void enqueue(ACCOUNTS_QUEUE, JOBS.settlementReconcile, { societyId, settlementId: id }).catch(err =>
        logger.error({ err, societyId, settlementId: id }, 'settlement reconcile enqueue failed'),
      );
  });
  return { settlementId: id, created: true };
}

// ------------------------------------------------------------------ reading
interface ListQuery {
  status?: string;
  from?: string;
  to?: string;
  q?: string;
  page: number;
  limit: number;
}

const dto = (s: Settlement) => ({
  id: n(s.id),
  gatewayProvider: s.gatewayProvider,
  gatewaySettlementId: s.gatewaySettlementId,
  bankAccountId: s.bankAccountId === null ? null : n(s.bankAccountId),
  settlementDate: s.settlementDate,
  utr: s.utr,
  grossPaise: n(s.grossPaise),
  refundsPaise: n(s.refundsPaise),
  feePaise: n(s.feePaise),
  feeGstPaise: n(s.feeGstPaise),
  adjustmentPaise: n(s.adjustmentPaise),
  netPaise: n(s.netPaise),
  paymentCount: n(s.paymentCount),
  source: s.source,
  status: s.status,
  differenceAcceptedReason: s.differenceAcceptedReason,
  journalEntryId: s.journalEntryId === null ? null : n(s.journalEntryId),
  postedAt: s.postedAt ? s.postedAt.toISOString() : null,
  lastAttemptAt: s.lastAttemptAt ? s.lastAttemptAt.toISOString() : null,
  attempts: n(s.attempts),
  version: n(s.version),
  createdAt: s.createdAt.toISOString(),
});

export async function listSettlements(societyId: number, q: ListQuery) {
  const where: WhereOptions[] = [{ societyId }];
  if (q.status) where.push({ status: q.status });
  if (q.from) where.push({ settlementDate: { [Op.gte]: q.from } });
  if (q.to) where.push({ settlementDate: { [Op.lte]: q.to } });
  if (q.q)
    where.push({
      [Op.or]: [
        { gatewaySettlementId: { [Op.like]: `%${q.q.replace(/[%_\\]/g, m => `\\${m}`)}%` } },
        { utr: { [Op.like]: `%${q.q.replace(/[%_\\]/g, m => `\\${m}`)}%` } },
      ],
    });
  const { rows, count } = await Settlement.findAndCountAll({
    where: { [Op.and]: where },
    order: [
      ['settlementDate', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return {
    items: rows.map(dto),
    pagination: { page: q.page, limit: q.limit, total: count, totalPages: Math.ceil(count / q.limit) },
  };
}

export async function getSettlement(societyId: number, id: number) {
  const s = await Settlement.findOne({ where: { id, societyId } });
  if (!s) throw notFound();
  return detailDto(s);
}

async function detailDto(s: Settlement) {
  const ids = s.items.filter(i => i.type === 'payment').map(i => i.gatewayPaymentId);
  const pays = ids.length
    ? await Payment.findAll({
        where: { societyId: s.societyId, gatewayPaymentId: { [Op.in]: ids } },
        attributes: ['id', 'gatewayPaymentId', 'receiptNo'],
      })
    : [];
  const by = new Map(pays.map(p => [p.gatewayPaymentId, p]));
  return {
    ...dto(s),
    items: s.items.map(i => {
      const p = i.type === 'payment' ? by.get(i.gatewayPaymentId) : undefined;
      return { ...i, matchedPaymentId: p ? n(p.id) : null, receiptNo: p?.receiptNo ?? null };
    }),
    unmatchedItems: s.unmatchedItems,
  };
}

// ------------------------------------------------------------------ matching and posting
interface Unmatched {
  gatewayPaymentId: string;
  amountPaise: number;
  type: 'payment' | 'refund';
  reason:
    | 'UNKNOWN_PAYMENT'
    | 'AMOUNT_DIFFERS'
    | 'NOT_CAPTURED'
    | 'ALREADY_SETTLED'
    | 'DUPLICATE_ITEM'
    | 'REFUNDS_EXCEED_GROSS';
  expectedPaise?: number;
}

const SETTLEABLE = ['CAPTURED', 'CONFIRMED'];

/** BR-13-39: which items do not match a captured, unsettled payment of the society. */
export async function matchItems(s: Settlement, t: Transaction): Promise<Unmatched[]> {
  const societyId = n(s.societyId);
  const out: Unmatched[] = [];
  const payItems = s.items.filter(i => i.type === 'payment');
  const ids = [...new Set(payItems.map(i => i.gatewayPaymentId))];
  const taken = new Set<string>();
  if (ids.length) {
    const others = await sequelize.query<{ id: number; items: SettlementItem[] | string }>(
      `SELECT id, items FROM settlements
        WHERE societyId = :societyId AND status = 'POSTED' AND id <> :id
          AND JSON_OVERLAPS(items->'$[*].gatewayPaymentId', CAST(:ids AS JSON))`,
      {
        replacements: { societyId, id: n(s.id), ids: JSON.stringify(ids) },
        type: QueryTypes.SELECT,
        transaction: t,
      },
    );
    for (const o of others) {
      const list = typeof o.items === 'string' ? (JSON.parse(o.items) as SettlementItem[]) : o.items;
      for (const i of list) if (i.type === 'payment') taken.add(i.gatewayPaymentId);
    }
  }
  const seen = new Set<string>();
  for (const it of payItems) {
    const base = {
      gatewayPaymentId: it.gatewayPaymentId,
      amountPaise: it.amountPaise,
      type: 'payment' as const,
    };
    if (seen.has(it.gatewayPaymentId)) {
      out.push({ ...base, reason: 'DUPLICATE_ITEM' });
      continue;
    }
    seen.add(it.gatewayPaymentId);
    const p = await payments.findByGatewayPaymentId(societyId, it.gatewayPaymentId);
    if (!p) out.push({ ...base, reason: 'UNKNOWN_PAYMENT' });
    else if (!SETTLEABLE.includes(p.status)) out.push({ ...base, reason: 'NOT_CAPTURED' });
    else if (n(p.grossAmountPaise) !== it.amountPaise)
      out.push({ ...base, reason: 'AMOUNT_DIFFERS', expectedPaise: n(p.grossAmountPaise) });
    else if (taken.has(it.gatewayPaymentId)) out.push({ ...base, reason: 'ALREADY_SETTLED' });
  }
  if (n(s.refundsPaise) > n(s.grossPaise))
    for (const it of s.items.filter(i => i.type === 'refund'))
      out.push({
        gatewayPaymentId: it.gatewayPaymentId,
        amountPaise: it.amountPaise,
        type: 'refund',
        reason: 'REFUNDS_EXCEED_GROSS',
      });
  return out;
}

/** BR-13-38 journal lines: signed paise per ledger code (positive = debit), zero lines dropped. */
export function settlementLines(
  s: Pick<
    Settlement,
    'netPaise' | 'feePaise' | 'feeGstPaise' | 'grossPaise' | 'refundsPaise' | 'adjustmentPaise'
  >,
  bankCode: string,
  gstClaimable: boolean,
  unmatchedGrossPaise = 0,
) {
  const signed = new Map<string, number>();
  const add = (code: string, v: number) => signed.set(code, (signed.get(code) ?? 0) + v);
  add(bankCode, n(s.netPaise));
  add(CODE.gatewayCharges, n(s.feePaise) + (gstClaimable ? 0 : n(s.feeGstPaise)));
  if (gstClaimable) add(CODE.gstInput, n(s.feeGstPaise));
  add(CODE.gatewayClearing, -(n(s.grossPaise) - n(s.refundsPaise) - unmatchedGrossPaise));
  add(CODE.suspense, -(n(s.adjustmentPaise) + unmatchedGrossPaise));
  return [...signed.entries()]
    .filter(([, v]) => v !== 0)
    .map(([ledgerAccountCode, v]) => ({
      ledgerAccountCode,
      debitPaise: v > 0 ? v : 0,
      creditPaise: v < 0 ? -v : 0,
    }));
}

async function postSettlement(
  s: Settlement,
  ctx: Ctx,
  t: Transaction,
  opts: { unmatchedGrossPaise: number; reason?: string },
): Promise<void> {
  const societyId = n(s.societyId);
  const bank = await collectionBank(societyId, t);
  if (!bank)
    throw new UnprocessableError(
      ERR.collectionAccountRequired,
      'Set a collection bank account before settlements can post',
    );
  const gst = Boolean(
    await Promise.resolve(settings.get(societyId, 'finance.gstInputClaimable' as never)).catch(() => false),
  );
  // gateway settlements are system postings (BR-13-9): a locked date is re-dated, never refused
  const sys = withSociety(systemCtx('accounts:settlement'), societyId);
  const res = await postJournal(
    sys,
    {
      date: s.settlementDate,
      voucherType: 'CONTRA',
      refType: 'settlement',
      refId: n(s.id),
      narration: `Gateway settlement ${s.gatewaySettlementId} reached bank`,
      label: `Gateway settlement ${s.gatewaySettlementId} reached bank`,
      instrumentRef: s.utr,
      lines: settlementLines(s, bank.ledgerCode, gst, opts.unmatchedGrossPaise),
    },
    t,
  );
  s.bankAccountId = bank.id;
  s.journalEntryId = res.id;
  s.status = 'POSTED';
  s.postedAt = now();
  s.unmatchedItems = opts.reason ? s.unmatchedItems : null;
  if (opts.reason) s.differenceAcceptedReason = opts.reason;
  s.updatedBy = ctx.user?.id ?? null;
  s.version = n(s.version) + 1;
  await s.save({ transaction: t });
}

export interface ReconcileOutcome {
  settlementId: number;
  societyId: number;
  status: 'POSTED' | 'MISMATCH' | 'SKIPPED';
  unmatched: Unmatched[];
}

/** Locks the row, matches and posts or marks MISMATCH. Never throws for a mismatch (the state change must commit). */
export async function reconcileSettlement(
  ctx: Ctx,
  societyId: number,
  id: number,
): Promise<ReconcileOutcome> {
  let firstMismatch = false;
  const outcome = await moneyTx(async t => {
    const s = await Settlement.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!s) throw notFound();
    if (s.status === 'POSTED')
      return { settlementId: id, societyId, status: 'SKIPPED' as const, unmatched: [] };
    if (!(await collectionBank(societyId, t)))
      throw new UnprocessableError(
        ERR.collectionAccountRequired,
        'Set a collection bank account before settlements can post',
      );
    const unmatched = await matchItems(s, t);
    s.attempts = n(s.attempts) + 1;
    s.lastAttemptAt = now();
    if (unmatched.length) {
      firstMismatch = n(s.attempts) === 1;
      s.status = 'MISMATCH';
      s.unmatchedItems = unmatched as unknown as Record<string, unknown>[];
      s.updatedBy = ctx.user?.id ?? null;
      s.version = n(s.version) + 1;
      await s.save({ transaction: t });
      await audit(
        ctx,
        {
          action: AUDIT.settlementMismatched,
          entityType: 'settlement',
          entityId: id,
          societyId,
          after: { unmatched: unmatched.length },
        },
        t,
      );
      t.afterCommit(() =>
        emitToRoom(roomFinance(societyId), RT.settlementUpdated, { id, status: 'MISMATCH' }),
      );
      return { settlementId: id, societyId, status: 'MISMATCH' as const, unmatched };
    }
    await postSettlement(s, ctx, t, { unmatchedGrossPaise: 0 });
    await audit(
      ctx,
      {
        action: AUDIT.settlementPosted,
        entityType: 'settlement',
        entityId: id,
        societyId,
        after: { journalEntryId: s.journalEntryId, netPaise: n(s.netPaise) },
      },
      t,
    );
    t.afterCommit(() => emitToRoom(roomFinance(societyId), RT.settlementUpdated, { id, status: 'POSTED' }));
    return { settlementId: id, societyId, status: 'POSTED' as const, unmatched: [] };
  });
  if (outcome.status === 'MISMATCH' && firstMismatch) await notifyMismatch(societyId, id);
  return outcome;
}

/** Route `POST /:id/reconcile`: 409 on a POSTED settlement, 422 SETTLEMENT_MISMATCH when it still does not match. */
export async function reconcileNow(ctx: Ctx, id: number) {
  const societyId = societyIdOf(ctx);
  const cur = await Settlement.findOne({ where: { id, societyId }, attributes: ['id', 'status'] });
  if (!cur) throw notFound();
  if (cur.status === 'POSTED')
    throw new ConflictError(ERR.settlementAlreadyPosted, 'This settlement is already posted');
  const out = await reconcileSettlement(ctx, societyId, id);
  if (out.status === 'MISMATCH')
    throw new UnprocessableError(
      ERR.settlementMismatch,
      'Some items do not match captured payments',
      out.unmatched.map(u => ({
        field: u.gatewayPaymentId,
        message: u.reason,
      })),
    );
  return getSettlement(societyId, id);
}

/** BR-13-39 / US-13-05: Treasurer and Accountant, once per settlement. */
async function notifyMismatch(societyId: number, id: number): Promise<void> {
  const s = await Settlement.findByPk(id);
  const users = await sequelize.query<{ userId: number }>(
    `SELECT DISTINCT m.userId FROM society_members m JOIN roles r ON r.id = m.roleId
      WHERE m.societyId = :societyId AND m.status = 'ACTIVE' AND r.\`key\` IN ('treasurer', 'accountant')`,
    { replacements: { societyId }, type: QueryTypes.SELECT },
  );
  await accountsPorts()
    .notifications.send(
      NOTIFY.settlementMismatch,
      users.map(u => n(u.userId)),
      {
        societyId,
        settlementId: id,
        gatewaySettlementId: s?.gatewaySettlementId,
        unmatched: Array.isArray(s?.unmatchedItems) ? s!.unmatchedItems!.length : 0,
      },
    )
    .catch(err => logger.error({ err, societyId, id }, 'settlement mismatch notification failed'));
}

// ------------------------------------------------------------------ accept difference
export async function acceptDifference(ctx: Ctx, id: number, input: { reason: string; version: number }) {
  const societyId = societyIdOf(ctx);
  await moneyTx(async t => {
    const s = await Settlement.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!s) throw notFound();
    if (s.status === 'POSTED')
      throw new ConflictError(ERR.settlementAlreadyPosted, 'This settlement is already posted');
    if (s.status !== 'MISMATCH')
      throw new AppError(409, ERR.invalidState, 'Only a MISMATCH settlement can be accepted');
    if (n(s.version) !== input.version)
      throw new ConflictError(
        ERR.staleVersion,
        'Someone else changed this settlement. Reload to see the change.',
      );
    const unmatched = (s.unmatchedItems ?? []) as unknown as Unmatched[];
    const unmatchedGross = unmatched.filter(u => u.type === 'payment').reduce((a, u) => a + u.amountPaise, 0);
    await postSettlement(s, ctx, t, { unmatchedGrossPaise: unmatchedGross, reason: input.reason });
    await audit(
      ctx,
      {
        action: AUDIT.settlementDifferenceAccepted,
        entityType: 'settlement',
        entityId: id,
        societyId,
        reason: input.reason,
        after: { unmatchedGrossPaise: unmatchedGross, journalEntryId: s.journalEntryId },
      },
      t,
    );
    t.afterCommit(() => emitToRoom(roomFinance(societyId), RT.settlementUpdated, { id, status: 'POSTED' }));
  });
  return getSettlement(societyId, id);
}
