import { Op } from 'sequelize';
import { MemberGrant, Permission, SocietyMember, sequelize } from '../../models';
import { addHours, now } from '../../lib/clock';
import { registerProcessor, registerQueue, registerRepeatable } from '../../lib/queue';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { invalidateMemberKey } from './access-control.cache';
import { expireInvitations } from './access-control.invitations.service';
import { syncCatalogue } from './access-control.provision';
import { AUDIT } from './access-control.permissions';
import { emitAccessChanged, notifyAfterCommit } from './access-control.util';
import './access-control.templates';

/** Queue `access-control` (section 9.1). Payloads are empty; every processor is safe to run twice. */
export const ACCESS_QUEUE = 'access-control';
const SYSTEM: Ctx = { requestId: 'job', ip: '', userAgent: '' };

/** ACTIVE grants with `endsAt <= now` become EXPIRED; the status is re-checked under the row lock. */
export async function expireGrants(): Promise<number> {
  let n = 0;
  const due = await MemberGrant.findAll({
    where: { status: 'ACTIVE', endsAt: { [Op.lte]: now() } },
    attributes: ['id'],
    limit: 500,
  });
  for (const d of due)
    await sequelize.transaction(async tx => {
      const g = await MemberGrant.findByPk(d.id!, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!g || g.status !== 'ACTIVE' || !g.endsAt || g.endsAt > now()) return;
      g.status = 'EXPIRED';
      await g.save({ transaction: tx });
      const m = await SocietyMember.findByPk(g.memberId, { transaction: tx });
      await audit(
        SYSTEM,
        {
          action: AUDIT.grantExpired,
          entityType: 'member_grant',
          entityId: g.id!,
          societyId: g.societyId,
          before: { status: 'ACTIVE' },
          after: { status: 'EXPIRED' },
        },
        tx,
      );
      if (m) {
        invalidateMemberKey(tx, g.societyId, m.userId);
        notifyAfterCommit(tx, 'access.grant_expired', [{ userId: m.userId }, { userId: g.grantedBy }], {});
        emitAccessChanged(tx, g.societyId, [m.userId], 'GRANT_CHANGED');
      }
      n++;
    });
  return n;
}

/** ADMIN grants ending within 24 hours get one reminder (`expiryReminderSentAt` guards a second one). */
export async function grantExpiryReminders(): Promise<number> {
  let n = 0;
  const t = now();
  const due = await MemberGrant.findAll({
    where: {
      status: 'ACTIVE',
      source: 'ADMIN',
      expiryReminderSentAt: null,
      endsAt: { [Op.gt]: t, [Op.lte]: addHours(t, 24) },
    },
    include: [{ model: Permission, attributes: ['label'], required: true }],
    attributes: ['id'],
    limit: 500,
  });
  for (const d of due)
    await sequelize.transaction(async tx => {
      const g = await MemberGrant.findByPk(d.id!, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!g || g.status !== 'ACTIVE' || g.expiryReminderSentAt) return;
      g.expiryReminderSentAt = now();
      await g.save({ transaction: tx });
      const m = await SocietyMember.findByPk(g.memberId, { transaction: tx });
      if (m)
        notifyAfterCommit(tx, 'access.grant_expiring', [{ userId: m.userId }, { userId: g.grantedBy }], {
          permission: (d as any).Permission.label,
        });
      n++;
    });
  return n;
}

export function registerAccessControlJobs(): void {
  registerQueue(ACCESS_QUEUE, 'Invitations, grants and the permission catalogue', 2);
  registerProcessor(ACCESS_QUEUE, 'access-control:expire-invitations', () => expireInvitations());
  registerProcessor(ACCESS_QUEUE, 'access-control:expire-grants', () => expireGrants());
  registerProcessor(ACCESS_QUEUE, 'access-control:grant-expiry-reminder', () => grantExpiryReminders());
  registerProcessor(ACCESS_QUEUE, 'access-control:sync-catalogue', () => syncCatalogue());
  registerRepeatable(ACCESS_QUEUE, 'access-control:expire-invitations', { everyMs: 15 * 60_000 });
  registerRepeatable(ACCESS_QUEUE, 'access-control:expire-grants', { everyMs: 5 * 60_000 });
  registerRepeatable(ACCESS_QUEUE, 'access-control:grant-expiry-reminder', { hourlyAtMinute: 0 });
}
