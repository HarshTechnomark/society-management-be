import type { Transaction } from 'sequelize';
import { Op } from 'sequelize';
import { ApprovalDelegation } from '../../models';
import { enqueueAfterCommit } from '../../lib/queue';
import { nowMs, now } from '../../lib/clock';
import { emitToUser } from '../../lib/realtime';
import type { Ctx } from '../../types/context';
import { audit } from '../../utils/audit';
import { APPROVALS_QUEUE, AUDIT, ENTITY, JOB, NOTIFY, RT } from './approvals.constants';
import { sendTo } from './approvals.notify';
import { afterCommit } from './approvals.shared';

const n = (v: unknown): number => Number(v);

/** `displayStatus` of a delegation (6.5): SCHEDULED before `startsAt`. */
export const displayStatus = (
  d: Pick<ApprovalDelegation, 'status' | 'startsAt'>,
  at: Date = now(),
): string => (d.status === 'ACTIVE' && d.startsAt.getTime() > at.getTime() ? 'SCHEDULED' : d.status);

export function emitDelegation(d: ApprovalDelegation): void {
  const payload = { delegationId: n(d.id), displayStatus: displayStatus(d) };
  emitToUser(n(d.delegatorUserId), RT.delegationUpdated, payload);
  emitToUser(n(d.delegateUserId), RT.delegationUpdated, payload);
}

/** Queues `approvals:recheck-member` after commit (also for module 03 role changes). */
export function enqueueRecheck(t: Transaction, societyId: number): void {
  enqueueAfterCommit(
    t,
    APPROVALS_QUEUE,
    JOB.recheckMember,
    { societyId },
    { jobId: `recheck:${societyId}:${nowMs()}` },
  );
}

/**
 * 8.20 `onMemberEnded`: revokes the ACTIVE delegations where the user is delegator or delegate (reason "Member ended") and
 * queues the recheck of the society's open requests (BR-14-11 b). Called by module 03 (member ended) and module 10.
 */
export async function onMemberEnded(
  ctx: Ctx,
  societyId: number,
  userId: number,
  t: Transaction,
): Promise<void> {
  const rows = await ApprovalDelegation.findAll({
    where: {
      societyId,
      status: 'ACTIVE',
      [Op.or]: [{ delegatorUserId: userId }, { delegateUserId: userId }],
    },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  for (const d of rows) {
    const before = { status: d.status, version: n(d.version) };
    d.status = 'REVOKED';
    d.revokedAt = now();
    d.revokedBy = ctx.user?.id ?? null;
    d.revokeReason = 'Member ended';
    d.version = n(d.version) + 1;
    d.updatedBy = ctx.user?.id ?? null;
    await d.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.delegationRevoked,
        entityType: ENTITY.delegation,
        entityId: n(d.id),
        societyId,
        before,
        after: { status: d.status, version: n(d.version) },
        reason: 'Member ended',
      },
      t,
    );
    afterCommit(t, async () => {
      emitDelegation(d);
      await sendTo(NOTIFY.delegationRevoked, [n(d.delegatorUserId), n(d.delegateUserId)], {
        delegationId: n(d.id),
        reason: 'Member ended',
      });
    });
  }
  enqueueRecheck(t, societyId);
}
