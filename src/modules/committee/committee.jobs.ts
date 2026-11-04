import { Op } from 'sequelize';
import { CommitteeTerm, Society, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { registerProcessor, registerQueue, registerRepeatable } from '../../lib/queue';
import { systemCtx, type Ctx } from '../../types/context';
import { audit } from '../../utils/audit';
import { members } from '../access-control/access-control.public';
import { residents } from '../residents/residents.public';
import { isJobAllowed } from '../societies/societies.guard';
import { entitlements } from '../subscriptions/subscriptions.public';
import { settings } from '../society-setup/society-setup.public';
import {
  AUDIT,
  COMMITTEE_QUEUE,
  DESIGNATION_LABEL,
  ENTITY,
  FEATURE,
  HANDOVER_REMINDER_DAYS,
  JOBS,
} from './committee.constants';
import { officerIds, sendNow } from './committee.notify';
import {
  daysBetween,
  handoverReminderDay,
  reminderThreshold,
  sameFlags,
  seatedSeats,
  seatFlags,
  type SeatFlag,
} from './committee.planner';
import { findCurrent } from './committee.queries';
import type { SeatJson } from './committee.schemas';
import { lockTerm, seatsForAudit } from './committee.service';
import { committeeSettings, emitChanged, societyToday } from './committee.shared';

/**
 * Jobs of queue `members` (section 9.1): term reminders (09:00 society time), term auto-expiry (00:15) and seat reconciliation
 * (02:00). Per-society work runs for every society whose status allows ordinary jobs (BR-05-14) and one society's failure is
 * logged without stopping the others. The repeatable schedule is `dailyAtIst` like module 09 (every society is IST for now).
 * Each step is idempotent through a guarded UPDATE or a changed-only rewrite, so a retry or a second run the same day sends and
 * writes nothing twice. Audit rows of these jobs have the actor `system`.
 */
const affected = (meta: unknown): number => Number((meta as { affectedRows?: number })?.affectedRows ?? 0);

async function societiesToRun(): Promise<number[]> {
  const rows = await Society.findAll({ attributes: ['id', 'status'], order: [['id', 'ASC']] });
  return rows.filter(s => isJobAllowed(s.status, 'normal') && s.status !== 'CLOSED').map(s => s.id!);
}

// ------------------------------------------------------------------ members:term-auto-expiry (BR-10-23)
/** ACTIVE terms past their end date become EXPIRED when the plan has `iam.committee_term_auto_expiry`. Returns the terms moved. */
export async function autoExpireFor(
  societyId: number,
  ctx: Ctx = systemCtx('term-auto-expiry'),
): Promise<number[]> {
  if (!(await entitlements.isFeatureOn(societyId, FEATURE.autoExpiry))) return [];
  const today = await societyToday(societyId);
  const due = await CommitteeTerm.findAll({
    where: { societyId, status: 'ACTIVE', endDate: { [Op.lt]: today } },
    attributes: ['id'],
  });
  const moved: number[] = [];
  for (const { id } of due)
    await sequelize.transaction(async t => {
      const [, meta] = await sequelize.query(
        `UPDATE committee_terms SET status = 'EXPIRED', expiredAt = :at, version = version + 1, updatedAt = :at
          WHERE id = :id AND societyId = :societyId AND status = 'ACTIVE' AND endDate < :today AND deletedAt IS NULL`,
        { replacements: { id, societyId, today, at: now() }, transaction: t },
      );
      if (affected(meta) !== 1) return;
      const term = await lockTerm(societyId, id!, t);
      await audit(
        ctx,
        {
          action: AUDIT.expired,
          entityType: ENTITY.term,
          entityId: term.id!,
          entityLabel: term.name,
          societyId,
          before: { status: 'ACTIVE' },
          after: { status: 'EXPIRED', endDate: term.endDate, expiredOn: today },
        },
        t,
      );
      emitChanged(t, societyId, term.id!, 'EXPIRED', 'EXPIRED');
      moved.push(term.id!);
    });
  return moved;
}

// ------------------------------------------------------------------ members:term-reminders (BR-10-24, hand-over reminders)
export interface ReminderReport {
  expiring: number | null;
  expired: boolean;
  handover: number | null;
}

/** Guarded UPDATE of a reminder column; true only for the run that changed the row, so only that run notifies. */
async function claim(
  id: number,
  column: 'lastReminderDays' | 'lastHandoverReminderDay',
  value: number,
  cmp: '>' | '<',
) {
  const [, meta] = await sequelize.query(
    `UPDATE committee_terms SET ${column} = :value
      WHERE id = :id AND deletedAt IS NULL AND (${column} IS NULL OR ${column} ${cmp} :value)`,
    { replacements: { id, value } },
  );
  return affected(meta) === 1;
}

/** One society's reminders: the smallest qualifying threshold, `term_expired` at threshold 0, and the hand-over reminders. */
export async function sendRemindersFor(societyId: number): Promise<ReminderReport> {
  const report: ReminderReport = { expiring: null, expired: false, handover: null };
  const term = await findCurrent(societyId);
  if (!term) return report;
  const today = await societyToday(societyId);
  const daysLeft = daysBetween(today, term.endDate);
  const days = [...(await settings.get(societyId, 'committee.reminderDays'))];
  const d = reminderThreshold(daysLeft, days, term.lastReminderDays);
  if (d !== null && (await claim(term.id!, 'lastReminderDays', d, '>'))) {
    const officers = await officerIds(societyId);
    if (d === 0) {
      report.expired = true;
      await sendNow(societyId, 'committee.term_expired', officers, {
        termName: term.name,
        endDate: term.endDate,
      });
    } else {
      report.expiring = d;
      await sendNow(societyId, 'committee.term_expiring', officers, {
        termName: term.name,
        endDate: term.endDate,
        daysLeft,
      });
    }
  }
  // hand-over reminders at day 15 and 30 after the committee took charge while the checklist is incomplete
  const pending = term.handoverChecklist.filter(i => i.status === 'PENDING');
  if (term.tookChargeOn && term.handoverCompletedAt === null && pending.length) {
    const h = handoverReminderDay(
      daysBetween(term.tookChargeOn, today),
      HANDOVER_REMINDER_DAYS,
      term.lastHandoverReminderDay,
    );
    if (h !== null && (await claim(term.id!, 'lastHandoverReminderDay', h, '<'))) {
      report.handover = h;
      const owners = new Set(pending.map(i => i.ownerDesignation));
      const holders = seatedSeats(term.members)
        .filter(s => owners.has(s.designation))
        .map(s => s.userId!);
      await sendNow(societyId, 'committee.handover_pending', [...holders, ...(await officerIds(societyId))], {
        termName: term.name,
        endDate: term.endDate,
      });
    }
  }
  return report;
}

// ------------------------------------------------------------------ members:reconcile-seats (BR-10-25)
export interface ReconcileReport {
  closed: string[];
  flagged: string[];
  cleared: string[];
}

/**
 * Re-reads every SEATED seat of the current term against module 03 and 09: an ENDED membership closes the seat (`LEFT`,
 * `MEMBERSHIP_ENDED`, no module 03 call), the other findings are flags on the seat. Flags never remove a role. Rewrites the
 * term under its row lock only when something changed, and notifies the officers only for a changed set that holds a flag or a
 * closed seat.
 */
export async function reconcileSeatsFor(
  societyId: number,
  ctx: Ctx = systemCtx('reconcile-seats'),
): Promise<ReconcileReport> {
  const report: ReconcileReport = { closed: [], flagged: [], cleared: [] };
  const peek = await findCurrent(societyId);
  if (!peek) return report;
  const [cfg, today] = [await committeeSettings(societyId), await societyToday(societyId)];
  const seated = seatedSeats(peek.members).filter(s => s.userId !== null);
  const userIds = [...new Set(seated.map(s => s.userId!))];
  const rows = userIds.length
    ? await members.listForSociety(societyId, { userIds, statuses: ['ACTIVE', 'SUSPENDED', 'ENDED'] })
    : [];
  const links = new Map<number, boolean>();
  if (cfg.ownersOnly)
    for (const uid of userIds)
      links.set(
        uid,
        (await residents.getActiveUnitLinks(societyId, uid)).some(l => l.relation === 'OWNER'),
      );
  const state = (userId: number) => {
    const mine = rows.filter(r => r.userId === userId);
    return mine.find(r => r.status === 'ACTIVE') ?? mine.find(r => r.status === 'SUSPENDED') ?? null;
  };

  const term = await sequelize.transaction(async t => {
    const term = await lockTerm(societyId, peek.id!, t);
    if (term.status !== 'ACTIVE' && term.status !== 'EXPIRED') return null;
    const before = term.members;
    const flagsBefore = new Map<string, SeatFlag[]>();
    const next: SeatJson[] = before.map(s => {
      if (s.status !== 'SEATED' || s.userId === null) return s;
      flagsBefore.set(s.seatId, s.flags);
      const m = state(s.userId);
      if (!m) {
        report.closed.push(s.seatId);
        return {
          ...s,
          status: 'LEFT' as const,
          toDate: s.fromDate && today < s.fromDate ? s.fromDate : today,
          exitReason: 'MEMBERSHIP_ENDED' as const,
          flags: [],
        };
      }
      const flags = seatFlags(
        s.designation,
        {
          membership: m.status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE',
          roleKey: m.roleKey,
          hasOwnerLink: links.get(s.userId) ?? true,
        },
        cfg.ownersOnly,
      );
      if (!sameFlags(flags, s.flags)) (flags.length ? report.flagged : report.cleared).push(s.seatId);
      return sameFlags(flags, s.flags) ? s : { ...s, flags };
    });
    if (!report.closed.length && !report.flagged.length && !report.cleared.length) return null;
    term.members = next;
    term.version += 1;
    await term.save({ transaction: t });
    const brief = (list: SeatJson[], ids: string[]) =>
      list
        .filter(s => ids.includes(s.seatId))
        .map(s => ({
          seatId: s.seatId,
          name: s.name,
          designation: s.designation,
          status: s.status,
          flags: s.flags,
        }));
    if (report.closed.length)
      await audit(
        ctx,
        {
          action: AUDIT.seatVacated,
          entityType: ENTITY.term,
          entityId: term.id!,
          entityLabel: term.name,
          societyId,
          before: seatsForAudit(before.filter(s => report.closed.includes(s.seatId))),
          after: { seats: brief(next, report.closed), exitReason: 'MEMBERSHIP_ENDED' },
        },
        t,
      );
    const changedFlags = [...report.flagged, ...report.cleared];
    if (changedFlags.length)
      await audit(
        ctx,
        {
          action: AUDIT.seatFlagged,
          entityType: ENTITY.term,
          entityId: term.id!,
          entityLabel: term.name,
          societyId,
          before: { seats: changedFlags.map(id => ({ seatId: id, flags: flagsBefore.get(id) ?? [] })) },
          after: { seats: brief(next, changedFlags) },
        },
        t,
      );
    emitChanged(t, societyId, term.id!, term.status, 'CHANGED');
    return term;
  });
  if (term && (report.closed.length || report.flagged.length)) {
    const named = (ids: string[]) =>
      term.members
        .filter(s => ids.includes(s.seatId))
        .map(s => `${s.name} (${DESIGNATION_LABEL[s.designation]})`)
        .join(', ');
    await sendNow(societyId, 'committee.seat_needs_attention', await officerIds(societyId), {
      termName: term.name,
      extra: named([...report.closed, ...report.flagged]),
    });
  }
  return report;
}

async function forEachSociety(job: string, fn: (societyId: number) => Promise<unknown>): Promise<void> {
  for (const id of await societiesToRun())
    try {
      await fn(id);
    } catch (err) {
      logger.error({ err, societyId: id, job }, 'committee job failed for a society');
    }
}

export function registerCommitteeJobs(): void {
  registerQueue(COMMITTEE_QUEUE, 'Committee: term reminders, auto-expiry, seat reconciliation', 2);
  registerProcessor(COMMITTEE_QUEUE, JOBS.termReminders, () =>
    forEachSociety(JOBS.termReminders, sendRemindersFor),
  );
  registerProcessor(COMMITTEE_QUEUE, JOBS.termAutoExpiry, () =>
    forEachSociety(JOBS.termAutoExpiry, id => autoExpireFor(id)),
  );
  registerProcessor(COMMITTEE_QUEUE, JOBS.reconcileSeats, () =>
    forEachSociety(JOBS.reconcileSeats, id => reconcileSeatsFor(id)),
  );
  registerRepeatable(COMMITTEE_QUEUE, JOBS.termAutoExpiry, { dailyAtIst: '00:15' });
  registerRepeatable(COMMITTEE_QUEUE, JOBS.reconcileSeats, { dailyAtIst: '02:00' });
  registerRepeatable(COMMITTEE_QUEUE, JOBS.termReminders, { dailyAtIst: '09:00' });
}
