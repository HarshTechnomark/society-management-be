import type { CookieOptions, Response } from 'express';
import { Op, UniqueConstraintError, type Transaction, type WhereOptions } from 'sequelize';
import { Organization, Society, SocietyLifecycleEvent, sequelize } from '../../models';
import type { SocietyStatus } from '../../models/society.model';
import { addDays, now } from '../../lib/clock';
import { kv } from '../../lib/kv';
import { audit } from '../../utils/audit';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  RateLimitedError,
  UnprocessableError,
} from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { auth, sessions, users } from '../auth/auth.public';
import { appUrl } from '../auth/auth.apps';
import {
  createInitialMember,
  createInvitation,
  invalidateSociety,
  provisionSocietyRoles,
} from '../access-control/access-control.public';
import { keysOfScope } from '../access-control/access-control.permissions';
import { subscriptions } from '../subscriptions/subscriptions.public';
import { setting } from './societies.ports';
import { AUDIT, type HealthBand, type LifecycleAction, type PlanKey } from './societies.types';
import {
  isReservedSlug,
  isValidSlug,
  normaliseName,
  slugCandidates,
  slugify,
  withSuffix,
} from './societies.slug';
import {
  mapPlanError,
  societyNotFound,
  societyPurged,
  staleVersion,
  writeEvent,
} from './societies.lifecycle';
import { healthBand } from './societies.health';
import { openGrantOfSociety, activeGrantOfSociety, pendingCount } from './societies.support-access';
import { latestClosureExportId } from './societies.exports';
import { groups, notifyAfterCommit, platformUsersWith } from './societies.notify';

/** Society creation (wizard and self-serve), list, detail, edit, CSV export and the society status endpoint (8.1 to 8.7, 8.22). */

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

// ------------------------------------------------------------------ slug (BR-05-6)
const slugTaken = async (slug: string, t?: Transaction) =>
  (await Society.count({ where: { slug }, transaction: t })) > 0;

export async function suggestions(slug: string, city?: string | null, t?: Transaction): Promise<string[]> {
  const out: string[] = [];
  for (const c of slugCandidates(slug, city)) {
    if (out.length === 3) break;
    if (!(await slugTaken(c, t))) out.push(c);
  }
  return out;
}

export async function slugAvailability(slug: string) {
  if (isReservedSlug(slug))
    return { slug, available: false, reason: 'RESERVED' as const, suggestions: await suggestions(slug) };
  if (await slugTaken(slug))
    return { slug, available: false, reason: 'TAKEN' as const, suggestions: await suggestions(slug) };
  return { slug, available: true, reason: null, suggestions: [] as string[] };
}

const slugTakenError = async (slug: string, city: string | null, t?: Transaction) =>
  new AppError(409, 'SLUG_TAKEN', 'This web address is already in use', [
    { field: 'society.slug', message: 'Taken', suggestions: await suggestions(slug, city, t) },
  ]);
const slugReserved = () =>
  new UnprocessableError('SLUG_RESERVED', 'This web address is reserved', [
    { field: 'society.slug', message: 'Reserved' },
  ]);

// ------------------------------------------------------------------ duplicates (BR-05-7)
export async function findDuplicates(name: string, pincode: string, t?: Transaction) {
  const key = normaliseName(name);
  const rows = await Society.findAll({
    where: { pincode, status: { [Op.ne]: 'CLOSED' } },
    attributes: ['id', 'name', 'city'],
    transaction: t,
  });
  return rows.filter(r => normaliseName(r.name) === key);
}

// ------------------------------------------------------------------ assisted create (8.4)
export interface CreateSocietyInput {
  society: {
    name: string;
    legalName?: string;
    slug?: string;
    registrationNo?: string;
    gstin?: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    state: string;
    pincode: string;
    timezone?: string;
    locale?: string;
    approxFlats: number;
    organizationId?: number;
    requiresSupportConsent?: boolean;
  };
  firstAdmin: { name: string; mobile: string; email: string; roleKey: 'chairman' | 'society_admin' };
  plan: {
    planKey: PlanKey;
    billingCycle: 'MONTHLY' | 'ANNUAL';
    startAs: 'TRIAL' | 'ACTIVE';
    customPricePerFlatPaise?: number;
  };
  confirmNotDuplicate?: boolean;
}

async function assertOrganization(organizationId: number, planKey: string, t?: Transaction): Promise<void> {
  if (planKey !== 'ENTERPRISE')
    throw new UnprocessableError(
      'ORGANIZATION_REQUIRES_ENTERPRISE',
      'Only Enterprise societies can belong to an organization',
    );
  const org = await Organization.findByPk(organizationId, { transaction: t });
  if (!org || org.status !== 'ACTIVE')
    throw new UnprocessableError('ORGANIZATION_NOT_ACTIVE', 'This organization is not active');
}

export async function createSociety(ctx: Ctx, input: CreateSocietyInput) {
  const approve = ctx.platformPermissions?.has('platform.societies.approve');
  if ((input.plan.startAs === 'ACTIVE' || input.plan.customPricePerFlatPaise !== undefined) && !approve)
    throw new ForbiddenError('PERMISSION_DENIED', 'You do not have permission to do this');
  if (input.plan.customPricePerFlatPaise !== undefined && input.plan.planKey !== 'ENTERPRISE')
    throw new UnprocessableError('CUSTOM_PRICE_ENTERPRISE_ONLY', 'A custom price is only for Enterprise');
  const s = input.society;
  const slug = s.slug ?? slugify(s.name);
  if (isReservedSlug(slug)) throw slugReserved();
  if (!isValidSlug(slug))
    throw new AppError(400, 'VALIDATION_FAILED', 'Validation failed', [
      { field: 'society.slug', message: 'Use 3 to 60 lowercase letters, digits and dashes' },
    ]);
  try {
    return await sequelize.transaction(async t => {
      if (await slugTaken(slug, t)) throw await slugTakenError(slug, s.city, t);
      if (!input.confirmNotDuplicate) {
        const dups = await findDuplicates(s.name, s.pincode, t);
        if (dups.length)
          throw new AppError(
            409,
            'POSSIBLE_DUPLICATE_SOCIETY',
            'A society with the same name and pincode exists',
            dups.map(d => ({
              field: 'society.name',
              message: 'Possible duplicate',
              societyId: d.id!,
              name: d.name,
              city: d.city,
            })),
          );
      }
      if (s.organizationId !== undefined) await assertOrganization(s.organizationId, input.plan.planKey, t);
      const t0 = now();
      const trial = input.plan.startAs === 'TRIAL';
      const trialEndsAt = trial ? addDays(t0, await setting('lifecycle.trialDays')) : null;
      const society = await Society.create(
        {
          organizationId: s.organizationId ?? null,
          name: s.name,
          legalName: s.legalName ?? null,
          slug,
          registrationNo: s.registrationNo ?? null,
          gstin: s.gstin ?? null,
          addressLine1: s.addressLine1,
          addressLine2: s.addressLine2 ?? null,
          city: s.city,
          state: s.state,
          pincode: s.pincode,
          timezone: s.timezone ?? 'Asia/Kolkata',
          locale: s.locale ?? 'en-IN',
          status: input.plan.startAs,
          statusChangedAt: t0,
          createdVia: 'ASSISTED',
          creatorUserId: null,
          approxFlats: s.approxFlats,
          trialEndsAt,
          activatedAt: trial ? null : t0,
          requiresSupportConsent: s.requiresSupportConsent ?? true,
          version: 1,
          createdBy: ctx.user?.id ?? null,
          updatedBy: ctx.user?.id ?? null,
        } as never,
        { transaction: t },
      );
      const sid = society.id!;
      await provisionSocietyRoles(sid, t);
      const sub = await subscriptions
        .createInitial(
          ctx,
          {
            societyId: sid,
            planKey: input.plan.planKey,
            billingCycle: input.plan.billingCycle,
            startAs: input.plan.startAs,
            trialEndsAt: trialEndsAt ?? undefined,
            customPricePerFlatPaise: input.plan.customPricePerFlatPaise,
          },
          t,
        )
        .catch(mapPlanError);
      // platform staff hold no society permissions; the invite is given with the full society catalogue so module 03's
      // "cannot grant what you do not hold" check (meant for society admins) does not apply to the Add society wizard
      const inviteCtx: Ctx = { ...ctx, permissions: new Set(keysOfScope('society')) };
      const invitation = await createInvitation(
        inviteCtx,
        {
          societyId: sid,
          name: input.firstAdmin.name,
          mobile: input.firstAdmin.mobile,
          email: input.firstAdmin.email,
          roleKey: input.firstAdmin.roleKey,
        },
        t,
      ).catch((err: unknown) => {
        if (err instanceof AppError && err.status < 500)
          throw new AppError(409, 'INVITATION_CONFLICT', 'The first admin could not be invited', [
            { field: 'firstAdmin.mobile', message: err.message, reason: err.code },
          ]);
        throw err;
      });
      await writeEvent(
        ctx,
        sid,
        {
          eventType: 'CREATED',
          fromStatus: null,
          toStatus: society.status,
          triggerSource: 'PLATFORM_USER',
          triggerCode: 'ASSISTED_CREATE',
          relatedEntityType: 'subscription',
          relatedEntityId: sub.subscriptionId,
          metadata: { planKey: input.plan.planKey, startAs: input.plan.startAs },
        },
        t,
      );
      await audit(
        ctx,
        {
          action: AUDIT.created,
          entityType: 'society',
          entityId: sid,
          entityLabel: society.name,
          societyId: sid,
          after: {
            slug,
            status: society.status,
            planKey: input.plan.planKey,
            billingCycle: input.plan.billingCycle,
            firstAdminRole: input.firstAdmin.roleKey,
          },
        },
        t,
      );
      return {
        id: sid,
        name: society.name,
        slug,
        status: society.status,
        trialEndsAt: iso(trialEndsAt),
        planKey: input.plan.planKey,
        invitationId: invitation.id!,
        version: society.version,
      };
    });
  } catch (err) {
    if (err instanceof UniqueConstraintError && JSON.stringify(err.fields ?? {}).includes('slug'))
      throw await slugTakenError(slug, s.city);
    throw err;
  }
}

// ------------------------------------------------------------------ self-serve sign-up (8.1)
export interface SignupInput {
  signupToken: string;
  person: { name: string; email?: string; role: 'chairman' | 'society_admin' };
  society: {
    name: string;
    addressLine1: string;
    addressLine2?: string;
    city: string;
    state: string;
    pincode: string;
    approxFlats: number;
  };
  planKey: 'STARTER' | 'STANDARD' | 'PREMIUM';
  acceptTerms: true;
  confirmNotDuplicate?: boolean;
}

export interface CollectedCookie {
  name: string;
  value: string;
  options: CookieOptions;
}

const signupTokenInvalid = () =>
  new AppError(401, 'SIGNUP_TOKEN_INVALID', 'This sign-up link is not valid. Verify your mobile again.');

export async function signup(
  ctx: Ctx,
  input: SignupInput,
): Promise<{ result: Record<string, unknown>; cookies: CollectedCookie[] }> {
  const created = await sequelize.transaction(async t => {
    const { mobile } = await auth
      .consumeSignupToken(t, input.signupToken, { clientApp: 'ADMIN' })
      .catch(() => {
        throw signupTokenInvalid();
      });
    const hit = await kv().slidingWindowHit(`signup-mobile:${mobile}`, 86_400_000, 3);
    if (!hit.allowed) throw new RateLimitedError(hit.retryAfterSeconds);
    const { userId } = await users.findOrCreateByMobile(t, mobile, {
      name: input.person.name,
      ...(input.person.email ? { email: input.person.email } : {}),
    });
    const open = await Society.count({
      where: {
        creatorUserId: userId,
        [Op.or]: [{ status: 'TRIAL' }, { status: 'SUSPENDED', suspensionCause: 'TRIAL_EXPIRED' }],
      },
      transaction: t,
    });
    if (open) throw new ConflictError('TRIAL_ALREADY_USED', 'You already have a society on a free trial');
    const s = input.society;
    if (!input.confirmNotDuplicate) {
      const dups = await findDuplicates(s.name, s.pincode, t);
      if (dups.length)
        throw new AppError(
          409,
          'POSSIBLE_DUPLICATE_SOCIETY',
          'A society with the same name and pincode is already on SocietyApp',
          dups.map(d => ({
            field: 'society.name',
            message: 'Possible duplicate',
            name: d.name,
            city: d.city,
          })),
        );
    }
    const t0 = now();
    const trialEndsAt = addDays(t0, await setting('lifecycle.trialDays'));
    const base = slugify(s.name);
    const candidates = [isValidSlug(base) && !isReservedSlug(base) ? base : `${base || 'society'}-chs`];
    for (let i = 2; i <= 20; i++) candidates.push(withSuffix(candidates[0]!, i));
    let society: Society | null = null;
    for (const slug of candidates) {
      if (await slugTaken(slug, t)) continue;
      try {
        society = await Society.create(
          {
            organizationId: null,
            name: s.name,
            slug,
            addressLine1: s.addressLine1,
            addressLine2: s.addressLine2 ?? null,
            city: s.city,
            state: s.state,
            pincode: s.pincode,
            status: 'TRIAL',
            statusChangedAt: t0,
            createdVia: 'SELF_SERVE',
            creatorUserId: userId,
            approxFlats: s.approxFlats,
            trialEndsAt,
            requiresSupportConsent: true,
            version: 1,
            createdBy: userId,
            updatedBy: userId,
          } as never,
          { transaction: t },
        );
        break;
      } catch (err) {
        if (!(err instanceof UniqueConstraintError)) throw err;
      }
    }
    if (!society) throw await slugTakenError(candidates[0]!, s.city, t);
    const sid = society.id!;
    await provisionSocietyRoles(sid, t);
    // the trial subscription exists before the first member takes an admin seat
    const sub = await subscriptions.createTrial(sid, input.planKey, trialEndsAt, t).catch(mapPlanError);
    const actorCtx: Ctx = {
      ...ctx,
      user: {
        id: userId,
        name: input.person.name,
        mobile,
        email: input.person.email ?? null,
        platformRoleId: null,
        status: 'ACTIVE',
      },
      actorRoleKey: input.person.role,
    };
    await createInitialMember(
      { requestId: ctx.requestId, ip: ctx.ip, userAgent: ctx.userAgent },
      { societyId: sid, userId, roleKey: input.person.role },
      t,
    );
    await writeEvent(
      actorCtx,
      sid,
      {
        eventType: 'CREATED',
        fromStatus: null,
        toStatus: 'TRIAL',
        triggerSource: 'PUBLIC_SIGNUP',
        triggerCode: 'SELF_SERVE_SIGNUP',
        relatedEntityType: 'subscription',
        relatedEntityId: sub.subscriptionId,
        metadata: { planKey: input.planKey },
      },
      t,
    );
    await audit(
      actorCtx,
      {
        action: AUDIT.signedUp,
        entityType: 'society',
        entityId: sid,
        entityLabel: society.name,
        societyId: sid,
        after: {
          slug: society.slug,
          planKey: input.planKey,
          role: input.person.role,
          approxFlats: s.approxFlats,
        },
      },
      t,
    );
    notifyAfterCommit(t, 'societies.welcome', [userId], {
      societyName: society.name,
      trialEndsAt: trialEndsAt.toISOString(),
      link: appUrl('ADMIN', '/onboarding'),
    });
    notifyAfterCommit(t, 'societies.new_signup', () => platformUsersWith('platform.societies.view'), {
      societyName: society.name,
      city: society.city,
    });
    return { userId, societyId: sid, slug: society.slug, trialEndsAt };
  });

  // after commit: an admin-app session for the new chairman or society admin (module 02)
  const cookies: CollectedCookie[] = [];
  const sink = {
    cookie(name: string, value: string, options: CookieOptions) {
      cookies.push({ name, value, options });
      return sink;
    },
  } as unknown as Pick<Response, 'cookie'>;
  await sequelize.transaction(t =>
    sessions.issueForUser({ ...ctx, clientApp: 'ADMIN' }, t, sink, {
      userId: created.userId,
      clientApp: 'ADMIN',
      amr: ['OTP'],
      mfaVerified: false,
      activeSocietyId: created.societyId,
    }),
  );
  return {
    result: {
      societyId: created.societyId,
      slug: created.slug,
      status: 'TRIAL',
      trialEndsAt: created.trialEndsAt.toISOString(),
      role: input.person.role,
      redirectUrl: appUrl('ADMIN', '/onboarding'),
    },
    cookies,
  };
}

// ------------------------------------------------------------------ list and CSV (8.2)
export interface ListQuery {
  q?: string;
  status?: SocietyStatus[];
  planKey?: PlanKey;
  state?: string;
  city?: string;
  organizationId?: number;
  healthBand?: HealthBand;
  createdVia?: 'ASSISTED' | 'SELF_SERVE';
  trialEndingWithinDays?: number;
  sortBy:
    | 'name'
    | 'createdAt'
    | 'status'
    | 'healthScore'
    | 'trialEndsAt'
    | 'city'
    | 'activeUsers30'
    | 'unitsSnapshot';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

async function listWhere(q: ListQuery): Promise<WhereOptions> {
  const and: WhereOptions[] = [];
  if (q.q) {
    const esc = q.q.replace(/[%_\\]/g, m => `\\${m}`);
    and.push({
      [Op.or]: [
        { name: { [Op.like]: `%${esc}%` } },
        { slug: { [Op.like]: `${esc.toLowerCase()}%` } },
        { city: { [Op.like]: `${esc}%` } },
      ],
    });
  }
  if (q.status?.length) and.push({ status: { [Op.in]: q.status } });
  if (q.planKey) and.push({ id: { [Op.in]: await subscriptions.societyIdsByPlan(q.planKey) } });
  if (q.state) and.push({ state: q.state });
  if (q.city) and.push({ city: q.city });
  if (q.organizationId) and.push({ organizationId: q.organizationId });
  if (q.createdVia) and.push({ createdVia: q.createdVia });
  if (q.healthBand === 'HEALTHY') and.push({ healthScore: { [Op.gte]: 75 } });
  if (q.healthBand === 'WATCH') and.push({ healthScore: { [Op.between]: [55, 74] } });
  if (q.healthBand === 'AT_RISK') and.push({ healthScore: { [Op.lt]: 55 } });
  if (q.trialEndingWithinDays)
    and.push({ status: 'TRIAL', trialEndsAt: { [Op.lte]: addDays(now(), q.trialEndingWithinDays) } });
  return { [Op.and]: and };
}

const unitsOf = (s: Society) => s.unitsSnapshot || s.approxFlats || 0;

async function listRows(rows: Society[]) {
  const plans = await subscriptions.summaryForSocieties(rows.map(r => r.id!));
  return rows.map(r => {
    const p = plans.get(r.id!);
    return {
      id: r.id!,
      name: r.name,
      slug: r.slug,
      city: r.city,
      state: r.state,
      status: r.status,
      planKey: p?.planKey ?? null,
      units: unitsOf(r),
      activeUsers30: r.activeUsers30,
      mrrPaise: p?.mrrPaise ?? 0,
      healthScore: r.healthScore,
      healthBand: healthBand(r.healthScore),
      trialEndsAt: iso(r.trialEndsAt),
      createdVia: r.createdVia,
      organizationId: r.organizationId,
      createdAt: iso(r.createdAt),
    };
  });
}

export async function listSocieties(q: ListQuery) {
  const { rows, count } = await Society.findAndCountAll({
    where: await listWhere(q),
    order: [
      [q.sortBy, q.sortOrder.toUpperCase()],
      ['id', 'ASC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return { data: await listRows(rows), pagination: pageMeta(q.page, q.limit, count) };
}

const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function exportCsv(ctx: Ctx, q: Omit<ListQuery, 'page' | 'limit'>): Promise<string> {
  const where = await listWhere({ ...q, page: 1, limit: 1 });
  const total = await Society.count({ where });
  if (total > 5000)
    throw new UnprocessableError('EXPORT_TOO_LARGE', 'More than 5,000 societies match. Narrow the filters.');
  const rows = await listRows(
    await Society.findAll({
      where,
      order: [
        [q.sortBy, q.sortOrder.toUpperCase()],
        ['id', 'ASC'],
      ],
    }),
  );
  const header = [
    'ID',
    'Name',
    'Slug',
    'City',
    'State',
    'Plan',
    'Status',
    'Units',
    'Active users 30d',
    'MRR (INR)',
    'Health',
    'Created',
  ];
  const lines = [header.join(',')];
  for (const r of rows)
    lines.push(
      [
        r.id,
        r.name,
        r.slug,
        r.city,
        r.state,
        r.planKey ?? '',
        r.status,
        r.units,
        r.activeUsers30,
        (r.mrrPaise / 100).toFixed(2),
        r.healthScore,
        r.createdAt,
      ]
        .map(csvCell)
        .join(','),
    );
  await audit(ctx, {
    action: AUDIT.listExported,
    entityType: 'society',
    entityId: 'list',
    after: { filter: q, rows: rows.length },
  });
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// ------------------------------------------------------------------ detail and edit (8.5, 8.6)
export async function assertSocietyExists(societyId: number): Promise<void> {
  if (!(await Society.findByPk(societyId, { attributes: ['id'] }))) throw societyNotFound();
}

export function allowedActions(s: Society, perms: Set<string>, maxExtensions: number): LifecycleAction[] {
  const out: LifecycleAction[] = [];
  const approve = perms.has('platform.societies.approve');
  const trialLike =
    s.status === 'TRIAL' || (s.status === 'SUSPENDED' && s.suspensionCause === 'TRIAL_EXPIRED');
  if (approve && trialLike) out.push('CONVERT');
  if (approve && trialLike && s.trialExtendedCount < maxExtensions) out.push('EXTEND_TRIAL');
  if (approve && ['TRIAL', 'ACTIVE', 'PAST_DUE'].includes(s.status)) out.push('SUSPEND');
  if (approve && s.status === 'SUSPENDED') out.push('REACTIVATE');
  if (perms.has('platform.societies.delete') && s.status !== 'CLOSED') out.push('CLOSE');
  if (approve && s.status === 'CLOSED' && !s.purgedAt) out.push('REOPEN');
  return out;
}

export async function getDetail(ctx: Ctx, societyId: number) {
  const s = await Society.findByPk(societyId, {
    include: [{ model: Organization, attributes: ['id', 'name', 'status'] }],
  });
  if (!s) throw societyNotFound();
  const maxExt = await setting('lifecycle.trialMaxExtensions');
  const sub = (await subscriptions.summaryForSocieties([societyId])).get(societyId);
  const org = (s as unknown as { Organization?: Organization | null }).Organization;
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
    organization: org ? { id: org.id!, name: org.name, status: org.status } : null,
    createdVia: s.createdVia,
    approxFlats: s.approxFlats,
    lifecycle: {
      status: s.status,
      statusChangedAt: iso(s.statusChangedAt),
      trialEndsAt: iso(s.trialEndsAt),
      trialExtendedCount: s.trialExtendedCount,
      trialExtensionsLeft: Math.max(0, maxExt - s.trialExtendedCount),
      activatedAt: iso(s.activatedAt),
      pastDueSince: iso(s.pastDueSince),
      suspendedAt: iso(s.suspendedAt),
      suspensionCause: s.suspensionCause,
      suspensionHoldUntil: iso(s.suspensionHoldUntil),
      closedAt: iso(s.closedAt),
      closureReason: s.closureReason,
      purgeAfter: iso(s.purgeAfter),
      purgeHoldReason: s.purgeHoldReason,
      purgeHoldSetAt: iso(s.purgeHoldSetAt),
      purgedAt: iso(s.purgedAt),
      financialRetainUntil: s.financialRetainUntil,
      allowedActions: allowedActions(s, ctx.platformPermissions ?? new Set(), maxExt),
    },
    requiresSupportConsent: s.requiresSupportConsent,
    health: {
      score: s.healthScore,
      band: healthBand(s.healthScore),
      computedAt: iso(s.healthComputedAt),
      breakdown: s.healthBreakdown,
    },
    stats: { units: unitsOf(s), activeUsers30: s.activeUsers30 },
    subscription: sub
      ? { planKey: sub.planKey, billingCycle: sub.billingCycle, status: sub.status, mrrPaise: sub.mrrPaise }
      : null,
    openSupportGrant: await openGrantOfSociety(societyId),
    closureExportId: s.status === 'CLOSED' ? await latestClosureExportId(societyId) : null,
    lastNudgedAt: iso(s.lastNudgedAt),
    version: s.version,
    createdAt: iso(s.createdAt),
  };
}

const EDITABLE = [
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
  'approxFlats',
  'organizationId',
] as const;

export async function updateSociety(
  ctx: Ctx,
  societyId: number,
  input: Record<string, unknown> & { version: number },
) {
  await sequelize.transaction(async t => {
    const s = await Society.findByPk(societyId, { transaction: t, lock: t.LOCK.UPDATE });
    if (!s) throw societyNotFound();
    if (s.version !== input.version) throw staleVersion();
    if (s.purgedAt) throw societyPurged();
    if (
      input.organizationId !== undefined &&
      input.organizationId !== null &&
      input.organizationId !== s.organizationId
    ) {
      const plan = (await subscriptions.summaryForSocieties([societyId])).get(societyId)?.planKey ?? 'NONE';
      await assertOrganization(input.organizationId as number, plan, t);
    }
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const k of EDITABLE) {
      if (input[k] === undefined) continue;
      const v = input[k] as never;
      if ((s as unknown as Record<string, unknown>)[k] === v) continue;
      before[k] = (s as unknown as Record<string, unknown>)[k];
      after[k] = v;
      (s as unknown as Record<string, unknown>)[k] = v;
    }
    if (!Object.keys(after).length) return;
    s.version += 1;
    s.updatedBy = ctx.user?.id ?? null;
    await s.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.updated,
        entityType: 'society',
        entityId: societyId,
        entityLabel: s.name,
        societyId,
        before,
        after,
      },
      t,
    );
    t.afterCommit(() => invalidateSociety(societyId));
  });
  return getDetail(ctx, societyId);
}

export async function lifecycleEvents(
  societyId: number,
  q: { eventType?: string; page: number; limit: number; sortOrder: 'asc' | 'desc' },
) {
  if (!(await Society.findByPk(societyId, { attributes: ['id'] }))) throw societyNotFound();
  const where: Record<string, unknown> = { societyId };
  if (q.eventType) where.eventType = q.eventType;
  const { rows, count } = await SocietyLifecycleEvent.findAndCountAll({
    where,
    order: [
      ['createdAt', q.sortOrder.toUpperCase()],
      ['id', q.sortOrder.toUpperCase()],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
  });
  return {
    data: rows.map(e => ({
      id: e.id!,
      eventType: e.eventType,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      triggerSource: e.triggerSource,
      triggerCode: e.triggerCode,
      reasonCategory: e.reasonCategory,
      reason: e.reason,
      actorName: e.actorName,
      relatedEntityType: e.relatedEntityType,
      relatedEntityId: e.relatedEntityId,
      metadata: e.metadata,
      createdAt: iso(e.createdAt),
    })),
    pagination: pageMeta(q.page, q.limit, count),
  };
}

// ------------------------------------------------------------------ society status (8.22)
const fmtDate = (d: Date) =>
  d.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata',
  });

export async function societyStatus(ctx: Ctx) {
  const sid = ctx.society!.id;
  const s = await Society.findByPk(sid);
  if (!s) throw societyNotFound();
  const perms = ctx.permissions ?? new Set<string>();
  const support = Boolean(ctx.supportGrant);
  const resident = !support && (ctx.clientApp === 'RESIDENT' || ctx.membership?.roleScope === 'resident');
  const billing = perms.has('settings.subscription.view');
  let banner: { tone: 'info' | 'warn' | 'bad'; key: string; text: string } | null = null;
  if (s.status === 'CLOSED')
    banner = {
      tone: 'bad',
      key: 'CLOSED',
      text: "Your society's SocietyApp account is closed. You can still download the closure export.",
    };
  else if (!resident) {
    if (s.status === 'SUSPENDED')
      banner = {
        tone: 'bad',
        key: 'SUSPENDED',
        text:
          s.suspensionCause === 'TRIAL_EXPIRED'
            ? "Your society's free trial has ended. You can view and export data. Choose a plan to continue."
            : "Your society's SocietyApp account is suspended. You can view and export data. Pay the platform invoice to restore access.",
      };
    else if (s.status === 'PAST_DUE' && billing)
      banner = {
        tone: 'warn',
        key: 'PAST_DUE',
        text: 'A SocietyApp invoice is overdue. Pay it to avoid suspension.',
      };
    else if (s.status === 'TRIAL' && billing && s.trialEndsAt)
      banner = { tone: 'info', key: 'TRIAL', text: `Your free trial ends on ${fmtDate(s.trialEndsAt)}.` };
  }
  let supportAccess: Record<string, unknown> | null = null;
  if (!resident) {
    const g = await activeGrantOfSociety(sid);
    if (g)
      supportAccess = {
        active: true,
        grantId: g.id!,
        scope: g.scope,
        endsAt: iso(g.endsAt),
        staffFirstName: (g.requester?.name ?? 'Support').split(' ')[0],
        ...(support ? { viewerIsSupport: true } : {}),
      };
  }
  return {
    societyId: sid,
    status: s.status,
    readOnly: s.status === 'SUSPENDED' || s.status === 'CLOSED',
    banner,
    trialEndsAt: billing ? iso(s.trialEndsAt) : null,
    suspensionCause: billing ? s.suspensionCause : null,
    closedAt: iso(s.closedAt),
    closureExportId: s.status === 'CLOSED' ? await latestClosureExportId(sid) : null,
    supportAccess,
    viewerIsSupport: support,
    pendingSupportRequests: perms.has('settings.support_access.view') ? await pendingCount(sid) : null,
  };
}

/** Recipients helper re-exported for jobs (trial reminders). */
export { groups };
