import { Building, OnboardingStep, Society, sequelize } from '../src/models';
import { istDate, now } from '../src/lib/clock';
import { systemCtx, type Ctx } from '../src/types/context';
import { setAbsoluteUsage } from '../src/modules/subscriptions/entitlements.service';
import {
  commit,
  preview,
  type GeneratorParams,
} from '../src/modules/society-setup/society-setup.generator.service';
import { createNode } from '../src/modules/society-setup/society-setup.locations.service';
import { ensureSteps } from '../src/modules/society-setup/society-setup.onboarding.service';
import { setMany } from '../src/modules/society-setup/society-setup.settings.service';
import { HOLIDAY_SUGGESTIONS } from '../src/modules/society-setup/society-setup.holiday-suggestions';
import { bulkCreate } from '../src/modules/society-setup/society-setup.holidays.service';

/**
 * Module 08 seed (spec 7.7), not run in production. Sky Heights CHS gets towers A, B, C (6 floors, 4 flats per floor,
 * `{floor}0{pos}`: A-101 to C-604, 800 to 1450 sq ft carpet); Green Park CHS gets towers A and B (5 floors, 3 per floor);
 * Tulip Gardens CHS stays empty. Units go through the generator, so the `limit.flats` counter (reset to 0 first, then
 * consumed) equals the unit count and module 04 sees the flat count. Both live societies get all 8 onboarding steps DONE,
 * the current year's suggested holidays and, for Sky Heights, a gate, a clubhouse and a garden. Idempotent: a society that
 * already has a building is left alone.
 */
interface Demo {
  slug: string;
  towers: string[];
  floors: number;
  perFloor: number;
  carpet: string[];
  bhk: ('2BHK' | '3BHK')[];
  settings: { key: string; value: unknown }[];
  commonAreas: { name: string; areaType: 'GATE' | 'CLUBHOUSE' | 'GARDEN' }[];
}

const DEMOS: Demo[] = [
  {
    slug: 'sky-heights',
    towers: ['A', 'B', 'C'],
    floors: 6,
    perFloor: 4,
    carpet: ['800', '1000', '1250', '1450'],
    bhk: ['2BHK', '2BHK', '3BHK', '3BHK'],
    settings: [
      { key: 'finance.showFinancesToResidents', value: true },
      { key: 'billing.billingDay', value: 1 },
      { key: 'billing.dueDays', value: 9 },
    ],
    commonAreas: [
      { name: 'Main Gate', areaType: 'GATE' },
      { name: 'Clubhouse', areaType: 'CLUBHOUSE' },
      { name: 'Garden', areaType: 'GARDEN' },
    ],
  },
  {
    slug: 'green-park',
    towers: ['A', 'B'],
    floors: 5,
    perFloor: 3,
    carpet: ['650', '850', '1050'],
    bhk: ['2BHK', '2BHK', '3BHK'],
    settings: [],
    commonAreas: [],
  },
];

export interface SetupSeedReport {
  societies: string[];
  skipped: string[];
  units: number;
}

export async function seedSocietySetup(): Promise<SetupSeedReport> {
  if (process.env.NODE_ENV === 'production')
    throw new Error('society-setup demo seed must not run in production');
  const report: SetupSeedReport = { societies: [], skipped: [], units: 0 };
  for (const d of DEMOS) {
    const society = await Society.findOne({ where: { slug: d.slug } });
    if (!society) continue;
    const sid = society.id!;
    if (await Building.count({ where: { societyId: sid } })) {
      report.skipped.push(d.slug);
      continue;
    }
    const ctx: Ctx = {
      ...systemCtx('seed'),
      society: {
        id: sid,
        name: society.name,
        status: society.status,
        timezone: society.timezone,
        planKey: '',
      },
    };
    // the subscription seed wrote the demo flat count straight into the counter; the generator consumes it properly
    await setAbsoluteUsage(sid, 'limit.flats', 0);
    const params: GeneratorParams = {
      buildings: d.towers.map(code => ({
        newBuilding: { code, name: `Tower ${code}`, kind: 'TOWER' as const },
      })),
      floorFrom: 1,
      floorTo: d.floors,
      positions: Array.from({ length: d.perFloor }, (_, i) => ({
        position: i + 1,
        unitType: 'FLAT' as const,
        bhk: d.bhk[i]!,
        carpetAreaSqft: d.carpet[i]!,
      })),
      pattern: '{floor}0{pos}',
    };
    const pv = await preview(ctx, sid, params);
    const r = await commit(ctx, sid, { ...params, previewHash: pv.previewHash });
    report.units += r.created;

    if (d.settings.length)
      await sequelize.transaction(t =>
        setMany(
          ctx,
          sid,
          d.settings.map(s => ({ ...s })),
          t,
          { reason: 'Demo data' },
        ),
      );
    for (const a of d.commonAreas)
      await createNode(ctx, sid, { parentId: null, nodeType: 'AREA', areaType: a.areaType, name: a.name });

    await ensureSteps(sid);
    await OnboardingStep.update(
      { status: 'DONE', completedAt: now(), lastCheckSummary: 'Demo data' },
      { where: { societyId: sid } },
    );
    const year = Number(istDate().slice(0, 4));
    await bulkCreate(
      ctx,
      sid,
      (HOLIDAY_SUGGESTIONS[year] ?? []).map(h => ({
        holidayDate: h.date,
        name: h.name,
        holidayType: h.holidayType,
      })),
    );
    report.societies.push(d.slug);
  }
  return report;
}
