import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/utils/errors';
import {
  NOTICE_ACTIONS,
  NOTICE_TRANSITIONS,
  ackDueValid,
  assertCanCancelEmergency,
  assertCanRealert,
  assertEmergencyTransition,
  assertNoticeTransition,
  assertSurveyOpen,
  assertSurveyTransition,
  emergencyTransition,
  expiryValid,
  noticeAllowedActions,
  noticeEditMode,
  noticeTransition,
  outageValid,
  publishTarget,
  remindCheck,
  resolveReminderDue,
  scheduleValid,
  surveyCloseWindowOk,
  surveyReminderDue,
  surveyTransition,
} from '../../../src/modules/communication/communication.state';
import { NOTICE_STATUSES } from '../../../src/modules/communication/communication.constants';

const T0 = new Date('2026-11-01T10:00:00Z');
const plus = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

describe('notice state machine (6.1)', () => {
  it('has the rows of the table and nothing leaves ARCHIVED', () => {
    expect(noticeAllowedActions('ARCHIVED')).toEqual([]);
    expect(noticeAllowedActions('DRAFT').sort()).toEqual(['delete', 'publish', 'submit']);
    expect(noticeAllowedActions('PENDING_APPROVAL').sort()).toEqual(['publish', 'return']);
    expect(noticeAllowedActions('SCHEDULED').sort()).toEqual(['cancelSchedule', 'publish']);
    expect(noticeAllowedActions('PUBLISHED').sort()).toEqual(['archive', 'expire', 'recall']);
    expect(noticeAllowedActions('EXPIRED')).toEqual(['archive']);
    expect(noticeAllowedActions('RECALLED')).toEqual(['archive']);
  });
  it('moves through every documented transition', () => {
    expect(noticeTransition('DRAFT', 'submit')).toBe('PENDING_APPROVAL');
    expect(noticeTransition('DRAFT', 'delete')).toBe('DELETED');
    expect(noticeTransition('PENDING_APPROVAL', 'return')).toBe('DRAFT');
    expect(noticeTransition('SCHEDULED', 'cancelSchedule')).toBe('DRAFT');
    expect(noticeTransition('SCHEDULED', 'publish')).toBe('PUBLISHED');
    expect(noticeTransition('PUBLISHED', 'expire')).toBe('EXPIRED');
    expect(noticeTransition('PUBLISHED', 'recall')).toBe('RECALLED');
    for (const from of ['PUBLISHED', 'EXPIRED', 'RECALLED'] as const)
      expect(noticeTransition(from, 'archive')).toBe('ARCHIVED');
  });
  it('publish resolves to SCHEDULED only when scheduledAt is more than 60 s away', () => {
    expect(publishTarget(null, T0)).toBe('PUBLISHED');
    expect(publishTarget(plus(60_000), T0)).toBe('PUBLISHED');
    expect(publishTarget(plus(61_000), T0)).toBe('SCHEDULED');
    expect(noticeTransition('DRAFT', 'publish', { scheduledAt: plus(HOUR), at: T0 })).toBe('SCHEDULED');
    expect(noticeTransition('PENDING_APPROVAL', 'publish', { scheduledAt: plus(10_000), at: T0 })).toBe(
      'PUBLISHED',
    );
  });
  it('every other pair is 409 INVALID_STATE listing the allowed actions', () => {
    let bad = 0;
    for (const s of NOTICE_STATUSES)
      for (const a of NOTICE_ACTIONS)
        if (!NOTICE_TRANSITIONS[s][a]) {
          bad++;
          try {
            assertNoticeTransition(s, a);
            throw new Error('should have thrown');
          } catch (e) {
            expect(e).toBeInstanceOf(AppError);
            expect((e as AppError).status).toBe(409);
            expect((e as AppError).code).toBe('INVALID_STATE');
            expect((e as AppError).errors?.map(x => x.message)).toEqual(noticeAllowedActions(s));
          }
        }
    expect(bad).toBeGreaterThan(30);
  });
  it('edit modes (BR-16-7, BR-16-8)', () => {
    expect(noticeEditMode('DRAFT')).toBe('FULL');
    expect(noticeEditMode('PUBLISHED')).toBe('TYPO');
    for (const s of ['PENDING_APPROVAL', 'SCHEDULED', 'EXPIRED', 'RECALLED', 'ARCHIVED'] as const)
      expect(noticeEditMode(s)).toBe('NONE');
  });
  it('reminder guard (BR-16-12)', () => {
    const n = { requiresAck: true, lastRemindedAt: null, remindersSent: 0, ackDueAt: plus(DAY) };
    expect(remindCheck(n, 3, T0)).toBeNull();
    expect(remindCheck({ ...n, requiresAck: false }, 3, T0)).toBe('NOTICE_ACK_NOT_REQUIRED');
    expect(remindCheck({ ...n, lastRemindedAt: plus(-5 * HOUR) }, 3, T0)).toBe('NOTICE_REMIND_TOO_SOON');
    expect(remindCheck({ ...n, lastRemindedAt: plus(-6 * HOUR) }, 3, T0)).toBeNull();
    expect(remindCheck({ ...n, remindersSent: 3 }, 3, T0)).toBe('NOTICE_REMIND_LIMIT');
    expect(remindCheck({ ...n, ackDueAt: plus(-1) }, 3, T0)).toBe('NOTICE_REMIND_LIMIT');
  });
  it('date windows (BR-16-5, BR-16-16)', () => {
    expect(scheduleValid(plus(4 * MIN), T0)).toBe(false);
    expect(scheduleValid(plus(5 * MIN), T0)).toBe(true);
    expect(scheduleValid(plus(90 * DAY), T0)).toBe(true);
    expect(scheduleValid(plus(90 * DAY + 1), T0)).toBe(false);
    expect(expiryValid(plus(HOUR - 1), T0)).toBe(false);
    expect(expiryValid(plus(HOUR), T0)).toBe(true);
    expect(expiryValid(plus(365 * DAY), T0)).toBe(true);
    expect(expiryValid(plus(365 * DAY + 1), T0)).toBe(false);
    expect(ackDueValid(T0, T0)).toBe(false);
    expect(ackDueValid(plus(90 * DAY), T0)).toBe(true);
    expect(ackDueValid(plus(90 * DAY + 1), T0)).toBe(false);
    expect(outageValid(plus(HOUR), plus(2 * HOUR), T0)).toBe(true);
    expect(outageValid(plus(-1), plus(HOUR), T0)).toBe(false);
    expect(outageValid(plus(HOUR), plus(HOUR), T0)).toBe(false);
    expect(outageValid(plus(HOUR), plus(HOUR + 7 * DAY + 1), T0)).toBe(false);
  });
});

describe('emergency state machine (6.3)', () => {
  it('only ACTIVE takes actions', () => {
    for (const a of ['update', 'realert', 'response', 'attend'] as const)
      expect(emergencyTransition('ACTIVE', a)).toBe('ACTIVE');
    expect(emergencyTransition('ACTIVE', 'resolve')).toBe('RESOLVED');
    expect(emergencyTransition('ACTIVE', 'cancel')).toBe('CANCELLED');
    for (const s of ['RESOLVED', 'CANCELLED'] as const) {
      expect(emergencyTransition(s, 'response')).toBeNull();
      expect(() => assertEmergencyTransition(s, 'response')).toThrowError(/ended/);
      try {
        assertEmergencyTransition(s, 'update');
      } catch (e) {
        expect((e as AppError).code).toBe('EMERGENCY_NOT_ACTIVE');
        expect((e as AppError).status).toBe(409);
      }
    }
  });
  it('cancel window is 15 minutes, re-alert spacing 3 minutes, reminder 30 minutes', () => {
    expect(() => assertCanCancelEmergency(T0, plus(15 * MIN))).not.toThrow();
    try {
      assertCanCancelEmergency(T0, plus(15 * MIN + 1));
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('EMERGENCY_CANCEL_WINDOW_PASSED');
      expect((e as AppError).status).toBe(422);
    }
    expect(() => assertCanRealert(null, T0)).not.toThrow();
    expect(() => assertCanRealert(plus(-3 * MIN), T0)).not.toThrow();
    try {
      assertCanRealert(plus(-2 * MIN), T0);
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('EMERGENCY_REALERT_TOO_SOON');
    }
    expect(resolveReminderDue({ startedAt: plus(-29 * MIN), lastResolveReminderAt: null }, T0)).toBe(false);
    expect(resolveReminderDue({ startedAt: plus(-30 * MIN), lastResolveReminderAt: null }, T0)).toBe(true);
    expect(
      resolveReminderDue({ startedAt: plus(-90 * MIN), lastResolveReminderAt: plus(-10 * MIN) }, T0),
    ).toBe(false);
  });
});

describe('survey state machine (6.4)', () => {
  it('DRAFT publishes or is deleted, OPEN closes or cancels, the rest is final', () => {
    expect(surveyTransition('DRAFT', 'publish')).toBe('OPEN');
    expect(surveyTransition('DRAFT', 'delete')).toBe('DELETED');
    expect(surveyTransition('OPEN', 'close')).toBe('CLOSED');
    expect(surveyTransition('OPEN', 'cancel')).toBe('CANCELLED');
    expect(surveyTransition('OPEN', 'delete')).toBeNull();
    expect(surveyTransition('CLOSED', 'close')).toBeNull();
    expect(surveyTransition('CANCELLED', 'publish')).toBeNull();
    try {
      assertSurveyTransition('CLOSED', 'cancel');
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('INVALID_STATE');
    }
  });
  it('SURVEY_NOT_OPEN, close window and the 24 hour reminder', () => {
    expect(() => assertSurveyOpen('OPEN')).not.toThrow();
    try {
      assertSurveyOpen('CLOSED');
      expect.unreachable();
    } catch (e) {
      expect((e as AppError).code).toBe('SURVEY_NOT_OPEN');
    }
    expect(surveyCloseWindowOk(plus(HOUR - 1), T0)).toBe(false);
    expect(surveyCloseWindowOk(plus(HOUR), T0)).toBe(true);
    expect(surveyCloseWindowOk(plus(90 * DAY), T0)).toBe(true);
    expect(surveyCloseWindowOk(plus(90 * DAY + 1), T0)).toBe(false);
    expect(surveyReminderDue({ closesAt: plus(25 * HOUR), reminderSentAt: null }, T0)).toBe(false);
    expect(surveyReminderDue({ closesAt: plus(24 * HOUR), reminderSentAt: null }, T0)).toBe(true);
    expect(surveyReminderDue({ closesAt: plus(HOUR), reminderSentAt: T0 }, T0)).toBe(false);
  });
});
