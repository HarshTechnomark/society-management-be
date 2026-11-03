import { Society, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { AppError, UnprocessableError, ValidationError } from '../../utils/errors';
import { hasPermission } from '../access-control/access-control.policies';
import { invalidateSociety } from '../access-control/access-control.public';
import type { Ctx } from '../../types/context';
import { maskPhone } from '../../lib/logger';
import { assertGstin } from './society-setup.gstin';
import { isLive } from './society-setup.onboarding.service';
import { setupPorts } from './society-setup.ports';
import { getManyFresh, setMany, get as getSetting } from './society-setup.settings.service';
import { AUDIT, ENTITY } from './society-setup.types';
import { notifyAfterCommit, recipients } from './society-setup.notify';

/** Society profile (module 08 sections 5.1, 8.2, 8.3): the editable subset of `societies` plus the `profile.*` settings. */
export const PROFILE_KEYS = [
  'profile.societyType',
  'profile.pan',
  'profile.tan',
  'profile.registrationDate',
  'profile.contactEmail',
  'profile.contactPhone',
] as const;
const SHORT = (k: string): string => k.slice('profile.'.length);

/** BR-08-1: the only `societies` columns this module writes. */
export const PROFILE_COLUMNS = [
  'name',
  'legalName',
  'registrationNo',
  'gstin',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'pincode',
  'timezone',
  'locale',
  'logoFileId',
] as const;
type Column = (typeof PROFILE_COLUMNS)[number];
const LEGAL: Column[] = ['legalName', 'registrationNo', 'gstin'];

const notFound = () => new AppError(404, 'NOT_FOUND', 'Society not found');

export async function getProfile(ctx: Ctx, societyId: number) {
  const s = await Society.findByPk(societyId);
  if (!s) throw notFound();
  const p = await getManyFresh(societyId, [...PROFILE_KEYS]);
  const phone = p['profile.contactPhone'] as string | null;
  return {
    id: s.id!,
    name: s.name,
    legalName: s.legalName,
    slug: s.slug,
    registrationNo: s.registrationNo,
    gstin: s.gstin,
    addressLine1: s.addressLine1,
    addressLine2: s.addressLine2,
    city: s.city,
    state: s.state,
    pincode: s.pincode,
    timezone: s.timezone,
    locale: s.locale,
    fyStartMonth: s.fyStartMonth,
    logoFileId: s.logoFileId,
    status: s.status,
    isLive: await isLive(societyId),
    profile: {
      societyType: p['profile.societyType'],
      pan: p['profile.pan'],
      tan: p['profile.tan'],
      registrationDate: p['profile.registrationDate'],
      contactEmail: p['profile.contactEmail'],
      contactPhone: phone && !hasPermission(ctx, 'residents.contacts.view') ? maskPhone(phone) : phone,
    },
    version: s.version,
  };
}

export interface ProfileInput {
  version: number;
  reason?: string;
  profile?: Partial<Record<(typeof PROFILE_KEYS)[number] extends `profile.${infer K}` ? K : never, unknown>>;
  [column: string]: unknown;
}

/** True when the request changes a legal field (route guard for step-up: BR-08-4). */
export async function changesLegalField(societyId: number, body: Record<string, unknown>): Promise<boolean> {
  if (!LEGAL.some(f => body[f] !== undefined)) return false;
  const s = await Society.findByPk(societyId, { attributes: [...LEGAL] });
  if (!s) return false;
  return LEGAL.some(f => body[f] !== undefined && (body[f] ?? null) !== (s[f] ?? null));
}

export async function updateProfile(ctx: Ctx, societyId: number, input: ProfileInput) {
  await sequelize.transaction(async t => {
    const s = await Society.findByPk(societyId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!s) throw notFound();
    if (s.version !== input.version)
      throw new AppError(
        409,
        'STALE_VERSION',
        'The profile changed since you opened it. Reload and try again.',
      );

    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const columnChanges: Partial<Record<Column, unknown>> = {};
    for (const c of PROFILE_COLUMNS) {
      if (input[c] === undefined) continue;
      const next = input[c] ?? null;
      const cur = (s[c] as unknown) ?? null;
      if (next === cur) continue;
      before[c] = cur;
      after[c] = next;
      columnChanges[c] = next;
    }

    const storedProfile = await getManyFresh(societyId, [...PROFILE_KEYS], t);
    const profileChanges: { key: string; value: unknown }[] = [];
    for (const [short, value] of Object.entries(input.profile ?? {})) {
      const key = `profile.${short}`;
      const cur = storedProfile[key] ?? null;
      const next = value ?? null;
      if (JSON.stringify(next) === JSON.stringify(cur)) continue;
      profileChanges.push({ key, value: next });
    }

    if (!Object.keys(columnChanges).length && !profileChanges.length) return;

    const legalChanged = LEGAL.filter(f => f in columnChanges);
    if (legalChanged.length && (!input.reason || input.reason.length < 5))
      throw new ValidationError([
        { field: 'reason', message: 'A reason of 5 to 500 characters is required when legal details change' },
      ]);

    if (('timezone' in columnChanges || 'locale' in columnChanges) && (await isLive(societyId, t)))
      throw new UnprocessableError(
        'TIMEZONE_LOCKED',
        'The time zone and language cannot change after the society is live',
        [{ field: 'timezone' in columnChanges ? 'timezone' : 'locale', message: 'Locked after go-live' }],
      );

    // BR-08-2 on the merged values
    const mergedGstin = ('gstin' in columnChanges ? columnChanges.gstin : s.gstin) as string | null;
    const mergedState = ('state' in columnChanges ? columnChanges.state : s.state) as string;
    const panChange = profileChanges.find(c => c.key === 'profile.pan');
    const mergedPan = (panChange ? panChange.value : storedProfile['profile.pan']) as string | null;
    if (mergedGstin && ('gstin' in columnChanges || 'state' in columnChanges || panChange))
      assertGstin(mergedGstin, mergedState, mergedPan);
    if (
      'gstin' in columnChanges &&
      !mergedGstin &&
      (await getSetting(societyId, 'billing.applyGst')) === true
    )
      throw new UnprocessableError(
        'GST_REQUIRES_GSTIN',
        'Turn GST off in the billing settings before removing the GSTIN',
      );

    // BR-08-5: the logo is linked in the same transaction
    if ('logoFileId' in columnChanges && columnChanges.logoFileId !== null)
      await setupPorts().files.linkSocietyLogo(ctx, columnChanges.logoFileId as number, societyId, t);

    for (const [k, v] of Object.entries(columnChanges)) (s as unknown as Record<string, unknown>)[k] = v;
    s.version += 1;
    s.updatedBy = ctx.user?.id ?? null;
    await s.save({ transaction: t });

    if (profileChanges.length) {
      await setMany(ctx, societyId, profileChanges, t, { skipAudit: true });
      for (const c of profileChanges) {
        before[`profile.${SHORT(c.key)}`] = storedProfile[c.key] ?? null;
        after[`profile.${SHORT(c.key)}`] = c.value;
      }
    }
    if (
      'profile.contactPhone' in storedProfile ||
      profileChanges.some(c => c.key === 'profile.contactPhone')
    ) {
      for (const bag of [before, after]) {
        const p = bag['profile.contactPhone'];
        if (typeof p === 'string') bag['profile.contactPhone'] = maskPhone(p);
      }
    }
    await audit(
      ctx,
      {
        action: AUDIT.societyUpdated,
        entityType: ENTITY.society,
        entityId: societyId,
        entityLabel: s.name,
        societyId,
        before,
        after,
        reason: input.reason ?? null,
      },
      t,
    );
    t.afterCommit(() => invalidateSociety(societyId));
    if (legalChanged.length)
      notifyAfterCommit(t, 'setup.profile.legal_changed', societyId, recipients.billingApprovers, {
        actorName: ctx.user?.name ?? 'An administrator',
        fields: legalChanged,
        reason: input.reason ?? null,
        link: '/settings?tab=society',
      });
  });
  return getProfile(ctx, societyId);
}
