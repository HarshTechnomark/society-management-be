import { sequelize } from '../../models';
import { audit } from '../../utils/audit';
import type { Ctx } from '../../types/context';
import { settings } from '../society-setup/society-setup.public';
import { AUDIT, ENTITY, SETTING } from './approvals.constants';
import { requireSociety } from './approvals.shared';

/** 8.17 (7.6): the two society settings, stored by module 08. */
export interface ApprovalSettings {
  stepUpAbovePaise: number;
  bulkApproveBelowPaise: number;
}
export async function getApprovalSettings(societyId: number): Promise<ApprovalSettings> {
  const v = await settings.getMany(societyId, [SETTING.stepUpAbovePaise, SETTING.bulkApproveBelowPaise]);
  return {
    stepUpAbovePaise: Number(v[SETTING.stepUpAbovePaise]),
    bulkApproveBelowPaise: Number(v[SETTING.bulkApproveBelowPaise]),
  };
}

export async function updateApprovalSettings(
  ctx: Ctx,
  body: Partial<ApprovalSettings>,
): Promise<ApprovalSettings> {
  const societyId = requireSociety(ctx);
  const before = await getApprovalSettings(societyId);
  await sequelize.transaction(async t => {
    const changes = (Object.keys(body) as (keyof ApprovalSettings)[])
      .filter(k => body[k] !== undefined)
      .map(k => ({ key: SETTING[k], value: body[k] }));
    await settings.setMany(ctx, societyId, changes, t);
    await audit(
      ctx,
      {
        action: AUDIT.settingsUpdated,
        entityType: ENTITY.settings,
        entityId: societyId,
        societyId,
        before,
        after: { ...before, ...body },
      },
      t,
    );
  });
  return getApprovalSettings(societyId);
}
