import { QueryTypes, UniqueConstraintError, type Transaction } from 'sequelize';
import { User, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../utils/errors';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { hashPassword } from './auth.crypto';
import { emailSchema, mobileSchema, nameSchema } from './auth.normalise';
import { revokeUserSessionsInternal } from './auth.sessions';

const invalidState = (msg = 'This action is not allowed for the account in its current state') =>
  new AppError(409, 'INVALID_STATE', msg);

function parseContact(input: { mobile: string; name: string; email?: string }) {
  const m = mobileSchema.safeParse(input.mobile);
  const n = nameSchema.safeParse(input.name);
  const e = input.email === undefined ? null : emailSchema.safeParse(input.email);
  const errors = [
    ...(m.success ? [] : [{ field: 'mobile', message: m.error.issues[0].message }]),
    ...(n.success ? [] : [{ field: 'name', message: n.error.issues[0].message }]),
    ...(e && !e.success ? [{ field: 'email', message: e.error.issues[0].message }] : []),
  ];
  if (errors.length) throw new ValidationError(errors);
  return { mobile: m.data!, name: n.data!, email: e && e.success ? e.data : null };
}

/**
 * Inserts the user unless the mobile exists (`ON DUPLICATE KEY` keeps parallel callers from deadlocking on gap locks),
 * then returns the locked row. `created` is true for the caller that inserted it.
 */
async function insertOrLock(
  tx: Transaction,
  v: {
    mobile: string;
    name: string | null;
    email: string | null;
    status: 'ACTIVE' | 'INVITED';
    createdBy: number | null;
  },
): Promise<{ user: User; created: boolean }> {
  const t = now();
  const [insertId] = (await sequelize.query(
    `INSERT INTO users (mobile, name, email, status, mobileVerifiedAt, locale, version, createdBy, createdAt, updatedAt)
     VALUES (:mobile, :name, :email, :status, :verified, 'en-IN', 1, :createdBy, :t, :t)
     ON DUPLICATE KEY UPDATE id = id`,
    {
      replacements: { ...v, verified: v.status === 'ACTIVE' ? t : null, t },
      transaction: tx,
      type: QueryTypes.INSERT,
    },
  )) as unknown as [number, number];
  const user = await User.findOne({ where: { mobile: v.mobile }, transaction: tx, lock: tx.LOCK.UPDATE });
  if (!user) throw new ConflictError('EMAIL_IN_USE', 'This email already belongs to another account');
  return { user, created: Number(insertId) > 0 };
}

async function assertUsableForJoin(user: User): Promise<void> {
  if (user.status === 'DISABLED') throw new ForbiddenError('ACCOUNT_DISABLED', 'This account is disabled');
  if (user.status === 'PENDING_DELETION' || user.status === 'DELETED' || user.status === 'SYSTEM')
    throw invalidState();
}

export const users = {
  /** Section 8.30: only after `consumeSignupToken` in the same transaction, or after module 02's own OTP verify. */
  async findOrCreateByMobile(
    tx: Transaction,
    mobile: string,
    input: { name: string; email?: string },
  ): Promise<{ userId: number; created: boolean }> {
    const c = parseContact({ mobile, ...input });
    const { user, created } = await insertOrLock(tx, {
      mobile: c.mobile,
      name: c.name,
      email: c.email,
      status: 'ACTIVE',
      createdBy: null,
    });
    if (created) {
      await audit(
        { requestId: 'service', ip: '', userAgent: '' },
        {
          action: 'auth.user.created',
          entityType: 'user',
          entityId: user.id!,
          after: { source: 'SIGNUP' },
          actor: { userId: user.id!, name: c.name, role: 'user' },
        },
        tx,
      );
      return { userId: user.id!, created: true };
    }
    await assertUsableForJoin(user);
    if (user.status === 'INVITED') await activateInvited(user, tx);
    return { userId: user.id!, created: false };
  },

  /** Module 03 creates invited people here (BR-02-4). An existing user is returned unchanged. */
  async ensureInvitedUser(
    ctx: Ctx,
    input: { mobile: string; name: string; email?: string },
    tx: Transaction,
  ): Promise<{ userId: number; created: boolean }> {
    const c = parseContact(input);
    const { user, created } = await insertOrLock(tx, {
      mobile: c.mobile,
      name: c.name,
      email: c.email,
      status: 'INVITED',
      createdBy: ctx.user?.id ?? null,
    });
    if (!created) {
      if (user.status === 'DISABLED')
        throw new ForbiddenError('ACCOUNT_DISABLED', 'This account is disabled');
      return { userId: user.id!, created: false };
    }
    await audit(
      ctx,
      {
        action: 'auth.user.created',
        entityType: 'user',
        entityId: user.id!,
        after: { source: 'INVITATION' },
      },
      tx,
    );
    return { userId: user.id!, created: true };
  },

  /** `superadmin:create` script: an ACTIVE user with a verified email and password, no role yet. */
  async createPlatformUser(
    input: { mobile: string; email: string; name: string; password: string },
    tx: Transaction,
  ): Promise<number> {
    const c = parseContact(input);
    try {
      const u = await User.create(
        {
          mobile: c.mobile,
          email: emailSchema.parse(input.email),
          name: c.name,
          status: 'ACTIVE',
          mobileVerifiedAt: now(),
          emailVerifiedAt: now(),
          passwordHash: await hashPassword(input.password),
          passwordChangedAt: now(),
        } as never,
        { transaction: tx },
      );
      await audit(
        { requestId: 'script', ip: '', userAgent: '' },
        {
          action: 'auth.user.created',
          entityType: 'user',
          entityId: u.id!,
          after: { source: 'PLATFORM_SCRIPT' },
          actor: { userId: u.id!, name: c.name, role: 'user' },
        },
        tx,
      );
      return u.id!;
    } catch (e) {
      if (e instanceof UniqueConstraintError)
        throw new ConflictError('MOBILE_IN_USE', 'Mobile or email already in use');
      throw e;
    }
  },

  async getSystemUserId(): Promise<number> {
    if (systemUserId) return systemUserId;
    const u = await User.findOne({ where: { status: 'SYSTEM' }, attributes: ['id'] });
    if (!u)
      throw new AppError(500, 'INTERNAL_ERROR', 'The system user is missing; run the system-user seeder');
    return (systemUserId = u.id!);
  },

  async getUserSummary(userId: number) {
    const u = await User.findByPk(userId);
    if (!u) throw new NotFoundError('NOT_FOUND', 'User not found');
    return {
      id: u.id!,
      name: u.name,
      mobile: u.mobile,
      email: u.email,
      status: u.status,
      mfaEnabled: u.mfaEnabledAt !== null,
      lastLoginAt: u.lastLoginAt,
    };
  },

  /** ACTIVE to DISABLED, all sessions revoked (`USER_DISABLED`). */
  async disableUser(ctx: Ctx, userId: number, reason: string, tx: Transaction): Promise<void> {
    const u = await lockUser(userId, tx);
    if (u.status !== 'ACTIVE') throw invalidState();
    const before = { status: u.status };
    u.status = 'DISABLED';
    u.statusReason = reason.slice(0, 500);
    u.updatedBy = ctx.user?.id ?? null;
    await u.save({ transaction: tx });
    await revokeUserSessionsInternal(ctx, userId, { reason: 'USER_DISABLED' }, tx);
    await audit(
      ctx,
      {
        action: 'auth.user.disabled',
        entityType: 'user',
        entityId: userId,
        before,
        after: { status: 'DISABLED' },
        reason,
      },
      tx,
    );
  },

  async enableUser(ctx: Ctx, userId: number, reason: string, tx: Transaction): Promise<void> {
    const u = await lockUser(userId, tx);
    if (u.status !== 'DISABLED') throw invalidState();
    u.status = 'ACTIVE';
    u.statusReason = reason.slice(0, 500);
    u.updatedBy = ctx.user?.id ?? null;
    await u.save({ transaction: tx });
    await audit(
      ctx,
      {
        action: 'auth.user.enabled',
        entityType: 'user',
        entityId: userId,
        before: { status: 'DISABLED' },
        after: { status: 'ACTIVE' },
        reason,
      },
      tx,
    );
  },

  /** Module 03 calls this after its own checks and writes the audit row itself (section 8.30). */
  async setPlatformRole(
    tx: Transaction,
    userId: number,
    roleId: number | null,
  ): Promise<{ before: number | null; after: number | null }> {
    const u = await lockUser(userId, tx);
    if (u.status === 'SYSTEM' || u.status === 'DELETED' || u.status === 'PENDING_DELETION')
      throw invalidState();
    const before = u.platformRoleId;
    if (before === roleId) return { before, after: roleId };
    u.platformRoleId = roleId;
    u.version += 1;
    await u.save({ transaction: tx });
    if (roleId === null)
      await revokeUserSessionsInternal(
        { requestId: 'service', ip: '', userAgent: '' },
        userId,
        { reason: 'ADMIN_REVOKED', clientApp: 'PLATFORM' },
        tx,
      );
    return { before, after: roleId };
  },
};

let systemUserId: number | undefined;
export const resetSystemUserCache = (): void => {
  systemUserId = undefined;
};

export async function lockUser(userId: number, tx: Transaction): Promise<User> {
  const u = await User.findByPk(userId, { transaction: tx, lock: tx.LOCK.UPDATE });
  if (!u) throw new NotFoundError('NOT_FOUND', 'User not found');
  return u;
}

/** INVITED to ACTIVE with the audit row (OTP verify, password setup, `findOrCreateByMobile`). */
export async function activateInvited(user: User, tx: Transaction, ctx?: Ctx): Promise<void> {
  user.status = 'ACTIVE';
  user.mobileVerifiedAt = user.mobileVerifiedAt ?? (user.mobile ? now() : null);
  await user.save({ transaction: tx });
  await audit(
    ctx ?? { requestId: 'service', ip: '', userAgent: '' },
    {
      action: 'auth.user.activated',
      entityType: 'user',
      entityId: user.id!,
      before: { status: 'INVITED' },
      after: { status: 'ACTIVE' },
      actor: { userId: user.id!, name: user.name ?? 'User', role: 'user' },
    },
    tx,
  );
}
