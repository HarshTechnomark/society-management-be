import { Op, type ModelStatic, type Model } from 'sequelize';
import { Building, Holiday, LocationNode, OnboardingStep, SocietySetting, Unit } from '../../models';
import type { ExportProvider } from '../societies/societies.exports';

/** Module 05 export provider of module 08 (section 13): every society table of this module, in id order, in batches. */
const BATCH = 500;

async function* streamRows<M extends Model>(
  model: ModelStatic<M>,
  societyId: number,
): AsyncGenerator<Record<string, unknown>> {
  let last = 0;
  for (;;) {
    const rows = await model.findAll({
      where: { societyId, id: { [Op.gt]: last } } as never,
      order: [['id', 'ASC']],
      limit: BATCH,
    });
    if (!rows.length) return;
    for (const r of rows) yield r.get({ plain: true }) as Record<string, unknown>;
    last = (rows[rows.length - 1] as unknown as { id: number }).id;
  }
}

export const societySetupExportProvider: ExportProvider = {
  module: 'society-setup',
  tables: [
    { name: 'buildings', file: 'buildings.csv', stream: sid => streamRows(Building, sid) },
    { name: 'units', file: 'units.csv', stream: sid => streamRows(Unit, sid) },
    {
      name: 'society_settings',
      file: 'society_settings.csv',
      stream: sid => streamRows(SocietySetting, sid),
    },
    {
      name: 'onboarding_steps',
      file: 'onboarding_steps.csv',
      stream: sid => streamRows(OnboardingStep, sid),
    },
    { name: 'holidays', file: 'holidays.csv', stream: sid => streamRows(Holiday, sid) },
    { name: 'location_nodes', file: 'location_nodes.csv', stream: sid => streamRows(LocationNode, sid) },
  ],
};
