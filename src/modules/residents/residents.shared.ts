import { AppError, NotFoundError } from '../../utils/errors';
import { logger, maskEmail, maskPhone } from '../../lib/logger';
import { now } from '../../lib/clock';
import { Society, UnitResident } from '../../models';
import type { LinkRelation } from '../../models/unit-resident.model';
import { featureAllowed, featureNotInPlan, getEntitlements } from '../subscriptions/entitlements.service';
import type { FeatureKey } from '../subscriptions/subscriptions.catalogue';
import { RELATION_RANK, type AccessRelation, type DocType, OWNER_RELATIONS } from './residents.constants';

export {
  addDaysYmd,
  isForeignKeyViolation,
  isUniqueViolation,
  invalidState,
  staleVersion,
  unitNotFound,
  weekdayOf,
  ymdToUtc,
} from '../society-setup/society-setup.shared';

export const residentNotFound = () => new NotFoundError('RESIDENT_NOT_FOUND', 'Resident not found');
export const linkNotFound = () => new NotFoundError('LINK_NOT_FOUND', 'Unit link not found');
export const documentNotFound = () => new NotFoundError('DOCUMENT_NOT_FOUND', 'Document not found');
export const petNotFound = () => new NotFoundError('PET_NOT_FOUND', 'Pet not found');
export const rule = (status: 403 | 409 | 422, code: string, message: string, field?: string, detail = {}) =>
  new AppError(status, code, message, field ? [{ field, message, ...detail }] : undefined);

// ------------------------------------------------------------------ dates in the society's time zone
/** `YYYY-MM-DD` of an instant in a time zone. */
export function ymdIn(tz: string, at: Date = now()): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  } catch {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  }
}

/** BR-09-9: "today" is in the society's time zone. */
export async function societyToday(societyId: number): Promise<string> {
  const s = await Society.findByPk(societyId, { attributes: ['timezone'] });
  return ymdIn(s?.timezone ?? 'Asia/Kolkata');
}

/** BR-09-4: a minor is less than 18 years old on `today`. */
export function isMinor(dateOfBirth: string | null, today: string): boolean {
  if (!dateOfBirth) return false;
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  let age = ty - y;
  if (tm < m || (tm === m && td < d)) age -= 1;
  return age < 18;
}
export function ageOf(dateOfBirth: string | null, today: string): number | null {
  if (!dateOfBirth) return null;
  const [y, m, d] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  let age = ty - y;
  if (tm < m || (tm === m && td < d)) age -= 1;
  return age;
}

// ------------------------------------------------------------------ masking (BR-09-3)
export const maskMobile = (m: string | null): string | null => (m ? maskPhone(m) : null);
export const maskMail = (e: string | null): string | null => (e ? maskEmail(e) : null);

// ------------------------------------------------------------------ relations (BR-09-8)
export const accessRelationOf = (r: LinkRelation): AccessRelation =>
  r === 'OWNER' || r === 'CO_OWNER' ? 'OWNER' : r === 'TENANT' ? 'TENANT' : 'FAMILY';
export const strongestRelation = (rs: LinkRelation[]): AccessRelation =>
  rs
    .map(accessRelationOf)
    .reduce((a, b) => (RELATION_RANK[b] > RELATION_RANK[a] ? b : a), 'FAMILY' as AccessRelation);
export const isOwnerRelation = (r: string): boolean => (OWNER_RELATIONS as readonly string[]).includes(r);

/** BR-09-9: active on date D. */
export const activeOn = (l: Pick<UnitResident, 'fromDate' | 'toDate'>, d: string): boolean =>
  l.fromDate <= d && (l.toDate === null || l.toDate >= d);

// ------------------------------------------------------------------ shares (BR-09-12): integer hundredths, never floats
/** `"50"`, `"50.5"`, `"50.00"` or `"50.0000"` to hundredths (5000). */
export function shareCents(v: string | number): number {
  const [i = '0', f = ''] = String(v).split('.');
  return Number(i) * 100 + Number((f + '00').slice(0, 2));
}
/** Hundredths to the two-decimal API string. */
export const centsToShare = (c: number): string =>
  `${Math.floor(c / 100)}.${String(c % 100).padStart(2, '0')}`;
export const shareOut = (v: string | null): string | null =>
  v === null ? null : centsToShare(shareCents(v));

// ------------------------------------------------------------------ entitlements checked in services
/** `402 FEATURE_NOT_IN_PLAN` unless the feature is on (or, with `read`, in the read grace) for the society. */
export async function assertFeatureFor(
  societyId: number,
  key: FeatureKey,
  mode: 'write' | 'read' = 'write',
): Promise<void> {
  const ent = await getEntitlements(societyId);
  if (!featureAllowed(ent, key, mode)) throw await featureNotInPlan(ent, key);
}
export async function featureOn(societyId: number, key: FeatureKey): Promise<boolean> {
  return featureAllowed(await getEntitlements(societyId), key, 'write');
}

export const docPurpose = (t: DocType | string): 'KYC_DOCUMENT' | 'RESIDENT_RECORD' =>
  ['AADHAAR', 'PAN', 'PASSPORT', 'DRIVING_LICENCE', 'VOTER_ID', 'OTHER_ID', 'ADDRESS_PROOF'].includes(t)
    ? 'KYC_DOCUMENT'
    : 'RESIDENT_RECORD';

/** Runs a side effect that must never fail the action it follows. */
export async function safely(label: string, fn: () => Promise<unknown> | unknown): Promise<void> {
  try {
    await fn();
  } catch (err) {
    logger.error({ err, label }, 'residents: side effect failed');
  }
}
