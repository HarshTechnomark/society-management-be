/**
 * Dunning engine (5.5, BR-06-36 to BR-06-43; job `platform-billing:dunning`, daily 09:00 IST). One transaction per open
 * invoice: society lock, invoice lock, then the steps due today. Every automatic step writes one `dunning_events` row
 * with a unique `dedupeKey`, so a rerun (or a second worker) does nothing twice. Society transitions go through module 05
 * (`onInvoiceOverdue`, `onGraceExpired`), which makes calls that do not apply no-ops.
 */
import { Op, UniqueConstraintError, type Transaction } from 'sequelize';
import { DunningEvent, PlatformInvoice, PlatformPayment, Society, sequelize } from '../../models';
import type { DunningSkipReason } from '../../models/dunning-event.model';
import { istDate } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { notifyAfterCommit } from '../societies/societies.notify';
import { groups } from '../societies/societies.notify';
import { societyLifecycle } from '../societies/societies.public';
import { addDaysYmd, OPEN_STATUSES } from './pricing';
import { billingSettings, type BillingSettings } from './platform-billing.settings';
import { getOutstanding, lockSociety, settleInvoice, todayIst } from './platform-billing.settlement';
import { notifySubscriptionViewers, payersOf } from './platform-billing.notify';
import { SYSTEM_CTX, num } from './platform-billing.shared';

export interface DunningResult {
  invoices: number;
  reminders: number;
  superseded: number;
  overdue: number;
  pastDue: number;
  suspended: number;
  skipped: number;
  failed: number;
}

async function writeEvent(
  ctx: Ctx,
  o: {
    societyId: number;
    invoiceId: number;
    step: 'REMINDER' | 'PAST_DUE' | 'SUSPENDED';
    offsetDays?: number | null;
    scheduledFor: string;
    dedupeKey: string;
    skipReason?: DunningSkipReason;
    templateKey?: string | null;
    notes?: string | null;
  },
  t: Transaction,
): Promise<boolean> {
  try {
    await sequelize.transaction({ transaction: t }, sp =>
      DunningEvent.create(
        {
          societyId: o.societyId,
          invoiceId: o.invoiceId,
          step: o.step,
          offsetDays: o.offsetDays ?? null,
          scheduledFor: o.scheduledFor,
          dedupeKey: o.dedupeKey,
          outcome: o.skipReason ? 'SKIPPED' : 'DONE',
          skipReason: o.skipReason ?? null,
          templateKey: o.templateKey ?? null,
          notes: o.notes ?? null,
          createdBy: null,
        } as never,
        { transaction: sp },
      ),
    );
    return true;
  } catch (err) {
    if (err instanceof UniqueConstraintError) return false;
    throw err;
  }
}

/** Reminder offsets already written for the invoice (done or skipped). */
async function doneOffsets(invoiceId: number, t: Transaction): Promise<Set<number>> {
  const rows = await DunningEvent.findAll({
    where: { invoiceId, step: 'REMINDER' },
    attributes: ['offsetDays'],
    transaction: t,
  });
  return new Set(rows.map(r => r.offsetDays).filter((x): x is number => x !== null));
}

async function stepsOfInvoice(
  inv: PlatformInvoice,
  society: Society,
  s: BillingSettings,
  today: string,
  r: DunningResult,
  t: Transaction,
): Promise<void> {
  const ctx = SYSTEM_CTX('dunning');
  const due = inv.dueDate!;
  const min = Math.max(1, s['billing.dunningMinDuePaise']);
  const amountDue = num(inv.amountDuePaise);

  // ---- reminders (BR-06-36, BR-06-37): only the latest missed offset is sent
  const offsets = s['billing.reminderOffsetsDays'];
  const have = await doneOffsets(inv.id!, t);
  const pending = offsets.filter(o => addDaysYmd(due, o) <= today && !have.has(o));
  if (pending.length) {
    const latest = pending[pending.length - 1]!;
    for (const o of pending.slice(0, -1)) {
      const ok = await writeEvent(
        ctx,
        {
          societyId: inv.societyId,
          invoiceId: inv.id!,
          step: 'REMINDER',
          offsetDays: o,
          scheduledFor: addDaysYmd(due, o),
          dedupeKey: `REMINDER:${inv.id}:${o}`,
          skipReason: 'SUPERSEDED',
        },
        t,
      );
      if (ok) r.superseded += 1;
    }
    const warning = latest === offsets[offsets.length - 1];
    const template = warning ? 'platform_billing.suspension_warning' : 'platform_billing.payment_reminder';
    const ok = await writeEvent(
      ctx,
      {
        societyId: inv.societyId,
        invoiceId: inv.id!,
        step: 'REMINDER',
        offsetDays: latest,
        scheduledFor: addDaysYmd(due, latest),
        dedupeKey: `REMINDER:${inv.id}:${latest}`,
        templateKey: template,
      },
      t,
    );
    if (ok) {
      r.reminders += 1;
      await audit(
        ctx,
        {
          action: 'platform_billing.dunning.reminder_sent',
          entityType: 'platform_invoice',
          entityId: inv.id!,
          entityLabel: inv.invoiceNo,
          societyId: inv.societyId,
          after: { offsetDays: latest, template },
        },
        t,
      );
      notifyAfterCommit(t, template, () => payersOf(inv.societyId), {
        invoiceNo: inv.invoiceNo,
        amountDuePaise: amountDue,
        dueDate: due,
        suspendOn: inv.suspendOn,
        societyName: society.name,
        offsetDays: latest,
      });
    }
  }

  // ---- PAST_DUE (BR-06-36, BR-06-38): invoice OVERDUE, society PAST_DUE through module 05
  const pastDueOn = addDaysYmd(due, s['billing.pastDueAfterDays']);
  if (pastDueOn > today) return;
  if (inv.status !== 'OVERDUE') {
    await settleInvoice(ctx, inv, {}, t); // re-derives the status: dueDate < today gives OVERDUE
    r.overdue += 1;
    await audit(
      ctx,
      {
        action: 'platform_billing.invoice.overdue',
        entityType: 'platform_invoice',
        entityId: inv.id!,
        entityLabel: inv.invoiceNo,
        societyId: inv.societyId,
        before: { status: 'OPEN' },
        after: { status: inv.status },
      },
      t,
    );
  }
  if (amountDue < min) {
    const ok = await writeEvent(
      ctx,
      {
        societyId: inv.societyId,
        invoiceId: inv.id!,
        step: 'PAST_DUE',
        scheduledFor: pastDueOn,
        dedupeKey: `PAST_DUE:${inv.id}:${pastDueOn}`,
        skipReason: 'BELOW_MINIMUM',
      },
      t,
    );
    if (ok) r.skipped += 1;
    return; // below the minimum: reminders only, no transitions (BR-06-38)
  }
  // The hook is idempotent, so a society that became ACTIVE again (TDS rejected, credit note reversed) is moved back
  // to PAST_DUE here even though the PAST_DUE event of this invoice exists already.
  const statusBefore = society.status;
  await societyLifecycle.onInvoiceOverdue(ctx, society.id!, t);
  const after = await Society.findByPk(society.id!, { attributes: ['id', 'status'], transaction: t });
  if (after && after.status !== statusBefore && after.status === 'PAST_DUE') {
    society.status = after.status;
    const ok = await writeEvent(
      ctx,
      {
        societyId: inv.societyId,
        invoiceId: inv.id!,
        step: 'PAST_DUE',
        scheduledFor: pastDueOn,
        dedupeKey: `PAST_DUE:${inv.id}:${pastDueOn}`,
      },
      t,
    );
    if (!ok)
      await DunningEvent.create(
        {
          societyId: inv.societyId,
          invoiceId: inv.id!,
          step: 'PAST_DUE',
          scheduledFor: today,
          dedupeKey: `PAST_DUE:${inv.id}:${today}`,
          outcome: 'DONE',
          notes: 'Society moved back to past due',
        } as never,
        { transaction: t },
      );
    r.pastDue += 1;
    await audit(
      ctx,
      {
        action: 'platform_billing.dunning.past_due',
        entityType: 'society',
        entityId: society.id!,
        entityLabel: society.name,
        societyId: society.id!,
        before: { status: statusBefore },
        after: { status: 'PAST_DUE', invoiceId: inv.id },
      },
      t,
    );
    notifySubscriptionViewers(t, 'platform_billing.past_due', society.id!, {
      invoiceNo: inv.invoiceNo,
      amountDuePaise: amountDue,
      suspendOn: inv.suspendOn,
      societyName: society.name,
    });
  } else if (
    !(await DunningEvent.findOne({ where: { dedupeKey: `PAST_DUE:${inv.id}:${pastDueOn}` }, transaction: t }))
  ) {
    // the society was not ACTIVE (already past due through another invoice, trial, manual suspension): note it once
    const ok = await writeEvent(
      ctx,
      {
        societyId: inv.societyId,
        invoiceId: inv.id!,
        step: 'PAST_DUE',
        scheduledFor: pastDueOn,
        dedupeKey: `PAST_DUE:${inv.id}:${pastDueOn}`,
        ...(after?.status === 'PAST_DUE' ? {} : { skipReason: 'NOT_APPLICABLE' as const }),
      },
      t,
    );
    if (ok) r.skipped += after?.status === 'PAST_DUE' ? 0 : 1;
  }

  // ---- SUSPENDED (BR-06-36, BR-06-39) on `suspendOn`
  const suspendOn = inv.suspendOn;
  if (!suspendOn || suspendOn > today) return;
  const current = (await Society.findByPk(society.id!, { transaction: t }))!;
  if (current.status === 'SUSPENDED') return; // already suspended: nothing left to do for this invoice
  const skip = async (reason: DunningSkipReason) => {
    const ok = await writeEvent(
      ctx,
      {
        societyId: inv.societyId,
        invoiceId: inv.id!,
        step: 'SUSPENDED',
        scheduledFor: suspendOn,
        dedupeKey: `SUSPENDED:${inv.id}:skip:${today}`,
        skipReason: reason,
      },
      t,
    );
    if (ok) r.skipped += 1;
  };
  if (
    await DunningEvent.findOne({ where: { dedupeKey: `SUSPENDED:${inv.id}:${suspendOn}` }, transaction: t })
  )
    return; // suspended earlier by this step and reactivated since: a deliberate reactivation is not undone
  if (amountDue < min) return skip('BELOW_MINIMUM');
  if (current.status !== 'PAST_DUE') return skip('NOT_APPLICABLE');
  if (statusBefore !== 'PAST_DUE') return; // it became past due in this run: the suspension waits for the next run
  if (current.suspensionHoldUntil && istDate(current.suspensionHoldUntil) >= today)
    return skip('HOLD_ACTIVE');
  const { overduePaise } = await getOutstanding(current.id!, t);
  const pendingManual = num(
    await PlatformPayment.sum('amountPaise', {
      where: { societyId: current.id!, kind: 'PAYMENT', status: 'PENDING_APPROVAL' },
      transaction: t,
    }),
  );
  if (pendingManual > 0 && pendingManual >= overduePaise) return skip('PENDING_MANUAL_PAYMENT');
  await societyLifecycle.onGraceExpired(ctx, current.id!, t);
  const done = await Society.findByPk(current.id!, { attributes: ['id', 'status'], transaction: t });
  if (done?.status !== 'SUSPENDED') return skip('NOT_APPLICABLE');
  await writeEvent(
    ctx,
    {
      societyId: inv.societyId,
      invoiceId: inv.id!,
      step: 'SUSPENDED',
      scheduledFor: suspendOn,
      dedupeKey: `SUSPENDED:${inv.id}:${suspendOn}`,
      templateKey: 'platform_billing.suspended',
    },
    t,
  );
  r.suspended += 1;
  await audit(
    ctx,
    {
      action: 'platform_billing.dunning.suspended',
      entityType: 'society',
      entityId: current.id!,
      entityLabel: current.name,
      societyId: current.id!,
      before: { status: 'PAST_DUE' },
      after: { status: 'SUSPENDED', invoiceId: inv.id, suspendOn },
    },
    t,
  );
  notifyAfterCommit(t, 'platform_billing.suspended', () => groups.committee(current.id!), {
    invoiceNo: inv.invoiceNo,
    amountDuePaise: amountDue,
    societyName: current.name,
  });
}

/**
 * Runs every step due on `today` (IST date) for every open invoice. CLOSED societies get nothing (BR-06-43). A failing
 * invoice is logged and counted; it never stops the others and is retried by the next run.
 */
export async function runDunning(today: string = todayIst()): Promise<DunningResult> {
  const r: DunningResult = {
    invoices: 0,
    reminders: 0,
    superseded: 0,
    overdue: 0,
    pastDue: 0,
    suspended: 0,
    skipped: 0,
    failed: 0,
  };
  const s = await billingSettings();
  const ids = await PlatformInvoice.findAll({
    attributes: ['id', 'societyId'],
    where: {
      documentType: 'INVOICE',
      status: OPEN_STATUSES as unknown as string[],
      amountDuePaise: { [Op.gt]: 0 },
      dueDate: { [Op.ne]: null },
    },
    order: [['id', 'ASC']],
  });
  for (const row of ids) {
    try {
      await sequelize.transaction(async t => {
        const society = await lockSociety(row.societyId, t);
        const inv = await PlatformInvoice.findByPk(row.id!, { transaction: t, lock: t.LOCK.UPDATE });
        if (!inv || !OPEN_STATUSES.includes(inv.status) || num(inv.amountDuePaise) <= 0) return;
        if (society.status === 'CLOSED') return;
        r.invoices += 1;
        await stepsOfInvoice(inv, society, s, today, r, t);
      });
    } catch (err) {
      r.failed += 1;
      logger.error({ err, invoiceId: row.id }, 'platform dunning failed for an invoice');
    }
  }
  logger.info({ ...r, today }, 'platform-billing:dunning done');
  return r;
}
