import type { Transaction } from 'sequelize';
import { UserRecoveryCode } from '../../models';
import { notify } from '../../lib/notify';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { revokeUserSessionsInternal } from './auth.sessions';
import { lockUser } from './auth.users';
import { safeAfterCommit } from './auth.util';

/** `auth.resetMfa` (section 8.30): clears TOTP and recovery codes, revokes all sessions (`MFA_RESET`). */
export async function resetMfaForUser(
  ctx: Ctx,
  userId: number,
  reason: string,
  tx: Transaction,
): Promise<void> {
  const u = await lockUser(userId, tx);
  u.totpSecretEnc = null;
  u.mfaEnabledAt = null;
  u.totpLastUsedStep = null;
  u.version += 1;
  await u.save({ transaction: tx });
  await UserRecoveryCode.destroy({ where: { userId }, transaction: tx });
  await revokeUserSessionsInternal(ctx, userId, { reason: 'MFA_RESET' }, tx);
  await audit(ctx, { action: 'auth.mfa.reset', entityType: 'user', entityId: userId, reason }, tx);
  safeAfterCommit(tx, () => notify('auth.mfa_reset', [{ userId }], {}));
}
