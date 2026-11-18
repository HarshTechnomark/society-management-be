import { now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils/errors';
import { isFeatureOn } from '../subscriptions/entitlements.service';
import { holidays, settings } from '../society-setup/society-setup.public';
import { SlaPolicy } from '../../models';
import {
  ENT,
  ERR,
  LIMITS,
  type Priority,
  type SlaCalendar,
  type SlaState,
  type TicketStatus,
} from './helpdesk.constants';
import type { BusinessCalendar, EffectiveCategory, SlaDue, SlaSnapshot } from './helpdesk.types';

/**
 * SLA maths of module 15 (5.3, 6.4). The calendar maths is PURE and works on instants plus a `BusinessCalendar`; the society time zone is
 * Asia/Kolkata (UTC+05:30, no daylight saving), as in `lib/clock`. The database wrappers (`policyFor`, `snapshotFor`, `liveBusinessCalendar`) are at the end.
 */
const IST_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

export const addMinutesTo = (d: Date, minutes: number): Date => new Date(d.getTime() + minutes * MIN_MS);
const istShift = (d: Date): Date => new Date(d.getTime() + IST_MS);
/** IST calendar date `YYYY-MM-DD` of an instant. */
export const ymdOf = (d: Date): string => istShift(d).toISOString().slice(0, 10);
/** The instant of `ymd` at minute-of-day `m` (IST). */
const instantOf = (ymd: string, minuteOfDay: number): Date =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) - IST_MS + minuteOfDay * MIN_MS);
const nextYmd = (ymd: string): string =>
  new Date(Date.parse(`${ymd}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
export const minutesOfDay = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};
const minuteOfDayOf = (d: Date): number => {
  const x = istShift(d);
  return x.getUTCHours() * 60 + x.getUTCMinutes() + x.getUTCSeconds() / 60 + x.getUTCMilliseconds() / 60000;
};

/**
 * BR-15-25: `start` moves forward to the next open minute (a working day between open and close), then `n` minutes are consumed day by
 * day. The search stops after 400 calendar days and throws `INTERNAL_ERROR` (logged) so a mis-configured calendar never loops.
 * Open means `[openTime, closeTime)`; a start exactly at closing moves to the next working day's opening.
 */
export async function addBusinessMinutes(start: Date, n: number, cal: BusinessCalendar): Promise<Date> {
  const open = minutesOfDay(cal.openTime);
  const close = minutesOfDay(cal.closeTime);
  if (!(close > open)) {
    logger.error({ cal }, 'helpdesk: office closes before it opens');
    throw new AppError(500, ERR.internal, 'The office calendar is not usable');
  }
  let remaining = Math.max(0, n);
  let ymd = ymdOf(start);
  let cursor = minuteOfDayOf(start);
  for (let day = 0; day <= LIMITS.businessSearchDays; day++) {
    if (await cal.isWorkingDay(ymd)) {
      const from = Math.max(cursor, open);
      if (from < close) {
        const room = close - from;
        if (remaining <= room) return instantOf(ymd, from + remaining);
        remaining -= room;
      }
    }
    ymd = nextYmd(ymd);
    cursor = 0;
  }
  logger.error({ start, n }, 'helpdesk: no business time found within 400 days');
  throw new AppError(500, ERR.internal, 'No business time found');
}

/** `add(start, minutes)` on a calendar (BR-15-26). 24x7 uses wall-clock minutes. */
export async function addOnCalendar(
  start: Date,
  minutes: number,
  calendar: SlaCalendar,
  cal?: BusinessCalendar,
): Promise<Date> {
  if (calendar === 'TWENTY_FOUR_SEVEN') return addMinutesTo(start, minutes);
  if (!cal) throw new Error('addOnCalendar: a business calendar is needed for BUSINESS_HOURS');
  return addBusinessMinutes(start, minutes, cal);
}

/**
 * Calendar minutes between two instants on a calendar (BR-15-28 pause length): wall-clock minutes (floor) for 24x7, open minutes
 * for BUSINESS_HOURS. `to <= from` gives 0.
 */
export async function calendarMinutesBetween(
  from: Date,
  to: Date,
  calendar: SlaCalendar,
  cal?: BusinessCalendar,
): Promise<number> {
  if (to.getTime() <= from.getTime()) return 0;
  if (calendar === 'TWENTY_FOUR_SEVEN') return Math.floor((to.getTime() - from.getTime()) / MIN_MS);
  if (!cal) throw new Error('calendarMinutesBetween: a business calendar is needed');
  const open = minutesOfDay(cal.openTime);
  const close = minutesOfDay(cal.closeTime);
  const lastDay = ymdOf(to);
  let ymd = ymdOf(from);
  let total = 0;
  for (let day = 0; day <= LIMITS.businessSearchDays; day++) {
    if (await cal.isWorkingDay(ymd)) {
      const a = ymd === ymdOf(from) ? Math.max(minuteOfDayOf(from), open) : open;
      const b = ymd === lastDay ? Math.min(minuteOfDayOf(to), close) : close;
      if (b > a) total += b - a;
    }
    if (ymd === lastDay) break;
    ymd = nextYmd(ymd);
  }
  return Math.floor(total);
}

/** BR-15-26: `responseDueAt = add(slaStartAt, responseMinutes)`; `resolutionDueAt = add(slaStartAt, resolutionMinutes + pausedMinutes)`. */
export async function slaDue(
  snap: Pick<SlaSnapshot, 'slaCalendar' | 'responseMinutes' | 'resolutionMinutes'>,
  slaStartAt: Date,
  slaPausedMinutes: number,
  cal?: BusinessCalendar,
): Promise<SlaDue> {
  return {
    responseDueAt: await addOnCalendar(slaStartAt, snap.responseMinutes, snap.slaCalendar, cal),
    resolutionDueAt: await addOnCalendar(
      slaStartAt,
      snap.resolutionMinutes + slaPausedMinutes,
      snap.slaCalendar,
      cal,
    ),
  };
}

/**
 * BR-15-28: leaving WAITING_ON_RESIDENT adds the calendar minutes between `slaPausedAt` and now to `slaPausedMinutes` and recomputes the
 * resolution due time. The response SLA is never paused.
 */
export async function endPause(
  t: {
    slaCalendar: SlaCalendar;
    resolutionMinutes: number;
    slaStartAt: Date;
    slaPausedAt: Date;
    slaPausedMinutes: number;
  },
  at: Date,
  cal?: BusinessCalendar,
): Promise<{ slaPausedMinutes: number; resolutionDueAt: Date }> {
  const added = await calendarMinutesBetween(t.slaPausedAt, at, t.slaCalendar, cal);
  const slaPausedMinutes = t.slaPausedMinutes + added;
  return {
    slaPausedMinutes,
    resolutionDueAt: await addOnCalendar(
      t.slaStartAt,
      t.resolutionMinutes + slaPausedMinutes,
      t.slaCalendar,
      cal,
    ),
  };
}

/** BR-15-32. `remainingFraction` is computed against the wall-clock window from `slaStartAt` to `resolutionDueAt`. */
export function slaState(
  t: {
    status: TicketStatus;
    resolutionBreached: boolean;
    slaStartAt: Date;
    resolutionDueAt: Date;
  },
  at: Date = now(),
): SlaState {
  if (t.status === 'CANCELLED') return 'NONE';
  if (t.status === 'RESOLVED' || t.status === 'CLOSED') return t.resolutionBreached ? 'BREACHED' : 'MET';
  if (t.status === 'WAITING_ON_RESIDENT') return 'PAUSED';
  if (t.resolutionBreached) return 'BREACHED';
  const window = t.resolutionDueAt.getTime() - t.slaStartAt.getTime();
  const remaining = t.resolutionDueAt.getTime() - at.getTime();
  return window > 0 && remaining / window < LIMITS.atRiskFraction ? 'AT_RISK' : 'ON_TRACK';
}

/** BR-15-59: the fire time of an SLA rule: `add(slaStartAt, ceil(minutes x threshold / 100) + paused)`. */
export async function escalationFireTime(
  t: { slaStartAt: Date; slaCalendar: SlaCalendar; slaPausedMinutes: number },
  minutes: number,
  thresholdPercent: number,
  trigger: 'RESPONSE_SLA' | 'RESOLUTION_SLA',
  cal?: BusinessCalendar,
): Promise<Date> {
  const base = Math.ceil((minutes * thresholdPercent) / 100);
  const paused = trigger === 'RESOLUTION_SLA' ? t.slaPausedMinutes : 0;
  return addOnCalendar(t.slaStartAt, base + paused, t.slaCalendar, cal);
}

/** 6.4: the earliest instant the sweep must look at the ticket again, or NULL (resolved, closed, cancelled, paused, nothing pending). */
export function nextSlaCheck(
  t: {
    status: TicketStatus;
    firstResponseAt: Date | null;
    responseBreached: boolean;
    resolutionBreached: boolean;
    responseDueAt: Date;
    resolutionDueAt: Date;
  },
  unfiredRuleTimes: Date[],
): Date | null {
  if (['RESOLVED', 'CLOSED', 'CANCELLED', 'WAITING_ON_RESIDENT'].includes(t.status)) return null;
  const c: Date[] = [...unfiredRuleTimes];
  if (!t.firstResponseAt && !t.responseBreached) c.push(t.responseDueAt);
  if (!t.resolutionBreached) c.push(t.resolutionDueAt);
  if (!c.length) return null;
  return new Date(Math.min(...c.map(d => d.getTime())));
}

const PRIORITY_KEYS = {
  P1: ['p1ResponseMinutes', 'p1ResolutionMinutes', 'p1Calendar'],
  P2: ['p2ResponseMinutes', 'p2ResolutionMinutes', 'p2Calendar'],
  P3: ['p3ResponseMinutes', 'p3ResolutionMinutes', 'p3Calendar'],
  P4: ['p4ResponseMinutes', 'p4ResolutionMinutes', 'p4Calendar'],
} as const;

/** Pure part of BR-15-23/24: the numbers a policy gives a priority; BUSINESS_HOURS becomes 24x7 without the plan feature or for P1. */
export function snapshotOf(policy: SlaPolicy, priority: Priority, businessOk: boolean): SlaSnapshot {
  const [r, s, c] = PRIORITY_KEYS[priority];
  const calendar = policy[c] as SlaCalendar;
  return {
    slaPolicyId: policy.id,
    slaCalendar: priority === 'P1' || !businessOk ? 'TWENTY_FOUR_SEVEN' : calendar,
    responseMinutes: policy[r],
    resolutionMinutes: policy[s],
  };
}

// ------------------------------------------------------------------ database wrappers
/** BR-15-23: sub-category policy, then category policy, then the society's ACTIVE default. */
export async function policyFor(
  societyId: number,
  cat: Pick<EffectiveCategory, 'slaPolicyId'>,
  t?: import('sequelize').Transaction,
): Promise<SlaPolicy> {
  if (cat.slaPolicyId) {
    const p = await SlaPolicy.findOne({
      where: { id: cat.slaPolicyId, societyId, status: 'ACTIVE' },
      transaction: t,
    });
    if (p) return p;
  }
  const d = await SlaPolicy.findOne({
    where: { societyId, isDefault: true, status: 'ACTIVE' },
    transaction: t,
  });
  if (!d)
    throw new AppError(500, ERR.internal, 'The society has no default SLA policy (ensureSeeded did not run)');
  return d;
}

export async function snapshotFor(
  societyId: number,
  cat: Pick<EffectiveCategory, 'slaPolicyId'>,
  priority: Priority,
  t?: import('sequelize').Transaction,
): Promise<SlaSnapshot> {
  const policy = await policyFor(societyId, cat, t);
  return snapshotOf(policy, priority, await isFeatureOn(societyId, ENT.businessCalendar));
}

/** The society's live office calendar (module 08 settings and holidays). */
export async function liveBusinessCalendar(societyId: number): Promise<BusinessCalendar> {
  const [openTime, closeTime] = await Promise.all([
    settings.get(societyId, 'office.openTime'),
    settings.get(societyId, 'office.closeTime'),
  ]);
  return {
    openTime: openTime as string,
    closeTime: closeTime as string,
    isWorkingDay: ymd => holidays.isWorkingDay(societyId, ymd),
  };
}

/** Only loads the calendar when the ticket's snapshot needs it. */
export async function calendarFor(
  societyId: number,
  calendar: SlaCalendar,
): Promise<BusinessCalendar | undefined> {
  return calendar === 'BUSINESS_HOURS' ? liveBusinessCalendar(societyId) : undefined;
}
