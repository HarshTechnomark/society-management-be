import { addHours, addMinutes } from '../../lib/clock';
import type { TicketPriority } from '../../models/platform-ticket.model';
import type { SettingValue } from './platform-ops.settings-registry';

/**
 * Ticket SLA maths (BR-07-4 to BR-07-8, BR-07-11). Pure functions: no database, no clock. Calendar hours, 24 by 7.
 */
export type SlaHours = SettingValue<'support.slaHours'>;

export interface SlaTicket {
  createdAt: Date;
  priority: TicketPriority;
  status: string;
  firstResponseDueAt: Date;
  resolutionDueAt: Date;
  firstRespondedAt: Date | null;
  firstResponseBreachedAt: Date | null;
  resolutionWarnedAt: Date | null;
  resolutionBreachedAt: Date | null;
  waitingSince: Date | null;
  pausedMinutes: number;
}

/** BR-07-4: due times at creation. */
export function dueTimes(createdAt: Date, priority: TicketPriority, sla: SlaHours) {
  const h = sla[priority];
  return {
    firstResponseDueAt: addHours(createdAt, h.firstResponse),
    resolutionDueAt: addHours(createdAt, h.resolution),
  };
}

/** BR-07-6: whole minutes spent waiting; added to `pausedMinutes` and `resolutionDueAt` when leaving WAITING. */
export function settleWaiting(
  t: Pick<SlaTicket, 'waitingSince' | 'pausedMinutes' | 'resolutionDueAt'>,
  now: Date,
): { pausedMinutes: number; resolutionDueAt: Date; waitingSince: null } {
  if (!t.waitingSince)
    return { pausedMinutes: t.pausedMinutes, resolutionDueAt: t.resolutionDueAt, waitingSince: null };
  const add = Math.max(0, Math.floor((now.getTime() - t.waitingSince.getTime()) / 60_000));
  return {
    pausedMinutes: t.pausedMinutes + add,
    resolutionDueAt: addMinutes(t.resolutionDueAt, add),
    waitingSince: null,
  };
}

/** BR-07-7: a priority change recomputes the due times and clears breach and warning stamps that are in the future again. */
export function reprioritise(
  t: Pick<
    SlaTicket,
    | 'createdAt'
    | 'pausedMinutes'
    | 'firstRespondedAt'
    | 'firstResponseDueAt'
    | 'firstResponseBreachedAt'
    | 'resolutionWarnedAt'
    | 'resolutionBreachedAt'
    | 'resolutionDueAt'
  >,
  priority: TicketPriority,
  sla: SlaHours,
  now: Date,
) {
  const h = sla[priority];
  const resolutionDueAt = addMinutes(addHours(t.createdAt, h.resolution), t.pausedMinutes);
  const out = {
    resolutionDueAt,
    firstResponseDueAt: t.firstResponseDueAt,
    firstResponseBreachedAt: t.firstResponseBreachedAt,
    resolutionWarnedAt: t.resolutionWarnedAt,
    resolutionBreachedAt: t.resolutionBreachedAt,
  };
  if (!t.firstRespondedAt) {
    out.firstResponseDueAt = addHours(t.createdAt, h.firstResponse);
    if (out.firstResponseDueAt > now) out.firstResponseBreachedAt = null;
  }
  if (resolutionDueAt > now) {
    out.resolutionWarnedAt = null;
    out.resolutionBreachedAt = null;
  }
  return out;
}

/** BR-07-11: reopen restarts the resolution clock. */
export function restartResolution(now: Date, priority: TicketPriority, sla: SlaHours) {
  return {
    resolutionDueAt: addHours(now, sla[priority].resolution),
    resolutionWarnedAt: null,
    resolutionBreachedAt: null,
  };
}

const live = (s: string) => s === 'OPEN' || s === 'IN_PROGRESS';

/** BR-07-8: what the scan would set for this ticket right now. */
export function scan(
  t: SlaTicket,
  now: Date,
): { firstResponseBreach: boolean; warn: boolean; resolutionBreach: boolean } {
  const firstResponseBreach =
    !t.firstRespondedAt && !t.firstResponseBreachedAt && live(t.status) && now > t.firstResponseDueAt;
  const window = t.resolutionDueAt.getTime() - t.createdAt.getTime();
  const warn =
    !t.resolutionWarnedAt && live(t.status) && now.getTime() >= t.createdAt.getTime() + window * 0.8;
  const resolutionBreach = !t.resolutionBreachedAt && live(t.status) && now > t.resolutionDueAt;
  return { firstResponseBreach, warn, resolutionBreach };
}
