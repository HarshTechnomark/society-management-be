import { Op } from 'sequelize';
import { Holiday, sequelize } from '../../models';
import { istDate, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { audit } from '../../utils/audit';
import { AppError, ValidationError, type FieldError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { HOLIDAY_SUGGESTIONS } from './society-setup.holiday-suggestions';
import { get as getSetting } from './society-setup.settings.service';
import {
  addDaysYmd,
  holidayNotFound,
  isUniqueViolation,
  staleVersion,
  weekdayOf,
} from './society-setup.shared';
import { AUDIT, ENTITY, type HolidayDto } from './society-setup.types';
import type { HolidayType } from '../../models/holiday.model';

/** Holiday calendar and working-day helpers (module 08 sections 5.8, 8.22, 8.30). Dates are society-local `YYYY-MM-DD`. */
const dateTaken = () =>
  new AppError(409, 'HOLIDAY_DATE_TAKEN', 'There is already a holiday on this date', [
    { field: 'holidayDate', message: 'Already a holiday' },
  ]);

const view = (h: Holiday): HolidayDto => ({
  id: h.id!,
  holidayDate: h.holidayDate,
  name: h.name,
  holidayType: h.holidayType,
  isOfficeClosed: Boolean(h.isOfficeClosed),
  notes: h.notes,
  version: h.version,
});

/** Current year in the society's calendar (the platform default time zone is Asia/Kolkata). */
const currentYear = (): number => Number(istDate(now()).slice(0, 4));

/** BR-08-42: the previous, current or next two calendar years. */
export function assertYearInRange(year: number, field = 'year'): void {
  const y = currentYear();
  if (year < y - 1 || year > y + 2)
    throw new ValidationError([{ field, message: `Use a year from ${y - 1} to ${y + 2}` }]);
}

// ------------------------------------------------------------------ list and suggestions (8.22)
export async function listYear(societyId: number, year?: number) {
  const y = year ?? currentYear();
  assertYearInRange(y);
  const rows = await Holiday.findAll({
    where: { societyId, holidayDate: { [Op.between]: [`${y}-01-01`, `${y}-12-31`] } },
    order: [['holidayDate', 'ASC']],
  });
  return {
    items: rows.map(view),
    weeklyOffDays: (await getSetting(societyId, 'office.weeklyOffDays')) as number[],
  };
}

export async function suggestions(societyId: number, year?: number) {
  const y = year ?? currentYear();
  assertYearInRange(y);
  const added = new Set(
    (
      await Holiday.findAll({
        where: { societyId, holidayDate: { [Op.between]: [`${y}-01-01`, `${y}-12-31`] } },
        attributes: ['holidayDate'],
      })
    ).map(h => h.holidayDate),
  );
  return {
    items: (HOLIDAY_SUGGESTIONS[y] ?? [])
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map(s => ({ ...s, isOfficeClosed: true, alreadyAdded: added.has(s.date) })),
  };
}

// ------------------------------------------------------------------ writes
export interface HolidayInput {
  holidayDate: string;
  name: string;
  holidayType?: HolidayType;
  isOfficeClosed?: boolean;
  notes?: string | null;
}

function checkDate(date: string, field: string): void {
  const d = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date)
    throw new ValidationError([{ field, message: 'Not a real date' }]);
  assertYearInRange(Number(date.slice(0, 4)), field);
}

async function createRow(ctx: Ctx, societyId: number, i: HolidayInput, t: import('sequelize').Transaction) {
  const h = await Holiday.create(
    {
      societyId,
      holidayDate: i.holidayDate,
      name: i.name,
      holidayType: i.holidayType ?? 'FESTIVAL',
      isOfficeClosed: i.isOfficeClosed ?? true,
      notes: i.notes ?? null,
      version: 1,
      createdBy: ctx.user?.id ?? null,
      updatedBy: ctx.user?.id ?? null,
    },
    { transaction: t },
  );
  await audit(
    ctx,
    {
      action: AUDIT.holidayCreated,
      entityType: ENTITY.holiday,
      entityId: h.id!,
      entityLabel: h.name,
      societyId,
      after: view(h),
    },
    t,
  );
  return h;
}

export async function createHoliday(ctx: Ctx, societyId: number, input: HolidayInput): Promise<HolidayDto> {
  checkDate(input.holidayDate, 'holidayDate');
  try {
    return view(await sequelize.transaction(t => createRow(ctx, societyId, input, t)));
  } catch (err) {
    if (isUniqueViolation(err)) throw dateTaken();
    throw err;
  }
}

export async function bulkCreate(ctx: Ctx, societyId: number, items: HolidayInput[]) {
  const errors: FieldError[] = [];
  items.forEach((it, idx) => {
    try {
      checkDate(it.holidayDate, `items.${idx}.holidayDate`);
    } catch (err) {
      if (err instanceof ValidationError) errors.push(...err.errors!);
      else throw err;
    }
  });
  if (errors.length) throw new ValidationError(errors);
  return sequelize.transaction(async t => {
    const dates = [...new Set(items.map(i => i.holidayDate))];
    const have = new Set(
      (
        await Holiday.findAll({
          where: { societyId, holidayDate: { [Op.in]: dates } },
          attributes: ['holidayDate'],
          transaction: t,
        })
      ).map(h => h.holidayDate),
    );
    const skipped: string[] = [];
    let created = 0;
    for (const it of items) {
      if (have.has(it.holidayDate)) {
        if (!skipped.includes(it.holidayDate)) skipped.push(it.holidayDate);
        continue;
      }
      await createRow(ctx, societyId, it, t);
      have.add(it.holidayDate);
      created += 1;
    }
    return { created, skipped };
  });
}

export type PatchHolidayInput = Partial<HolidayInput> & { version: number };

export async function patchHoliday(
  ctx: Ctx,
  societyId: number,
  id: number,
  input: PatchHolidayInput,
): Promise<HolidayDto> {
  if (input.holidayDate !== undefined) checkDate(input.holidayDate, 'holidayDate');
  try {
    return await sequelize.transaction(async t => {
      const h = await Holiday.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
      if (!h) throw holidayNotFound();
      if (h.version !== input.version) throw staleVersion('This holiday');
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      for (const k of ['holidayDate', 'name', 'holidayType', 'isOfficeClosed', 'notes'] as const) {
        const v = input[k];
        if (v === undefined || (h[k] as unknown) === v) continue;
        before[k] = h[k];
        after[k] = v;
        (h as unknown as Record<string, unknown>)[k] = v;
      }
      if (!Object.keys(after).length) return view(h);
      h.version += 1;
      h.updatedBy = ctx.user?.id ?? null;
      await h.save({ transaction: t });
      await audit(
        ctx,
        {
          action: AUDIT.holidayUpdated,
          entityType: ENTITY.holiday,
          entityId: h.id!,
          entityLabel: h.name,
          societyId,
          before,
          after,
        },
        t,
      );
      return view(h);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw dateTaken();
    throw err;
  }
}

export async function deleteHoliday(ctx: Ctx, societyId: number, id: number): Promise<void> {
  await sequelize.transaction(async t => {
    const h = await Holiday.findOne({ where: { id, societyId }, transaction: t, lock: t.LOCK.UPDATE });
    if (!h) throw holidayNotFound();
    const row = view(h);
    await h.destroy({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.holidayDeleted,
        entityType: ENTITY.holiday,
        entityId: row.id,
        entityLabel: row.name,
        societyId,
        before: row,
      },
      t,
    );
  });
}

// ------------------------------------------------------------------ working days (8.30)
async function closedDates(societyId: number, from: string, to: string): Promise<Set<string>> {
  const rows = await Holiday.findAll({
    where: { societyId, isOfficeClosed: true, holidayDate: { [Op.between]: [from, to] } },
    attributes: ['holidayDate'],
  });
  return new Set(rows.map(r => r.holidayDate));
}

/** An office-closed holiday falls on the date. */
export async function isHoliday(societyId: number, date: string): Promise<boolean> {
  return (await closedDates(societyId, date, date)).has(date);
}

/** BR-08-42: not a weekly off day and not an office-closed holiday. */
export async function isWorkingDay(societyId: number, date: string): Promise<boolean> {
  const off = (await getSetting(societyId, 'office.weeklyOffDays')) as number[];
  if (off.includes(weekdayOf(date))) return false;
  return !(await isHoliday(societyId, date));
}

const SEARCH_DAYS = 30;

/** The date itself when it is a working day; searches at most 30 days, then returns the 30th day and logs a warning. */
export async function nextWorkingDay(societyId: number, date: string): Promise<string> {
  const off = (await getSetting(societyId, 'office.weeklyOffDays')) as number[];
  const closed = await closedDates(societyId, date, addDaysYmd(date, SEARCH_DAYS));
  for (let i = 0; i <= SEARCH_DAYS; i++) {
    const d = addDaysYmd(date, i);
    if (!off.includes(weekdayOf(d)) && !closed.has(d)) return d;
  }
  logger.warn({ societyId, date }, 'no working day within 30 days; returning the 30th day');
  return addDaysYmd(date, SEARCH_DAYS);
}

/** The date after `n` working days (n from 0 to 365; 0 gives the date itself). */
export async function addWorkingDays(societyId: number, date: string, n: number): Promise<string> {
  if (!Number.isInteger(n) || n < 0 || n > 365) throw new Error('n must be an integer from 0 to 365');
  if (n === 0) return date;
  const off = (await getSetting(societyId, 'office.weeklyOffDays')) as number[];
  const horizon = Math.max(60, n * 4);
  const closed = await closedDates(societyId, date, addDaysYmd(date, horizon));
  let d = date;
  let counted = 0;
  for (let i = 1; i <= horizon; i++) {
    d = addDaysYmd(date, i);
    if (!off.includes(weekdayOf(d)) && !closed.has(d) && ++counted === n) return d;
  }
  logger.warn({ societyId, date, n }, 'working-day search passed its horizon');
  return d;
}

export async function listBetween(societyId: number, from: string, to: string): Promise<HolidayDto[]> {
  const days = (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000;
  if (!(days >= 0 && days <= 400))
    throw new Error('listBetween needs from <= to and a range of at most 400 days');
  const rows = await Holiday.findAll({
    where: { societyId, holidayDate: { [Op.between]: [from, to] } },
    order: [['holidayDate', 'ASC']],
  });
  return rows.map(view);
}
