import { Op } from 'sequelize';
import { ServiceProvider, sequelize } from '../../models';
import { audit } from '../../utils/audit';
import { systemCtx } from '../../types/context';
import { AUDIT, ENTITY } from './platform-ops.types';
import { activeKeyVersion, decryptCredentials, encryptCredentials } from './platform-ops.crypto';
import { providersChangedAfterCommit } from './platform-ops.providers.service';

/**
 * `npm run providers:rekey` (section 9.1): re-encrypts every provider's credentials with the active key version. One
 * transaction per row; decrypts with the stored version. Old key versions may leave the environment only after the
 * report shows 0 rows on old versions.
 */
export async function rekeyProviders(): Promise<{ rekeyed: number; remainingOnOldVersions: number }> {
  const active = activeKeyVersion();
  const rows = await ServiceProvider.scope('withSecrets').findAll({
    where: { credentialsEnc: { [Op.ne]: null }, credentialsKeyVersion: { [Op.ne]: active } },
    attributes: ['id'],
  });
  let rekeyed = 0;
  for (const r of rows)
    await sequelize.transaction(async t => {
      const p = await ServiceProvider.scope('withSecrets').findByPk(r.id!, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (!p?.credentialsEnc || !p.credentialsIv || !p.credentialsTag || p.credentialsKeyVersion === active)
        return;
      const from = p.credentialsKeyVersion!;
      const creds = decryptCredentials(p.providerKey, {
        enc: p.credentialsEnc,
        iv: p.credentialsIv,
        tag: p.credentialsTag,
        keyVersion: from,
      });
      const sealed = encryptCredentials(p.providerKey, creds, active);
      await p.update(
        {
          credentialsEnc: sealed.enc,
          credentialsIv: sealed.iv,
          credentialsTag: sealed.tag,
          credentialsKeyVersion: active,
        },
        { transaction: t, silent: true },
      );
      await audit(
        systemCtx('rekey'),
        {
          action: AUDIT.providerCredentialsRekeyed,
          entityType: ENTITY.provider,
          entityId: p.id!,
          entityLabel: p.displayName,
          after: { fromKeyVersion: from, toKeyVersion: active },
        },
        t,
      );
      providersChangedAfterCommit(t);
      rekeyed += 1;
    });
  const remainingOnOldVersions = await ServiceProvider.count({
    where: { credentialsEnc: { [Op.ne]: null }, credentialsKeyVersion: { [Op.ne]: active } },
  });
  return { rekeyed, remainingOnOldVersions };
}
