import { Op, QueryTypes } from 'sequelize';
import { Invoice, Society, sequelize } from '../../models';
import { addHours, istDate, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { enqueue } from '../../lib/queue';
import { systemCtx, type Ctx } from '../../types/context';
import { audit } from '../../utils/audit';
import { NotFoundError } from '../../utils/errors';
import { isJobAllowed } from '../societies/societies.guard';
import { addDaysYmd } from './billing.calc.period';
import {
  AUDIT,
  BILLING_QUEUE,
  JOBS,
  REMINDER_DUE_SOON_DAYS,
  REMINDER_MIN_GAP_HOURS,
  REMINDER_OVERDUE_FIRST_OFFSET_DAYS,
  REMINDER_OVERDUE_INTERVAL_DAYS,
  REMINDER_OVERDUE_MAX,
} from './billing.constants';
import { billRecipients, invoicePeriodLabel } from './billing.dues.shared';
import { billingPorts } from './billing.ports';
import { conflict, invalidState, societyToday } from './billing.setup.shared';
import './billing.reminders.templates';

/**
 * Reminders (F21, sections 8.18 and BR-11-63): the automatic ones of `billing:due-reminders` (3 days before the due date; on due
 * date + 1 and every 7 days after, at most 4 times; never for disputed invoices) and the manual ones (one invoice, or all
 * overdue invoices through `billing:send-reminders`; at most one per invoice per 24 hours). Messages go through the
 * notifications port (module 16 placeholder); the invoice keeps `reminderCount` and `lastReminderAt` (BR-11-6 allows both).
 */
const ENTITY = 'invoice';
const OPEN_STATUSES = ['ISSUED', 'PARTIALLY_PAID'];

const notifyData = (inv: Invoice) => ({
  invoiceNo: inv.invoiceNo,
  amountPaise: Number(inv.outstandingPaise),
  dueDate: inv.dueDate,
  periodLabel: invoicePeriodLabel(inv),
});

type Kind = 'billing.invoice_reminder' | 'billing.invoice_due_soon' | 'billing.invoice_overdue';

/**
 * Records one reminder under the invoice lock and sends it after commit. Returns the send time, or null when the invoice is no
 * longer open or was reminded too recently (`minGapHours`; the automatic jobs use the same-day check instead).
 */
async function sendOne(
  societyId: number,
  invoiceId: number,
  kind: Kind,
  opts: {
    minGapHours?: number;
    notOnDate?: string;
    ctx?: Ctx;
    audit?: boolean;
    throwOnRefusal?: boolean;
  } = {},
): Promise<Date | null> {
  const at = now();
  const result = await sequelize.transaction(async t => {
    const inv = await Invoice.findOne({
      where: { id: invoiceId, societyId },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!inv) throw new NotFoundError('INVOICE_NOT_FOUND', 'Invoice not found');
    if (!OPEN_STATUSES.includes(inv.status) || Number(inv.outstandingPaise) <= 0) {
      if (opts.throwOnRefusal) throw invalidState('Only an open invoice can be reminded');
      return null;
    }
    if (inv.lastReminderAt) {
      const tooSoon =
        opts.minGapHours !== undefined &&
        inv.lastReminderAt.getTime() > addHours(at, -opts.minGapHours).getTime();
      const sameDay = opts.notOnDate !== undefined && istDate(inv.lastReminderAt) === opts.notOnDate;
      if (tooSoon || sameDay) {
        if (opts.throwOnRefusal && tooSoon)
          throw conflict('REMINDER_TOO_SOON', 'This bill was reminded in the last 24 hours');
        return null;
      }
    }
    await inv.update(
      { reminderCount: Math.min(255, Number(inv.reminderCount) + 1), lastReminderAt: at },
      { transaction: t },
    );
    if (opts.audit && opts.ctx)
      await audit(
        opts.ctx,
        {
          action: AUDIT.invoiceReminded,
          entityType: ENTITY,
          entityId: inv.id!,
          entityLabel: inv.invoiceNo,
          societyId,
          after: { template: kind, reminderCount: Number(inv.reminderCount) },
        },
        t,
      );
    return inv;
  });
  if (!result) return null;
  const recipients = await billRecipients(societyId, result, istDate(at));
  if (recipients.length) await billingPorts().notifications.send(kind, recipients, notifyData(result));
  return at;
}

/** `POST /invoices/:id/remind`: `409 INVALID_STATE` unless open, `409 REMINDER_TOO_SOON` within 24 hours. */
export async function remindInvoice(
  ctx: Ctx,
  societyId: number,
  invoiceId: number,
): Promise<{ sentAt: string }> {
  const sentAt = await sendOne(societyId, invoiceId, 'billing.invoice_reminder', {
    minGapHours: REMINDER_MIN_GAP_HOURS,
    ctx,
    audit: true,
    throwOnRefusal: true,
  });
  return { sentAt: sentAt!.toISOString() };
}

/** Overdue open invoices of the society that a bulk reminder would reach (not disputed, not reminded in the last 24 hours). */
async function overdueTargets(
  societyId: number,
  today: string,
  buildingId?: number,
): Promise<{ id: number; unitId: number }[]> {
  const since = addHours(now(), -REMINDER_MIN_GAP_HOURS);
  return sequelize.query<{ id: number; unitId: number }>(
    `SELECT i.id AS id, i.unitId AS unitId FROM invoices i JOIN units u ON u.id = i.unitId
      WHERE i.societyId = :societyId AND i.status IN ('ISSUED', 'PARTIALLY_PAID') AND i.outstandingPaise > 0
        AND i.dueDate < :today AND i.isDisputed = 0
        AND (i.lastReminderAt IS NULL OR i.lastReminderAt <= :since)
        ${buildingId ? 'AND u.buildingId = :buildingId' : ''}
      ORDER BY i.id`,
    { replacements: { societyId, today, since, buildingId: buildingId ?? null }, type: QueryTypes.SELECT },
  );
}

/** `POST /billing/reminders` (`202`): counts what will be sent and enqueues `billing:send-reminders`. */
export async function requestBulkReminders(
  ctx: Ctx,
  societyId: number,
  input: { buildingId?: number },
): Promise<{ flats: number; invoices: number }> {
  const today = await societyToday(societyId);
  const targets = await overdueTargets(societyId, today, input.buildingId);
  const r = { flats: new Set(targets.map(x => x.unitId)).size, invoices: targets.length };
  await enqueue(BILLING_QUEUE, JOBS.sendReminders, {
    societyId,
    buildingId: input.buildingId ?? null,
    requestedBy: ctx.user?.id ?? null,
    requestId: ctx.requestId,
  });
  return r;
}

/** The job `billing:send-reminders`: sends to every target again checked under its own lock; audits `billing.reminders.bulk_sent`. */
export async function sendBulkReminders(
  societyId: number,
  buildingId: number | null,
  requestedBy: number | null,
): Promise<{ flats: number; invoices: number }> {
  const society = await Society.findByPk(societyId, { attributes: ['id', 'status'] });
  if (!society || !isJobAllowed(society.status, 'normal')) return { flats: 0, invoices: 0 };
  const today = await societyToday(societyId);
  const targets = await overdueTargets(societyId, today, buildingId ?? undefined);
  const units = new Set<number>();
  let sent = 0;
  for (const x of targets)
    try {
      if (
        await sendOne(societyId, x.id, 'billing.invoice_reminder', { minGapHours: REMINDER_MIN_GAP_HOURS })
      ) {
        sent += 1;
        units.add(x.unitId);
      }
    } catch (err) {
      logger.error({ err, invoiceId: x.id }, 'billing bulk reminder failed for an invoice');
    }
  const r = { flats: units.size, invoices: sent };
  await audit(systemCtx('billing-send-reminders'), {
    action: AUDIT.remindersBulkSent,
    entityType: 'billing_reminders',
    entityId: societyId,
    societyId,
    after: { ...r, scope: 'OVERDUE', buildingId, requestedBy },
  });
  return r;
}

/** Day offsets (days after the due date) on which an overdue reminder goes out: 1, 8, 15, 22 (BR-11-63). */
export const OVERDUE_REMINDER_OFFSETS: readonly number[] = Array.from(
  { length: REMINDER_OVERDUE_MAX },
  (_, i) => REMINDER_OVERDUE_FIRST_OFFSET_DAYS + i * REMINDER_OVERDUE_INTERVAL_DAYS,
);

/** `billing:due-reminders` for one society at `today` (society-local date). Idempotent per invoice and day. */
export async function runDueReminders(
  societyId: number,
  today?: string,
): Promise<{ dueSoon: number; overdue: number }> {
  const day = today ?? (await societyToday(societyId));
  const dueSoonDate = addDaysYmd(day, REMINDER_DUE_SOON_DAYS);
  const overdueDates = OVERDUE_REMINDER_OFFSETS.map(o => addDaysYmd(day, -o));
  const open = {
    societyId,
    status: { [Op.in]: OPEN_STATUSES },
    outstandingPaise: { [Op.gt]: 0 },
    isDisputed: false,
  };
  const dueSoon = await Invoice.findAll({
    where: { ...open, dueDate: dueSoonDate },
    attributes: ['id'],
    order: [['id', 'ASC']],
  });
  const overdue = await Invoice.findAll({
    where: { ...open, dueDate: { [Op.in]: overdueDates } },
    attributes: ['id', 'dueDate'],
    order: [['id', 'ASC']],
  });
  const counts = { dueSoon: 0, overdue: 0 };
  for (const [list, kind, key] of [
    [dueSoon, 'billing.invoice_due_soon', 'dueSoon'],
    [overdue, 'billing.invoice_overdue', 'overdue'],
  ] as const)
    for (const inv of list)
      try {
        if (await sendOne(societyId, inv.id!, kind, { notOnDate: day })) counts[key] += 1;
      } catch (err) {
        logger.error({ err, invoiceId: inv.id }, 'billing automatic reminder failed for an invoice');
      }
  return counts;
}

/** The job: every society whose status allows ordinary jobs (module 05 BR-05-14). */
export async function runDueRemindersAll(): Promise<void> {
  const societies = await Society.findAll({ attributes: ['id', 'status'], order: [['id', 'ASC']] });
  for (const s of societies) {
    if (!isJobAllowed(s.status, 'normal')) continue;
    try {
      await runDueReminders(s.id!);
    } catch (err) {
      logger.error({ err, societyId: s.id }, 'billing:due-reminders failed for a society');
    }
  }
}
