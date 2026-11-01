import { FEATURE_ROWS } from './subscriptions.catalogue-data';

/**
 * The entitlement catalogue in code (module 04 sections 2.3 to 2.5). Features come from the generated table in
 * `subscriptions.catalogue-data.ts` (561 keys); limits are written here. Keys never change once released.
 */
export const PLAN_CODES = ['STARTER', 'STANDARD', 'PREMIUM', 'ENTERPRISE'] as const;
export type PlanCode = (typeof PLAN_CODES)[number];
export const PLAN_RANK: Record<PlanCode, number> = { STARTER: 1, STANDARD: 2, PREMIUM: 3, ENTERPRISE: 4 };
export const PLAN_BY_RANK: Record<number, PlanCode> = {
  1: 'STARTER',
  2: 'STANDARD',
  3: 'PREMIUM',
  4: 'ENTERPRISE',
};

export type FeatureKey = (typeof FEATURE_ROWS)[number][0];
export type CatalogueStatus = 'LIVE' | 'PLANNED';

export interface FeatureDef {
  key: FeatureKey;
  title: string;
  moduleNo: number;
  /** Target plan for PLANNED keys. */
  minPlan: PlanCode;
  isAlwaysOn: boolean;
  catalogueStatus: CatalogueStatus;
}

export const FEATURES: readonly FeatureDef[] = FEATURE_ROWS.map(([key, title, moduleNo, minPlan, flag]) => ({
  key,
  title,
  moduleNo,
  minPlan: minPlan as PlanCode,
  isAlwaysOn: flag === 'ALWAYS',
  catalogueStatus: flag === 'PLANNED' ? ('PLANNED' as const) : ('LIVE' as const),
}));
export const FEATURE_BY_KEY: ReadonlyMap<string, FeatureDef> = new Map(FEATURES.map(f => [f.key, f]));

export type LimitPeriod = 'MONTHLY' | 'ABSOLUTE';
export type Enforcement = 'HARD' | 'SOFT';
export interface LimitDefault {
  /** Base or minimum value; null is unlimited. */
  value: number | null;
  /** Admin seats only: effective = max(value, ceil(flats / perFlats)). */
  perFlats?: number;
}
export interface LimitDef {
  key: LimitKey;
  title: string;
  unit: string;
  period: LimitPeriod;
  enforcement: Enforcement;
  defaults: Record<PlanCode, LimitDefault>;
  /** SOFT limits: units per price step and the default overage price in paise. */
  overage?: { unitSize: number; pricePaise: number };
  /** Label of the OVERAGE invoice line. */
  overageLabel?: string;
}

const d = (
  s: number | null,
  st: number | null,
  p: number | null,
  e: number | null,
): LimitDef['defaults'] => ({
  STARTER: { value: s },
  STANDARD: { value: st },
  PREMIUM: { value: p },
  ENTERPRISE: { value: e },
});

export const LIMIT_KEYS = [
  'limit.flats',
  'limit.admin_seats',
  'limit.custom_roles',
  'limit.sms_per_month',
  'limit.whatsapp_per_month',
  'limit.storage_gb',
  'limit.guard_devices',
  'limit.scheduled_reports',
  'limit.automation_rules',
  'limit.ai_messages_per_month',
  'limit.api_keys',
  'limit.societies_per_org',
] as const;
export type LimitKey = (typeof LIMIT_KEYS)[number];

export const LIMITS: readonly LimitDef[] = [
  {
    key: 'limit.flats',
    title: 'Flats',
    unit: 'flats',
    period: 'ABSOLUTE',
    enforcement: 'HARD',
    defaults: d(300, 1000, 3000, null),
  },
  {
    key: 'limit.admin_seats',
    title: 'Admin seats',
    unit: 'members',
    period: 'ABSOLUTE',
    enforcement: 'HARD',
    defaults: {
      STARTER: { value: 2, perFlats: 50 },
      STANDARD: { value: 4, perFlats: 40 },
      PREMIUM: { value: 8, perFlats: 25 },
      ENTERPRISE: { value: null },
    },
  },
  {
    key: 'limit.custom_roles',
    title: 'Custom roles',
    unit: 'roles',
    period: 'ABSOLUTE',
    enforcement: 'HARD',
    defaults: d(0, 5, 20, null),
  },
  {
    key: 'limit.sms_per_month',
    title: 'SMS per month',
    unit: 'messages',
    period: 'MONTHLY',
    enforcement: 'SOFT',
    defaults: d(500, 2000, 5000, 10000),
    overage: { unitSize: 1, pricePaise: 25 },
    overageLabel: 'SMS above plan limit',
  },
  {
    key: 'limit.whatsapp_per_month',
    title: 'WhatsApp messages per month',
    unit: 'messages',
    period: 'MONTHLY',
    enforcement: 'SOFT',
    defaults: d(0, 5000, 15000, 30000),
    overage: { unitSize: 1, pricePaise: 60 },
    overageLabel: 'WhatsApp messages above plan limit',
  },
  {
    key: 'limit.storage_gb',
    title: 'Storage',
    unit: 'GB',
    period: 'ABSOLUTE',
    enforcement: 'SOFT',
    defaults: d(5, 25, 100, 500),
    overage: { unitSize: 1, pricePaise: 500 },
    overageLabel: 'Storage above plan limit',
  },
  {
    key: 'limit.guard_devices',
    title: 'Guard devices',
    unit: 'devices',
    period: 'ABSOLUTE',
    enforcement: 'HARD',
    defaults: d(0, 3, 6, null),
  },
  {
    key: 'limit.scheduled_reports',
    title: 'Scheduled reports',
    unit: 'schedules',
    period: 'ABSOLUTE',
    enforcement: 'HARD',
    defaults: d(0, 0, 20, null),
  },
  {
    key: 'limit.automation_rules',
    title: 'Automation rules',
    unit: 'active rules',
    period: 'ABSOLUTE',
    enforcement: 'HARD',
    defaults: d(0, 0, 25, null),
  },
  {
    key: 'limit.ai_messages_per_month',
    title: 'AI messages per month',
    unit: 'messages',
    period: 'MONTHLY',
    enforcement: 'SOFT',
    defaults: d(0, 0, 5000, 20000),
    overage: { unitSize: 1, pricePaise: 20 },
    overageLabel: 'AI messages above plan limit',
  },
  {
    key: 'limit.api_keys',
    title: 'API keys',
    unit: 'active keys',
    period: 'ABSOLUTE',
    enforcement: 'HARD',
    defaults: d(0, 0, 0, null),
  },
  {
    key: 'limit.societies_per_org',
    title: 'Societies per organization',
    unit: 'societies',
    period: 'ABSOLUTE',
    enforcement: 'HARD',
    defaults: d(1, 1, 1, null),
  },
];
export const LIMIT_BY_KEY: ReadonlyMap<string, LimitDef> = new Map(LIMITS.map(l => [l.key, l]));

/** Bytes per GB: `limit.storage_gb` is configured in GB and its counter is in bytes. */
export const BYTES_PER_GB = 1_073_741_824;

export const isFeatureKey = (k: string): k is FeatureKey => FEATURE_BY_KEY.has(k);
export const isLimitKey = (k: string): k is LimitKey => LIMIT_BY_KEY.has(k);

/** Plans that enable a feature (minimum plan and every higher one); PLANNED keys are in none. */
export function plansWithFeature(f: FeatureDef): PlanCode[] {
  if (f.catalogueStatus === 'PLANNED') return [];
  if (f.isAlwaysOn) return [...PLAN_CODES];
  return PLAN_CODES.filter(c => PLAN_RANK[c] >= PLAN_RANK[f.minPlan]);
}

/** Default `isEnabled` of a feature in a plan version (the seeder rule, section 2.3). */
export const defaultEnabled = (f: FeatureDef, plan: PlanCode): boolean => plansWithFeature(f).includes(plan);

/** Startup assertion (section 8.8): keys are unique and match their regexes; counts match the spec. */
export function assertCatalogue(): void {
  const seen = new Set<string>();
  for (const f of FEATURES) {
    if (!/^[a-z]+\.[a-z0-9_]+$/.test(f.key) || f.key.length > 80) throw new Error(`bad feature key ${f.key}`);
    if (seen.has(f.key)) throw new Error(`duplicate feature key ${f.key}`);
    seen.add(f.key);
  }
  for (const l of LIMITS) {
    if (!/^limit\.[a-z0-9_]+$/.test(l.key) || seen.has(l.key)) throw new Error(`bad limit key ${l.key}`);
    seen.add(l.key);
  }
  if (FEATURES.length !== 561 || LIMITS.length !== 12)
    throw new Error('catalogue counts differ from the spec');
}
