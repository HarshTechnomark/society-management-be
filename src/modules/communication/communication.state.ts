import { AppError, ConflictError, UnprocessableError } from '../../utils/errors';
import {
  ERR,
  LIMITS,
  type EmergencyStatus,
  type NoticeStatus,
  type SurveyStatus,
} from './communication.constants';

/**
 * PURE state machines of section 6: notice (6.1), emergency broadcast (6.3) and survey (6.4). No database, no clock (callers pass `at`).
 * Services never compare status strings themselves: they call `noticeTransition(...)` / `assertNoticeTransition(...)` and friends.
 */

// ------------------------------------------------------------------ notice 6.1
export const NOTICE_ACTIONS = [
  'submit', // DRAFT -> PENDING_APPROVAL (POST /publish, approval pending)
  'publish', // DRAFT -> PUBLISHED | SCHEDULED (auto-approved), PENDING_APPROVAL -> same (onApproved), SCHEDULED -> PUBLISHED (scheduler)
  'return', // PENDING_APPROVAL -> DRAFT (withdraw, reject, changes requested, cancelled, expired)
  'cancelSchedule', // SCHEDULED -> DRAFT
  'expire', // PUBLISHED -> EXPIRED
  'recall', // PUBLISHED -> RECALLED
  'archive', // PUBLISHED | EXPIRED | RECALLED -> ARCHIVED
  'delete', // DRAFT -> soft deleted (no status change)
] as const;
export type NoticeAction = (typeof NOTICE_ACTIONS)[number];

/** Rows of the 6.1 table: `from -> [action -> to]`. `publish` from DRAFT / PENDING_APPROVAL resolves through `publishTarget`. */
export const NOTICE_TRANSITIONS: Record<
  NoticeStatus,
  Partial<Record<NoticeAction, NoticeStatus | 'DELETED' | 'PUBLISH_TARGET'>>
> = {
  DRAFT: { submit: 'PENDING_APPROVAL', publish: 'PUBLISH_TARGET', delete: 'DELETED' },
  PENDING_APPROVAL: { publish: 'PUBLISH_TARGET', return: 'DRAFT' },
  SCHEDULED: { publish: 'PUBLISHED', cancelSchedule: 'DRAFT' },
  PUBLISHED: { expire: 'EXPIRED', recall: 'RECALLED', archive: 'ARCHIVED' },
  EXPIRED: { archive: 'ARCHIVED' },
  RECALLED: { archive: 'ARCHIVED' },
  ARCHIVED: {},
};

/** 6.1: after approval a notice whose `scheduledAt` is more than 60 s away is SCHEDULED, otherwise PUBLISHED. */
export function publishTarget(scheduledAt: Date | null | undefined, at: Date): 'SCHEDULED' | 'PUBLISHED' {
  return scheduledAt && scheduledAt.getTime() > at.getTime() + LIMITS.schedulerLeadSeconds * 1000
    ? 'SCHEDULED'
    : 'PUBLISHED';
}

export function noticeAllowedActions(from: NoticeStatus): NoticeAction[] {
  return Object.keys(NOTICE_TRANSITIONS[from]) as NoticeAction[];
}

/** The status after `action`, or `'DELETED'` for a soft delete. Returns null when the action is not allowed in `from`. */
export function noticeTransition(
  from: NoticeStatus,
  action: NoticeAction,
  opts: { scheduledAt?: Date | null; at?: Date } = {},
): NoticeStatus | 'DELETED' | null {
  const to = NOTICE_TRANSITIONS[from][action];
  if (!to) return null;
  if (to === 'PUBLISH_TARGET') return publishTarget(opts.scheduledAt, opts.at ?? new Date());
  return to;
}

/** `409 INVALID_STATE` with the allowed actions in `errors[]` (any other transition, 6.1). */
export function assertNoticeTransition(
  from: NoticeStatus,
  action: NoticeAction,
  opts: { scheduledAt?: Date | null; at?: Date } = {},
): NoticeStatus | 'DELETED' {
  const to = noticeTransition(from, action, opts);
  if (to) return to;
  throw new AppError(
    409,
    ERR.invalidState,
    `A ${from.toLowerCase().replace('_', ' ')} notice cannot be ${action}ed`,
    noticeAllowedActions(from).map(a => ({ field: 'action', message: a })),
  );
}

/** BR-16-7: only DRAFT notices are edited freely; after publish only a typo edit is allowed (BR-16-8). */
export const noticeEditMode = (s: NoticeStatus): 'FULL' | 'TYPO' | 'NONE' =>
  s === 'DRAFT' ? 'FULL' : s === 'PUBLISHED' ? 'TYPO' : 'NONE';

/** BR-16-12: manual reminder at most once every 6 hours, within the maximum and before `ackDueAt`. */
export function remindCheck(
  n: { requiresAck: boolean; lastRemindedAt: Date | null; remindersSent: number; ackDueAt: Date | null },
  maxReminders: number,
  at: Date,
): null | 'NOTICE_ACK_NOT_REQUIRED' | 'NOTICE_REMIND_TOO_SOON' | 'NOTICE_REMIND_LIMIT' {
  if (!n.requiresAck) return ERR.noticeAckNotRequired;
  if (n.remindersSent >= maxReminders || (n.ackDueAt && n.ackDueAt.getTime() <= at.getTime()))
    return ERR.noticeRemindLimit;
  if (n.lastRemindedAt && at.getTime() - n.lastRemindedAt.getTime() < LIMITS.remindMinHours * 3_600_000)
    return ERR.noticeRemindTooSoon;
  return null;
}

/** BR-16-5: `scheduledAt` 5 minutes to 90 days after `at`. */
export const scheduleValid = (scheduledAt: Date, at: Date): boolean =>
  scheduledAt.getTime() >= at.getTime() + LIMITS.scheduleMinMinutes * 60_000 &&
  scheduledAt.getTime() <= at.getTime() + LIMITS.scheduleMaxDays * 86_400_000;
/** BR-16-5: `expiresAt` 1 hour to 365 days after the publish moment. */
export const expiryValid = (expiresAt: Date, publishAt: Date): boolean =>
  expiresAt.getTime() >= publishAt.getTime() + LIMITS.expiryMinHours * 3_600_000 &&
  expiresAt.getTime() <= publishAt.getTime() + LIMITS.expiryMaxDays * 86_400_000;
/** BR-16-5: `ackDueAt` after the publish moment and at most 90 days after it. */
export const ackDueValid = (ackDueAt: Date, publishAt: Date): boolean =>
  ackDueAt.getTime() > publishAt.getTime() &&
  ackDueAt.getTime() <= publishAt.getTime() + LIMITS.ackDueMaxDays * 86_400_000;
/** BR-16-16: outage start in the future, end after start and at most 7 days later. */
export const outageValid = (start: Date, end: Date, at: Date): boolean =>
  start.getTime() > at.getTime() &&
  end.getTime() > start.getTime() &&
  end.getTime() <= start.getTime() + LIMITS.utilityMaxDays * 86_400_000;

// ------------------------------------------------------------------ emergency 6.3
export const EMERGENCY_ACTIONS = ['update', 'realert', 'response', 'attend', 'resolve', 'cancel'] as const;
export type EmergencyAction = (typeof EMERGENCY_ACTIONS)[number];

/** 6.3: only an ACTIVE broadcast takes any action; the start creates the row in ACTIVE. */
export function emergencyTransition(from: EmergencyStatus, action: EmergencyAction): EmergencyStatus | null {
  if (from !== 'ACTIVE') return null;
  return action === 'resolve' ? 'RESOLVED' : action === 'cancel' ? 'CANCELLED' : 'ACTIVE';
}
/** `409 EMERGENCY_NOT_ACTIVE` for any action on a resolved or cancelled broadcast. */
export function assertEmergencyTransition(from: EmergencyStatus, action: EmergencyAction): EmergencyStatus {
  const to = emergencyTransition(from, action);
  if (to) return to;
  throw new ConflictError(ERR.emergencyNotActive, 'This emergency broadcast has ended');
}
/** BR-16-43: a false alarm can be cancelled within 15 minutes of the start. */
export const canCancelEmergency = (startedAt: Date, at: Date): boolean =>
  at.getTime() - startedAt.getTime() <= LIMITS.emergencyCancelWindowMinutes * 60_000;
export function assertCanCancelEmergency(startedAt: Date, at: Date): void {
  if (!canCancelEmergency(startedAt, at))
    throw new UnprocessableError(
      ERR.emergencyCancelWindowPassed,
      'A false alarm can only be cancelled within 15 minutes',
    );
}
/** BR-16-42: re-alert once every 3 minutes. */
export const canRealert = (lastRealertAt: Date | null, at: Date): boolean =>
  lastRealertAt === null || at.getTime() - lastRealertAt.getTime() >= LIMITS.emergencyRealertMinutes * 60_000;
export function assertCanRealert(lastRealertAt: Date | null, at: Date): void {
  if (!canRealert(lastRealertAt, at))
    throw new UnprocessableError(ERR.emergencyRealertTooSoon, 'Re-alert is allowed once every 3 minutes');
}
/** BR-16-43: the starter is reminded every 30 minutes while ACTIVE. */
export const resolveReminderDue = (
  b: { startedAt: Date; lastResolveReminderAt: Date | null },
  at: Date,
): boolean =>
  at.getTime() - (b.lastResolveReminderAt ?? b.startedAt).getTime() >=
  LIMITS.emergencyResolveReminderMinutes * 60_000;

// ------------------------------------------------------------------ survey 6.4
export const SURVEY_ACTIONS = ['publish', 'close', 'cancel', 'delete'] as const;
export type SurveyAction = (typeof SURVEY_ACTIONS)[number];
const SURVEY_TRANSITIONS: Record<SurveyStatus, Partial<Record<SurveyAction, SurveyStatus | 'DELETED'>>> = {
  DRAFT: { publish: 'OPEN', delete: 'DELETED' },
  OPEN: { close: 'CLOSED', cancel: 'CANCELLED' },
  CLOSED: {},
  CANCELLED: {},
};
export const surveyAllowedActions = (from: SurveyStatus): SurveyAction[] =>
  Object.keys(SURVEY_TRANSITIONS[from]) as SurveyAction[];
export const surveyTransition = (from: SurveyStatus, action: SurveyAction): SurveyStatus | 'DELETED' | null =>
  SURVEY_TRANSITIONS[from][action] ?? null;
export function assertSurveyTransition(from: SurveyStatus, action: SurveyAction): SurveyStatus | 'DELETED' {
  const to = surveyTransition(from, action);
  if (to) return to;
  throw new AppError(
    409,
    ERR.invalidState,
    `A ${from.toLowerCase()} survey cannot be ${action}d`,
    surveyAllowedActions(from).map(a => ({ field: 'action', message: a })),
  );
}
/** `409 SURVEY_NOT_OPEN` for a response to a survey that is not OPEN. */
export function assertSurveyOpen(s: SurveyStatus): void {
  if (s !== 'OPEN') throw new ConflictError(ERR.surveyNotOpen, 'This survey is not accepting responses');
}
/** BR-16-46: `closesAt` 1 hour to 90 days after the publish moment. */
export const surveyCloseWindowOk = (closesAt: Date, publishAt: Date): boolean =>
  closesAt.getTime() >= publishAt.getTime() + LIMITS.surveyCloseMinHours * 3_600_000 &&
  closesAt.getTime() <= publishAt.getTime() + LIMITS.surveyCloseMaxDays * 86_400_000;
/** 9.1: the 24-hour reminder window before `closesAt`. */
export const surveyReminderDue = (s: { closesAt: Date; reminderSentAt: Date | null }, at: Date): boolean =>
  !s.reminderSentAt && s.closesAt.getTime() - at.getTime() <= LIMITS.surveyReminderHours * 3_600_000;
