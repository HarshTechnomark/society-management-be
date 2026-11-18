import { describe, expect, it } from 'vitest';
import {
  addBusinessMinutes,
  addOnCalendar,
  calendarMinutesBetween,
  endPause,
  escalationFireTime,
  nextSlaCheck,
  slaDue,
  slaState,
  ymdOf,
} from '../../../src/modules/helpdesk/helpdesk.sla';
import type { BusinessCalendar } from '../../../src/modules/helpdesk/helpdesk.types';

/** IST 2026-11-DD HH:MM as an instant. */
const ist = (d: string, hhmm: string): Date => new Date(`${d}T${hhmm}:00+05:30`);

/** Office 09:00 to 18:00, Sunday off; 2026-11-16 (Monday) is a holiday. 2026-11-13 is a Friday. */
const cal: BusinessCalendar = {
  openTime: '09:00',
  closeTime: '18:00',
  isWorkingDay: ymd => new Date(`${ymd}T00:00:00Z`).getUTCDay() !== 0 && ymd !== '2026-11-16',
};

describe('business minutes (BR-15-25)', () => {
  it('T15-01: Friday 17:00 + 180 minutes with Sunday off and a Monday holiday is Saturday 11:00', async () => {
    expect(new Date('2026-11-13T00:00:00Z').getUTCDay()).toBe(5);
    expect((await addBusinessMinutes(ist('2026-11-13', '17:00'), 180, cal)).toISOString()).toBe(
      ist('2026-11-14', '11:00').toISOString(),
    );
  });
  it('T15-02: the same start on a 24x7 calendar is Friday 20:00', async () => {
    expect((await addOnCalendar(ist('2026-11-13', '17:00'), 180, 'TWENTY_FOUR_SEVEN')).toISOString()).toBe(
      ist('2026-11-13', '20:00').toISOString(),
    );
  });
  it('skips Sunday and the Monday holiday to Tuesday', async () => {
    // Saturday 17:30 + 60: 30 minutes left on Saturday, then Tuesday 09:30 (Sunday off, Monday holiday)
    expect((await addBusinessMinutes(ist('2026-11-14', '17:30'), 60, cal)).toISOString()).toBe(
      ist('2026-11-17', '09:30').toISOString(),
    );
  });
  it('a start before opening or after closing moves to the next open minute', async () => {
    expect((await addBusinessMinutes(ist('2026-11-13', '07:00'), 30, cal)).toISOString()).toBe(
      ist('2026-11-13', '09:30').toISOString(),
    );
    expect((await addBusinessMinutes(ist('2026-11-13', '18:30'), 30, cal)).toISOString()).toBe(
      ist('2026-11-14', '09:30').toISOString(),
    );
    // exactly at closing: next day opening plus the minutes
    expect((await addBusinessMinutes(ist('2026-11-13', '18:00'), 15, cal)).toISOString()).toBe(
      ist('2026-11-14', '09:15').toISOString(),
    );
  });
  it('a calendar with no working day throws INTERNAL_ERROR instead of looping', async () => {
    await expect(
      addBusinessMinutes(ist('2026-11-13', '10:00'), 30, { ...cal, isWorkingDay: () => false }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    await expect(
      addBusinessMinutes(ist('2026-11-13', '10:00'), 30, { ...cal, closeTime: '08:00' }),
    ).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  });
  it('counts open minutes between two instants', async () => {
    expect(
      await calendarMinutesBetween(
        ist('2026-11-13', '17:00'),
        ist('2026-11-14', '10:00'),
        'BUSINESS_HOURS',
        cal,
      ),
    ).toBe(60 + 60);
    expect(
      await calendarMinutesBetween(
        ist('2026-11-14', '17:00'),
        ist('2026-11-17', '10:00'),
        'BUSINESS_HOURS',
        cal,
      ),
    ).toBe(60 + 60);
    expect(
      await calendarMinutesBetween(
        ist('2026-11-13', '10:00'),
        ist('2026-11-13', '10:00'),
        'BUSINESS_HOURS',
        cal,
      ),
    ).toBe(0);
    expect(
      await calendarMinutesBetween(
        ist('2026-11-15', '10:00'),
        ist('2026-11-15', '15:00'),
        'BUSINESS_HOURS',
        cal,
      ),
    ).toBe(0);
  });
  it('reads the IST date of an instant', () => {
    expect(ymdOf(new Date('2026-11-13T19:00:00Z'))).toBe('2026-11-14');
  });
});

describe('due times and pauses (BR-15-26, BR-15-28)', () => {
  const snap = { slaCalendar: 'TWENTY_FOUR_SEVEN' as const, responseMinutes: 720, resolutionMinutes: 4320 };
  it('due = start + minutes (+ paused minutes for the resolution)', async () => {
    const start = ist('2026-11-10', '10:00');
    const d = await slaDue(snap, start, 0);
    expect(d.responseDueAt.toISOString()).toBe(ist('2026-11-10', '22:00').toISOString());
    expect(d.resolutionDueAt.toISOString()).toBe(ist('2026-11-13', '10:00').toISOString());
    expect((await slaDue(snap, start, 1440)).resolutionDueAt.toISOString()).toBe(
      ist('2026-11-14', '10:00').toISOString(),
    );
  });
  it('T15-03 / US-15-05: paused 10 Nov 10:00 to 11 Nov 10:00 gives 1440 minutes and a due date 14 Nov 10:00', async () => {
    const r = await endPause(
      {
        slaCalendar: 'TWENTY_FOUR_SEVEN',
        resolutionMinutes: 4320,
        slaStartAt: ist('2026-11-10', '10:00'),
        slaPausedAt: ist('2026-11-10', '10:00'),
        slaPausedMinutes: 0,
      },
      ist('2026-11-11', '10:00'),
    );
    expect(r.slaPausedMinutes).toBe(1440);
    expect(r.resolutionDueAt.toISOString()).toBe(ist('2026-11-14', '10:00').toISOString());
  });
  it('a business-hours pause counts only open minutes', async () => {
    const r = await endPause(
      {
        slaCalendar: 'BUSINESS_HOURS',
        resolutionMinutes: 540,
        slaStartAt: ist('2026-11-13', '09:00'),
        slaPausedAt: ist('2026-11-13', '17:00'),
        slaPausedMinutes: 30,
      },
      ist('2026-11-14', '10:00'),
      cal,
    );
    expect(r.slaPausedMinutes).toBe(30 + 60 + 60);
    // 540 + 150 business minutes from Friday 09:00: Friday 540, Saturday 150 -> 11:30
    expect(r.resolutionDueAt.toISOString()).toBe(ist('2026-11-14', '11:30').toISOString());
  });
});

describe('SLA state, fire times and the sweep cursor', () => {
  const base = { slaStartAt: ist('2026-11-10', '10:00'), resolutionDueAt: ist('2026-11-10', '14:00') };
  it('BR-15-32 states', () => {
    const at = ist('2026-11-10', '11:00');
    expect(slaState({ ...base, status: 'CANCELLED', resolutionBreached: false }, at)).toBe('NONE');
    expect(slaState({ ...base, status: 'RESOLVED', resolutionBreached: false }, at)).toBe('MET');
    expect(slaState({ ...base, status: 'CLOSED', resolutionBreached: true }, at)).toBe('BREACHED');
    expect(slaState({ ...base, status: 'WAITING_ON_RESIDENT', resolutionBreached: false }, at)).toBe(
      'PAUSED',
    );
    expect(slaState({ ...base, status: 'IN_PROGRESS', resolutionBreached: true }, at)).toBe('BREACHED');
    expect(slaState({ ...base, status: 'IN_PROGRESS', resolutionBreached: false }, at)).toBe('ON_TRACK');
    expect(
      slaState({ ...base, status: 'IN_PROGRESS', resolutionBreached: false }, ist('2026-11-10', '13:30')),
    ).toBe('AT_RISK');
  });
  it('BR-15-59: rule fire time = start + ceil(minutes x percent / 100) + paused (resolution only)', async () => {
    const t = {
      slaStartAt: ist('2026-11-10', '10:00'),
      slaCalendar: 'TWENTY_FOUR_SEVEN' as const,
      slaPausedMinutes: 30,
    };
    expect((await escalationFireTime(t, 240, 75, 'RESOLUTION_SLA')).toISOString()).toBe(
      ist('2026-11-10', '13:30').toISOString(),
    );
    expect((await escalationFireTime(t, 240, 100, 'RESPONSE_SLA')).toISOString()).toBe(
      ist('2026-11-10', '14:00').toISOString(),
    );
    expect(
      (await escalationFireTime({ ...t, slaPausedMinutes: 0 }, 7, 25, 'RESOLUTION_SLA')).toISOString(),
    ).toBe(ist('2026-11-10', '10:02').toISOString());
  });
  it('6.4: the cursor is the earliest pending time and NULL when settled or paused', () => {
    const t = {
      status: 'ASSIGNED' as const,
      firstResponseAt: null,
      responseBreached: false,
      resolutionBreached: false,
      responseDueAt: ist('2026-11-10', '10:30'),
      resolutionDueAt: ist('2026-11-10', '14:00'),
    };
    expect(nextSlaCheck(t, [ist('2026-11-10', '13:00')])?.toISOString()).toBe(
      ist('2026-11-10', '10:30').toISOString(),
    );
    expect(
      nextSlaCheck({ ...t, firstResponseAt: ist('2026-11-10', '10:10') }, [
        ist('2026-11-10', '13:00'),
      ])?.toISOString(),
    ).toBe(ist('2026-11-10', '13:00').toISOString());
    expect(nextSlaCheck({ ...t, firstResponseAt: new Date(), resolutionBreached: true }, [])).toBeNull();
    for (const s of ['RESOLVED', 'CLOSED', 'CANCELLED', 'WAITING_ON_RESIDENT'] as const)
      expect(nextSlaCheck({ ...t, status: s }, [new Date()])).toBeNull();
  });
});
