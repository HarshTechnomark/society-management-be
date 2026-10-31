import type { Transaction } from 'sequelize';
import type { Invitation } from '../../models/invitation.model';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { auth } from '../auth/auth.public';
import { AUDIT } from './access-control.permissions';

/**
 * Moves a PENDING invitation to a final status other than ACCEPTED (revoke, decline, expiry, cancel) and withdraws its
 * account-setup link (BR-03-13). The caller holds the row lock.
 */
export async function closeInvitationRow(
  ctx: Ctx,
  inv: Invitation,
  status: 'REVOKED' | 'DECLINED' | 'EXPIRED',
  reason: string | null,
  tx: Transaction,
  opts: { actor?: { userId: number | null; name: string; role: string } } = {},
): Promise<void> {
  const action =
    status === 'REVOKED'
      ? inv.societyId === null
        ? AUDIT.platformInvitationRevoked
        : AUDIT.invitationRevoked
      : status === 'DECLINED'
        ? AUDIT.invitationDeclined
        : AUDIT.invitationExpired;
  inv.status = status;
  inv.respondedAt = status === 'REVOKED' ? inv.respondedAt : now();
  if (status === 'REVOKED') {
    inv.revokedBy = ctx.user?.id ?? null;
    inv.revokeReason = reason?.slice(0, 500) ?? null;
  }
  inv.version += 1;
  inv.updatedBy = ctx.user?.id ?? null;
  await inv.save({ transaction: tx });
  await auth.revokeAccountSetupTokens(inv.invitedUserId, inv.id!, tx);
  await audit(
    ctx,
    {
      action,
      entityType: 'invitation',
      entityId: inv.id!,
      societyId: inv.societyId,
      before: { status: 'PENDING' },
      after: { status },
      reason,
      actor: opts.actor,
    },
    tx,
  );
}

export const revokeInvitationRow = (ctx: Ctx, inv: Invitation, reason: string, tx: Transaction) =>
  closeInvitationRow(ctx, inv, 'REVOKED', reason, tx);
