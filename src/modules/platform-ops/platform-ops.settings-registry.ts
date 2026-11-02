import { z } from 'zod';
import ipaddr from 'ipaddr.js';
import type { SettingCategory, SettingValueType } from '../../models/platform-setting.model';
import { GST_STATE_CODES } from '../platform-billing/platform-billing.constants';

/**
 * The platform settings registry (module 07 section 7.1): every key with its category, type, default, description and Zod
 * schema. The seeder inserts missing keys with these defaults and never overwrites stored values. A key removed from this
 * list is left in the table and ignored.
 */
const STATE_CODES = new Set(Object.values(GST_STATE_CODES));
const pct = (max: number) =>
  z
    .string()
    .regex(/^\d{1,2}\.\d{4}$/, 'Use a decimal with 4 places, for example 18.0000')
    .refine(v => Number(v) >= 0 && Number(v) <= max, `0 to ${max}`);
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const oneOf = <T extends number>(...v: T[]) =>
  z.number().refine(n => (v as number[]).includes(n), `One of ${v.join(', ')}`);
const bool = z.boolean();

const cidr = z.string().refine(v => {
  try {
    ipaddr.parseCIDR(v);
    return true;
  } catch {
    return false;
  }
}, 'Not a valid IPv4 or IPv6 CIDR');

const slaWindow = z
  .object({ firstResponse: int(1, 720), resolution: int(1, 720) })
  .strict()
  .refine(w => w.firstResponse <= w.resolution, 'First response must not exceed resolution');
const slaHours = z.object({ HIGH: slaWindow, MEDIUM: slaWindow, LOW: slaWindow }).strict();

const manifestEntry = z.record(z.string(), z.unknown());

export interface SettingDef<S extends z.ZodType = z.ZodType> {
  category: SettingCategory;
  type: SettingValueType;
  default: z.infer<S>;
  description: string;
  schema: S;
  readOnly?: boolean;
  /** Modules that read the key (documentation only). */
  readBy: string;
}

function def<S extends z.ZodType>(d: SettingDef<S>): SettingDef<S> {
  return d;
}

export const SETTINGS_REGISTRY = {
  'company.platformName': def({
    category: 'GENERAL',
    type: 'STRING',
    default: 'SocietyApp',
    description: 'Name shown in emails, invoices and the status page',
    schema: z.string().min(2).max(60),
    readBy: '06, 16',
  }),
  'company.legalName': def({
    category: 'GENERAL',
    type: 'STRING',
    default: 'SocietyApp Technologies Pvt Ltd',
    description: 'Legal entity name printed on invoices',
    schema: z.string().min(3).max(200),
    readBy: '06',
  }),
  'company.gstin': def({
    category: 'GENERAL',
    type: 'STRING',
    default: '27ABCDE1234F1Z5',
    description: 'GSTIN printed on invoices; starts with the state code and contains the PAN',
    schema: z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Not a valid GSTIN'),
    readBy: '06',
  }),
  'company.stateCode': def({
    category: 'GENERAL',
    type: 'STRING',
    default: '27',
    description: 'GST state code of the place of supply (27 = Maharashtra)',
    schema: z
      .string()
      .regex(/^\d{2}$/)
      .refine(v => STATE_CODES.has(v), 'Unknown GST state code'),
    readBy: '06',
  }),
  'company.address': def({
    category: 'GENERAL',
    type: 'STRING',
    default: 'Office 401, Baner Road, Pune, Maharashtra 411045',
    description: 'Registered office address printed on invoices',
    schema: z.string().min(10).max(300),
    readBy: '06',
  }),
  'company.pan': def({
    category: 'GENERAL',
    type: 'STRING',
    default: 'ABCDE1234F',
    description: 'PAN of the company',
    schema: z.string().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Not a valid PAN'),
    readBy: '06',
  }),
  'company.supportEmail': def({
    category: 'GENERAL',
    type: 'STRING',
    default: 'help@societyapp.in',
    description: 'Support address shown to societies',
    schema: z.string().max(254).pipe(z.email()),
    readBy: '07, 16',
  }),
  'billing.sacCode': def({
    category: 'BILLING',
    type: 'STRING',
    default: '998314',
    description: 'SAC code on platform invoices',
    schema: z.string().regex(/^\d{6}$/),
    readBy: '06',
  }),
  'billing.gstRatePct': def({
    category: 'BILLING',
    type: 'STRING',
    default: '18.0000',
    description: 'GST rate in percent (decimal string)',
    schema: pct(28),
    readBy: '06',
  }),
  'billing.netTermsDays': def({
    category: 'BILLING',
    type: 'INTEGER',
    default: 15,
    description: 'Days from invoice issue to due date',
    schema: int(7, 45),
    readBy: '06',
  }),
  'billing.reminderOffsetsDays': def({
    category: 'BILLING',
    type: 'JSON',
    default: [-7, 0, 3, 7],
    description: 'Reminder days relative to the due date (negative = before)',
    schema: z
      .array(int(-15, 14))
      .min(1)
      .max(8)
      .refine(a => a.every((v, i) => i === 0 || a[i - 1]! < v), 'Sorted ascending and distinct'),
    readBy: '06',
  }),
  'billing.pastDueAfterDays': def({
    category: 'BILLING',
    type: 'INTEGER',
    default: 1,
    description: 'Days after the due date when a society becomes past due',
    schema: int(1, 10),
    readBy: '06',
  }),
  'billing.suspendAfterDays': def({
    category: 'BILLING',
    type: 'INTEGER',
    default: 15,
    description: 'Days after the due date when a past due society is suspended',
    schema: int(2, 60),
    readBy: '06',
  }),
  'billing.dunningMinDuePaise': def({
    category: 'BILLING',
    type: 'INTEGER',
    default: 10_000,
    description: 'Smallest overdue amount (paise) that triggers dunning',
    schema: int(0, 100_000),
    readBy: '06',
  }),
  'billing.maxGoodwillCreditPaise': def({
    category: 'BILLING',
    type: 'INTEGER',
    default: 50_000_000,
    description: 'Largest goodwill credit (paise) one approval may grant',
    schema: int(100, 100_000_000),
    readBy: '06',
  }),
  'billing.tdsMaxRatePct': def({
    category: 'BILLING',
    type: 'STRING',
    default: '10.0000',
    description: 'Highest TDS rate in percent a society may claim',
    schema: pct(20),
    readBy: '06',
  }),
  'billing.pendingOrderMinutes': def({
    category: 'BILLING',
    type: 'INTEGER',
    default: 30,
    description: 'Minutes before an unpaid gateway order is reconciled',
    schema: int(10, 1440),
    readBy: '06',
  }),
  'lifecycle.trialDays': def({
    category: 'LIFECYCLE',
    type: 'INTEGER',
    default: 14,
    description: 'Length of the free trial in days',
    schema: int(1, 60),
    readBy: '05',
  }),
  'lifecycle.trialMaxExtensions': def({
    category: 'LIFECYCLE',
    type: 'INTEGER',
    default: 2,
    description: 'How many times a trial may be extended',
    schema: int(0, 5),
    readBy: '05',
  }),
  'lifecycle.autoCloseSuspendedDays': def({
    category: 'LIFECYCLE',
    type: 'INTEGER',
    default: 60,
    description: 'Days a society stays suspended before it is closed (0 = never)',
    schema: z
      .number()
      .int()
      .refine(n => n === 0 || (n >= 30 && n <= 365), '0 (disabled) or 30 to 365'),
    readBy: '05',
  }),
  'lifecycle.retentionDaysAfterClose': def({
    category: 'LIFECYCLE',
    type: 'INTEGER',
    default: 90,
    description: 'Days a closed society keeps its data before purge',
    schema: int(30, 365),
    readBy: '05',
  }),
  'exports.fullExportDownloadDays': def({
    category: 'LIFECYCLE',
    type: 'INTEGER',
    default: 7,
    description: 'Days a full data export stays downloadable',
    schema: int(1, 30),
    readBy: '05',
  }),
  'exports.closureExportDownloadDays': def({
    category: 'LIFECYCLE',
    type: 'INTEGER',
    default: 30,
    description: 'Days a closure export stays downloadable',
    schema: int(7, 90),
    readBy: '05',
  }),
  'exports.maxPerSocietyPer24h': def({
    category: 'LIFECYCLE',
    type: 'INTEGER',
    default: 2,
    description: 'Data exports a society may request per 24 hours',
    schema: int(1, 10),
    readBy: '05',
  }),
  'supportAccess.consentTimeoutMinutes': def({
    category: 'LIFECYCLE',
    type: 'INTEGER',
    default: 1440,
    description: 'Minutes a society has to approve a support access request',
    schema: int(15, 4320),
    readBy: '05',
  }),
  'security.idleMinutes': def({
    category: 'SECURITY',
    type: 'INTEGER',
    default: 30,
    description: 'Idle timeout of platform console sessions',
    schema: oneOf(5, 15, 30, 60),
    readBy: '02',
  }),
  'security.stepUpMinutes': def({
    category: 'SECURITY',
    type: 'INTEGER',
    default: 5,
    description: 'How long a platform re-authentication stays valid',
    schema: oneOf(5, 10),
    readBy: '02',
  }),
  'security.ipAllowlist': def({
    category: 'SECURITY',
    type: 'JSON',
    default: [] as string[],
    description: 'IPv4 or IPv6 CIDR ranges allowed to call the platform API (empty = anyone)',
    schema: z
      .array(cidr)
      .max(50)
      .refine(a => new Set(a).size === a.length, 'Entries must be unique'),
    readBy: '07',
  }),
  'alerts.pastDue': def({
    category: 'NOTIFICATIONS',
    type: 'BOOLEAN',
    default: true,
    description: 'Alert the team when a society becomes past due',
    schema: bool,
    readBy: '06',
  }),
  'alerts.jobFailed': def({
    category: 'NOTIFICATIONS',
    type: 'BOOLEAN',
    default: true,
    description: 'Alert the team when background jobs fail',
    schema: bool,
    readBy: '07',
  }),
  'alerts.trialEnding': def({
    category: 'NOTIFICATIONS',
    type: 'BOOLEAN',
    default: true,
    description: 'Alert the team when a trial is about to end',
    schema: bool,
    readBy: '05',
  }),
  'alerts.providerDown': def({
    category: 'NOTIFICATIONS',
    type: 'BOOLEAN',
    default: true,
    description: 'Alert the team when a service provider changes status',
    schema: bool,
    readBy: '07',
  }),
  'support.slaHours': def({
    category: 'SUPPORT',
    type: 'JSON',
    default: {
      HIGH: { firstResponse: 2, resolution: 24 },
      MEDIUM: { firstResponse: 8, resolution: 72 },
      LOW: { firstResponse: 24, resolution: 120 },
    },
    description: 'First response and resolution hours by priority (calendar hours)',
    schema: slaHours,
    readBy: '07',
  }),
  'support.autoCloseDays': def({
    category: 'SUPPORT',
    type: 'INTEGER',
    default: 7,
    description: 'Days a resolved ticket can be reopened before it closes',
    schema: int(3, 30),
    readBy: '07',
  }),
  'support.waitingAutoResolveDays': def({
    category: 'SUPPORT',
    type: 'INTEGER',
    default: 14,
    description: 'Days a ticket waits on the society before it is resolved automatically',
    schema: int(7, 60),
    readBy: '07',
  }),
  'support.maxOpenTicketsPerSociety': def({
    category: 'SUPPORT',
    type: 'INTEGER',
    default: 25,
    description: 'Open tickets one society may have at a time',
    schema: int(5, 100),
    readBy: '07',
  }),
  'audit.archiveAfterMonths': def({
    category: 'DATA',
    type: 'INTEGER',
    default: 24,
    description: 'Audit rows older than this many months are archived',
    schema: int(24, 96),
    readBy: '07',
  }),
  'audit.archivePaused': def({
    category: 'DATA',
    type: 'BOOLEAN',
    default: false,
    description: 'Legal hold: stops audit archiving and archive deletion',
    schema: bool,
    readBy: '07',
  }),
  'audit.archiveManifest': def({
    category: 'DATA',
    type: 'JSON',
    default: [] as Record<string, unknown>[],
    description: 'System-managed list of audit archive objects',
    schema: z.array(manifestEntry),
    readOnly: true,
    readBy: '07',
  }),
  'status.publicEnabled': def({
    category: 'STATUS',
    type: 'BOOLEAN',
    default: true,
    description: 'Show the public status page',
    schema: bool,
    readBy: '07',
  }),
} as const;

export type SettingKey = keyof typeof SETTINGS_REGISTRY;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS_REGISTRY)[K]['schema']>;
export const SETTING_KEYS = Object.keys(SETTINGS_REGISTRY) as SettingKey[];

export const isSettingKey = (k: string): k is SettingKey =>
  Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY, k);

export const settingDef = (k: SettingKey): SettingDef => SETTINGS_REGISTRY[k] as unknown as SettingDef;

/** Cross-key rules of section 7.1, checked on the merged result of a save (BR-07-48). Returns the error code or null. */
export function crossKeyError(
  v: (k: SettingKey) => unknown,
): { code: string; message: string; keys: SettingKey[] } | null {
  const gstin = String(v('company.gstin'));
  const state = String(v('company.stateCode'));
  const pan = String(v('company.pan'));
  if (!gstin.startsWith(state) || gstin.slice(2, 12) !== pan)
    return {
      code: 'GSTIN_STATE_MISMATCH',
      message: 'The GSTIN must start with the state code and contain the PAN',
      keys: ['company.gstin', 'company.stateCode', 'company.pan'],
    };
  if (Number(v('billing.suspendAfterDays')) < Number(v('billing.pastDueAfterDays')) + 1)
    return {
      code: 'SUSPEND_NOT_AFTER_PAST_DUE',
      message: 'Suspend days must be later than past due days',
      keys: ['billing.suspendAfterDays', 'billing.pastDueAfterDays'],
    };
  const offsets = v('billing.reminderOffsetsDays') as number[];
  if (Math.min(...offsets) < -Number(v('billing.netTermsDays')))
    return {
      code: 'REMINDER_BEFORE_ISSUE',
      message: 'A reminder cannot be earlier than the invoice issue date',
      keys: ['billing.reminderOffsetsDays', 'billing.netTermsDays'],
    };
  return null;
}
