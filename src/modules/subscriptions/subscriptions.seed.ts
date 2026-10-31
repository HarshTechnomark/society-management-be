import { QueryTypes, type Transaction } from 'sequelize';
import { Addon, FeatureFlag, Plan, PlanEntitlement, PlanVersion, sequelize } from '../../models';
import type { AddonGrantRow } from '../../models/addon.model';
import type { FeatureFlagType } from '../../models/feature-flag.model';
import { now } from '../../lib/clock';
import {
  FEATURES,
  LIMITS,
  PLAN_CODES,
  PLAN_RANK,
  defaultEnabled,
  type PlanCode,
} from './subscriptions.catalogue';
import { clearVersionRowsCache } from './entitlements.service';

/**
 * Seeder `subscriptions-catalogue` (section 7.11, all environments): plans, v1 versions, one entitlement row per
 * catalogue key per version, add-ons and the base flags. `syncCatalogue` appends rows for keys added to the catalogue to
 * every version (minimum-plan rule) and is safe to run on every deploy.
 */
export const PLAN_SEED: Record<
  PlanCode,
  { name: string; description: string; price: number; minFlats: number }
> = {
  STARTER: {
    name: 'Starter',
    description: 'Billing, payments, helpdesk and notices',
    price: 900,
    minFlats: 30,
  },
  STANDARD: {
    name: 'Standard',
    description: 'Adds gate, amenities, parking, staff and community',
    price: 1500,
    minFlats: 50,
  },
  PREMIUM: {
    name: 'Premium',
    description: 'Adds accounting, vendors, assets, governance and AI',
    price: 2500,
    minFlats: 100,
  },
  ENTERPRISE: {
    name: 'Enterprise',
    description: 'Facility companies, townships and federations',
    price: 0,
    minFlats: 500,
  },
};

export interface AddonSeed {
  code: string;
  name: string;
  description: string;
  billingType: 'ONE_TIME' | 'RECURRING';
  grants: AddonGrantRow[];
  pricePaise: number;
  minTierRank: number;
  maxTierRank: number;
  maxQuantity: number;
}
export const ADDON_SEED: AddonSeed[] = [
  {
    code: 'SMS_PACK_2000',
    name: '2,000 SMS',
    description: 'Extra SMS for the usage month in which the pack is paid',
    billingType: 'ONE_TIME',
    grants: [{ type: 'LIMIT_INCREMENT', key: 'limit.sms_per_month', amount: 2000 }],
    pricePaise: 90000,
    minTierRank: 1,
    maxTierRank: 4,
    maxQuantity: 10,
  },
  {
    code: 'WHATSAPP_PACK_5000',
    name: '5,000 WhatsApp messages',
    description: 'Extra WhatsApp messages for the usage month in which the pack is paid',
    billingType: 'ONE_TIME',
    grants: [{ type: 'LIMIT_INCREMENT', key: 'limit.whatsapp_per_month', amount: 5000 }],
    pricePaise: 240000,
    minTierRank: 2,
    maxTierRank: 4,
    maxQuantity: 10,
  },
  {
    code: 'AI_PACK_5000',
    name: '5,000 AI messages',
    description: 'Extra AI messages for the usage month in which the pack is paid',
    billingType: 'ONE_TIME',
    grants: [{ type: 'LIMIT_INCREMENT', key: 'limit.ai_messages_per_month', amount: 5000 }],
    pricePaise: 150000,
    minTierRank: 3,
    maxTierRank: 4,
    maxQuantity: 10,
  },
  {
    code: 'EXTRA_STORAGE_50GB',
    name: '50 GB extra storage',
    description: 'More document and photo storage, billed every month',
    billingType: 'RECURRING',
    grants: [{ type: 'LIMIT_INCREMENT', key: 'limit.storage_gb', amount: 50 }],
    pricePaise: 50000,
    minTierRank: 1,
    maxTierRank: 4,
    maxQuantity: 20,
  },
  {
    code: 'EXTRA_GUARD_DEVICE',
    name: 'One more guard console',
    description: 'One more paired guard device, billed every month',
    billingType: 'RECURRING',
    grants: [{ type: 'LIMIT_INCREMENT', key: 'limit.guard_devices', amount: 1 }],
    pricePaise: 30000,
    minTierRank: 2,
    maxTierRank: 3,
    maxQuantity: 20,
  },
  {
    code: 'WHITE_LABEL',
    name: 'White-label branding',
    description: 'Your society brand on the apps and emails',
    billingType: 'RECURRING',
    grants: [{ type: 'FEATURE', key: 'platform.white_label_branding' }],
    pricePaise: 199900,
    minTierRank: 2,
    maxTierRank: 3,
    maxQuantity: 1,
  },
  {
    code: 'API_ACCESS',
    name: 'Public API access',
    description: 'Public API keys with scopes, up to 2 keys',
    billingType: 'RECURRING',
    grants: [
      { type: 'FEATURE', key: 'integrations.public_api_keys_with_scopes' },
      { type: 'LIMIT_INCREMENT', key: 'limit.api_keys', amount: 2 },
    ],
    pricePaise: 299900,
    minTierRank: 3,
    maxTierRank: 3,
    maxQuantity: 1,
  },
  {
    code: 'FEATURE_UNLOCK',
    name: 'One higher-plan feature',
    description: 'Unlock one feature of a higher plan, billed every month',
    billingType: 'RECURRING',
    grants: [{ type: 'FEATURE_CHOICE' }],
    pricePaise: 99900,
    minTierRank: 1,
    maxTierRank: 3,
    maxQuantity: 1,
  },
];

export interface FlagSeed {
  flagKey: string;
  description: string;
  type: FeatureFlagType;
  isEnabled: boolean;
  minPlanCode?: PlanCode;
  rolloutPercent?: number;
  isClientVisible?: boolean;
}
/** All environments (section 7.11). */
export const BASE_FLAGS: FlagSeed[] = [
  {
    flagKey: 'platform.autopay',
    description: 'Autopay for platform invoices (module 06)',
    type: 'GLOBAL',
    isEnabled: false,
  },
  {
    flagKey: 'payments.upi_autopay',
    description: 'UPI AutoPay mandates for maintenance',
    type: 'PLAN',
    isEnabled: false,
    minPlanCode: 'PREMIUM',
  },
];
/** Non-production, from the prototype. */
export const DEMO_FLAGS: FlagSeed[] = [
  {
    flagKey: 'billing.new_run_wizard',
    description: 'New billing run wizard with exceptions grid',
    type: 'PERCENTAGE',
    isEnabled: true,
    rolloutPercent: 35,
  },
  {
    flagKey: 'payments.whatsapp_pay_links',
    description: 'One-tap pay from WhatsApp reminders',
    type: 'PLAN',
    isEnabled: true,
    minPlanCode: 'STANDARD',
  },
  {
    flagKey: 'ai.resident_assistant',
    description: 'AI resident assistant in portal',
    type: 'PLAN',
    isEnabled: true,
    minPlanCode: 'PREMIUM',
  },
  {
    flagKey: 'payments.virtual_accounts',
    description: 'Virtual bank account per flat',
    type: 'TENANT',
    isEnabled: false,
  },
  {
    flagKey: 'ui.liquid_glass_theme',
    description: 'Liquid glass look for resident portal',
    type: 'PERCENTAGE',
    isEnabled: true,
    rolloutPercent: 10,
    isClientVisible: true,
  },
  {
    flagKey: 'gate.anpr_gateway',
    description: 'ANPR camera events and boom barrier',
    type: 'TENANT',
    isEnabled: false,
  },
  {
    flagKey: 'kill.sms_provider_primary',
    description: 'Kill switch: stop sending via primary SMS provider, use fallback',
    type: 'KILL_SWITCH',
    isEnabled: false,
  },
  {
    flagKey: 'kill.whatsapp_marketing',
    description: 'Kill switch: block all non-transactional WhatsApp sends',
    type: 'KILL_SWITCH',
    isEnabled: false,
  },
  {
    flagKey: 'reports.custom_builder',
    description: 'Custom report builder (beta)',
    type: 'PLAN',
    isEnabled: true,
    minPlanCode: 'PREMIUM',
  },
];

/** The default row of a catalogue key in a plan (minimum-plan rule; PLANNED keys always 0). */
export interface EntitlementRowValues {
  entitlementKey: string;
  kind: 'FEATURE' | 'LIMIT';
  isEnabled: boolean | null;
  limitValue: number | null;
  limitPerFlats: number | null;
  overageUnitSize: number | null;
  overagePricePaise: number | null;
}
export function defaultRow(key: string, plan: PlanCode): EntitlementRowValues {
  const f = FEATURES.find(x => x.key === key);
  if (f)
    return {
      entitlementKey: key,
      kind: 'FEATURE',
      isEnabled: defaultEnabled(f, plan),
      limitValue: null,
      limitPerFlats: null,
      overageUnitSize: null,
      overagePricePaise: null,
    };
  const l = LIMITS.find(x => x.key === key)!;
  const d = l.defaults[plan];
  return {
    entitlementKey: key,
    kind: 'LIMIT',
    isEnabled: null,
    limitValue: d.value,
    limitPerFlats: d.value === null ? null : (d.perFlats ?? null),
    overageUnitSize: l.overage ? l.overage.unitSize : null,
    overagePricePaise: l.overage ? l.overage.pricePaise : null,
  };
}

export const ALL_KEYS = (): string[] => [...FEATURES.map(f => f.key), ...LIMITS.map(l => l.key)];

/** Appends missing catalogue rows to every plan version (BR-04-2: only the seeder may append to published versions). */
export async function syncCatalogue(t?: Transaction): Promise<number> {
  const versions = await sequelize.query<{ id: number; code: PlanCode }>(
    'SELECT v.id, p.code FROM plan_versions v JOIN plans p ON p.id = v.planId',
    { type: QueryTypes.SELECT, transaction: t },
  );
  let added = 0;
  const keys = ALL_KEYS();
  for (const v of versions) {
    const have = new Set(
      (
        await PlanEntitlement.findAll({
          where: { planVersionId: v.id },
          attributes: ['entitlementKey'],
          transaction: t,
        })
      ).map(r => r.entitlementKey),
    );
    const missing = keys.filter(k => !have.has(k));
    if (!missing.length) continue;
    const at = now();
    await PlanEntitlement.bulkCreate(
      missing.map(k => ({ ...defaultRow(k, v.code), planVersionId: v.id, createdAt: at, updatedAt: at })),
      { transaction: t },
    );
    added += missing.length;
  }
  // a PLANNED key is never enabled, whatever an older row says
  const planned = FEATURES.filter(f => f.catalogueStatus === 'PLANNED').map(f => f.key);
  if (planned.length)
    await PlanEntitlement.update(
      { isEnabled: false },
      { where: { entitlementKey: planned, isEnabled: true }, transaction: t, hooks: false },
    );
  clearVersionRowsCache();
  return added;
}

/** Startup assertion (definition of done): every catalogue key has a row in every plan version. */
export async function assertCatalogueComplete(): Promise<void> {
  const [row] = await sequelize.query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM plan_versions v
      WHERE (SELECT COUNT(*) FROM plan_entitlements e WHERE e.planVersionId = v.id) < :total`,
    { replacements: { total: ALL_KEYS().length }, type: QueryTypes.SELECT },
  );
  if (Number(row?.n ?? 0) > 0)
    throw new Error('plan versions miss catalogue keys: run `npm run seed` (subscriptions-catalogue sync)');
}

export async function seedFlags(flags: FlagSeed[]): Promise<number> {
  let created = 0;
  for (const f of flags) {
    const exists = await FeatureFlag.findOne({ where: { flagKey: f.flagKey }, paranoid: false });
    if (exists) continue;
    await FeatureFlag.create({
      flagKey: f.flagKey,
      description: f.description,
      type: f.type,
      isEnabled: f.isEnabled,
      minPlanCode: f.minPlanCode ?? null,
      rolloutPercent: f.rolloutPercent ?? (f.type === 'PLAN' ? 100 : 0),
      isClientVisible: f.isClientVisible ?? false,
      ownerTeam: null,
      expiresOn: null,
      createdBy: null,
      updatedBy: null,
      version: 1,
    });
    created += 1;
  }
  return created;
}

/** Plans, v1 PUBLISHED versions, entitlement rows, add-ons and base flags. Idempotent. */
export async function seedPlanCatalogue(): Promise<{
  plansCreated: number;
  rowsAdded: number;
  addonsCreated: number;
}> {
  let plansCreated = 0;
  let addonsCreated = 0;
  await sequelize.transaction(async t => {
    for (const code of PLAN_CODES) {
      if (await Plan.findOne({ where: { code }, transaction: t })) continue;
      const d = PLAN_SEED[code];
      const plan = await Plan.create(
        {
          code,
          name: d.name,
          description: d.description,
          tierRank: PLAN_RANK[code],
          isPublic: true,
          isActive: true,
          currentVersionId: null,
          createdBy: null,
          updatedBy: null,
          version: 1,
        },
        { transaction: t },
      );
      const v = await PlanVersion.create(
        {
          planId: plan.id!,
          versionNo: 1,
          status: 'PUBLISHED',
          pricePerFlatPaise: d.price,
          minBillableFlats: d.minFlats,
          annualFreeMonths: 2,
          notes: 'Initial catalogue',
          publishedAt: now(),
          publishedBy: null,
          retiredAt: null,
          createdBy: null,
          updatedBy: null,
          version: 1,
        },
        { transaction: t },
      );
      await plan.update({ currentVersionId: v.id! }, { transaction: t });
      plansCreated += 1;
    }
    for (const [i, a] of ADDON_SEED.entries()) {
      if (await Addon.findOne({ where: { code: a.code }, transaction: t })) continue;
      await Addon.create(
        { ...a, isOnSale: true, sortOrder: (i + 1) * 10, createdBy: null, updatedBy: null, version: 1 },
        { transaction: t },
      );
      addonsCreated += 1;
    }
  });
  const rowsAdded = await syncCatalogue();
  await seedFlags(BASE_FLAGS);
  return { plansCreated, rowsAdded, addonsCreated };
}

/** Current published version of a plan. */
export async function currentVersionOf(code: PlanCode, t?: Transaction): Promise<PlanVersion> {
  const plan = await Plan.findOne({ where: { code }, transaction: t });
  if (!plan?.currentVersionId) throw new Error(`plan ${code} has no published version; run the seeder`);
  return (await PlanVersion.findByPk(plan.currentVersionId, { transaction: t }))!;
}
