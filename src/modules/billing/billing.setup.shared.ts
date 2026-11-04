import { z } from 'zod';
import { Society } from '../../models';
import { BHK_VALUES, UNIT_TYPES } from '../../models/unit.model';
import { now } from '../../lib/clock';
import { AppError, NotFoundError, UnprocessableError, type FieldError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { featureAllowed, featureNotInPlan, getEntitlements } from '../subscriptions/entitlements.service';
import type { FeatureKey } from '../subscriptions/subscriptions.catalogue';
import { CYCLES, type BillingCycle } from './billing.constants';

/** Helpers shared by the 11.1 services (heads, rules, split rules, late fee policies): errors, dates, scope values, plan checks. */

export const chargeHeadNotFound = () => new NotFoundError('CHARGE_HEAD_NOT_FOUND', 'Charge head not found');
export const ruleNotFound = () => new NotFoundError('RULE_NOT_FOUND', 'Billing rule not found');
export const splitRuleNotFound = () => new NotFoundError('SPLIT_RULE_NOT_FOUND', 'Bill split rule not found');
export const staleVersion = (what: string) =>
  new AppError(409, 'STALE_VERSION', `This ${what} changed since you opened it. Reload and try again.`);
export const invalidState = (message: string) => new AppError(409, 'INVALID_STATE', message);
export const conflict = (code: string, message: string, field?: string) =>
  new AppError(409, code, message, field ? [{ field, message }] : undefined);
/** A 422 business rule with the field in `errors[]`. */
export const unprocessable = (
  code: string,
  message: string,
  field = 'body',
  detail: Record<string, unknown> = {},
) => new UnprocessableError(code, message, [{ field, message, ...detail } as FieldError]);

// ------------------------------------------------------------------ Zod pieces
export const idParam = z.object({ id: z.coerce.number().int().positive() });
export const positiveInt = z.number().int().positive();
export const versionField = z.number().int().min(1);
export const text = (min: number, max: number) => z.string().trim().min(min).max(max);
export const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
/** `{ reason, version }` body of every archive route. */
export const archiveBody = z.object({ reason: text(5, 500), version: versionField }).strict();
export const statusQuery = z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).default('ACTIVE');

/** Values a `UNIT_TYPES` scope may list: module 08 `unitType` and `bhk` (14 values). */
export const UNIT_CLASSES: readonly string[] = [...UNIT_TYPES, ...BHK_VALUES];
export const unitClass = z.string().refine(v => UNIT_CLASSES.includes(v), 'Not a unit type or BHK value');

// ------------------------------------------------------------------ dates and periods
export const addDaysYmd = (d: string, days: number): string => {
  const x = new Date(`${d}T00:00:00.000Z`);
  x.setUTCDate(x.getUTCDate() + days);
  return x.toISOString().slice(0, 10);
};
/** `YYYY-MM-DD` of an instant in a time zone (the society's, default Asia/Kolkata). */
export function ymdIn(tz: string, at: Date = now()): string {
  const fmt = (zone: string) =>
    new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  try {
    return fmt(tz);
  } catch {
    return fmt('Asia/Kolkata');
  }
}
/** "Today" is a business date in the society's time zone. */
export async function societyToday(societyId: number): Promise<string> {
  const s = await Society.findByPk(societyId, { attributes: ['timezone'] });
  return ymdIn(s?.timezone ?? 'Asia/Kolkata');
}
export const firstOfMonth = (ymdValue: string): string => `${ymdValue.slice(0, 7)}-01`;

/** BR-11-24: periods are aligned to the financial year (1 April): the month numbers on which a period of the cycle starts. */
const PERIOD_START_MONTHS: Record<BillingCycle, readonly number[]> = {
  MONTHLY: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  QUARTERLY: [4, 7, 10, 1],
  HALF_YEARLY: [4, 10],
  ANNUAL: [4],
};
/** True when `date` is the first day of a billing period of `cycle`. */
export function isPeriodStart(cycle: BillingCycle, date: string): boolean {
  return date.endsWith('-01') && PERIOD_START_MONTHS[cycle].includes(Number(date.slice(5, 7)));
}
export const isCycle = (v: unknown): v is BillingCycle => (CYCLES as readonly unknown[]).includes(v);

// ------------------------------------------------------------------ plan checks
/** `402 FEATURE_NOT_IN_PLAN` unless the feature is on for the society (write mode). */
export async function assertFeatureFor(societyId: number, key: FeatureKey): Promise<void> {
  const ent = await getEntitlements(societyId);
  if (!featureAllowed(ent, key, 'write')) throw await featureNotInPlan(ent, key);
}

export type { Ctx };
export const actorId = (ctx: Ctx): number | null => ctx.user?.id ?? null;
export const isUniqueViolation = (err: unknown): boolean =>
  (err as { name?: string })?.name === 'SequelizeUniqueConstraintError';
