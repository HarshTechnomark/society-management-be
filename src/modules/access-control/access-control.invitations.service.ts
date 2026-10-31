import { Op, UniqueConstraintError, type Transaction, type WhereOptions } from 'sequelize';
import { Invitation, Role, Society, SocietyMember, User, sequelize } from '../../models';
import { addDays, addSeconds, now } from '../../lib/clock';
import { emitToRoom } from '../../lib/realtime';
import { audit } from '../../utils/audit';
import {
  AppError,
  ConflictError,
  ForbiddenError,
  GoneError,
  PaymentRequiredError,
  UnprocessableError,
} from '../../utils/errors';
import { pageMeta } from '../../utils/pagination';
import type { Ctx } from '../../types/context';
import { appUrl } from '../auth/auth.apps';
import { membershipFitsApp } from '../auth/auth.sessions';
import { auth, sessions, users } from '../auth/auth.public';
import type { ClientApp } from '../auth/auth.types';
import { invalidateMemberKey } from './access-control.cache';
import { accessPorts } from './access-control.ports';
import { assertCanGrant } from './access-control.policies';
import { AUDIT } from './access-control.permissions';
import { closeInvitationRow } from './access-control.invitation-rows';
import { joinMember } from './access-control.members.service';
import { revokeForMfaPolicy } from './access-control.roles.service';
import {
  afterCommit,
  emitAccessChanged,
  invitationNotFound,
  mobileMask,
  newToken,
  notifyAfterCommit,
  roleKeysTx,
  roleNotFound,
  sha256,
  TOKEN_PATTERN,
} from './access-control.util';
import {
  INVITATION_DAYS,
  MAX_MEMBERSHIPS,
  MAX_RESENDS,
  RESEND_MIN_GAP_SECONDS,
} from './access-control.types';

const APP_FOR_SCOPE: Record<string, ClientApp> = {
  society: 'ADMIN',
  gate: 'GATE',
  work: 'WORK',
  resident: 'RESIDENT',
  platform: 'PLATFORM',
};
export const APP_HOME_PATH: Record<ClientApp, string> = {
  PLATFORM: '/platform',
  ADMIN: '/admin',
  RESIDENT: '/resident',
  GATE: '/gate',
  WORK: '/work',
};
const inviteLink = (scope: string, token: string) =>
  appUrl(APP_FOR_SCOPE[scope] ?? 'ADMIN', `/invite/${token}`);
const setupLink = (scope: string, token: string) =>
  appUrl(APP_FOR_SCOPE[scope] ?? 'ADMIN', `/setup?token=${token}`);
const PLATFORM_SOCIETY_NAME = 'SocietyApp platform team';

const expiresOn = (d: Date, tz = 'Asia/Kolkata'): string =>
  new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: tz })
    .format(d)
    .replace(/\./g, '');

// ------------------------------------------------------------------ views
export interface InvitationView {
  id: number;
  name: string;
  mobile: string | null;
  email: string | null;
  role: { id: number; key: string; name: string };
  status: string;
  expiresAt: string;
  resendCount: number;
  lastSentAt: string;
  invitedByName?: string;
  respondedAt?: string | null;
  revokeReason?: string | null;
}

async function views(rows: Invitation[], reveal: boolean, extended: boolean): Promise<InvitationView[]> {
  const roles = new Map(
    (
      await Role.findAll({
        where: { id: { [Op.in]: [...new Set(rows.map(r => r.roleId))] } },
        paranoid: false,
      })
    ).map(r => [r.id!, r]),
  );
  const inviters = new Map(
    (
      await User.findAll({
        where: { id: { [Op.in]: rows.map(r => r.invitedBy).filter((x): x is number => x !== null) } },
        attributes: ['id', 'name'],
      })
    ).map(u => [u.id!, u.name]),
  );
  return rows.map(i => {
    const r = roles.get(i.roleId)!;
    return {
      id: i.id!,
      name: i.name,
      mobile: reveal ? i.mobile : mobileMask(i.mobile),
      email: i.email,
      role: { id: r.id!, key: r.key, name: r.name },
      status: i.status,
      expiresAt: i.expiresAt.toISOString(),
      resendCount: i.resendCount,
      lastSentAt: i.lastSentAt.toISOString(),
      ...(extended
        ? {
            invitedByName: (i.invitedBy ? inviters.get(i.invitedBy) : null) ?? 'SocietyApp',
            respondedAt: i.respondedAt ? i.respondedAt.toISOString() : null,
            revokeReason: i.revokeReason,
          }
        : {}),
    };
  });
}
export const invitationViews = views;
export { inviteLink, setupLink };

// ------------------------------------------------------------------ create
export interface CreateInvitationInput {
  societyId: number | null;
  name: string;
  mobile: string;
  email?: string;
  roleKey?: string;
  roleId?: number;
  locationLabel?: string;
  message?: string;
  unitId?: number;
  residentId?: number;
}

interface CreateOpts {
  /** Admin route: only society, gate and work roles. The service API (module 09) may use resident roles. */
  allowResident?: boolean;
}

async function expireLapsed(ctx: Ctx, inv: Invitation, tx: Transaction): Promise<void> {
  await closeInvitationRow(ctx, inv, 'EXPIRED', null, tx, {
    actor: { userId: null, name: 'System', role: 'system' },
  });
}

/** Core of `POST /members/invite`, the platform invite and `createInvitation()` (8.10, 8.19, 8.21). Runs in `tx`. */
export async function createInvitationCore(
  ctx: Ctx,
  input: CreateInvitationInput,
  tx: Transaction,
  o: CreateOpts = {},
): Promise<{ invitation: Invitation; token: string; setupToken: string | null }> {
  const system = !ctx.user;
  const platform = input.societyId === null;
  let role: Role | null;
  if (input.roleId !== undefined)
    role = await Role.findOne({ where: { id: input.roleId, societyId: input.societyId }, transaction: tx });
  else
    role = await Role.findOne({
      where: { societyId: input.societyId, key: input.roleKey ?? '' },
      transaction: tx,
    });
  if (!role) throw roleNotFound();
  if (
    platform
      ? role.scope !== 'platform'
      : role.scope === 'platform' || (role.scope === 'resident' && !o.allowResident)
  )
    throw new UnprocessableError('ROLE_SCOPE_NOT_ALLOWED', 'This role cannot be given by invitation here');
  if (!platform && !system && role.scope === 'society') assertCanGrant(ctx, await roleKeysTx(role.id!, tx));

  let society: Society | null = null;
  if (!platform) {
    society = await Society.findByPk(input.societyId!, { transaction: tx });
    if (!society) throw new AppError(404, 'SOCIETY_NOT_FOUND', 'Society not found');
    if (!system && role.consumesSeat) {
      const { limit, used } = await accessPorts().entitlements.getLimit(society.id!, 'limit.admin_seats');
      if (limit !== null && used >= limit)
        throw new PaymentRequiredError('USAGE_LIMIT_EXCEEDED', 'No free admin seat on your plan');
    }
  }

  // existing person
  const existingUser = await User.findOne({ where: { mobile: input.mobile }, transaction: tx });
  if (existingUser) {
    if (platform) {
      if (existingUser.platformRoleId)
        throw new ConflictError('ALREADY_MEMBER', 'This person is already on the platform team');
    } else {
      const m = await SocietyMember.findOne({
        where: { societyId: input.societyId!, userId: existingUser.id! },
        transaction: tx,
      });
      if (m?.status === 'ACTIVE')
        throw new ConflictError('ALREADY_MEMBER', 'This person is already a member');
      if (m?.status === 'SUSPENDED')
        throw new ConflictError(
          'MEMBER_SUSPENDED',
          'This member is suspended. Reactivate instead of inviting again.',
        );
    }
  }
  // one PENDING per society and mobile
  const pending = await Invitation.findOne({
    where: { societyId: input.societyId, mobile: input.mobile, status: 'PENDING' },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  if (pending) {
    if (pending.expiresAt <= now()) await expireLapsed(ctx, pending, tx);
    else
      throw new AppError(
        409,
        'INVITATION_ALREADY_PENDING',
        'An invitation for this mobile is already pending',
        [{ field: 'invitationId', message: String(pending.id) }],
      );
  }

  const { userId } = await users.ensureInvitedUser(
    ctx,
    { mobile: input.mobile, name: input.name, ...(input.email ? { email: input.email } : {}) },
    tx,
  );
  const t = now();
  const expiresAt = addDays(t, INVITATION_DAYS);
  const token = newToken();
  let inv: Invitation;
  try {
    inv = await Invitation.create(
      {
        societyId: input.societyId,
        roleId: role.id!,
        name: input.name,
        mobile: input.mobile,
        email: input.email?.toLowerCase() ?? null,
        locationLabel: input.locationLabel ?? null,
        unitId: input.unitId ?? null,
        residentId: input.residentId ?? null,
        message: input.message ?? null,
        tokenHash: sha256(token),
        status: 'PENDING',
        expiresAt,
        resendCount: 0,
        lastSentAt: t,
        invitedUserId: userId,
        invitedBy: ctx.user?.id ?? null,
        acceptedUserId: null,
        acceptedMemberId: null,
        respondedAt: null,
        revokedBy: null,
        revokeReason: null,
        version: 1,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
      },
      { transaction: tx },
    );
  } catch (err) {
    if (err instanceof UniqueConstraintError) {
      const again = await Invitation.findOne({
        where: { societyId: input.societyId, mobile: input.mobile, status: 'PENDING' },
      });
      throw new AppError(
        409,
        'INVITATION_ALREADY_PENDING',
        'An invitation for this mobile is already pending',
        [{ field: 'invitationId', message: String(again?.id ?? '') }],
      );
    }
    throw err;
  }
  const setup = await maybeSetupToken(ctx, inv, role, userId, tx);
  await audit(
    ctx,
    {
      action: platform ? AUDIT.platformInvitationCreated : AUDIT.invitationCreated,
      entityType: 'invitation',
      entityId: inv.id!,
      societyId: input.societyId,
      after: { roleKey: role.key, mobile: mobileMask(input.mobile), expiresAt },
    },
    tx,
  );
  await sendInvitation(ctx, inv, role, society, token, setup, tx);
  return { invitation: inv, token, setupToken: setup };
}

/** BR-03-13: an INVITED user of a society or platform role with an email gets a "set your password" link as long as the invitation. */
async function maybeSetupToken(
  ctx: Ctx,
  inv: Invitation,
  role: Role,
  userId: number,
  tx: Transaction,
): Promise<string | null> {
  if (role.scope !== 'society' && role.scope !== 'platform') return null;
  const s = await users.getUserSummary(userId);
  if (s.status !== 'INVITED' || !s.email) return null;
  const r = await auth.issueAccountSetupToken(
    ctx,
    userId,
    { invitationId: inv.id!, expiresAt: inv.expiresAt },
    tx,
  );
  return r.rawToken;
}

async function sendInvitation(
  ctx: Ctx,
  inv: Invitation,
  role: Role,
  society: Society | null,
  token: string,
  setupToken: string | null,
  tx: Transaction,
): Promise<void> {
  const inviter = inv.invitedBy ? await User.findByPk(inv.invitedBy, { attributes: ['name'] }) : null;
  const recipients = [{ mobile: inv.mobile }, ...(inv.email ? [{ email: inv.email }] : [])];
  notifyAfterCommit(tx, society ? 'access.invitation' : 'access.platform_invitation', recipients, {
    societyName: society?.name ?? PLATFORM_SOCIETY_NAME,
    roleName: role.name,
    inviterName: inviter?.name ?? ctx.user?.name ?? 'SocietyApp',
    link: inviteLink(role.scope, token),
    ...(setupToken ? { setupLink: setupLink(role.scope, setupToken) } : {}),
    expiresOn: expiresOn(inv.expiresAt, society?.timezone),
  });
}

/** `POST /members/invite`. */
export async function inviteMember(
  ctx: Ctx,
  body: {
    name: string;
    mobile: string;
    email?: string;
    roleId: number;
    locationLabel?: string;
    message?: string;
  },
  reveal: boolean,
): Promise<InvitationView> {
  const inv = await sequelize.transaction(async tx => {
    const r = await createInvitationCore(ctx, { societyId: ctx.society!.id, ...body }, tx);
    return r.invitation;
  });
  return (await views([inv], reveal, false))[0]!;
}

/** Service API `createInvitation` (modules 05 and 09, and module 20 with a SystemCtx). Exactly one of roleKey and roleId. */
export async function createInvitation(
  ctx: Ctx,
  input: CreateInvitationInput & { societyId: number },
  t: Transaction,
): Promise<Invitation> {
  if ((input.roleKey === undefined) === (input.roleId === undefined))
    throw new UnprocessableError('ROLE_SCOPE_NOT_ALLOWED', 'Give exactly one of roleKey and roleId');
  return (await createInvitationCore(ctx, input, t, { allowResident: true })).invitation;
}

// ------------------------------------------------------------------ list
export interface InvitationListQuery {
  status: 'PENDING' | 'ACCEPTED' | 'DECLINED' | 'REVOKED' | 'EXPIRED' | 'ALL';
  roleId?: number;
  scope?: 'society' | 'resident' | 'gate' | 'work';
  search?: string;
  sortBy: 'createdAt' | 'expiresAt' | 'name';
  sortOrder: 'asc' | 'desc';
  page: number;
  limit: number;
}

export async function listInvitations(societyId: number | null, q: InvitationListQuery, reveal: boolean) {
  const and: WhereOptions[] = [{ societyId }];
  if (q.status !== 'ALL') and.push({ status: q.status });
  if (q.roleId) and.push({ roleId: q.roleId });
  if (q.search) {
    const like = `%${q.search.replace(/[%_\\]/g, m => `\\${m}`)}%`;
    const or: WhereOptions[] = [{ name: { [Op.like]: like } }];
    if (/^\d{4}$/.test(q.search)) or.push({ mobile: { [Op.like]: `%${q.search}` } });
    and.push({ [Op.or]: or });
  }
  const dir = q.sortOrder === 'asc' ? 'ASC' : 'DESC';
  const roleWhere = q.scope ? { scope: q.scope } : { scope: { [Op.ne]: 'resident' } };
  const include = [{ model: Role, required: true, paranoid: false, attributes: [], where: roleWhere }];
  const where = { [Op.and]: and };
  const total = await Invitation.count({ where, include, distinct: true });
  const rows = await Invitation.findAll({
    where,
    include,
    order: [
      [q.sortBy, dir],
      ['id', 'ASC'],
    ],
    limit: q.limit,
    offset: (q.page - 1) * q.limit,
    subQuery: false,
  });
  return { data: await views(rows, reveal, true), pagination: pageMeta(q.page, q.limit, total) };
}

// ------------------------------------------------------------------ resend, revoke
async function lockInvitation(societyId: number | null, id: number, tx: Transaction): Promise<Invitation> {
  const inv = await Invitation.findOne({
    where: { id, societyId },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });
  if (!inv) throw invitationNotFound();
  return inv;
}

const notPending = () => new AppError(409, 'INVITATION_NOT_PENDING', 'This invitation is no longer pending');
const expired = () => new GoneError('INVITATION_EXPIRED', 'This invitation has expired');

export async function resendInvitation(
  ctx: Ctx,
  societyId: number | null,
  id: number,
  reveal: boolean,
): Promise<InvitationView> {
  let lapsed = false;
  const view = await sequelize.transaction(async tx => {
    const inv = await lockInvitation(societyId, id, tx);
    const t = now();
    if (inv.status === 'EXPIRED') throw expired();
    if (inv.status !== 'PENDING') throw notPending();
    if (inv.expiresAt <= t) {
      await expireLapsed(ctx, inv, tx);
      lapsed = true;
      return null;
    }
    if (inv.resendCount >= MAX_RESENDS)
      throw new UnprocessableError('RESEND_LIMIT_REACHED', 'This invitation was already sent 3 times');
    if (t < addSeconds(inv.lastSentAt, RESEND_MIN_GAP_SECONDS))
      throw new UnprocessableError('INVITATION_RESEND_TOO_SOON', 'Wait a minute before sending it again');
    const role = (await Role.findByPk(inv.roleId, { transaction: tx, paranoid: false }))!;
    await auth.revokeAccountSetupTokens(inv.invitedUserId, inv.id!, tx);
    const token = newToken();
    inv.tokenHash = sha256(token);
    inv.resendCount += 1;
    inv.lastSentAt = t;
    inv.expiresAt = addDays(t, INVITATION_DAYS);
    inv.version += 1;
    inv.updatedBy = ctx.user?.id ?? null;
    await inv.save({ transaction: tx });
    const setup = await maybeSetupToken(ctx, inv, role, inv.invitedUserId, tx);
    await audit(
      ctx,
      {
        action: inv.societyId === null ? AUDIT.platformInvitationResent : AUDIT.invitationResent,
        entityType: 'invitation',
        entityId: inv.id!,
        societyId: inv.societyId,
        after: { resendCount: inv.resendCount, expiresAt: inv.expiresAt },
      },
      tx,
    );
    const society = inv.societyId ? await Society.findByPk(inv.societyId, { transaction: tx }) : null;
    await sendInvitation(ctx, inv, role, society, token, setup, tx);
    return (await views([inv], reveal, false))[0]!;
  });
  if (lapsed) throw expired();
  return view!;
}

export async function revokeInvitation(
  ctx: Ctx,
  societyId: number | null,
  id: number,
  reason: string,
  reveal: boolean,
): Promise<InvitationView> {
  return sequelize.transaction(async tx => {
    const inv = await lockInvitation(societyId, id, tx);
    if (inv.status !== 'PENDING') throw notPending();
    await closeInvitationRow(ctx, inv, 'REVOKED', reason, tx);
    return (await views([inv], reveal, true))[0]!;
  });
}

/** `cancelAllPendingInvitations` (module 05 closure): no notifications. */
export async function cancelAllPendingInvitations(
  ctx: Ctx,
  societyId: number,
  reason: string,
  t: Transaction,
): Promise<number> {
  const rows = await Invitation.findAll({
    where: { societyId, status: 'PENDING' },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  for (const inv of rows) await closeInvitationRow(ctx, inv, 'REVOKED', reason, t);
  return rows.length;
}

// ------------------------------------------------------------------ public preview and decline
async function findByToken(token: string, tx?: Transaction, lock = false): Promise<Invitation> {
  if (!TOKEN_PATTERN.test(token)) throw invitationNotFound();
  const inv = await Invitation.findOne({
    where: { tokenHash: sha256(token) },
    transaction: tx,
    lock: lock && tx ? tx.LOCK.UPDATE : undefined,
  });
  if (!inv) throw invitationNotFound();
  return inv;
}

/** A PENDING invitation past its time becomes EXPIRED (committed), then the caller answers 410. */
async function expireOnAccess(ctx: Ctx, id: number): Promise<void> {
  await sequelize.transaction(async tx => {
    const inv = await Invitation.findByPk(id, { transaction: tx, lock: tx.LOCK.UPDATE });
    if (inv && inv.status === 'PENDING' && inv.expiresAt <= now()) await expireLapsed(ctx, inv, tx);
  });
}

export async function previewInvitation(ctx: Ctx, token: string) {
  const inv = await findByToken(token);
  if (inv.status === 'PENDING' && inv.expiresAt <= now()) {
    await expireOnAccess(ctx, inv.id!);
    throw expired();
  }
  if (inv.status === 'EXPIRED') throw expired();
  if (inv.status !== 'PENDING') throw notPending();
  const role = (await Role.findByPk(inv.roleId, { paranoid: false }))!;
  const society = inv.societyId ? await Society.findByPk(inv.societyId) : null;
  const inviter = inv.invitedBy ? await User.findByPk(inv.invitedBy, { attributes: ['name'] }) : null;
  return {
    societyName: society?.name ?? PLATFORM_SOCIETY_NAME,
    societyLogoUrl: null,
    roleName: role.name,
    scope: role.scope,
    inviterName: inviter?.name ?? 'SocietyApp',
    inviteeName: inv.name,
    mobileMasked: mobileMask(inv.mobile),
    message: inv.message,
    status: inv.status,
    expiresAt: inv.expiresAt.toISOString(),
    requiresMfa: role.requiresMfa,
  };
}

export async function declineInvitation(ctx: Ctx, token: string, reason?: string): Promise<void> {
  let lapsed = false;
  await sequelize.transaction(async tx => {
    const inv = await findByToken(token, tx, true);
    if (inv.status === 'EXPIRED') throw expired();
    if (inv.status !== 'PENDING') throw notPending();
    if (inv.expiresAt <= now()) {
      await expireLapsed(ctx, inv, tx);
      lapsed = true;
      return;
    }
    await closeInvitationRow(ctx, inv, 'DECLINED', reason ?? null, tx, {
      actor: { userId: null, name: inv.name, role: 'public' },
    });
    if (inv.invitedBy)
      notifyAfterCommit(tx, 'access.invitation_declined', [{ userId: inv.invitedBy }], {
        inviteeName: inv.name,
      });
  });
  if (lapsed) throw expired();
}

// ------------------------------------------------------------------ accept (8.17)
export interface AcceptResult {
  societyId: number | null;
  memberId: number | null;
  role: { key: string; name: string; scope: string };
  requiresMfa: boolean;
  reSignInRequired: boolean;
  redirectTo: string;
}

export async function acceptInvitation(
  ctx: Ctx,
  token: string,
): Promise<{ message: string; data: AcceptResult }> {
  let lapsed = false;
  const result = await sequelize.transaction(async tx => {
    const inv = await findByToken(token, tx, true);
    const t = now();
    if (inv.status === 'EXPIRED') throw expired();
    if (inv.status !== 'PENDING') throw notPending();
    if (inv.expiresAt <= t) {
      await expireLapsed(ctx, inv, tx);
      lapsed = true;
      return null;
    }
    const userId = ctx.user!.id;
    if (inv.invitedUserId !== userId)
      throw new ForbiddenError('INVITATION_MOBILE_MISMATCH', 'This invitation is for another mobile number');
    const role = (await Role.findByPk(inv.roleId, { transaction: tx, paranoid: false }))!;
    const app = APP_FOR_SCOPE[role.scope] ?? 'ADMIN';
    let memberId: number | null = null;
    let societyId: number | null = null;
    const summary = await users.getUserSummary(userId);
    let revoked = false;

    if (inv.societyId === null) {
      const u = await User.findByPk(userId, { transaction: tx });
      if (u?.platformRoleId)
        throw new ConflictError('ALREADY_MEMBER', 'You are already on the platform team');
      const r = await users.setPlatformRole(tx, userId, role.id!);
      await audit(
        ctx,
        {
          action: AUDIT.platformMemberRoleChanged,
          entityType: 'user',
          entityId: userId,
          societyId: null,
          before: { roleId: r.before },
          after: { roleId: r.after },
          reason: 'Invitation accepted',
        },
        tx,
      );
    } else {
      societyId = inv.societyId;
      const society = await Society.findByPk(societyId, { transaction: tx });
      if (!society) throw new AppError(404, 'SOCIETY_NOT_FOUND', 'Society not found');
      if (society.status === 'CLOSED') throw new AppError(423, 'SOCIETY_CLOSED', 'This society is closed');
      const existing = await SocietyMember.findOne({ where: { societyId, userId }, transaction: tx });
      if (existing && existing.status !== 'ENDED')
        throw new ConflictError('ALREADY_MEMBER', 'You are already a member of this society');
      const live = await SocietyMember.count({
        where: { userId, status: { [Op.ne]: 'ENDED' } },
        transaction: tx,
      });
      if (live >= MAX_MEMBERSHIPS)
        throw new UnprocessableError('MEMBERSHIP_LIMIT_REACHED', 'You are already a member of 20 societies');
      const { member } = await joinMember(
        ctx,
        { societyId, userId, role, locationLabel: inv.locationLabel, invitationId: inv.id! },
        tx,
      );
      memberId = member.id!;
      await audit(
        ctx,
        {
          action: AUDIT.memberJoined,
          entityType: 'society_member',
          entityId: memberId,
          societyId,
          after: { userId, roleKey: role.key },
        },
        tx,
      );
    }
    inv.status = 'ACCEPTED';
    inv.acceptedUserId = userId;
    inv.acceptedMemberId = memberId;
    inv.respondedAt = t;
    inv.version += 1;
    inv.updatedBy = userId;
    await inv.save({ transaction: tx });
    if (inv.residentId !== null) await accessPorts().residents.onResidentInvitationAccepted(tx, inv, userId);
    if ((role.requiresMfa || role.scope === 'platform') && !summary.mfaEnabled)
      revoked = (await revokeForMfaPolicy(ctx, [userId], tx)).length > 0;
    await audit(
      ctx,
      {
        action: AUDIT.invitationAccepted,
        entityType: 'invitation',
        entityId: inv.id!,
        societyId,
        before: { status: 'PENDING' },
        after: { status: 'ACCEPTED', memberId },
      },
      tx,
    );
    // first society of the session: make it the active one (the client may also call switch-society)
    if (
      societyId &&
      !revoked &&
      ctx.session &&
      ctx.session.activeSocietyId === null &&
      !ctx.session.supportGrantId &&
      membershipFitsApp(
        {
          societyId,
          societyName: '',
          city: null,
          societyStatus: '',
          memberId,
          roleKey: role.key,
          roleName: role.name,
          roleScope: role.scope,
          status: 'ACTIVE',
        },
        ctx.session.clientApp,
      )
    )
      await sessions.setActiveSociety(ctx.session.id, societyId, {}, tx);
    if (societyId) invalidateMemberKey(tx, societyId, userId);
    emitAccessChanged(tx, societyId, [userId], 'ROLE_CHANGED');
    if (inv.invitedBy)
      notifyAfterCommit(tx, 'access.invitation_accepted', [{ userId: inv.invitedBy }], {
        inviteeName: inv.name,
      });
    if (societyId) afterCommit(tx, () => emitToRoom(`society:${societyId}:admin`, 'members.changed', {}));
    const society = societyId ? await Society.findByPk(societyId, { transaction: tx }) : null;
    return {
      message: society ? `Welcome to ${society.name}` : 'Welcome to the SocietyApp platform team',
      data: {
        societyId,
        memberId,
        role: { key: role.key, name: role.name, scope: role.scope },
        requiresMfa: role.requiresMfa,
        reSignInRequired: revoked,
        redirectTo: appUrl(app, APP_HOME_PATH[app]),
      } satisfies AcceptResult,
    };
  });
  if (lapsed) throw expired();
  return result!;
}

// ------------------------------------------------------------------ expiry job (9.1)
export async function expireInvitations(): Promise<number> {
  const ctx: Ctx = { requestId: 'job', ip: '', userAgent: '' };
  let total = 0;
  for (;;) {
    const batch = await Invitation.findAll({
      where: { status: 'PENDING', expiresAt: { [Op.lte]: now() } },
      attributes: ['id'],
      limit: 500,
    });
    if (!batch.length) break;
    for (const b of batch) {
      await sequelize.transaction(async tx => {
        const inv = await Invitation.findByPk(b.id!, { transaction: tx, lock: tx.LOCK.UPDATE });
        if (inv && inv.status === 'PENDING' && inv.expiresAt <= now()) {
          await expireLapsed(ctx, inv, tx);
          total++;
        }
      });
    }
    if (batch.length < 500) break;
  }
  return total;
}
