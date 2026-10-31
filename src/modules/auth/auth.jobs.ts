import { Op } from 'sequelize';
import {
  AuthLockout,
  AuthOtp,
  AuthToken,
  Session,
  User,
  UserPasskey,
  UserRecoveryCode,
  sequelize,
} from '../../models';
import { addDays, addHours, now } from '../../lib/clock';
import { logger } from '../../lib/logger';
import { notify } from '../../lib/notify';
import { enqueue, registerProcessor, registerQueue, registerRepeatable } from '../../lib/queue';
import { audit } from '../../utils/audit';
import { systemCtx } from '../../types/context';
import { ports } from './auth.ports';
import { isExpiredIdle, revokeSessionRows } from './auth.sessions';
import { users } from './auth.users';
import './auth.templates';

/** Queue `auth` (section 9.1). Payloads contain ids only; every processor is safe to run twice. */
export const AUTH_QUEUE = 'auth';

export async function cleanup(): Promise<void> {
  const t = now();
  await AuthOtp.update({ status: 'EXPIRED' }, { where: { status: 'PENDING', expiresAt: { [Op.lt]: t } } });
  await AuthOtp.destroy({ where: { createdAt: { [Op.lt]: addHours(t, -24) } } });
  const day = addHours(t, -24);
  await AuthToken.destroy({
    where: { [Op.or]: [{ expiresAt: { [Op.lt]: day } }, { consumedAt: { [Op.lt]: day } }] },
  });
  await AuthLockout.destroy({
    where: {
      lastFailedAt: { [Op.lt]: day },
      [Op.or]: [{ lockedUntil: null }, { lockedUntil: { [Op.lt]: day } }],
    },
  });
  const cutoff = addDays(t, -90);
  await Session.destroy({
    where: {
      [Op.or]: [
        { revokedAt: { [Op.lt]: cutoff } },
        { revokedAt: null, absoluteExpiresAt: { [Op.lt]: cutoff } },
      ],
    },
  });
}

/** Revokes active sessions past their idle or absolute limit so the device list is accurate. */
export async function expireIdleSessions(): Promise<number> {
  const t = now();
  const candidates = await Session.findAll({
    where: { revokedAt: null },
    attributes: ['id', 'lastSeenAt', 'idleTimeoutMinutes', 'absoluteExpiresAt', 'supportGrantId'],
  });
  let n = 0;
  for (const c of candidates) {
    const absolute = t >= c.absoluteExpiresAt;
    if (!absolute && !isExpiredIdle(c, t)) continue;
    n += await sequelize.transaction(async tx => {
      const s = await Session.findByPk(c.id!, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!s || s.revokedAt) return 0;
      const stillAbsolute = t >= s.absoluteExpiresAt;
      if (!stillAbsolute && !isExpiredIdle(s, t)) return 0;
      return revokeSessionRows(
        [s],
        stillAbsolute ? (s.supportGrantId ? 'SUPPORT_GRANT_ENDED' : 'EXPIRED') : 'IDLE_TIMEOUT',
        tx,
        null,
      );
    });
  }
  return n;
}

/** BR-02-52. One transaction per user, at most 500 per run, blockers re-checked. */
export async function processAccountDeletions(): Promise<number> {
  const due = await User.findAll({
    where: { status: 'PENDING_DELETION', deletionScheduledFor: { [Op.lte]: now() } },
    attributes: ['id'],
    limit: 500,
  });
  const system = await users.getSystemUserId().catch(() => null);
  const ctx = systemCtx('job:process-account-deletions');
  let done = 0;
  for (const d of due) {
    const blockers = await ports().authAccess.deletionBlockers(d.id!);
    if (blockers.length) {
      void notify('auth.account_deletion_blocked', [{ userId: d.id! }], { reasons: blockers.join(', ') });
      continue;
    }
    let contact: { mobile: string | null; email: string | null } | null = null;
    try {
      const ok = await sequelize.transaction(async tx => {
        const u = await User.scope('withSecrets').findByPk(d.id!, { transaction: tx, lock: tx.LOCK.UPDATE });
        if (!u || u.status !== 'PENDING_DELETION') return false;
        await ports().authAccess.onUserAnonymised(u.id!, tx);
        await ports().residentsHooks.onUserAnonymised(u.id!, tx);
        await ports().communicationHooks.onUserAnonymised(u.id!, tx);
        await ports().residentApp.onUserAnonymised(u.id!, tx);
        const rows = await Session.findAll({
          where: { userId: u.id, revokedAt: null },
          transaction: tx,
          lock: tx.LOCK.UPDATE,
        });
        await revokeSessionRows(rows, 'ACCOUNT_DELETED', tx, null);
        if (u.photoFileId) await ports().files.unlinkUserPhoto(ctx, u.photoFileId, tx);
        await UserRecoveryCode.destroy({ where: { userId: u.id }, transaction: tx });
        await UserPasskey.destroy({ where: { userId: u.id }, transaction: tx });
        await AuthToken.destroy({ where: { userId: u.id }, transaction: tx });
        await AuthOtp.destroy({ where: { userId: u.id }, transaction: tx });
        const hadName = u.name;
        contact = { mobile: u.mobile, email: u.email };
        u.mobile = null;
        u.email = null;
        u.name = 'Deleted user';
        u.photoFileId = null;
        u.passwordHash = null;
        u.passwordChangedAt = null;
        u.totpSecretEnc = null;
        u.totpLastUsedStep = null;
        u.mfaEnabledAt = null;
        u.emailVerifiedAt = null;
        u.mobileVerifiedAt = null;
        u.status = 'DELETED';
        u.anonymisedAt = now();
        u.version += 1;
        await u.save({ transaction: tx });
        await audit(
          ctx,
          {
            action: 'auth.account.anonymised',
            entityType: 'user',
            entityId: u.id!,
            before: { name: hadName },
            actor: { userId: system, name: 'System', role: 'system' },
          },
          tx,
        );
        return true;
      });
      if (ok) {
        done += 1;
        // sent with the contact data read before it was erased
        if (contact) await notify('auth.account_deleted', [contact], {});
      }
    } catch (err) {
      logger.error({ err, userId: d.id }, 'account anonymisation failed; will retry');
      throw err;
    }
  }
  return done;
}

/** 7 days and 1 day before `deletionScheduledFor`. */
export async function deletionReminders(): Promise<number> {
  let sent = 0;
  const t = now();
  for (const days of [7, 1]) {
    const from = addDays(t, days - 1);
    const to = addDays(t, days);
    const list = await User.findAll({
      where: { status: 'PENDING_DELETION', deletionScheduledFor: { [Op.gt]: from, [Op.lte]: to } },
      attributes: ['id'],
    });
    for (const u of list) {
      await enqueue(
        AUTH_QUEUE,
        'auth:send-deletion-reminder',
        { userId: u.id!, days },
        { jobId: `deletion-reminder:${u.id}:${days}` },
      );
      sent += 1;
    }
  }
  return sent;
}

export function registerAuthJobs(): void {
  registerQueue(AUTH_QUEUE, 'Authentication: cleanup, session expiry, account deletion', 2);
  registerProcessor(AUTH_QUEUE, 'auth:cleanup', cleanup);
  registerProcessor(AUTH_QUEUE, 'auth:expire-idle-sessions', async () => {
    await expireIdleSessions();
  });
  registerProcessor(AUTH_QUEUE, 'auth:process-account-deletions', async () => {
    await processAccountDeletions();
  });
  registerProcessor(AUTH_QUEUE, 'auth:deletion-reminders', async () => {
    await deletionReminders();
  });
  registerProcessor(AUTH_QUEUE, 'auth:send-deletion-reminder', async data => {
    const u = await User.findByPk(Number(data.userId), { attributes: ['id', 'status'] });
    if (u?.status === 'PENDING_DELETION')
      await notify('auth.account_deletion_reminder', [{ userId: u.id! }], { days: data.days });
  });
  registerProcessor(AUTH_QUEUE, 'auth:session-revoked-hook', async data => {
    await ports().communicationHooks.onSessionRevoked(Number(data.sessionId));
  });
  registerRepeatable(AUTH_QUEUE, 'auth:cleanup', { hourlyAtMinute: 15 });
  registerRepeatable(AUTH_QUEUE, 'auth:expire-idle-sessions', { everyMs: 5 * 60_000 });
  registerRepeatable(AUTH_QUEUE, 'auth:process-account-deletions', { dailyAtIst: '02:30' });
  registerRepeatable(AUTH_QUEUE, 'auth:deletion-reminders', { dailyAtIst: '10:00' });
}
