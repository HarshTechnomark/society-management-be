import { Op, type Transaction } from 'sequelize';
import { InboxItem, NotificationPreference, PushSubscription, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import {
  AppError,
  ConflictError,
  NotFoundError,
  UnprocessableError,
  ValidationError,
} from '../../utils/errors';
import {
  AUDIT,
  ENTITY,
  ERR,
  LIMITS,
  NOTIFY,
  type PushApp,
  type PushRevokeReason,
} from './communication.constants';
import { notify } from './communication.core';
import { encrypt, sha256Hex } from './communication.crypto';
import { communicationPorts } from './communication.ports';
import { isAllowedPushEndpoint } from './communication.push.sender';

/** Push subscriptions (8.24, BR-16-35, BR-16-36). The deliver step revokes on 404 / 410 / 5 failures; this file owns user actions, the cap and the hooks. */
const notFound = () => new NotFoundError(ERR.pushSubscriptionNotFound, 'Push subscription not found');
const notConfigured = () =>
  new AppError(503, ERR.pushNotConfigured, 'Push notifications are not available right now');

/** "Chrome on Android" from a user-agent (best effort, at most 60 characters). */
export function deviceLabelOf(ua: string | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /OPR\/|Opera/.test(ua)
      ? 'Opera'
      : /Firefox\//.test(ua)
        ? 'Firefox'
        : /Chrome\//.test(ua)
          ? 'Chrome'
          : /Safari\//.test(ua)
            ? 'Safari'
            : 'Browser';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(ua)
      ? 'iOS'
      : /Windows/.test(ua)
        ? 'Windows'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : null;
  return (os ? `${browser} on ${os}` : browser).slice(0, 60);
}

export async function listSubscriptions(ctx: Ctx) {
  const rows = await PushSubscription.findAll({
    where: { userId: ctx.user!.id, status: 'ACTIVE' },
    order: [['id', 'DESC']],
  });
  return rows.map(r => ({
    id: r.id,
    app: r.app,
    deviceLabel: r.deviceLabel,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    lastSuccessAt: r.lastSuccessAt ? r.lastSuccessAt.toISOString() : null,
    isThisDevice: r.sessionId !== null && r.sessionId === ctx.session?.id,
  }));
}

export interface SubscribeInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime?: number | null;
  app: PushApp;
}

async function revoke(row: PushSubscription, reason: PushRevokeReason, t?: Transaction): Promise<void> {
  row.status = 'REVOKED';
  row.revokedReason = reason;
  row.revokedAt = now();
  await row.save({ transaction: t });
}

export async function subscribe(ctx: Ctx, input: SubscribeInput): Promise<{ id: number; status: 'ACTIVE' }> {
  const userId = ctx.user!.id;
  if (!isAllowedPushEndpoint(input.endpoint))
    throw new UnprocessableError(ERR.pushEndpointNotAllowed, 'This push service is not supported', [
      { field: 'endpoint', message: 'Not a known push service' },
    ]);
  if (ctx.clientApp && ctx.clientApp !== input.app)
    throw new ValidationError([{ field: 'app', message: 'Does not match the app you are using' }]);
  if (!communicationPorts().push.publicKey()) throw notConfigured();
  const expiration =
    input.expirationTime === null || input.expirationTime === undefined
      ? null
      : new Date(input.expirationTime);
  if (expiration && expiration.getTime() <= now().getTime())
    throw new ValidationError([{ field: 'expirationTime', message: 'Must be in the future' }]);
  const endpointHash = sha256Hex(input.endpoint);
  const values = {
    userId,
    sessionId: ctx.session?.id ?? null,
    app: input.app,
    endpoint: input.endpoint,
    endpointHash,
    p256dh: input.keys.p256dh,
    authSecretEnc: encrypt(input.keys.auth),
    expirationTime: expiration,
    userAgent: ctx.userAgent ? ctx.userAgent.slice(0, 255) : null,
    deviceLabel: deviceLabelOf(ctx.userAgent),
    status: 'ACTIVE',
    revokedReason: null,
    revokedAt: null,
    consecutiveFailures: 0,
  };
  return sequelize.transaction(async t => {
    let row = await PushSubscription.findOne({
      where: { endpointHash },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (row) await row.update(values as never, { transaction: t });
    else {
      try {
        row = await PushSubscription.create(values as never, { transaction: t });
      } catch (err) {
        if ((err as { name?: string }).name !== 'SequelizeUniqueConstraintError') throw err;
        throw new ConflictError(ERR.invalidState, 'Registration is in progress. Try again.');
      }
    }
    // BR-16-35: at most 10 ACTIVE per user; the oldest `lastSuccessAt` (or `createdAt`) is revoked with reason LIMIT
    const active = await PushSubscription.findAll({
      where: { userId, status: 'ACTIVE', id: { [Op.ne]: row.id } },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    const over = active.length + 1 - LIMITS.pushPerUserMax;
    if (over > 0) {
      const stamp = (s: PushSubscription) => (s.lastSuccessAt ?? s.createdAt).getTime();
      for (const s of [...active].sort((a, b) => stamp(a) - stamp(b) || a.id - b.id).slice(0, over))
        await revoke(s, 'LIMIT', t);
    }
    await audit(
      ctx,
      {
        action: AUDIT.pushCreated,
        entityType: ENTITY.pushSubscription,
        entityId: row.id,
        societyId: null,
        after: { app: input.app, deviceLabel: values.deviceLabel },
      },
      t,
    );
    return { id: row.id, status: 'ACTIVE' as const };
  });
}

const own = async (ctx: Ctx, id: number): Promise<PushSubscription> => {
  const row = await PushSubscription.findOne({ where: { id, userId: ctx.user!.id } });
  if (!row) throw notFound();
  return row;
};

/** `DELETE /me/push-subscriptions/:id`: REVOKED (`USER`). Already revoked stays revoked (still 204). */
export async function unsubscribe(ctx: Ctx, id: number): Promise<void> {
  await sequelize.transaction(async t => {
    const row = await PushSubscription.findOne({
      where: { id, userId: ctx.user!.id },
      transaction: t,
      lock: t.LOCK.UPDATE,
    });
    if (!row) throw notFound();
    if (row.status === 'REVOKED') return;
    await revoke(row, 'USER', t);
    await audit(
      ctx,
      {
        action: AUDIT.pushRevoked,
        entityType: ENTITY.pushSubscription,
        entityId: row.id,
        societyId: null,
        after: { reason: 'USER' },
      },
      t,
    );
  });
}

/** `POST /me/push-subscriptions/:id/test`: a test push to this one browser. */
export async function testSubscription(ctx: Ctx, id: number): Promise<{ sent: true }> {
  const row = await own(ctx, id);
  if (row.status !== 'ACTIVE')
    throw new ConflictError(ERR.invalidState, 'This browser is no longer subscribed');
  await notify(
    NOTIFY.pushTest,
    [{ userId: ctx.user!.id }],
    {},
    { channels: ['PUSH'], pushSubscriptionId: id },
  );
  return { sent: true };
}

export function vapidPublicKey(): { publicKey: string } {
  const key = communicationPorts().push.publicKey();
  if (!key) throw notConfigured();
  return { publicKey: key };
}

/** Module 02 hook (BR-16-36): the session that created a subscription ended, so its subscriptions are revoked with reason `LOGOUT`. */
export async function onSessionRevoked(sessionId: number): Promise<void> {
  await PushSubscription.update(
    { status: 'REVOKED', revokedReason: 'LOGOUT', revokedAt: now() },
    { where: { sessionId, status: 'ACTIVE' } },
  );
}

/** Module 02 hook (BR-02 anonymisation, in its transaction): subscriptions are revoked (`USER_DELETED`), personal fields cleared, inbox and preferences removed. */
export async function onUserAnonymised(userId: number, t: Transaction): Promise<void> {
  await PushSubscription.update(
    {
      status: 'REVOKED',
      revokedReason: 'USER_DELETED',
      revokedAt: now(),
      userAgent: null,
      deviceLabel: null,
    },
    { where: { userId }, transaction: t },
  );
  await InboxItem.destroy({ where: { userId }, transaction: t });
  await NotificationPreference.destroy({ where: { userId }, transaction: t });
}
