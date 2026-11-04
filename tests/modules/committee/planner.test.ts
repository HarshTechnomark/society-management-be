import { describe, expect, it } from 'vitest';
import {
  addDaysYmd,
  addYearsYmd,
  bannerFor,
  daysBetween,
  daysLeftOf,
  handoverReminderDay,
  reminderThreshold,
  sameFlags,
  seatFlags,
  duplicateProblem,
  isOverdueOf,
  missingOfficeBearers,
  nextSeatId,
  occupying,
  rangesOverlap,
  seatInvariantProblem,
  termLengthProblem,
  vacantDesignations,
} from '../../../src/modules/committee/committee.planner';
import { parseHandover, parseSeats } from '../../../src/modules/committee/committee.schemas';
import { DESIGNATION_ROLE, DESIGNATIONS } from '../../../src/modules/committee/committee.constants';
import { newSeat } from '../../../src/modules/committee/committee.seats';

const s = (seatId: string, designation: any, o: Record<string, unknown> = {}) =>
  newSeat({ seatId, name: `Person ${seatId}`, designation, userId: Number(seatId.slice(1)), ...o });

describe('dates (BR-10-2)', () => {
  it('date arithmetic on business dates', () => {
    expect(addDaysYmd('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDaysYmd('2024-03-01', -1)).toBe('2024-02-29');
    expect(daysBetween('2026-11-01', '2026-12-01')).toBe(30);
    expect(daysBetween('2026-11-03', '2026-11-01')).toBe(-2);
    expect(addYearsYmd('2024-04-01', 5)).toBe('2029-04-01');
  });

  it('a term lasts at least 30 days and at most maxTermYears years minus one day', () => {
    const t = (startDate: string, endDate: string, y = 5) => termLengthProblem({ startDate, endDate }, y);
    expect(t('2024-04-01', '2029-03-31')).toBeNull();
    expect(t('2024-04-01', '2029-04-01')).toMatch(/at most 5 years/);
    expect(t('2024-04-01', '2025-03-31', 1)).toBeNull();
    expect(t('2024-04-01', '2025-04-01', 1)).toMatch(/at most 1 year$/);
    expect(t('2024-04-01', '2024-04-30')).toMatch(/at least 30 days/);
    expect(t('2024-04-01', '2024-05-01')).toBeNull();
    expect(t('2024-04-01', '2024-04-01')).toMatch(/after the start/);
    expect(t('2024-04-01', '2024-03-01')).toMatch(/after the start/);
  });

  it('ranges overlap on shared days', () => {
    const r = (startDate: string, endDate: string) => ({ startDate, endDate });
    expect(rangesOverlap(r('2019-04-01', '2024-03-31'), r('2024-03-31', '2025-01-01'))).toBe(true);
    expect(rangesOverlap(r('2019-04-01', '2024-03-31'), r('2024-04-01', '2025-01-01'))).toBe(false);
  });
});

describe('seats (BR-10-4, BR-10-32, section 7.2)', () => {
  it('seat ids are max + 1 over every seat held, never reused', () => {
    expect(nextSeatId([])).toBe('S1');
    expect(nextSeatId([{ seatId: 'S1' }, { seatId: 'S9' }])).toBe('S10');
    expect(nextSeatId([{ seatId: 'S2' }, { seatId: 'S11' }, { seatId: 'S3' }])).toBe('S12');
  });

  it('office designations are unique among PLANNED and SEATED seats; one seat per user; MEMBER may repeat', () => {
    expect(duplicateProblem([s('S1', 'MEMBER'), s('S2', 'MEMBER')])).toBeNull();
    expect(duplicateProblem([s('S1', 'TREASURER'), s('S2', 'TREASURER')])).toMatchObject({
      code: 'COMMITTEE_DESIGNATION_DUPLICATE',
      seatIds: ['S1', 'S2'],
    });
    expect(
      duplicateProblem([s('S1', 'MEMBER', { userId: 7 }), s('S2', 'MEMBER', { userId: 7 })]),
    ).toMatchObject({
      code: 'COMMITTEE_HOLDER_DUPLICATE',
      seatIds: ['S1', 'S2'],
    });
    // a LEFT seat does not count
    const left = { status: 'LEFT', toDate: '2025-01-01', exitReason: 'RESIGNED', fromDate: '2024-04-01' };
    expect(duplicateProblem([s('S1', 'TREASURER', left), s('S2', 'TREASURER')])).toBeNull();
  });

  it('office bearers still needed and vacant designations', () => {
    expect(missingOfficeBearers([s('S1', 'CHAIRMAN'), s('S2', 'MEMBER')])).toEqual([
      'SECRETARY',
      'TREASURER',
    ]);
    expect(vacantDesignations([s('S1', 'CHAIRMAN', { status: 'SEATED' })])).toEqual([
      'SECRETARY',
      'TREASURER',
    ]);
    expect(vacantDesignations([s('S1', 'CHAIRMAN')])).toEqual(['CHAIRMAN', 'SECRETARY', 'TREASURER']);
  });

  it('seat invariants of section 7.2', () => {
    const left = (o: Record<string, unknown>) => s('S1', 'MEMBER', { status: 'LEFT', ...o });
    expect(
      seatInvariantProblem([left({ toDate: '2025-01-01', exitReason: 'RESIGNED' })], 'ACTIVE'),
    ).toBeNull();
    expect(seatInvariantProblem([left({})], 'ENDED')).toMatch(/LEFT seat needs/);
    expect(seatInvariantProblem([s('S1', 'MEMBER', { toDate: '2025-01-01' })], 'DRAFT')).toMatch(
      /only a LEFT/,
    );
    expect(
      seatInvariantProblem([s('S1', 'MEMBER', { status: 'SEATED', fromDate: '2024-04-01' })], 'ACTIVE'),
    ).toMatch(/memberId/);
    expect(seatInvariantProblem([s('S1', 'MEMBER')], 'ACTIVE')).toMatch(/PLANNED only in a DRAFT/);
    expect(seatInvariantProblem([s('S1', 'MEMBER')], 'DRAFT')).toBeNull();
    expect(
      seatInvariantProblem(
        [left({ fromDate: '2025-02-01', toDate: '2025-01-01', exitReason: 'RESIGNED' })],
        'ACTIVE',
      ),
    ).toMatch(/before fromDate/);
  });

  it('the stored JSON is parsed with the strict schemas and a malformed row is INTERNAL_ERROR', () => {
    expect(parseSeats(JSON.stringify([s('S1', 'MEMBER')]))).toHaveLength(1);
    expect(() => parseSeats([{ seatId: 'S1' }])).toThrowError(/malformed/);
    expect(() => parseSeats([{ ...s('S1', 'MEMBER'), extra: 1 }])).toThrowError(/malformed/);
    expect(() => parseHandover([{ itemId: 'H100' }])).toThrowError(/malformed/);
    try {
      parseSeats('nope');
    } catch (e: any) {
      expect(e.status).toBe(500);
      expect(e.code).toBe('INTERNAL_ERROR');
    }
  });

  it('DESIGNATION_ROLE maps each designation to a committee role (BR-10-6)', () => {
    expect(DESIGNATIONS).toHaveLength(6);
    expect(DESIGNATION_ROLE).toEqual({
      CHAIRMAN: 'chairman',
      VICE_CHAIRMAN: 'committee_member',
      SECRETARY: 'secretary',
      JOINT_SECRETARY: 'committee_member',
      TREASURER: 'treasurer',
      MEMBER: 'committee_member',
    });
  });
});

describe('read model and banner (8.1)', () => {
  const cur = (status: string, endDate: string) => ({ status, endDate });
  it('days left and overdue exist only for a current term', () => {
    expect(daysLeftOf(cur('ACTIVE', '2026-11-11'), '2026-11-01')).toBe(10);
    expect(daysLeftOf(cur('ACTIVE', '2026-10-30'), '2026-11-01')).toBe(-2);
    expect(daysLeftOf(cur('DRAFT', '2026-11-11'), '2026-11-01')).toBeNull();
    expect(daysLeftOf(cur('ENDED', '2026-11-11'), '2026-11-01')).toBeNull();
    expect(isOverdueOf(cur('ACTIVE', '2026-10-31'), '2026-11-01')).toBe(true);
    expect(isOverdueOf(cur('ACTIVE', '2026-11-01'), '2026-11-01')).toBe(false);
    expect(isOverdueOf(cur('ENDED', '2020-01-01'), '2026-11-01')).toBe(false);
  });

  it('banner priority: caretaker, election draft, 90 days, no committee', () => {
    const today = '2026-11-01';
    const election = { id: 9, source: 'ELECTION', electionId: 31 };
    expect(bannerFor(null, null, today)).toEqual({ code: 'NO_COMMITTEE' });
    expect(bannerFor(null, { id: 9, source: 'MANUAL', electionId: null }, today)).toEqual({
      code: 'NO_COMMITTEE',
    });
    expect(bannerFor(null, election, today)).toEqual({
      code: 'DRAFT_FROM_ELECTION',
      draftId: 9,
      electionId: 31,
    });
    expect(bannerFor(cur('ACTIVE', '2029-03-31'), null, today)).toBeNull();
    expect(bannerFor(cur('ACTIVE', '2027-01-30'), null, today)).toEqual({
      code: 'TERM_ENDING',
      daysLeft: 90,
    });
    expect(bannerFor(cur('ACTIVE', '2027-01-31'), null, today)).toBeNull();
    expect(bannerFor(cur('EXPIRED', '2026-10-01'), election, today)).toEqual({
      code: 'CARETAKER',
      endedOn: '2026-10-01',
    });
    expect(bannerFor(cur('ACTIVE', '2026-10-31'), null, today)).toEqual({
      code: 'CARETAKER',
      endedOn: '2026-10-31',
    });
  });

  it('holders at the end of an ended term are the seats closed with TERM_ENDED', () => {
    const left = (id: string, reason: string) =>
      s(id, 'MEMBER', { status: 'LEFT', toDate: '2025-01-01', exitReason: reason, fromDate: '2024-04-01' });
    const seats = [left('S1', 'TERM_ENDED'), left('S2', 'RESIGNED')];
    expect(occupying('ENDED', seats).map(x => x.seatId)).toEqual(['S1']);
    expect(occupying('DRAFT', [s('S3', 'MEMBER')])).toEqual([]);
  });
});

describe('reminder thresholds (T10-04, BR-10-24)', () => {
  const days = [90, 30, 7];
  it('days left 95, 90, 45, 29 and 6 with the last threshold sent give none, 90, none, 30, 7', () => {
    let last: number | null = null;
    const seq = [95, 90, 45, 29, 6].map(left => {
      const d = reminderThreshold(left, days, last);
      if (d !== null) last = d;
      return d;
    });
    expect(seq).toEqual([null, 90, null, 30, 7]);
  });
  it('only the smallest qualifying threshold is sent (a late start does not burst)', () => {
    expect(reminderThreshold(20, days, null)).toBe(30);
    expect(reminderThreshold(5, days, null)).toBe(7);
    expect(reminderThreshold(5, days, 7)).toBeNull();
    expect(reminderThreshold(5, days, 30)).toBe(7);
  });
  it('threshold 0 means the end date has passed and applies once, whatever was sent before', () => {
    expect(reminderThreshold(0, days, 7)).toBeNull();
    expect(reminderThreshold(-1, days, 7)).toBe(0);
    expect(reminderThreshold(-1, days, null)).toBe(0);
    expect(reminderThreshold(-30, days, 0)).toBeNull();
  });
  it('honours the society reminder days (any order)', () => {
    expect(reminderThreshold(40, [10, 45], null)).toBe(45);
    expect(reminderThreshold(8, [10, 45], 45)).toBe(10);
  });
  it('hand-over reminders: the largest reached day not yet sent', () => {
    expect(handoverReminderDay(14, [15, 30], null)).toBeNull();
    expect(handoverReminderDay(15, [15, 30], null)).toBe(15);
    expect(handoverReminderDay(16, [15, 30], 15)).toBeNull();
    expect(handoverReminderDay(31, [15, 30], null)).toBe(30);
    expect(handoverReminderDay(31, [15, 30], 30)).toBeNull();
  });
});

describe('seat flags (BR-10-25)', () => {
  const active = { membership: 'ACTIVE' as const, hasOwnerLink: true };
  it('a matching role, an active member and an owner link give no flag', () => {
    expect(seatFlags('TREASURER', { ...active, roleKey: 'treasurer' }, true)).toEqual([]);
    expect(seatFlags('VICE_CHAIRMAN', { ...active, roleKey: 'committee_member' }, true)).toEqual([]);
  });
  it('flags a role mismatch, a suspension and a missing owner link in canonical order', () => {
    expect(seatFlags('CHAIRMAN', { ...active, roleKey: 'owner' }, true)).toEqual(['ROLE_MISMATCH']);
    expect(
      seatFlags('MEMBER', { membership: 'SUSPENDED', roleKey: 'owner', hasOwnerLink: false }, true),
    ).toEqual(['ROLE_MISMATCH', 'MEMBERSHIP_SUSPENDED', 'NOT_OWNER']);
    expect(
      seatFlags('MEMBER', { ...active, hasOwnerLink: false, roleKey: 'committee_member' }, false),
    ).toEqual([]);
  });
  it('compares flag sets regardless of order', () => {
    expect(sameFlags(['NOT_OWNER', 'ROLE_MISMATCH'], ['ROLE_MISMATCH', 'NOT_OWNER'])).toBe(true);
    expect(sameFlags([], ['NOT_OWNER'])).toBe(false);
  });
});
