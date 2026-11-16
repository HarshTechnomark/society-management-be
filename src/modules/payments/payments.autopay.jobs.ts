import { Op } from 'sequelize';
import { AutopayMandate, Invoice, PaymentOrder, Society, sequelize } from '../../models';
import { addHours, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { registerProcessor, registerRepeatable } from '../../lib/queue';
import { audit } from '../../utils/audit';
import { formatRupees } from '../../lib/money';
import { systemCtx, type Ctx } from '../../types/context';
import { invoices } from '../billing/billing.public';
import { isJobAllowed } from '../societies/societies.public';
import { flags } from '../subscriptions/subscriptions.public';
import {
  AUDIT,
  FLAG_UPI_AUTOPAY,
  JOBS,
  NOTIFY,
  PAYMENTS_QUEUE,
  type OrderStatus,
} from './payments.constants';
import { paymentsPorts } from './payments.ports';
import { n, societyToday, withSociety } from './payments.shared';
import { addDaysYmd, mandateAudit, notifyPayer } from './payments.autopay.service';
import type { Transaction } from './payments.types';

/**
 * AutoPay jobs (section 9.1, BR-12-48, BR-12-49). All run while a society is SUSPENDED (tag `payments`).
 *  - `payments:autopay-schedule` (06:00 IST): expires mandates past `endDate`, books the results of earlier debits, creates the
 *    `AUTOPAY` order of each debit 1 to 5 days ahead and sends the pre-debit notice.
 *  - `payments:autopay-execute` (07:00 IST): charges orders of today whose notice is at least 24 hours old.
 *  - `payments:mandate-auth-timeout` (hourly): `PENDING_AUTH` mandates older than 48 hours become FAILED.
 */
const DAY_MS = 86_400_000;
const NOTICE_HOURS = 24;
const WINDOW_DAYS = 5;
const SKIP_NOTICE_EVERY_DAYS = 3;

const sysFor = (societyId: number) => withSociety(systemCtx('job'), societyId) as Ctx;

async function flagOn(societyId: number): Promise<boolean> {
  return flags.isFlagOn(FLAG_UPI_AUTOPAY, { societyId });
}

/** Ids of the invoices that a still waiting order of this mandate already covers. */
async function reservedInvoiceIds(mandateId: number, t?: Transaction): Promise<Set<number>> {
  const orders = await PaymentOrder.findAll({
    where: {
      mandateId,
      sourceType: 'AUTOPAY',
      status: { [Op.in]: ['CREATED', 'ATTEMPTED'] as OrderStatus[] },
    },
    attributes: ['items'],
    transaction: t,
  });
  const ids = new Set<number>();
  for (const o of orders)
    for (const i of o.items) if (i.itemType === 'INVOICE' && i.itemId) ids.add(i.itemId);
  return ids;
}

// ------------------------------------------------------------------ results of earlier debits (BR-12-49)
/**
 * Books the outcome of debits whose order reached a final state after the mandate's `lastDebitAt`: PAID is SUCCESS (failures reset),
 * FAILED or EXPIRED is a failed debit; the second failure in a row pauses the mandate and tells the payer.
 */
export async function syncDebitResults(societyId: number): Promise<number> {
  const mandates = await AutopayMandate.findAll({
    where: { societyId, status: { [Op.in]: ['ACTIVE', 'PAUSED'] } },
  });
  let changed = 0;
  for (const m of mandates) {
    const orders = await PaymentOrder.findAll({
      where: {
        mandateId: n(m.id),
        sourceType: 'AUTOPAY',
        status: { [Op.in]: ['PAID', 'FAILED', 'EXPIRED'] as OrderStatus[] },
        gatewayOrderId: { [Op.ne]: null },
        ...(m.lastDebitAt ? { updatedAt: { [Op.gt]: m.lastDebitAt } } : {}),
      },
      order: [['updatedAt', 'ASC']],
    });
    for (const o of orders) {
      await sequelize.transaction(async t => {
        const row = await AutopayMandate.findByPk(n(m.id), { transaction: t, lock: t.LOCK.UPDATE });
        if (!row) return;
        if (row.lastDebitAt && new Date(o.updatedAt) <= new Date(row.lastDebitAt)) return;
        const at = o.status === 'PAID' ? (o.paidAt ?? now()) : o.updatedAt;
        if (o.status === 'PAID') {
          await row.update(
            {
              consecutiveFailures: 0,
              lastDebitStatus: 'SUCCESS',
              lastDebitAt: at,
              version: n(row.version) + 1,
            },
            { transaction: t },
          );
        } else {
          await recordFailure(row, at, t);
        }
        changed += 1;
      });
    }
  }
  return changed;
}

async function recordFailure(m: AutopayMandate, at: Date, t: Transaction): Promise<void> {
  const failures = n(m.consecutiveFailures) + 1;
  const pause = failures >= 2 && m.status === 'ACTIVE';
  const before = { status: m.status, consecutiveFailures: n(m.consecutiveFailures) };
  await m.update(
    {
      consecutiveFailures: failures,
      lastDebitStatus: 'FAILED',
      lastDebitAt: at,
      ...(pause ? { status: 'PAUSED' as const, pausedAt: now() } : {}),
      version: n(m.version) + 1,
    },
    { transaction: t },
  );
  notifyPayer(t, NOTIFY.mandateDebitFailed, m, { paused: pause, failures });
  if (pause)
    await audit(
      sysFor(n(m.societyId)),
      mandateAudit(AUDIT.mandatePaused, m, before, 'Two failed debits in a row'),
      t,
    );
}

// ------------------------------------------------------------------ schedule (BR-12-48)
export interface ScheduleResult {
  expired: number;
  orders: number;
  skipped: number;
}

export async function runAutopaySchedule(societyId: number): Promise<ScheduleResult> {
  const res: ScheduleResult = { expired: 0, orders: 0, skipped: 0 };
  const today = await societyToday(societyId);
  // 1. mandates past their end date
  const ending = await AutopayMandate.findAll({
    where: { societyId, status: { [Op.in]: ['ACTIVE', 'PAUSED'] }, endDate: { [Op.lt]: today } },
  });
  for (const m of ending)
    await sequelize.transaction(async t => {
      const row = await AutopayMandate.findByPk(n(m.id), { transaction: t, lock: t.LOCK.UPDATE });
      if (!row || !['ACTIVE', 'PAUSED'].includes(row.status)) return;
      await row.update(
        { status: 'EXPIRED', endedAt: now(), endReason: 'END_DATE', version: n(row.version) + 1 },
        { transaction: t },
      );
      await audit(
        sysFor(societyId),
        mandateAudit(AUDIT.mandateCancelled, row, { status: m.status }, 'End date passed'),
        t,
      );
      res.expired += 1;
    });
  if (!(await flagOn(societyId))) return res;
  await syncDebitResults(societyId);
  // 2. orders for the debits 1 to 5 days ahead
  const active = await AutopayMandate.findAll({
    where: { societyId, status: 'ACTIVE', startDate: { [Op.lte]: addDaysYmd(today, WINDOW_DAYS) } },
    order: [['id', 'ASC']],
  });
  for (const m of active) {
    try {
      const r = await scheduleOne(m, today);
      if (r === 'ORDER') res.orders += 1;
      else if (r === 'SKIPPED') res.skipped += 1;
    } catch (err) {
      logger.error({ err, mandateId: n(m.id) }, 'autopay schedule failed for a mandate');
    }
  }
  return res;
}

async function scheduleOne(m: AutopayMandate, today: string): Promise<'ORDER' | 'SKIPPED' | 'NONE'> {
  const societyId = n(m.societyId);
  const reserved = await reservedInvoiceIds(n(m.id));
  const open = (await invoices.listOpen(societyId, n(m.unitId), { payerUserId: n(m.payerUserId) })).filter(
    i => !i.isDisputed && i.outstandingPaise > 0 && !reserved.has(i.id),
  );
  const first = open[0];
  if (!first) return 'NONE';
  const tomorrow = addDaysYmd(today, 1);
  let debitOn = addDaysYmd(first.dueDate, -m.debitDaysBeforeDue);
  if (debitOn < tomorrow) debitOn = tomorrow;
  if (debitOn < m.startDate) debitOn = m.startDate;
  if (debitOn > addDaysYmd(today, WINDOW_DAYS) || debitOn > m.endDate) return 'NONE';
  const due = open.filter(i => i.dueDate <= addDaysYmd(debitOn, WINDOW_DAYS));
  const total = due.reduce((a, i) => a + i.outstandingPaise, 0);
  const dedupeKey = `autopay:${n(m.id)}:${debitOn}`;
  const exists = await PaymentOrder.findOne({ where: { societyId, dedupeKey }, attributes: ['id'] });
  if (exists) return 'NONE';

  if (total > n(m.maxAmountPaise)) {
    logger.warn(
      { mandateId: n(m.id), total, cap: n(m.maxAmountPaise), code: 'MANDATE_LIMIT_EXCEEDED' },
      'autopay debit skipped',
    );
    const recent =
      m.lastDebitStatus === 'SKIPPED' &&
      m.lastDebitAt &&
      now().getTime() - new Date(m.lastDebitAt).getTime() < SKIP_NOTICE_EVERY_DAYS * DAY_MS;
    if (recent) return 'SKIPPED';
    await sequelize.transaction(async t => {
      const row = await AutopayMandate.findByPk(n(m.id), { transaction: t, lock: t.LOCK.UPDATE });
      if (!row) return;
      await row.update(
        { lastDebitStatus: 'SKIPPED', lastDebitAt: now(), version: n(row.version) + 1 },
        { transaction: t },
      );
      notifyPayer(t, NOTIFY.mandateSkipped, row, {
        amountPaise: total,
        amount: formatRupees(total),
        capPaise: n(m.maxAmountPaise),
        debitOn,
      });
    });
    return 'SKIPPED';
  }

  await sequelize.transaction(async t => {
    const row = await AutopayMandate.findByPk(n(m.id), { transaction: t, lock: t.LOCK.UPDATE });
    if (!row || row.status !== 'ACTIVE') return;
    const at = now();
    const order = await PaymentOrder.create(
      {
        societyId,
        unitId: n(m.unitId),
        payerUserId: null,
        sourceType: 'AUTOPAY',
        sourceModule: null,
        refType: null,
        refId: null,
        dedupeKey,
        allocationMode: 'SELECTED',
        items: due.map(i => ({
          itemType: 'INVOICE' as const,
          itemId: i.id,
          label: i.invoiceNo,
          amountPaise: i.outstandingPaise,
        })),
        payListVersion: null,
        basePaise: total,
        convenienceFeePaise: 0,
        convenienceFeeGstPaise: 0,
        grossAmountPaise: total,
        feeMode: 'SOCIETY_ABSORBS',
        feeRateBp: 0,
        methodHint: null,
        gatewayAccountId: n(m.gatewayAccountId),
        gatewayOrderId: null,
        status: 'CREATED',
        expiresAt: new Date(new Date(`${debitOn}T00:00:00+05:30`).getTime() + 3 * DAY_MS),
        paidAt: null,
        cancelledAt: null,
        cancelReason: null,
        failureReason: null,
        attemptCount: 0,
        lastCheckedAt: null,
        nextCheckAt: null,
        linkTokenHash: null,
        linkShortCode: null,
        linkOpenedCount: 0,
        mandateId: n(m.id),
        debitOn,
        preDebitNotifiedAt: at,
        returnUrl: null,
        createdBy: null,
        updatedBy: null,
        version: 1,
      },
      { transaction: t },
    );
    notifyPayer(t, NOTIFY.mandatePredebit, row, {
      orderId: n(order.id),
      amountPaise: total,
      amount: formatRupees(total),
      debitOn,
      capPaise: n(m.maxAmountPaise),
      invoiceCount: due.length,
    });
  });
  return 'ORDER';
}

// ------------------------------------------------------------------ execute
export interface ExecuteResult {
  charged: number;
  failed: number;
  cancelled: number;
}

/** Charges the orders of today (or overdue) whose notice is at least 24 hours old. One charge per order. */
export async function runAutopayExecute(societyId: number): Promise<ExecuteResult> {
  const res: ExecuteResult = { charged: 0, failed: 0, cancelled: 0 };
  if (!(await flagOn(societyId))) return res;
  const today = await societyToday(societyId);
  const due = await PaymentOrder.findAll({
    where: {
      societyId,
      sourceType: 'AUTOPAY',
      status: 'CREATED',
      gatewayOrderId: null,
      debitOn: { [Op.lte]: today },
      preDebitNotifiedAt: { [Op.lte]: addHours(now(), -NOTICE_HOURS) },
    },
    order: [['id', 'ASC']],
    attributes: ['id'],
  });
  for (const o of due) {
    try {
      const r = await chargeOne(n(o.id));
      res[r] += 1;
    } catch (err) {
      logger.error({ err, orderId: n(o.id) }, 'autopay charge failed');
    }
  }
  return res;
}

async function chargeOne(orderId: number): Promise<'charged' | 'failed' | 'cancelled'> {
  return sequelize.transaction(async t => {
    const order = await PaymentOrder.findOne({ where: { id: orderId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!order || order.status !== 'CREATED' || order.gatewayOrderId || !order.mandateId) return 'cancelled';
    const m = await AutopayMandate.findByPk(n(order.mandateId), { transaction: t, lock: t.LOCK.UPDATE });
    const cancel = async (why: string) => {
      await order.update(
        { status: 'CANCELLED', cancelledAt: now(), cancelReason: why, version: n(order.version) + 1 },
        { transaction: t },
      );
      return 'cancelled' as const;
    };
    if (!m || m.status !== 'ACTIVE' || !m.gatewayMandateId) return cancel('Mandate is not active');
    const today = await societyToday(n(order.societyId));
    if (m.startDate > today || m.endDate < today) return cancel('Outside the mandate dates');
    // the amount told in the notice must still be due (BR-12-48); otherwise the next schedule run makes a new notice
    for (const i of order.items) {
      const inv = i.itemId ? await Invoice.findByPk(i.itemId, { transaction: t }) : null;
      if (!inv || inv.status === 'CANCELLED' || inv.isDisputed || n(inv.outstandingPaise) < i.amountPaise)
        return cancel('The bills changed after the notice');
    }
    const account = await paymentsPorts().gateways.getAccount(n(m.gatewayAccountId));
    const at = now();
    try {
      if (!account) throw new Error('no gateway account');
      const r = await paymentsPorts()
        .gateways.clientFor(account)
        .chargeMandate({
          mandateId: m.gatewayMandateId,
          amountPaise: n(order.grossAmountPaise),
          receipt: `PO-${order.id}`,
        });
      await order.update(
        {
          gatewayOrderId: r.orderId,
          lastCheckedAt: at,
          nextCheckAt: new Date(at.getTime() + 3 * 60_000),
          version: n(order.version) + 1,
        },
        { transaction: t },
      );
      await m.update({ lastDebitAt: at, version: n(m.version) + 1 }, { transaction: t });
      return 'charged';
    } catch (err) {
      logger.error({ err, orderId }, 'gateway chargeMandate failed');
      await order.update(
        { status: 'FAILED', failureReason: 'The debit could not be started', version: n(order.version) + 1 },
        { transaction: t },
      );
      await recordFailure(m, at, t);
      return 'failed';
    }
  });
}

// ------------------------------------------------------------------ authorisation timeout (6.5)
export async function runMandateAuthTimeout(): Promise<number> {
  const cutoff = addHours(now(), -48);
  const rows = await AutopayMandate.findAll({
    where: { status: 'PENDING_AUTH', createdAt: { [Op.lte]: cutoff } },
    attributes: ['id', 'societyId'],
  });
  let count = 0;
  for (const r of rows)
    await sequelize.transaction(async t => {
      const m = await AutopayMandate.findByPk(n(r.id), { transaction: t, lock: t.LOCK.UPDATE });
      if (!m || m.status !== 'PENDING_AUTH') return;
      const gatewayMandateId = m.gatewayMandateId;
      const accountId = n(m.gatewayAccountId);
      await m.update(
        { status: 'FAILED', endedAt: now(), endReason: 'AUTH_TIMEOUT', version: n(m.version) + 1 },
        { transaction: t },
      );
      await audit(
        sysFor(n(m.societyId)),
        mandateAudit(AUDIT.mandateFailed, m, { status: 'PENDING_AUTH' }, 'No authorisation in 48 hours'),
        t,
      );
      if (gatewayMandateId)
        t.afterCommit(() => {
          void (async () => {
            try {
              const account = await paymentsPorts().gateways.getAccount(accountId);
              if (account) await paymentsPorts().gateways.clientFor(account).cancelMandate(gatewayMandateId);
            } catch (err) {
              logger.error({ err }, 'cancel of an unauthorised mandate failed');
            }
          })();
        });
      count += 1;
    });
  return count;
}

// ------------------------------------------------------------------ registration
/** Societies that have a mandate in a live state and may run `payments` jobs. */
async function societiesWithMandates(): Promise<number[]> {
  const rows = await AutopayMandate.findAll({
    where: { status: { [Op.in]: ['ACTIVE', 'PAUSED', 'PENDING_AUTH'] } },
    attributes: ['societyId'],
    group: ['societyId'],
  });
  const ids = rows.map(r => n(r.societyId));
  if (!ids.length) return [];
  const societies = await Society.findAll({ where: { id: { [Op.in]: ids } }, attributes: ['id', 'status'] });
  return societies.filter(s => isJobAllowed(s.status, 'payments')).map(s => n(s.id));
}

export function registerAutopayJobs(): void {
  registerProcessor(PAYMENTS_QUEUE, JOBS.autopaySchedule, async data => {
    const ids = data.societyId ? [Number(data.societyId)] : await societiesWithMandates();
    for (const id of ids)
      try {
        await runAutopaySchedule(id);
      } catch (err) {
        logger.error({ err, societyId: id }, 'payments:autopay-schedule failed for a society');
      }
  });
  registerRepeatable(PAYMENTS_QUEUE, JOBS.autopaySchedule, { dailyAtIst: '06:00' });
  registerProcessor(PAYMENTS_QUEUE, JOBS.autopayExecute, async data => {
    const ids = data.societyId ? [Number(data.societyId)] : await societiesWithMandates();
    for (const id of ids)
      try {
        await runAutopayExecute(id);
      } catch (err) {
        logger.error({ err, societyId: id }, 'payments:autopay-execute failed for a society');
      }
  });
  registerRepeatable(PAYMENTS_QUEUE, JOBS.autopayExecute, { dailyAtIst: '07:00' });
  registerProcessor(PAYMENTS_QUEUE, JOBS.mandateAuthTimeout, async () => {
    await runMandateAuthTimeout();
  });
  registerRepeatable(PAYMENTS_QUEUE, JOBS.mandateAuthTimeout, { hourlyAtMinute: 20 });
}
