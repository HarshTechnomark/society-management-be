import type { Transaction } from 'sequelize';
import { Society } from '../../models';
import { nowMs, now } from '../../lib/clock';
import { emitToRoom } from '../../lib/realtime';
import { AppError, NotFoundError, UnprocessableError, type FieldError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { stepUpMinutesFor } from '../auth/auth.sessions';
import { featureAllowed, featureNotInPlan, getEntitlements } from '../subscriptions/entitlements.service';
import type { FeatureKey } from '../subscriptions/subscriptions.catalogue';
import { settings } from '../society-setup/society-setup.public';
import type { ChangeReason } from './committee.constants';

export const termNotFound = () => new NotFoundError('COMMITTEE_TERM_NOT_FOUND', 'Committee term not found');
export const seatNotFound = () => new NotFoundError('COMMITTEE_SEAT_NOT_FOUND', 'Seat not found');
export const staleVersion = () =>
  new AppError(
    409,
    'STALE_VERSION',
    'This committee term changed since you opened it. Reload and try again.',
  );
export const invalidState = (message: string) => new AppError(409, 'INVALID_STATE', message);
/** A 422 business rule with the field (and extra detail such as `seatIds`) in `errors[]`. */
export const rule = (code: string, message: string, field = 'seats', detail: Record<string, unknown> = {}) =>
  new UnprocessableError(code, message, [{ field, message, ...detail } as FieldError]);

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
/** BR-10-2: "today" is a business date in the society's time zone. */
export async function societyToday(societyId: number): Promise<string> {
  const s = await Society.findByPk(societyId, { attributes: ['timezone'] });
  return ymdIn(s?.timezone ?? 'Asia/Kolkata');
}

/** `402 FEATURE_NOT_IN_PLAN` unless the feature is on for the society. */
export async function assertFeatureFor(societyId: number, key: FeatureKey): Promise<void> {
  const ent = await getEntitlements(societyId);
  if (!featureAllowed(ent, key, 'write')) throw await featureNotInPlan(ent, key);
}

/** Society settings of section 7.4 (module 08 registry defaults apply). */
export interface CommitteeSettings {
  ownersOnly: boolean;
  minStrength: number;
  maxStrength: number;
  maxTermYears: number;
  coOptionAllowed: boolean;
  showOnResidentApp: boolean;
}
export async function committeeSettings(societyId: number): Promise<CommitteeSettings> {
  const [ownersOnly, minStrength, maxStrength, maxTermYears, coOptionAllowed, showOnResidentApp] =
    await Promise.all([
      settings.get(societyId, 'committee.ownersOnly'),
      settings.get(societyId, 'committee.minStrength'),
      settings.get(societyId, 'committee.maxStrength'),
      settings.get(societyId, 'committee.maxTermYears'),
      settings.get(societyId, 'committee.coOptionAllowed'),
      settings.get(societyId, 'committee.showOnResidentApp'),
    ]);
  return { ownersOnly, minStrength, maxStrength, maxTermYears, coOptionAllowed, showOnResidentApp };
}

/** BR-10-15 step-up for a rule that depends on the data (the route cannot carry it): `401 REAUTH_REQUIRED` like the middleware. */
export async function assertRecentAuth(ctx: Ctx): Promise<void> {
  const s = ctx.session;
  if (!s) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue');
  const window = await stepUpMinutesFor(s.clientApp, s.activeSocietyId);
  if (s.amr.includes('PIN') || nowMs() - s.authTime.getTime() > window * 60_000)
    throw new AppError(401, 'REAUTH_REQUIRED', 'Confirm it is you to continue');
}

export const adminRoom = (societyId: number): string => `society:${societyId}:admin`;
/** Section 9.4: after every committee write; no names or contacts in the payload. */
export function emitChanged(
  t: Transaction,
  societyId: number,
  termId: number,
  status: string,
  reason: ChangeReason,
): void {
  t.afterCommit(() => emitToRoom(adminRoom(societyId), 'committee.changed', { termId, status, reason }));
}
