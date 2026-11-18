import { Op } from 'sequelize';
import { SocietySetting, sequelize } from '../../models';
import { AppError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { settings } from '../society-setup/society-setup.public';
import { assertFeature } from '../subscriptions/entitlements.service';
import { ENT, SETTING } from './helpdesk.constants';
import { ensureSeededOnce } from './helpdesk.seed';
import { societyIdOf } from './helpdesk.shared';

/** 8.6: the `helpdesk.*` settings of section 7.9 as `{ [key]: { value, version } }`; version 0 means "still the default". Writes go through module 08 `setMany` (ranges, cross-key rule, audit). */
export type SettingsView = Record<string, { value: unknown; version: number }>;
const KEYS: string[] = Object.values(SETTING);

export async function getHelpdeskSettings(ctx: Ctx): Promise<SettingsView> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  return view(societyId);
}

async function view(societyId: number): Promise<SettingsView> {
  const values = await settings.getNamespace(societyId, 'helpdesk');
  const rows = await SocietySetting.findAll({
    where: { societyId, settingKey: { [Op.in]: KEYS } },
    attributes: ['settingKey', 'version'],
  });
  const versions = new Map(rows.map(r => [r.settingKey, r.version]));
  return Object.fromEntries(KEYS.map(k => [k, { value: values[k], version: versions.get(k) ?? 0 }]));
}

export async function updateHelpdeskSettings(
  ctx: Ctx,
  changes: { key: string; value: unknown; version?: number }[],
): Promise<SettingsView> {
  const societyId = societyIdOf(ctx);
  await ensureSeededOnce(societyId);
  const unknown = changes.filter(c => !KEYS.includes(c.key));
  if (unknown.length)
    throw new AppError(
      400,
      'UNKNOWN_SETTING_KEY',
      `Unknown setting: ${unknown.map(u => u.key).join(', ')}`,
      unknown.map(u => ({ field: u.key, message: 'Unknown setting key' })),
    );
  if (changes.some(c => c.key === SETTING.upvoteRaiseThreshold)) await assertFeature(ctx, ENT.meTooUpvotes);
  await sequelize.transaction(t => settings.setMany(ctx, societyId, changes as never, t));
  return view(societyId);
}
