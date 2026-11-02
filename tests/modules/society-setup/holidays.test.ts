import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog, Holiday, closeDb } from '../../../src/models';
import { drainQueues } from '../../../src/lib/queue';
import { holidays } from '../../../src/modules/society-setup/society-setup.public';
import { idemKey, memberOf, resetSetup, setupSociety } from '../../helpers/society-setup';

afterAll(async () => {
  await drainQueues();
  await closeDb();
});
beforeEach(resetSetup);

const audits = (societyId: number, action: string) =>
  AuditLog.findAll({ where: { societyId, action }, order: [['id', 'ASC']] });
const add = (c: any, body: Record<string, unknown>, headers = idemKey()) =>
  c('post', '/holidays', body, { headers });
const diwali = { holidayDate: '2026-11-08', name: 'Diwali (Lakshmi Puja)' };

describe('POST /holidays (8.22, BR-08-42)', () => {
  it('adds a holiday with the defaults (FESTIVAL, office closed) and audits it', async () => {
    const { society, c } = await setupSociety();
    const r = await add(c, diwali);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toEqual({
      id: expect.any(Number),
      holidayDate: '2026-11-08',
      name: 'Diwali (Lakshmi Puja)',
      holidayType: 'FESTIVAL',
      isOfficeClosed: true,
      notes: null,
      version: 1,
    });
    const log = await audits(society.id!, 'setup.holiday.created');
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ entityType: 'holiday', entityLabel: 'Diwali (Lakshmi Puja)' });
  });

  it('one holiday per date (409 HOLIDAY_DATE_TAKEN), also for another type; another society is separate', async () => {
    const { society, c } = await setupSociety();
    await add(c, diwali);
    const dup = await add(c, { holidayDate: '2026-11-08', name: 'Society day', holidayType: 'SOCIETY' });
    expect([dup.status, dup.body.code]).toEqual([409, 'HOLIDAY_DATE_TAKEN']);
    const other = await setupSociety({ name: 'Other CHS' });
    expect((await add(other.c, diwali)).status).toBe(201);
    expect(await Holiday.count({ where: { societyId: society.id! } })).toBe(1);
  });

  it('validates the name, the type, the date and the year range (previous, current and next two years)', async () => {
    const { c } = await setupSociety(); // the clock is frozen in 2026
    const code = async (body: Record<string, unknown>) => {
      const r = await add(c, { ...diwali, ...body });
      return [r.status, r.body.code];
    };
    expect(await code({ name: 'D' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code({ name: 'x'.repeat(81) })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code({ holidayType: 'WEDDING' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code({ holidayDate: '08-11-2026' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code({ holidayDate: '2026-02-30' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code({ notes: 'n'.repeat(301) })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code({ holidayDate: '2024-12-31' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code({ holidayDate: '2029-01-01' })).toEqual([400, 'VALIDATION_FAILED']);
    expect(await code({ holidayDate: '2025-01-01', name: 'Last year' })).toEqual([201, undefined]);
    expect(await code({ holidayDate: '2028-12-31', name: 'Two years on' })).toEqual([201, undefined]);
    expect(await code({ extra: 1 })).toEqual([400, 'VALIDATION_FAILED']);
  });

  it('needs an Idempotency-Key (the same key replays) and settings.society.edit', async () => {
    const { society, c } = await setupSociety();
    expect((await c('post', '/holidays', diwali)).status).toBe(400);
    const headers = idemKey();
    const a = await add(c, diwali, headers);
    const b = await add(c, diwali, headers);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body.data.id).toBe(a.body.data.id);
    const m = await memberOf(society, 'committee_member');
    expect((await add(m.c, { holidayDate: '2026-12-25', name: 'Christmas' })).status).toBe(403);
    expect((await m.c('get', '/holidays')).status).toBe(200);
  });
});

describe('POST /holidays/bulk (8.22)', () => {
  const items = (dates: string[]) =>
    dates.map((holidayDate, i) => ({ holidayDate, name: `Holiday ${i + 1}` }));
  const bulk = (c: any, body: unknown) => c('post', '/holidays/bulk', body, { headers: idemKey() });

  it('adds many, skips dates that already exist and reports them; one audit row per created holiday', async () => {
    const { society, c } = await setupSociety();
    await add(c, { holidayDate: '2026-08-15', name: 'Independence Day', holidayType: 'NATIONAL' });
    const r = await bulk(c, { items: items(['2026-01-26', '2026-08-15', '2026-10-02', '2026-01-26']) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.data).toEqual({ created: 2, skipped: ['2026-08-15', '2026-01-26'] }); // the second 26 Jan of the request is a repeat
    expect(await Holiday.count({ where: { societyId: society.id! } })).toBe(3);
    expect(await audits(society.id!, 'setup.holiday.created')).toHaveLength(3);
  });

  it('refuses the whole request for 0 or more than 60 items or a bad item, and writes nothing', async () => {
    const { society, c } = await setupSociety();
    expect((await bulk(c, { items: [] })).status).toBe(400);
    const sixtyOne = Array.from({ length: 61 }, (_, i) => ({
      holidayDate: `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + Math.floor(i / 12)).padStart(2, '0')}`,
      name: `Holiday ${i}`,
    }));
    expect((await bulk(c, { items: sixtyOne })).status).toBe(400);
    const bad = await bulk(c, {
      items: [
        { holidayDate: '2026-01-26', name: 'Republic Day' },
        { holidayDate: '2031-01-26', name: 'Far away' },
      ],
    });
    expect([bad.status, bad.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(await Holiday.count({ where: { societyId: society.id! } })).toBe(0);
    const sixty = sixtyOne.slice(0, 60);
    expect((await bulk(c, { items: sixty })).body.data.created).toBe(60);
  });
});

describe('GET /holidays and /holidays/suggestions (8.22)', () => {
  it('lists the holidays of a year by date with the weekly off days; the year defaults to the current one and is range checked', async () => {
    const { c } = await setupSociety();
    await add(c, { holidayDate: '2026-11-08', name: 'Diwali' });
    await add(c, { holidayDate: '2026-01-26', name: 'Republic Day', holidayType: 'NATIONAL' });
    await add(c, {
      holidayDate: '2027-01-26',
      name: 'Republic Day 2027',
      isOfficeClosed: false,
      notes: 'Flag hoisting',
    });
    const r = await c('get', '/holidays');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.items.map((h: any) => h.holidayDate)).toEqual(['2026-01-26', '2026-11-08']);
    expect(r.body.data.weeklyOffDays).toEqual([0]);
    const next = await c('get', '/holidays', undefined, { query: { year: '2027' } });
    expect(next.body.data.items).toEqual([
      expect.objectContaining({ name: 'Republic Day 2027', isOfficeClosed: false, notes: 'Flag hoisting' }),
    ]);
    expect((await c('get', '/holidays', undefined, { query: { year: '2024' } })).body.code).toBe(
      'VALIDATION_FAILED',
    );
    expect((await c('get', '/holidays', undefined, { query: { year: '2029' } })).status).toBe(400);
    expect((await c('get', '/holidays', undefined, { query: { year: 'abc' } })).status).toBe(400);
  });

  it('suggestions list national and festival holidays of the year and mark the ones already added', async () => {
    const { c } = await setupSociety();
    await add(c, { holidayDate: '2026-01-26', name: 'Republic Day', holidayType: 'NATIONAL' });
    const r = await c('get', '/holidays/suggestions');
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const items = r.body.data.items as {
      date: string;
      name: string;
      holidayType: string;
      alreadyAdded: boolean;
    }[];
    expect(items.length).toBeGreaterThan(8);
    expect(items.find(i => i.date === '2026-01-26')).toMatchObject({
      name: 'Republic Day',
      holidayType: 'NATIONAL',
      alreadyAdded: true,
    });
    expect(items.find(i => i.date === '2026-08-15')).toMatchObject({
      name: 'Independence Day',
      holidayType: 'NATIONAL',
      alreadyAdded: false,
    });
    expect(items.find(i => i.date === '2026-10-02')!.name).toBe('Gandhi Jayanti');
    expect(items.find(i => i.date === '2026-11-08')).toMatchObject({
      name: 'Diwali (Lakshmi Puja)',
      holidayType: 'FESTIVAL',
    });
    expect(items.map(i => i.date)).toEqual([...items.map(i => i.date)].sort());
    for (const year of ['2027', '2028']) {
      const y = await c('get', '/holidays/suggestions', undefined, { query: { year } });
      expect(y.body.data.items.some((i: any) => i.date === `${year}-01-26`)).toBe(true);
    }
    expect(
      (await c('get', '/holidays/suggestions', undefined, { query: { year: '2025' } })).body.data.items,
    ).toEqual([]);
    // the suggestions can be posted as they are
    const bulk = await c(
      'post',
      '/holidays/bulk',
      {
        items: items
          .filter(i => !i.alreadyAdded)
          .map(i => ({ holidayDate: i.date, name: i.name, holidayType: i.holidayType })),
      },
      { headers: idemKey() },
    );
    expect(bulk.status, JSON.stringify(bulk.body)).toBe(201);
    expect((await c('get', '/holidays/suggestions')).body.data.items.every((i: any) => i.alreadyAdded)).toBe(
      true,
    );
  });
});

describe('PATCH and DELETE /holidays/:id (8.22)', () => {
  it('edits fields, moves the date, audits changes and bumps the version', async () => {
    const { society, c } = await setupSociety();
    const h = (await add(c, diwali)).body.data;
    const r = await c('patch', `/holidays/${h.id}`, {
      version: 1,
      name: 'Diwali Day 1',
      holidayType: 'SOCIETY',
      isOfficeClosed: false,
      notes: 'Half day',
      holidayDate: '2026-11-09',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data).toMatchObject({
      name: 'Diwali Day 1',
      holidayType: 'SOCIETY',
      isOfficeClosed: false,
      notes: 'Half day',
      holidayDate: '2026-11-09',
      version: 2,
    });
    const log = await audits(society.id!, 'setup.holiday.updated');
    expect(Object.keys(log[0]!.after as object).sort()).toEqual([
      'holidayDate',
      'holidayType',
      'isOfficeClosed',
      'name',
      'notes',
    ]);
    const same = await c('patch', `/holidays/${h.id}`, { version: 2, name: 'Diwali Day 1' });
    expect(same.body.data.version).toBe(2);
    expect(await audits(society.id!, 'setup.holiday.updated')).toHaveLength(1);
  });

  it('STALE_VERSION, HOLIDAY_DATE_TAKEN on a used date, HOLIDAY_NOT_FOUND and the year range', async () => {
    const { c } = await setupSociety();
    const a = (await add(c, diwali)).body.data;
    await add(c, { holidayDate: '2026-12-25', name: 'Christmas' });
    expect((await c('patch', `/holidays/${a.id}`, { version: 3, name: 'Other' })).body.code).toBe(
      'STALE_VERSION',
    );
    const clash = await c('patch', `/holidays/${a.id}`, { version: 1, holidayDate: '2026-12-25' });
    expect([clash.status, clash.body.code]).toEqual([409, 'HOLIDAY_DATE_TAKEN']);
    expect((await c('patch', `/holidays/${a.id}`, { version: 1, holidayDate: '2031-12-25' })).body.code).toBe(
      'VALIDATION_FAILED',
    );
    expect((await c('patch', '/holidays/99999999', { version: 1, name: 'Nope' })).body.code).toBe(
      'HOLIDAY_NOT_FOUND',
    );
  });

  it('deletes a holiday (204) and audits it with the old values; unknown and other societies ids are 404', async () => {
    const { society, c } = await setupSociety();
    const a = (await add(c, diwali)).body.data;
    const other = await setupSociety({ name: 'Other CHS' });
    expect((await other.c('delete', `/holidays/${a.id}`)).body.code).toBe('HOLIDAY_NOT_FOUND');
    expect((await c('delete', `/holidays/${a.id}`)).status).toBe(204);
    expect(await Holiday.count({ where: { societyId: society.id! } })).toBe(0);
    expect((await audits(society.id!, 'setup.holiday.deleted'))[0]!.before).toMatchObject({
      holidayDate: '2026-11-08',
    });
    expect((await c('delete', `/holidays/${a.id}`)).body.code).toBe('HOLIDAY_NOT_FOUND');
  });
});

describe('working-day helpers (8.30, BR-08-42)', () => {
  async function calendar() {
    const s = await setupSociety();
    await s.c(
      'post',
      '/holidays/bulk',
      {
        items: [
          { holidayDate: '2026-11-08', name: 'Diwali (Lakshmi Puja)' }, // a Sunday
          { holidayDate: '2026-11-10', name: 'Diwali Day 2' }, // a Tuesday
          { holidayDate: '2026-11-11', name: 'Listed only', isOfficeClosed: false },
        ],
      },
      { headers: idemKey() },
    );
    return s;
  }
  const setOff = (c: any, days: number[], version = 0) =>
    c('patch', '/society/settings', { changes: [{ key: 'office.weeklyOffDays', value: days, version }] });

  it('US-08-10 an office-closed holiday is not a working day; a listed-only holiday and ordinary days are; Sundays are off by default', async () => {
    const { society } = await calendar();
    const id = society.id!;
    expect(await holidays.isHoliday(id, '2026-11-10')).toBe(true);
    expect(await holidays.isWorkingDay(id, '2026-11-10')).toBe(false);
    expect(await holidays.isHoliday(id, '2026-11-11')).toBe(false);
    expect(await holidays.isWorkingDay(id, '2026-11-11')).toBe(true);
    expect(await holidays.isWorkingDay(id, '2026-11-09')).toBe(true); // Monday
    expect(await holidays.isWorkingDay(id, '2026-11-07')).toBe(true); // Saturday
    expect(await holidays.isWorkingDay(id, '2026-11-08')).toBe(false); // Sunday and Diwali
    expect(await holidays.isWorkingDay(id, '2026-11-15')).toBe(false); // an ordinary Sunday
  });

  it('a holiday on a weekly off day is allowed and the day is off either way', async () => {
    const { c, society } = await calendar();
    expect((await add(c, { holidayDate: '2026-11-15', name: 'Society picnic' })).status).toBe(201);
    expect(await holidays.isWorkingDay(society.id!, '2026-11-15')).toBe(false);
  });

  it('follows the office.weeklyOffDays setting', async () => {
    const { c, society } = await calendar();
    expect((await setOff(c, [0, 6])).status).toBe(200);
    expect(await holidays.isWorkingDay(society.id!, '2026-11-07')).toBe(false);
    expect((await setOff(c, [], 1)).status).toBe(200);
    expect(await holidays.isWorkingDay(society.id!, '2026-11-15')).toBe(true);
  });

  it('nextWorkingDay returns the date itself when it works, else the next working day (due dates on holidays)', async () => {
    const { society } = await calendar();
    const id = society.id!;
    expect(await holidays.nextWorkingDay(id, '2026-11-09')).toBe('2026-11-09');
    expect(await holidays.nextWorkingDay(id, '2026-11-08')).toBe('2026-11-09');
    expect(await holidays.nextWorkingDay(id, '2026-11-10')).toBe('2026-11-11'); // the listed-only day works
    expect(await holidays.nextWorkingDay(id, '2026-11-14')).toBe('2026-11-14');
    expect(await holidays.nextWorkingDay(id, '2026-11-15')).toBe('2026-11-16');
  });

  it('nextWorkingDay searches at most 30 days, then returns the 30th day', async () => {
    const { c, society } = await setupSociety();
    expect(
      (
        await c('patch', '/society/settings', {
          changes: [{ key: 'office.weeklyOffDays', value: [0, 1], version: 0 }],
        })
      ).status,
    ).toBe(200);
    // close 31 days in a row from 2026-11-02 (a Monday) so that no working day is within reach
    const days = Array.from({ length: 31 }, (_, i) =>
      new Date(Date.UTC(2026, 10, 2 + i)).toISOString().slice(0, 10),
    );
    for (let i = 0; i < days.length; i += 20)
      await c(
        'post',
        '/holidays/bulk',
        { items: days.slice(i, i + 20).map(holidayDate => ({ holidayDate, name: 'Long closure' })) },
        { headers: idemKey() },
      );
    expect(await holidays.nextWorkingDay(society.id!, '2026-11-02')).toBe('2026-12-02');
    expect(await holidays.nextWorkingDay(society.id!, '2026-12-03')).toBe('2026-12-03');
  });

  it('T08-32 addWorkingDays: 2026-11-06 plus 2 days with Saturday and Sunday off and Diwali on the 8th is 2026-11-10', async () => {
    const { c, society } = await setupSociety();
    await add(c, diwali);
    await setOff(c, [0, 6]);
    // Sat 7 off, Sun 8 off and a holiday, Mon 9 is day 1, Tue 10 is day 2
    expect(await holidays.addWorkingDays(society.id!, '2026-11-06', 2)).toBe('2026-11-10');
    expect(await holidays.addWorkingDays(society.id!, '2026-11-06', 1)).toBe('2026-11-09');
  });

  it('addWorkingDays: Sunday off only gives Saturday as a working day; 0 days is the date itself; the closed Tuesday is skipped', async () => {
    const { society } = await calendar();
    const id = society.id!;
    expect(await holidays.addWorkingDays(id, '2026-11-06', 2)).toBe('2026-11-09'); // Sat 7, (Sun 8 off), Mon 9
    expect(await holidays.addWorkingDays(id, '2026-11-06', 0)).toBe('2026-11-06');
    expect(await holidays.addWorkingDays(id, '2026-11-09', 1)).toBe('2026-11-11'); // Tue 10 is closed
    expect(await holidays.addWorkingDays(id, '2026-11-09', 5)).toBe('2026-11-16');
    await expect(holidays.addWorkingDays(id, '2026-11-09', 366)).rejects.toThrow();
    await expect(holidays.addWorkingDays(id, '2026-11-09', -1)).rejects.toThrow();
    expect(await holidays.addWorkingDays(id, '2026-11-09', 365)).toMatch(/^2028-01/);
  });

  it('listBetween returns the holidays of a range of at most 400 days, by date, for one society', async () => {
    const { society } = await calendar();
    const other = await setupSociety({ name: 'Other CHS' });
    const list = await holidays.listBetween(society.id!, '2026-11-01', '2026-11-30');
    expect(list.map(h => h.holidayDate)).toEqual(['2026-11-08', '2026-11-10', '2026-11-11']);
    expect(list[2]).toMatchObject({ isOfficeClosed: false, holidayType: 'FESTIVAL', name: 'Listed only' });
    expect(await holidays.listBetween(other.society.id!, '2026-11-01', '2026-11-30')).toEqual([]);
    await expect(holidays.listBetween(society.id!, '2026-01-01', '2027-03-01')).rejects.toThrow();
    await expect(holidays.listBetween(society.id!, '2026-11-30', '2026-11-01')).rejects.toThrow();
    expect(await holidays.listBetween(society.id!, '2026-01-01', '2027-02-04')).toHaveLength(3); // exactly 400 days
  });
});
