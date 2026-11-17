import { Op, type WhereOptions } from 'sequelize';
import { Payment, Unit } from '../../models';
import { logger } from '../../lib/logger';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../../utils/errors';
import { usersWithPermission } from '../access-control/access-control.public';
import { addDaysYmd, diffDays } from '../billing/billing.calc.period';
import { invoices } from '../billing/billing.public';
import { ACCOUNT, AUDIT, ERR, NOTIFY, PERM, RT, type PaymentStatus } from './payments.constants';
import { paymentsPorts } from './payments.ports';
import { bumpReceiptRevision } from './payments.receipts.core';
import { reversePaymentCore } from './payments.reverse.core';
import {
  auditPayment,
  emitFinance,
  invalidState,
  lockUnit,
  moneyTx,
  n,
  paymentToAudit,
  setting,
  societyToday,
  unitLabelOf,
} from './payments.shared';
import type { Ctx, Transaction } from './payments.types';

/**
 * Cheque lifecycle (8.12, BR-12-30, BR-12-31): deposit batch, clear, bounce and return to payer, and the cheques list.
 * Money effects of bounce and return go through the core `reversePaymentCore`; the bounce charge through module 11
 * `invoices.createAdHoc`. Lock order: unit, then the payment row (BR-12-19).
 */
const staleVersion = () => new ConflictError(ERR.staleVersion, 'This payment changed; reload and try again');
const notFound = () => new NotFoundError(ERR.paymentNotFound, 'Payment not found');

async function lockCheque(ctx: Ctx, id: number, t: Transaction): Promise<Payment> {
  const societyId = ctx.society!.id;
  const pre = await Payment.findOne({
    where: { id, societyId, method: 'CHEQUE' },
    attributes: ['id', 'unitId'],
    transaction: t,
  });
  if (!pre) throw notFound();
  await lockUnit(societyId, n(pre.unitId), t);
  const p = await Payment.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!p) throw notFound();
  return p;
}

const chequeItem = (p: Payment, unitLabel?: string | null) => ({
  id: n(p.id),
  unitId: n(p.unitId),
  ...(unitLabel !== undefined ? { unitLabel } : {}),
  payerName: p.payerName,
  status: p.status,
  amountPaise: n(p.amountPaise),
  paymentDate: p.paymentDate,
  receiptNo: p.receiptNo,
  receiptStatus: p.receiptStatus,
  cheque: {
    bankName: p.chequeBankName,
    chequeNo: p.referenceNo,
    chequeDate: p.chequeDate,
    depositedOn: p.depositedOn,
    depositBankAccountId: p.depositBankAccountId ? n(p.depositBankAccountId) : null,
    clearedOn: p.clearedOn,
    bouncedOn: p.bouncedOn,
    bounceReason: p.bounceReason,
    bounceChargeInvoiceId: p.bounceChargeInvoiceId ? n(p.bounceChargeInvoiceId) : null,
  },
  version: n(p.version),
});

function notifyAfterCommit(
  t: Transaction,
  template: string,
  p: Payment,
  extra: Record<string, unknown>,
  approvers = false,
) {
  t.afterCommit(async () => {
    try {
      const to = new Set([p.payerUserId, p.createdBy].filter(Boolean).map(Number));
      if (approvers)
        for (const u of await usersWithPermission(n(p.societyId), PERM.paymentsApprove)) to.add(u);
      if (!to.size) return;
      await paymentsPorts().notifications.send(template, [...to], {
        societyId: n(p.societyId),
        paymentId: n(p.id),
        amountPaise: n(p.amountPaise),
        ...extra,
      });
    } catch (err) {
      logger.error({ err, template }, 'cheque notification failed');
    }
  });
}

// ------------------------------------------------------------------ deposit batch
export async function depositCheques(
  ctx: Ctx,
  input: { paymentIds: number[]; depositedOn: string; bankAccountId: number },
) {
  const societyId = ctx.society!.id;
  const today = await societyToday(societyId);
  if (input.depositedOn > today)
    throw new ValidationError([
      { field: 'depositedOn', message: 'The deposit date cannot be in the future' },
    ]);
  const bank = await paymentsPorts().bankAccounts.get(societyId, input.bankAccountId);
  if (!bank) throw new NotFoundError(ERR.bankAccountNotFound, 'Bank account not found');
  return moneyTx(async t => {
    const ids = [...input.paymentIds].sort((a, b) => a - b);
    const rows = await Payment.findAll({
      where: { id: { [Op.in]: ids }, societyId },
      order: [['id', 'ASC']],
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (rows.length !== ids.length) throw notFound();
    const bad = rows.filter(p => p.method !== 'CHEQUE' || p.status !== 'RECEIVED');
    if (bad.length)
      throw new ConflictError(ERR.invalidState, 'Only cheques that are received can be deposited');
    const early = rows.filter(p => p.chequeDate && input.depositedOn < p.chequeDate);
    if (early.length)
      throw new UnprocessableError(
        ERR.chequeDateInvalid,
        'A cheque cannot be deposited before its date',
        early.map(p => ({
          field: 'paymentIds',
          message: `Cheque ${p.referenceNo} is dated ${p.chequeDate}`,
          paymentId: n(p.id),
        })),
      );
    const out: { id: number; status: PaymentStatus; version: number }[] = [];
    for (const p of rows) {
      const before = paymentToAudit(p);
      await p.update(
        {
          status: 'DEPOSITED',
          depositedOn: input.depositedOn,
          depositBankAccountId: input.bankAccountId,
          updatedBy: ctx.user?.id ?? null,
          version: n(p.version) + 1,
        },
        { transaction: t },
      );
      await auditPayment(ctx, AUDIT.chequeDeposited, p, before, t);
      emitFinance(t, societyId, RT.chequeUpdated, { paymentId: n(p.id), status: p.status });
      out.push({ id: n(p.id), status: p.status, version: n(p.version) });
    }
    return { deposited: out.length, payments: out };
  });
}

// ------------------------------------------------------------------ clear
export async function clearCheque(ctx: Ctx, id: number, input: { clearedOn: string; version: number }) {
  const societyId = ctx.society!.id;
  const today = await societyToday(societyId);
  return moneyTx(async t => {
    const p = await lockCheque(ctx, id, t);
    if (p.status !== 'DEPOSITED') throw invalidState('Only a deposited cheque can be cleared');
    if (n(p.version) !== input.version) throw staleVersion();
    if (input.clearedOn > today || (p.depositedOn && input.clearedOn < p.depositedOn))
      throw new ValidationError([
        { field: 'clearedOn', message: 'On or after the deposit date and not in the future' },
      ]);
    const before = paymentToAudit(p);
    await p.update(
      {
        status: 'CLEARED',
        clearedOn: input.clearedOn,
        updatedBy: ctx.user?.id ?? null,
        version: n(p.version) + 1,
      },
      { transaction: t },
    );
    const label = await unitLabelOf(societyId, n(p.unitId), t);
    // 6.9 CONTRA: the money moves from cheques in clearing to the bank
    const gross = n(p.amountPaise);
    await paymentsPorts().journal.post(
      ctx as never,
      {
        date: input.clearedOn,
        voucherType: 'CONTRA',
        refType: 'cheque_clearance',
        refId: n(p.id),
        narration: `Cheque ${p.referenceNo} cleared · ${label}`,
        lines: [
          { accountCode: ACCOUNT.bank, debitPaise: gross, creditPaise: 0, unitId: n(p.unitId) },
          { accountCode: ACCOUNT.chequesInClearing, debitPaise: 0, creditPaise: gross, unitId: n(p.unitId) },
        ],
      },
      t,
    );
    // the receipt loses "Subject to realisation": new revision, re-rendered
    if (p.receiptStatus === 'ISSUED') await bumpReceiptRevision(p, t);
    await auditPayment(ctx, AUDIT.chequeCleared, p, before, t);
    emitFinance(t, societyId, RT.chequeUpdated, { paymentId: n(p.id), status: p.status });
    return chequeItem(p, label);
  });
}

// ------------------------------------------------------------------ bounce
export async function bounceCheque(
  ctx: Ctx,
  id: number,
  input: {
    bouncedOn: string;
    reason: string;
    applyBounceCharge?: boolean;
    bounceChargePaise?: number;
    version: number;
  },
) {
  const societyId = ctx.society!.id;
  const today = await societyToday(societyId);
  return moneyTx(async t => {
    const p = await lockCheque(ctx, id, t);
    if (p.status !== 'DEPOSITED' && p.status !== 'CLEARED')
      throw invalidState('Only a deposited or cleared cheque can be marked bounced');
    if (n(p.version) !== input.version) throw staleVersion();
    if (input.bouncedOn > today || (p.depositedOn && input.bouncedOn < p.depositedOn))
      throw new ValidationError([
        { field: 'bouncedOn', message: 'On or after the deposit date and not in the future' },
      ]);
    if (p.status === 'CLEARED') {
      const window = Number(await setting(societyId, 'payments.lateReturnDays'));
      if (!p.clearedOn || diffDays(p.clearedOn, today) > window)
        throw new UnprocessableError(
          ERR.bounceWindowPassed,
          `A cleared cheque can be returned only within ${window} days`,
        );
    }
    const chargeWanted = input.applyBounceCharge !== false;
    const charge =
      input.bounceChargePaise ?? Number(await setting(societyId, 'payments.chequeBounceChargePaise'));
    const reversed = await reversePaymentCore(
      ctx,
      id,
      {
        newStatus: 'BOUNCED',
        reason: input.reason,
        patch: { bounceReason: input.reason, bouncedOn: input.bouncedOn } as Partial<Payment>,
      },
      t,
    );
    if (chargeWanted && charge > 0) {
      const inv = await invoices.createAdHoc(
        ctx,
        {
          unitId: n(reversed.unitId),
          chargeHeadKey: 'CHEQUE_BOUNCE_CHARGE',
          amountPaise: charge,
          refType: 'cheque_bounce',
          refId: n(reversed.id),
          dueDate: addDaysYmd(today, 7),
        },
        t,
      );
      await reversed.update({ bounceChargeInvoiceId: inv.invoiceId }, { transaction: t });
    }
    emitFinance(t, societyId, RT.chequeUpdated, { paymentId: n(reversed.id), status: reversed.status });
    notifyAfterCommit(
      t,
      NOTIFY.chequeBounced,
      reversed,
      { chequeNo: reversed.referenceNo, reason: input.reason },
      true,
    );
    return chequeItem(reversed);
  });
}

// ------------------------------------------------------------------ return to payer
export async function returnCheque(ctx: Ctx, id: number, input: { reason: string; version: number }) {
  const societyId = ctx.society!.id;
  return moneyTx(async t => {
    const p = await lockCheque(ctx, id, t);
    if (p.status !== 'RECEIVED')
      throw invalidState('Only a cheque that is received and not yet deposited can be returned');
    if (n(p.version) !== input.version) throw staleVersion();
    const returned = await reversePaymentCore(ctx, id, { newStatus: 'RETURNED', reason: input.reason }, t);
    emitFinance(t, societyId, RT.chequeUpdated, { paymentId: n(returned.id), status: returned.status });
    return chequeItem(returned);
  });
}

// ------------------------------------------------------------------ list
export interface ChequeListQuery {
  status?: string[];
  unitId?: number;
  q?: string;
  chequeFrom?: string;
  chequeTo?: string;
  dueForDeposit?: boolean;
  page: number;
  limit: number;
}

export async function listCheques(societyId: number, q: ChequeListQuery) {
  const today = await societyToday(societyId);
  const and: WhereOptions[] = [{ societyId, method: 'CHEQUE' }];
  if (q.status?.length) and.push({ status: { [Op.in]: q.status } });
  if (q.unitId) and.push({ unitId: q.unitId });
  if (q.chequeFrom) and.push({ chequeDate: { [Op.gte]: q.chequeFrom } });
  if (q.chequeTo) and.push({ chequeDate: { [Op.lte]: q.chequeTo } });
  if (q.dueForDeposit) and.push({ status: 'RECEIVED', chequeDate: { [Op.lte]: today } });
  if (q.q) {
    const like = `%${q.q.replace(/[%_\\]/g, m => `\\${m}`)}%`;
    and.push({
      [Op.or]: [
        { referenceNo: { [Op.like]: like } },
        { chequeBankName: { [Op.like]: like } },
        { payerName: { [Op.like]: like } },
        { receiptNo: { [Op.like]: like } },
      ],
    });
  }
  const { rows, count } = await Payment.findAndCountAll({
    where: { [Op.and]: and },
    include: [{ model: Unit, attributes: ['label'], required: false }],
    order: [
      ['chequeDate', 'ASC'],
      ['id', 'ASC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
    distinct: true,
  });
  return {
    data: rows.map(p => chequeItem(p, (p as unknown as { Unit?: { label: string } }).Unit?.label ?? null)),
    pagination: {
      page: q.page,
      limit: q.limit,
      total: count,
      totalPages: Math.max(1, Math.ceil(count / q.limit)),
    },
  };
}
