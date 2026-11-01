import { z } from 'zod';
import { logger } from '../../lib/logger';
import { GST_STATE_CODES } from './platform-billing.constants';

/**
 * Settings read by module 06 (section 5.3). Module 07 owns `platform_settings`; until it exists every key has its code
 * default. Module 07 replaces the source with `setBillingSettingsSource()` at start-up. Every value is validated with the
 * section 5.3 rules; an invalid stored value is logged and the default is used, so a bad setting can never produce a
 * wrong invoice.
 */
const STATE_CODES = new Set(Object.values(GST_STATE_CODES));
const pct = (max: number) =>
  z
    .string()
    .regex(/^\d{1,2}(\.\d{1,4})?$/)
    .refine(v => Number(v) >= 0 && Number(v) <= max, `0 to ${max}`);

export const BILLING_SETTING_SCHEMAS = {
  'company.legalName': z.string().min(3).max(200),
  'company.gstin': z.string().regex(/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/),
  'company.stateCode': z
    .string()
    .regex(/^\d{2}$/)
    .refine(v => STATE_CODES.has(v), 'unknown GST state code'),
  'company.address': z.string().min(10).max(300),
  'company.pan': z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/),
  'billing.sacCode': z.string().regex(/^\d{6}$/),
  'billing.gstRatePct': pct(28),
  'billing.netTermsDays': z.number().int().min(7).max(45),
  'billing.reminderOffsetsDays': z
    .array(z.number().int().min(-15).max(14))
    .min(1)
    .max(8)
    .refine(
      a => new Set(a).size === a.length && a.every((v, i) => i === 0 || a[i - 1]! < v),
      'sorted, distinct',
    ),
  'billing.pastDueAfterDays': z.number().int().min(1).max(10),
  'billing.suspendAfterDays': z.number().int().min(2).max(60),
  'billing.dunningMinDuePaise': z.number().int().min(0).max(100_000),
  'billing.maxGoodwillCreditPaise': z.number().int().min(100).max(100_000_000),
  'billing.tdsMaxRatePct': pct(20),
  'billing.pendingOrderMinutes': z.number().int().min(10).max(1440),
} as const;

export type BillingSettingKey = keyof typeof BILLING_SETTING_SCHEMAS;
export type BillingSettings = { [K in BillingSettingKey]: z.infer<(typeof BILLING_SETTING_SCHEMAS)[K]> };

export const BILLING_SETTING_DEFAULTS: BillingSettings = {
  'company.legalName': 'SocietyApp Technologies Pvt Ltd',
  'company.gstin': '27ABCDE1234F1Z5',
  'company.stateCode': '27',
  'company.address': 'Registered office, Baner, Pune, Maharashtra 411045',
  'company.pan': 'ABCDE1234F',
  'billing.sacCode': '998314',
  'billing.gstRatePct': '18.0000',
  'billing.netTermsDays': 15,
  'billing.reminderOffsetsDays': [-7, 0, 3, 7],
  'billing.pastDueAfterDays': 1,
  'billing.suspendAfterDays': 15,
  'billing.dunningMinDuePaise': 10_000,
  'billing.maxGoodwillCreditPaise': 50_000_000,
  'billing.tdsMaxRatePct': '10.0000',
  'billing.pendingOrderMinutes': 30,
};

/** Returns the stored value of a key, or undefined when nothing is stored (module 07 `platform_settings`). */
export type BillingSettingsSource = (key: BillingSettingKey) => Promise<unknown>;

let source: BillingSettingsSource | undefined;

/** Module 07 (or a test) replaces the code defaults; pass nothing to go back to them. */
export function setBillingSettingsSource(s?: BillingSettingsSource): void {
  source = s;
}

async function read<K extends BillingSettingKey>(key: K): Promise<BillingSettings[K]> {
  const fallback = BILLING_SETTING_DEFAULTS[key];
  if (!source) return fallback;
  const raw = await source(key);
  if (raw === undefined || raw === null) return fallback;
  const r = BILLING_SETTING_SCHEMAS[key].safeParse(raw);
  if (!r.success) {
    logger.warn({ key }, 'invalid platform billing setting; using the default');
    return fallback;
  }
  return r.data as BillingSettings[K];
}

/** All section 5.3 settings, validated (cross-field rules included). */
export async function billingSettings(): Promise<BillingSettings> {
  const out = {} as Record<string, unknown>;
  for (const key of Object.keys(BILLING_SETTING_SCHEMAS) as BillingSettingKey[]) out[key] = await read(key);
  const s = out as BillingSettings;
  if (s['billing.suspendAfterDays'] <= s['billing.pastDueAfterDays']) {
    logger.warn('billing.suspendAfterDays must exceed billing.pastDueAfterDays; using the defaults');
    s['billing.pastDueAfterDays'] = BILLING_SETTING_DEFAULTS['billing.pastDueAfterDays'];
    s['billing.suspendAfterDays'] = BILLING_SETTING_DEFAULTS['billing.suspendAfterDays'];
  }
  if (s['company.gstin'].slice(0, 2) !== s['company.stateCode']) {
    logger.warn('company.gstin does not start with company.stateCode; using the defaults');
    s['company.gstin'] = BILLING_SETTING_DEFAULTS['company.gstin'];
    s['company.stateCode'] = BILLING_SETTING_DEFAULTS['company.stateCode'];
  }
  return s;
}
