import { societyToday } from '../billing/billing.runs.shared';
import { AppError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { ERR } from './accounts.constants';
import type { YmdString } from './accounts.types';

export { societyToday };

export const n = (v: unknown): number => Number(v ?? 0);

export const isYmd = (v: string): v is YmdString => /^\d{4}-\d{2}-\d{2}$/.test(v);

/** `YYYY-MM-DD` plus whole days (calendar arithmetic in UTC, no time zone involved). */
export function addDaysYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** First day of the financial year after the closed one: `2025-26` → `2026-04-01`. */
export const startOfYearAfter = (fy: string): string => `${Number(fy.slice(0, 4)) + 1}-04-01`;

export function societyIdOf(ctx: Ctx): number {
  const id = ctx.society?.id;
  if (!id) throw new Error('accounts: the context carries no society');
  return id;
}

/** A context with a signed-in user is a USER posting (BR-13-9); anything else (jobs, webhooks, seeders) is SYSTEM. */
export const isSystemCtx = (ctx: Ctx): boolean => !ctx.user;

export const notImplemented = (what: string): AppError =>
  new AppError(501, ERR.notImplemented, `${what} is not implemented in the foundation (filled by its part)`);
export const invalidState = (message: string): AppError => new AppError(409, ERR.invalidState, message);
