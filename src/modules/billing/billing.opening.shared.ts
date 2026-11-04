import { Op, QueryTypes } from 'sequelize';
import { BillingRun, sequelize } from '../../models';
import { istDate, now } from '../../lib/clock';
import { AppError, NotFoundError, UnprocessableError } from '../../utils/errors';
import type { OpeningTotals } from './billing.ledger.types';

/** Helpers shared by the opening balance import and the post, reverse and delete service (BR-11-65). */

export const openingNotFound = () =>
  new NotFoundError('OPENING_BALANCE_NOT_FOUND', 'Opening balance not found');
export const invalidState = (message: string) => new AppError(409, 'INVALID_STATE', message);
export const staleVersion = () =>
  new AppError(409, 'STALE_VERSION', 'This row was changed by someone else. Reload and try again.');

const dayBefore = (ymd: string): string =>
  new Date(Date.parse(`${ymd}T00:00:00.000Z`) - 86_400_000).toISOString().slice(0, 10);

/**
 * BR-11-65: `asOfDate` is a real date no later than society-local today and, when a regular billing run exists, exactly
 * the day before the first regular run's period start (`422 OPENING_BALANCE_DATE_INVALID`). Cancelled and failed runs
 * do not count.
 */
export async function assertAsOfDate(societyId: number, asOfDate: string): Promise<void> {
  const bad = (message: string) =>
    new UnprocessableError('OPENING_BALANCE_DATE_INVALID', message, [{ field: 'asOfDate', message }]);
  if (asOfDate > istDate(now())) throw bad('The as-of date cannot be in the future');
  const first = await BillingRun.findOne({
    where: { societyId, runType: 'REGULAR', status: { [Op.notIn]: ['CANCELLED', 'FAILED'] } },
    attributes: ['periodStart'],
    order: [['periodStart', 'ASC']],
  });
  if (first && asOfDate !== dayBefore(first.periodStart))
    throw bad(`Billing has started: the as-of date must be ${dayBefore(first.periodStart)}`);
}

interface TotalsRow {
  draftArrears: string | number | null;
  draftAdvance: string | number | null;
  invalidCount: string | number | null;
  postedCount: string | number | null;
}

/** Totals of the whole society (not of the current page or filter). */
export async function openingTotals(societyId: number): Promise<OpeningTotals> {
  const [r] = await sequelize.query<TotalsRow>(
    `SELECT
       SUM(CASE WHEN status = 'DRAFT' THEN arrearsPrincipalPaise + arrearsInterestPaise ELSE 0 END) AS draftArrears,
       SUM(CASE WHEN status = 'DRAFT' THEN advancePaise ELSE 0 END) AS draftAdvance,
       SUM(CASE WHEN status = 'INVALID' THEN 1 ELSE 0 END) AS invalidCount,
       SUM(CASE WHEN status = 'POSTED' THEN 1 ELSE 0 END) AS postedCount
     FROM opening_balances WHERE societyId = :societyId`,
    { replacements: { societyId }, type: QueryTypes.SELECT },
  );
  return {
    draftArrearsPaise: Number(r?.draftArrears ?? 0),
    draftAdvancePaise: Number(r?.draftAdvance ?? 0),
    invalidCount: Number(r?.invalidCount ?? 0),
    postedCount: Number(r?.postedCount ?? 0),
  };
}
