import { z } from 'zod';
import { istDate } from '../../lib/clock';

/**
 * The society settings registry (module 08 section 7.3, BR-08-7). Every key is declared once with its namespace, type,
 * default, Zod schema, permissions and flags. Keys and defaults are exactly those of the spec table. A key removed from
 * this list stays in `society_settings` and is ignored on read.
 */
export const SETTING_TYPES = ['INT', 'BOOL', 'STRING', 'ENUM', 'DEC', 'TIME', 'DATE', 'JSON'] as const;
export type SettingType = (typeof SETTING_TYPES)[number];
export type EditVia = 'SETTINGS' | 'PROFILE' | 'MODULE17';

export const SETTING_NAMESPACES = [
  'profile',
  'structure',
  'billing',
  'payments',
  'approvals',
  'committee',
  'amenities',
  'helpdesk',
  'staff',
  'parking',
  'vendors',
  'finance',
  'visitors',
  'security',
  'office',
  'communication',
  'residents',
] as const;
export type SettingNamespace = (typeof SETTING_NAMESPACES)[number];

/** View and edit permission per namespace (section 2). */
const NS_PERMISSIONS: Record<SettingNamespace, { view: string; edit: string }> = {
  profile: { view: 'settings.society.view', edit: 'settings.society.edit' },
  structure: { view: 'settings.society.view', edit: 'settings.society.edit' },
  visitors: { view: 'settings.society.view', edit: 'settings.society.edit' },
  office: { view: 'settings.society.view', edit: 'settings.society.edit' },
  communication: { view: 'settings.society.view', edit: 'settings.society.edit' },
  residents: { view: 'settings.society.view', edit: 'settings.society.edit' },
  security: { view: 'settings.society.view', edit: 'settings.society.edit' },
  finance: { view: 'finance.accounts.view', edit: 'finance.accounts.edit' },
  billing: { view: 'settings.billing_rules.view', edit: 'settings.billing_rules.edit' },
  payments: { view: 'finance.payments.view', edit: 'finance.payments.edit' },
  amenities: { view: 'amenities.amenities.view', edit: 'amenities.amenities.edit' },
  helpdesk: { view: 'helpdesk.settings.view', edit: 'helpdesk.settings.edit' },
  staff: { view: 'staff.society_staff.view', edit: 'staff.society_staff.edit' },
  parking: { view: 'parking.slots.view', edit: 'parking.slots.edit' },
  vendors: { view: 'vendors.vendors.view', edit: 'vendors.vendors.edit' },
  approvals: { view: 'settings.approval_rules.view', edit: 'settings.approval_rules.edit' },
  committee: { view: 'settings.members.view', edit: 'settings.members.edit' },
};
const ASSET_PERMISSIONS = { view: 'vendors.assets.view', edit: 'vendors.assets.edit' };

export interface SettingDef<T = unknown> {
  namespace: SettingNamespace;
  type: SettingType;
  default: T;
  description: string;
  schema: z.ZodType<T>;
  /** Shown to the screen: `{ min, max }`, `{ oneOf }`, `{ pattern }`, `{ maxItems }` ... */
  rules: Record<string, unknown>;
  viewPermission: string;
  editPermission: string;
  requiresStepUp: boolean;
  requiresReason: boolean;
  editVia: EditVia;
  /** Modules that read the key (documentation only). */
  readBy: string;
}

interface Opts {
  readBy: string;
  stepUp?: boolean;
  reason?: boolean;
  editVia?: EditVia;
  assetKey?: boolean;
}

const nsOf = (key: string): SettingNamespace => key.split('.')[0] as SettingNamespace;

function make<T>(
  key: string,
  type: SettingType,
  def: T,
  schema: z.ZodType<T>,
  rules: Record<string, unknown>,
  description: string,
  o: Opts,
): SettingDef<T> {
  const ns = nsOf(key);
  const perms = o.assetKey ? ASSET_PERMISSIONS : NS_PERMISSIONS[ns];
  return {
    namespace: ns,
    type,
    default: def,
    description,
    schema,
    rules,
    viewPermission: perms.view,
    editPermission: perms.edit,
    requiresStepUp: o.stepUp ?? false,
    requiresReason: o.reason ?? false,
    editVia: o.editVia ?? 'SETTINGS',
    readBy: o.readBy,
  };
}

// ------------------------------------------------------------------ value builders (each gives the schema and the rules shown to the screen)
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEC_RE = /^\d{1,2}\.\d{4}$/;
const timeStr = z.string().regex(TIME_RE, 'Use HH:mm (24-hour)');
const uniqueInts = (min: number, max: number, minItems: number, maxItems: number) =>
  z
    .array(z.number().int().min(min).max(max))
    .min(minItems)
    .max(maxItems)
    .refine(a => new Set(a).size === a.length, 'Values must be unique');
const descending = (a: number[]) => a.every((v, i) => i === 0 || a[i - 1]! > v);
const hours = z
  .object({ start: timeStr, end: timeStr })
  .strict()
  .refine(v => v.start < v.end, 'Start must be before end');

const cfg = {
  int: (
    key: string,
    def: number,
    min: number,
    max: number,
    description: string,
    o: Opts,
  ): [string, SettingDef<number>] => [
    key,
    make(key, 'INT', def, z.number().int().min(min).max(max), { min, max }, description, o),
  ],
  oneOf: (
    key: string,
    def: number,
    values: number[],
    description: string,
    o: Opts,
  ): [string, SettingDef<number>] => [
    key,
    make(
      key,
      'INT',
      def,
      z
        .number()
        .int()
        .refine(v => values.includes(v), `One of ${values.join(', ')}`),
      { oneOf: values },
      description,
      o,
    ),
  ],
  bool: (key: string, def: boolean, description: string, o: Opts): [string, SettingDef<boolean>] => [
    key,
    make(key, 'BOOL', def, z.boolean(), {}, description, o),
  ],
  en: <const V extends readonly [string, ...string[]]>(
    key: string,
    def: V[number],
    values: V,
    description: string,
    o: Opts,
  ): [string, SettingDef<V[number]>] => [
    key,
    make(
      key,
      'ENUM',
      def,
      z.enum(values) as unknown as z.ZodType<V[number]>,
      { oneOf: values },
      description,
      o,
    ),
  ],
  str: (
    key: string,
    def: string,
    pattern: RegExp,
    description: string,
    o: Opts,
  ): [string, SettingDef<string>] => [
    key,
    make(
      key,
      'STRING',
      def,
      z.string().regex(pattern, `Must match ${pattern.source}`),
      { pattern: pattern.source },
      description,
      o,
    ),
  ],
  dec: (
    key: string,
    def: string,
    min: number,
    max: number,
    description: string,
    o: Opts,
  ): [string, SettingDef<string>] => [
    key,
    make(
      key,
      'DEC',
      def,
      z
        .string()
        .regex(DEC_RE, 'Use a decimal with 4 places, for example 18.0000')
        .refine(v => Number(v) >= min && Number(v) <= max, `${min} to ${max}`),
      { min, max, pattern: DEC_RE.source },
      description,
      o,
    ),
  ],
  time: (key: string, def: string, description: string, o: Opts): [string, SettingDef<string>] => [
    key,
    make(key, 'TIME', def, timeStr, { pattern: TIME_RE.source }, description, o),
  ],
  json: <T>(
    key: string,
    def: T,
    schema: z.ZodType<T>,
    rules: Record<string, unknown>,
    description: string,
    o: Opts,
  ): [string, SettingDef<T>] => [key, make(key, 'JSON', def, schema, rules, description, o)],
  /** Nullable profile string; `editVia = PROFILE`. */
  profileStr: (
    key: string,
    schema: z.ZodType<string | null>,
    type: SettingType,
    rules: Record<string, unknown>,
    description: string,
    readBy: string,
    def: string | null = null,
  ): [string, SettingDef<string | null>] => [
    key,
    make<string | null>(key, type, def, schema, rules, description, { readBy, editVia: 'PROFILE' }),
  ],
};

const SOCIETY_TYPES = [
  'COOPERATIVE_HOUSING_SOCIETY',
  'APARTMENT_OWNERS_ASSOCIATION',
  'RESIDENT_WELFARE_ASSOCIATION',
  'FEDERATION',
  'COMMERCIAL_COMPLEX',
  'OTHER',
] as const;
const CARD_METHODS = ['UPI', 'CARD', 'NETBANKING', 'WALLET'] as const;
const PHONE_RE = /^([6-9]\d{9}|0\d{9,11})$/;

const handoverItem = z
  .object({
    title: z.string().min(3).max(120),
    ownerDesignation: z.string().nullable(),
  })
  .strict();
const DEFAULT_HANDOVER: { title: string; ownerDesignation: string | null }[] = [
  { title: 'Bank signatories and mandate changed', ownerDesignation: 'TREASURER' },
  { title: 'Cheque books, cash and petty cash handed over', ownerDesignation: 'TREASURER' },
  { title: 'Payment gateway, UPI and banking app access updated', ownerDesignation: 'TREASURER' },
  { title: 'Society seal and rubber stamps handed over', ownerDesignation: 'SECRETARY' },
  {
    title: 'Statutory registers, share certificates and minute books handed over',
    ownerDesignation: 'SECRETARY',
  },
  { title: 'Files, agreements, AMCs and vendor contracts handed over', ownerDesignation: 'SECRETARY' },
  { title: 'Keys (office, terrace, lift and pump rooms) handed over', ownerDesignation: 'SECRETARY' },
  { title: 'Registrar informed of the new committee', ownerDesignation: 'SECRETARY' },
  { title: 'Society email, website and social media passwords changed', ownerDesignation: 'CHAIRMAN' },
  { title: 'Pending court cases, notices and dues of the society briefed', ownerDesignation: 'CHAIRMAN' },
];

const shiftTemplate = z
  .object({ name: z.string().min(2).max(40), start: timeStr, end: timeStr })
  .strict()
  .refine(s => s.start !== s.end, 'Start and end must differ');
const DEFAULT_SHIFTS = [
  { name: 'Morning', start: '06:00', end: '14:00' },
  { name: 'Evening', start: '14:00', end: '22:00' },
  { name: 'Night', start: '22:00', end: '06:00' },
  { name: 'General', start: '09:00', end: '18:00' },
];

const overstay = z
  .object({
    GUEST: z.number().int().min(5).max(1440),
    DELIVERY: z.number().int().min(5).max(1440),
    CAB: z.number().int().min(5).max(1440),
    SERVICE: z.number().int().min(5).max(1440),
    OTHER: z.number().int().min(5).max(1440),
  })
  .strict();

const entries = [
  // ---- profile (editVia PROFILE: written by PATCH /society)
  cfg.profileStr(
    'profile.societyType',
    z.enum(SOCIETY_TYPES) as unknown as z.ZodType<string | null>,
    'ENUM',
    { oneOf: SOCIETY_TYPES },
    'Type of society',
    '22, 23',
    'COOPERATIVE_HOUSING_SOCIETY',
  ),
  cfg.profileStr(
    'profile.pan',
    z
      .string()
      .regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Not a valid PAN')
      .nullable(),
    'STRING',
    { pattern: '^[A-Z]{5}\\d{4}[A-Z]$', nullable: true },
    'PAN of the society',
    '13, 23',
  ),
  cfg.profileStr(
    'profile.tan',
    z
      .string()
      .regex(/^[A-Z]{4}\d{5}[A-Z]$/, 'Not a valid TAN')
      .nullable(),
    'STRING',
    { pattern: '^[A-Z]{4}\\d{5}[A-Z]$', nullable: true },
    'TAN of the society',
    '13',
  ),
  cfg.profileStr(
    'profile.registrationDate',
    z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
      .refine(v => v <= istDate(), 'Cannot be in the future')
      .nullable(),
    'DATE',
    { nullable: true },
    'Date the society was registered',
    '23',
  ),
  cfg.profileStr(
    'profile.contactEmail',
    z.string().trim().toLowerCase().max(254).pipe(z.email()).nullable(),
    'STRING',
    { maxLength: 254, nullable: true },
    'Office e-mail address',
    '16, 25',
  ),
  cfg.profileStr(
    'profile.contactPhone',
    z.string().regex(PHONE_RE, 'Use a mobile number or a landline with the STD code').nullable(),
    'STRING',
    { pattern: PHONE_RE.source, nullable: true },
    'Office phone number',
    '25',
  ),
  // ---- structure
  cfg.str('structure.groundFloorLabel', 'G', /^[A-Z]{1,3}$/, 'Label of the ground floor', {
    readBy: '08, 09, 25',
  }),
  cfg.str('structure.basementPrefix', 'B', /^[A-Z]{1,3}$/, 'Prefix of basement floors (B1, B2)', {
    readBy: '08',
  }),
  cfg.en('structure.areaDisplayUnit', 'SQFT', ['SQFT', 'SQM'] as const, 'Unit used to show areas', {
    readBy: '08, 09, 25',
  }),
  // ---- billing
  cfg.en(
    'billing.cycle',
    'MONTHLY',
    ['MONTHLY', 'QUARTERLY', 'HALF_YEARLY', 'ANNUAL'] as const,
    'How often bills are raised',
    { readBy: '11' },
  ),
  cfg.int('billing.billingDay', 1, 1, 28, 'Day of the month on which bills are dated', { readBy: '11' }),
  cfg.int('billing.dueDays', 15, 0, 60, 'Days to pay after the bill date', { readBy: '11, 12' }),
  cfg.bool(
    'billing.shiftDueDateOnHoliday',
    false,
    'Move a due date that falls on a holiday to the next working day',
    {
      readBy: '11',
    },
  ),
  cfg.en(
    'billing.areaBasis',
    'CARPET',
    ['CARPET', 'BUILT_UP', 'SUPER_BUILT_UP'] as const,
    'Area used to charge maintenance per sq ft',
    { readBy: '08, 11', reason: true },
  ),
  cfg.en(
    'billing.lateFeeDefaultMode',
    'SIMPLE_INTEREST',
    ['NONE', 'SIMPLE_INTEREST', 'FLAT'] as const,
    'Default late fee mode',
    { readBy: '11' },
  ),
  cfg.dec(
    'billing.lateFeeDefaultRatePct',
    '18.0000',
    0,
    21,
    'Default late interest, percent per year (21 is the model bye-law ceiling, verify per society)',
    { readBy: '11' },
  ),
  cfg.int('billing.lateFeeDefaultFlatPaise', 0, 0, 1_000_000, 'Default flat late fee in paise', {
    readBy: '11',
  }),
  cfg.int('billing.lateFeeGraceDays', 5, 0, 30, 'Days after the due date before a late fee applies', {
    readBy: '11',
  }),
  cfg.str('billing.invoicePrefix', 'INV', /^[A-Z][A-Z0-9]{1,7}$/, 'Invoice number prefix', { readBy: '11' }),
  cfg.str('billing.receiptPrefix', 'RCT', /^[A-Z][A-Z0-9]{1,7}$/, 'Receipt number prefix', { readBy: '12' }),
  cfg.bool('billing.roundToRupee', true, 'Round the invoice total half-up to whole rupees', { readBy: '11' }),
  cfg.dec('billing.earlyPaymentRebatePct', '0.0000', 0, 10, 'Rebate in percent for early payment', {
    readBy: '11',
  }),
  cfg.bool('billing.applyGst', false, 'Charge GST on maintenance (needs a GSTIN)', { readBy: '11' }),
  cfg.int(
    'billing.gstExemptLimitPerUnitPaise',
    750_000,
    0,
    10_000_000,
    'Monthly per-unit charge up to this amount is GST-exempt (verify with a tax adviser)',
    { readBy: '11' },
  ),
  // ---- payments
  cfg.bool('payments.allowPartialPayments', true, 'Residents may pay part of a bill', { readBy: '12' }),
  cfg.bool('payments.allowAdvancePayments', true, 'Residents may pay in advance', { readBy: '12' }),
  cfg.int('payments.orderExpiryMinutes', 30, 5, 1440, 'Minutes a payment order stays open', { readBy: '12' }),
  cfg.int('payments.paymentLinkExpiryDays', 7, 1, 30, 'Days a payment link stays valid', { readBy: '12' }),
  cfg.en(
    'payments.convenienceFeeMode',
    'SOCIETY_ABSORBS',
    ['SOCIETY_ABSORBS', 'PASS_TO_PAYER'] as const,
    'Who pays the gateway convenience fee',
    { readBy: '12' },
  ),
  cfg.json(
    'payments.convenienceFeeMethods',
    ['CARD', 'NETBANKING', 'WALLET'] as (typeof CARD_METHODS)[number][],
    z
      .array(z.enum(CARD_METHODS))
      .min(1)
      .max(4)
      .refine(a => new Set(a).size === a.length, 'Values must be unique'),
    { oneOf: CARD_METHODS, minItems: 1, maxItems: 4 },
    'Payment methods on which the convenience fee applies',
    { readBy: '12' },
  ),
  cfg.int('payments.chequeBounceChargePaise', 50_000, 0, 500_000, 'Charge for a bounced cheque, in paise', {
    readBy: '12',
  }),
  cfg.int('payments.chequeBounceBlockCount', 2, 1, 5, 'Bounced cheques after which cheques are refused', {
    readBy: '12',
  }),
  cfg.int('payments.lateReturnDays', 30, 0, 90, 'Days after which a returned payment is treated as late', {
    readBy: '12',
  }),
  cfg.bool('payments.autoApplyAdvance', true, 'Apply advance payments to new bills automatically', {
    readBy: '12',
  }),
  cfg.int('payments.autopayDebitDaysBeforeDue', 2, 1, 5, 'Days before the due date on which autopay debits', {
    readBy: '12',
  }),
  cfg.bool('payments.treasurerPaymentAlerts', false, 'Alert the treasurer on every payment', {
    readBy: '12',
  }),
  // ---- approvals
  cfg.int(
    'approvals.stepUpAbovePaise',
    2_500_000,
    100_000,
    1_000_000_000_000,
    'Approving a request of this amount or more asks for a fresh code (in paise)',
    { readBy: '14' },
  ),
  cfg.int(
    'approvals.bulkApproveBelowPaise',
    2_500_000,
    100_000,
    1_000_000_000_000,
    'Bulk approve only for amounts below this (in paise)',
    { readBy: '14' },
  ),
  // ---- committee
  cfg.bool('committee.ownersOnly', true, 'Only owners can sit on the committee', { readBy: '10' }),
  cfg.int('committee.minStrength', 3, 3, 25, 'Smallest committee size', { readBy: '10' }),
  cfg.int('committee.maxStrength', 25, 3, 25, 'Largest committee size', { readBy: '10' }),
  cfg.int('committee.maxTermYears', 5, 1, 5, 'Longest committee term in years', { readBy: '10' }),
  cfg.bool('committee.coOptionAllowed', true, 'The committee may co-opt members', { readBy: '10' }),
  cfg.json(
    'committee.reminderDays',
    [90, 30, 7],
    uniqueInts(1, 365, 1, 3),
    { minItems: 1, maxItems: 3, min: 1, max: 365, unique: true },
    'Days before the term ends on which reminders go out',
    { readBy: '10' },
  ),
  cfg.bool('committee.showOnResidentApp', true, 'Show the committee in the resident app', {
    readBy: '10, 25',
  }),
  cfg.int('committee.handoverDelegationDays', 30, 1, 60, 'Days a hand-over delegation may last', {
    readBy: '10',
  }),
  cfg.json(
    'committee.handoverTemplate',
    DEFAULT_HANDOVER,
    z.array(handoverItem).max(40) as z.ZodType<typeof DEFAULT_HANDOVER>,
    { maxItems: 40 },
    'Hand-over checklist template',
    { readBy: '10' },
  ),
  // ---- finance
  cfg.bool('finance.showFinancesToResidents', false, 'Show the society finances to residents', {
    readBy: '01, 03, 13',
    stepUp: true,
    reason: true,
  }),
  cfg.int(
    'finance.billRequiredAbovePaise',
    200_000,
    0,
    100_000_000,
    'Expenses above this need a bill photo (paise)',
    {
      readBy: '13',
    },
  ),
  cfg.bool('finance.gstInputClaimable', false, 'GST on expenses can be claimed as input credit', {
    readBy: '13',
  }),
  cfg.int('finance.autoMatchWindowDays', 3, 0, 10, 'Days around a date within which bank lines are matched', {
    readBy: '13',
  }),
  cfg.int('finance.clearingAlertDays', 3, 1, 15, 'Days after which an uncleared item raises an alert', {
    readBy: '13',
  }),
  cfg.int('finance.maxUnlockHours', 72, 1, 168, 'Hours a locked period stays unlocked', {
    readBy: '13, 14',
    stepUp: true,
  }),
  cfg.int('finance.expenseBackdateDays', 90, 1, 365, 'Days an expense may be back-dated', { readBy: '13' }),
  // ---- amenities
  cfg.int('amenities.paymentHoldMinutes', 15, 5, 60, 'Minutes a slot is held while the booker pays', {
    readBy: '18',
  }),
  cfg.int('amenities.approvedPaymentHoldHours', 24, 1, 72, 'Hours an approved booking waits for payment', {
    readBy: '18',
  }),
  cfg.int('amenities.approvalHoldHours', 48, 1, 168, 'Hours a booking waits for approval', { readBy: '18' }),
  cfg.int('amenities.waitlistOfferMinutes', 120, 15, 1440, 'Minutes a waitlist offer stays open', {
    readBy: '18',
  }),
  cfg.int('amenities.maxWaitlistPerUnit', 5, 0, 20, 'Waitlist places per unit (0 disables waitlists)', {
    readBy: '18',
  }),
  cfg.int('amenities.checkInEarlyMinutes', 30, 0, 180, 'Minutes before the start a check-in is allowed', {
    readBy: '18, 27',
  }),
  cfg.int(
    'amenities.noShowAfterMinutes',
    30,
    5,
    240,
    'Minutes after the start after which a booking is a no-show',
    {
      readBy: '18',
    },
  ),
  cfg.int('amenities.damageReportDays', 3, 0, 14, 'Days after use in which damage can be reported', {
    readBy: '18',
  }),
  cfg.int('amenities.chargeDueDays', 7, 0, 30, 'Days to pay an amenity charge', { readBy: '18' }),
  cfg.bool('amenities.duesBlockEnabled', false, 'Block bookings for units with dues', { readBy: '18' }),
  cfg.int(
    'amenities.duesBlockAbovePaise',
    500_000,
    0,
    100_000_000,
    'Dues above this block bookings (paise)',
    {
      readBy: '18',
    },
  ),
  cfg.bool('amenities.showBookerToResidents', false, 'Show who booked an amenity to other residents', {
    readBy: '18',
  }),
  cfg.int(
    'amenities.reminderHoursBefore',
    24,
    0,
    72,
    'Hours before a booking a reminder goes out (0 = none)',
    {
      readBy: '18',
    },
  ),
  // ---- helpdesk
  cfg.int('helpdesk.autoCloseHours', 72, 24, 336, 'Hours after resolution a ticket closes by itself', {
    readBy: '15',
  }),
  cfg.int('helpdesk.reopenWindowDays', 7, 1, 30, 'Days a closed ticket may be reopened', { readBy: '15' }),
  cfg.int('helpdesk.maxReopens', 3, 1, 10, 'Times a ticket may be reopened', { readBy: '15' }),
  cfg.int(
    'helpdesk.waitingReminderHours',
    72,
    12,
    168,
    'Hours before a waiting ticket reminds the resident',
    {
      readBy: '15',
    },
  ),
  cfg.int(
    'helpdesk.waitingAutoResolveDays',
    7,
    2,
    30,
    'Days after which a waiting ticket resolves by itself',
    {
      readBy: '15',
    },
  ),
  cfg.int('helpdesk.duplicateWindowHours', 24, 1, 168, 'Hours within which a similar ticket is a duplicate', {
    readBy: '15',
  }),
  cfg.int('helpdesk.upvoteRaiseThreshold', 10, 3, 100, 'Upvotes after which an issue is raised in priority', {
    readBy: '15',
  }),
  cfg.int('helpdesk.lowCsatThreshold', 2, 1, 3, 'Rating at or below which a ticket is flagged', {
    readBy: '15',
  }),
  cfg.int('helpdesk.recurringCount', 3, 2, 10, 'Tickets that make an issue recurring', { readBy: '15' }),
  cfg.int('helpdesk.recurringWindowDays', 30, 7, 90, 'Days in which recurring tickets are counted', {
    readBy: '15',
  }),
  cfg.int('helpdesk.chargeTolerancePct', 10, 0, 50, 'Percent a charge may exceed its estimate', {
    readBy: '15',
  }),
  cfg.int('helpdesk.chargeDueDays', 15, 1, 60, 'Days to pay a ticket charge', { readBy: '15' }),
  cfg.bool('helpdesk.showReporterOnBuildingIssues', false, 'Show the reporter on building-wide issues', {
    readBy: '15',
  }),
  cfg.int('helpdesk.unassignedReminderMinutes', 30, 10, 240, 'Minutes before an unassigned ticket reminds', {
    readBy: '15',
  }),
  cfg.int('helpdesk.residentDailyTicketLimit', 20, 5, 100, 'Tickets one resident may raise per day', {
    readBy: '15',
  }),
  // ---- staff
  cfg.bool('staff.helpRequiresApproval', true, 'A domestic help needs approval before working', {
    readBy: '20',
  }),
  cfg.int('staff.helpMaxUnits', 15, 1, 50, 'Units one domestic help may work in', { readBy: '20' }),
  cfg.int('staff.unitMaxHelps', 10, 1, 30, 'Domestic helps one unit may have', { readBy: '20, 25' }),
  cfg.bool('staff.entryRequiresVerification', false, 'Entry needs a verified help', { readBy: '20, 27' }),
  cfg.int(
    'staff.absenceGraceMinutes',
    45,
    10,
    240,
    'Minutes after the shift start before an absence is marked',
    {
      readBy: '20',
    },
  ),
  cfg.int(
    'staff.lateGraceMinutes',
    10,
    0,
    120,
    'Minutes after the shift start before a staff member is late',
    {
      readBy: '20, 24',
    },
  ),
  cfg.int('staff.autoCloseHours', 16, 4, 24, 'Hours after which an open attendance closes by itself', {
    readBy: '20',
  }),
  cfg.bool('staff.selfCheckInEnabled', true, 'Staff may check themselves in', { readBy: '20, 27, 28' }),
  cfg.bool('staff.staffAbsenceAlerts', true, 'Alert on staff absence', { readBy: '20' }),
  cfg.json(
    'staff.verificationReminderDays',
    [30, 7, 0],
    uniqueInts(0, 90, 1, 3).refine(descending, 'Values must be in descending order'),
    { minItems: 1, maxItems: 3, min: 0, max: 90, unique: true, order: 'descending' },
    'Days before a verification expires on which reminders go out',
    { readBy: '20' },
  ),
  cfg.int(
    'staff.policeVerificationValidityMonths',
    24,
    6,
    60,
    'Months a police verification stays valid (local practice varies; confirm with the police station)',
    { readBy: '20' },
  ),
  cfg.int('staff.reviewMinDays', 30, 0, 180, 'Days a resident must have used a help before a review', {
    readBy: '20, 25',
  }),
  cfg.en(
    'staff.reviewModeration',
    'TEXT_ONLY',
    ['NONE', 'TEXT_ONLY', 'ALL'] as const,
    'Which reviews are moderated',
    {
      readBy: '20',
    },
  ),
  cfg.json(
    'staff.shiftTemplates',
    DEFAULT_SHIFTS,
    z
      .array(shiftTemplate)
      .min(1)
      .max(10)
      .refine(a => new Set(a.map(s => s.name.toLowerCase())).size === a.length, 'Shift names must be unique'),
    { minItems: 1, maxItems: 10 },
    'Shift templates',
    { readBy: '20, 28' },
  ),
  // ---- visitors
  cfg.en(
    'visitors.approvalMode',
    'RESIDENT_APPROVAL',
    ['RESIDENT_APPROVAL', 'GUARD_DISCRETION'] as const,
    'Who approves a visitor',
    { readBy: '17, 27' },
  ),
  cfg.int('visitors.approvalTimeoutSeconds', 90, 30, 300, 'Seconds a resident has to answer', {
    readBy: '17, 27',
  }),
  cfg.bool('visitors.capturePhoto', true, 'Take a photo of every visitor', { readBy: '17, 27' }),
  cfg.en(
    'visitors.deliveryDefault',
    'ASK_RESIDENT',
    ['ASK_RESIDENT', 'LEAVE_AT_GATE', 'SEND_UP'] as const,
    'What happens to a delivery by default',
    { readBy: '17, 25, 27' },
  ),
  cfg.int('visitors.retentionDays', 90, 30, 365, 'Days visitor records are kept', { readBy: '17' }),
  cfg.int('visitors.autoExitAfterHours', 24, 6, 72, 'Hours after which a visitor is marked as exited', {
    readBy: '17',
  }),
  cfg.json(
    'visitors.overstayMinutes',
    { GUEST: 720, DELIVERY: 20, CAB: 15, SERVICE: 480, OTHER: 240 },
    overstay,
    { keys: ['GUEST', 'DELIVERY', 'CAB', 'SERVICE', 'OTHER'], min: 5, max: 1440 },
    'Minutes after which a visitor of each kind has overstayed',
    { readBy: '17' },
  ),
  cfg.int('visitors.passGraceMinutes', 15, 0, 60, 'Minutes a visitor pass stays valid after its window', {
    readBy: '17',
  }),
  cfg.int('visitors.passMaxDays', 7, 1, 30, 'Longest window of a one-time pass in days', { readBy: '17' }),
  cfg.int('visitors.deliveryReminderHours', 24, 4, 72, 'Hours before a held delivery reminds the resident', {
    readBy: '17',
  }),
  cfg.int('visitors.deliveryEscalateDays', 7, 2, 30, 'Days after which a held delivery escalates', {
    readBy: '17',
  }),
  cfg.int('visitors.sosEscalationSeconds', 60, 30, 300, 'Seconds before an SOS escalates', { readBy: '17' }),
  [
    'visitors.accessCardDepositPaise',
    make(
      'visitors.accessCardDepositPaise',
      'INT',
      50_000,
      z
        .number()
        .int()
        .refine(v => v === 0 || (v >= 100 && v <= 100_000_000), '0 or 100 to 100000000'),
      { min: 100, max: 100_000_000, allowZero: true },
      'Deposit for an access card, in paise',
      { readBy: '17' },
    ),
  ] as [string, SettingDef<number>],
  cfg.int('visitors.accessCardReplacementFeePaise', 20_000, 0, 1_000_000, 'Fee to replace an access card', {
    readBy: '17',
  }),
  cfg.json(
    'visitors.patrolPlans',
    [] as Record<string, unknown>[],
    z.array(z.record(z.string(), z.unknown())).max(10),
    { maxItems: 10 },
    'Patrol plans (written by module 17 only)',
    { readBy: '17', editVia: 'MODULE17' },
  ),
  // ---- security
  cfg.oneOf('security.adminIdleMinutes', 30, [5, 15, 30, 60], 'Admin app idle sign-out in minutes', {
    readBy: '02',
    stepUp: true,
    reason: true,
  }),
  cfg.oneOf('security.stepUpMinutes', 5, [5, 10], 'Minutes a fresh code stays valid', {
    readBy: '02',
    stepUp: true,
    reason: true,
  }),
  // ---- parking
  cfg.int('parking.maxFourWheelersPerUnit', 2, 1, 10, 'Four-wheelers one unit may register', {
    readBy: '19',
  }),
  cfg.int('parking.maxTwoWheelersPerUnit', 3, 1, 10, 'Two-wheelers one unit may register', { readBy: '19' }),
  cfg.bool('parking.requireVehicleVerification', true, 'New vehicles need verification', { readBy: '19' }),
  cfg.bool('parking.allowOtherPlateFormat', true, 'Allow number plates in other formats', { readBy: '19' }),
  cfg.bool('parking.lookupShowsOwnerName', true, 'A plate lookup shows the owner name', { readBy: '19' }),
  cfg.en(
    'parking.defaultChargeMode',
    'BILLING_RULE',
    ['NONE', 'BILLING_RULE', 'MONTHLY_ADHOC'] as const,
    'How parking is charged by default',
    { readBy: '19' },
  ),
  cfg.int(
    'parking.defaultMonthlyChargeFourWheelerPaise',
    0,
    0,
    10_000_000,
    'Default monthly charge for a four-wheeler slot (paise)',
    { readBy: '19' },
  ),
  cfg.int(
    'parking.defaultMonthlyChargeTwoWheelerPaise',
    0,
    0,
    10_000_000,
    'Default monthly charge for a two-wheeler slot (paise)',
    { readBy: '19' },
  ),
  cfg.int('parking.evTariffPerKwhPaise', 1200, 0, 10_000, 'EV charging tariff per kWh (paise)', {
    readBy: '19',
  }),
  cfg.int('parking.guestSlotMaxHours', 4, 1, 72, 'Hours a guest may use a slot', { readBy: '19' }),
  cfg.int('parking.guestOverstayGraceMinutes', 15, 0, 120, 'Minutes of grace before a guest overstays', {
    readBy: '19',
  }),
  cfg.int('parking.guestOverstayFeePerHourPaise', 0, 0, 100_000, 'Guest overstay fee per hour (0 = no fee)', {
    readBy: '19',
  }),
  cfg.int('parking.guestPreBookMaxDaysAhead', 7, 1, 30, 'Days ahead a guest slot may be booked', {
    readBy: '19',
  }),
  cfg.int('parking.guestPreBookMaxPerUnitPerDay', 2, 1, 5, 'Guest slot bookings per unit per day', {
    readBy: '19',
  }),
  cfg.int('parking.stickerValidityMonths', 0, 0, 60, 'Months a sticker is valid (0 = no expiry)', {
    readBy: '19',
  }),
  cfg.int('parking.stickerFeePaise', 0, 0, 100_000, 'Fee for a sticker (paise)', { readBy: '19' }),
  cfg.int('parking.stickerReplacementFeePaise', 10_000, 0, 100_000, 'Fee to replace a sticker (paise)', {
    readBy: '19',
  }),
  cfg.int('parking.violationEscalationMinutes', 30, 5, 240, 'Minutes before a violation escalates', {
    readBy: '19',
  }),
  cfg.int('parking.repeatOffenderWarnCount', 3, 2, 10, 'Violations that make a repeat offender', {
    readBy: '19',
  }),
  cfg.int('parking.repeatOffenderWindowDays', 30, 7, 180, 'Days in which violations are counted', {
    readBy: '19',
  }),
  cfg.int('parking.defaultFinePaise', 50_000, 100, 1_000_000, 'Default fine for a violation (paise)', {
    readBy: '19',
  }),
  cfg.en('parking.waitlistMode', 'FIFO', ['FIFO', 'LOTTERY'] as const, 'How the parking waitlist is served', {
    readBy: '19',
  }),
  cfg.bool('parking.waitlistRequiresVehicle', true, 'Joining the waitlist needs a vehicle', { readBy: '19' }),
  cfg.bool('parking.waitlistOnlyWithoutSlot', false, 'Only units without a slot may join the waitlist', {
    readBy: '19',
  }),
  cfg.bool('parking.waitlistBlockOnDues', false, 'Units with dues cannot join the waitlist', {
    readBy: '19',
  }),
  cfg.int('parking.waitlistDuesLimitPaise', 0, 0, 100_000_000, 'Dues above this block the waitlist (paise)', {
    readBy: '19',
  }),
  cfg.int('parking.offerAcceptDays', 7, 1, 30, 'Days a slot offer stays open', { readBy: '19' }),
  cfg.int('parking.inactiveVehicleRetentionDays', 365, 90, 3650, 'Days an inactive vehicle is kept', {
    readBy: '19',
  }),
  // ---- vendors
  cfg.bool('vendors.kycBlockOnExpiry', false, 'Block a vendor whose KYC has expired', { readBy: '21' }),
  cfg.int('vendors.minQuotations', 3, 0, 5, 'Quotations needed for a large purchase', { readBy: '21' }),
  cfg.int(
    'vendors.quotationsRequiredAbovePaise',
    2_500_000,
    0,
    1_000_000_000,
    'Purchases above this need quotations (paise)',
    {
      readBy: '21',
    },
  ),
  cfg.dec('vendors.billVarianceTolerancePct', '2.0000', 0, 20, 'Percent a bill may differ from its order', {
    readBy: '21',
  }),
  cfg.int(
    'vendors.billVarianceToleranceMaxPaise',
    50_000,
    0,
    10_000_000,
    'Most a bill may differ from its order (paise)',
    {
      readBy: '21',
    },
  ),
  cfg.str(
    'vendors.contractReminderDays',
    '60,30,7',
    /^\d{1,3}(,\d{1,3}){0,2}$/,
    'Days before a contract ends on which reminders go out (comma separated)',
    { readBy: '21' },
  ),
  cfg.bool('vendors.workOrderSignOffRequired', true, 'A work order needs sign-off', { readBy: '21' }),
  cfg.bool('vendors.readingPhotoRequired', true, 'A meter reading needs a photo', {
    readBy: '21',
    assetKey: true,
  }),
  cfg.dec(
    'vendors.highConsumptionFactor',
    '3.0000',
    1.5,
    10,
    'Factor above the average that flags high consumption',
    {
      readBy: '21',
      assetKey: true,
    },
  ),
  // ---- office
  cfg.json(
    'office.weeklyOffDays',
    [0],
    uniqueInts(0, 6, 0, 2).refine(a => a.every((v, i) => i === 0 || a[i - 1]! < v), 'Values must be sorted'),
    { minItems: 0, maxItems: 2, min: 0, max: 6, unique: true, sorted: true },
    'Weekly off days (0 = Sunday)',
    { readBy: '08, 11, 15, 20' },
  ),
  cfg.time('office.openTime', '09:00', 'Office opening time', { readBy: '15, 20, 25' }),
  cfg.time('office.closeTime', '18:00', 'Office closing time', { readBy: '15, 20, 25' }),
  // ---- communication
  cfg.en(
    'communication.defaultLanguage',
    'en',
    ['en', 'hi', 'mr', 'gu', 'ta', 'te', 'kn', 'bn'] as const,
    'Default language of messages',
    { readBy: '16' },
  ),
  cfg.int('communication.maxPinnedNotices', 5, 1, 10, 'Notices that may be pinned', { readBy: '16' }),
  cfg.int('communication.ackReminderHours', 48, 12, 168, 'Hours before an unacknowledged notice reminds', {
    readBy: '16',
  }),
  cfg.int('communication.ackMaxReminders', 3, 0, 5, 'Reminders for an unacknowledged notice', {
    readBy: '16',
  }),
  cfg.time('communication.quietHoursStart', '22:00', 'Start of quiet hours', { readBy: '16' }),
  cfg.time('communication.quietHoursEnd', '07:00', 'End of quiet hours', { readBy: '16' }),
  // ---- residents
  cfg.bool('residents.tenantsCanVote', false, 'Tenants may vote (per bye-laws)', { readBy: '22' }),
  cfg.bool('residents.directoryEnabled', true, 'Show the resident directory', { readBy: '09, 26' }),
  cfg.bool('residents.joinRequestNeedsApproval', true, 'Join requests need approval', { readBy: '09' }),
  cfg.bool('residents.tenancyRequiresApproval', true, 'A tenancy needs approval', { readBy: '09' }),
  cfg.int('residents.tenancyMaxMonths', 60, 1, 120, 'Longest tenancy in months', { readBy: '09' }),
  cfg.bool('residents.allowMultipleTenancies', false, 'A unit may have several tenancies', { readBy: '09' }),
  cfg.bool('residents.requireMoveInRequest', true, 'A move-in needs a request', { readBy: '09' }),
  cfg.json(
    'residents.agreementReminderDays',
    [30, 7],
    uniqueInts(1, 90, 1, 3).refine(descending, 'Values must be in descending order'),
    { minItems: 1, maxItems: 3, min: 1, max: 90, unique: true, order: 'descending' },
    'Days before an agreement ends on which reminders go out',
    { readBy: '09' },
  ),
  cfg.int(
    'residents.policeVerificationReminderDays',
    15,
    1,
    90,
    'Days before a verification expires to remind',
    {
      readBy: '09',
    },
  ),
  cfg.int('residents.joinRequestExpiryDays', 14, 1, 60, 'Days a join request stays open', { readBy: '09' }),
  cfg.int('residents.moveDepositPaise', 0, 0, 10_000_000, 'Deposit for a move (paise)', { readBy: '09' }),
  cfg.json(
    'residents.moveHours',
    { start: '09:00', end: '18:00' },
    hours,
    { shape: '{ start, end }', pattern: TIME_RE.source },
    'Hours in which moves are allowed',
    { readBy: '09' },
  ),
  cfg.int('residents.moveMaxHours', 6, 1, 12, 'Longest move in hours', { readBy: '09' }),
  cfg.json(
    'residents.moveBlackoutWeekdays',
    [] as number[],
    uniqueInts(0, 6, 0, 7),
    { minItems: 0, maxItems: 7, min: 0, max: 6, unique: true },
    'Weekdays on which moves are not allowed (0 = Sunday)',
    { readBy: '09' },
  ),
  cfg.int('residents.depositInspectionDays', 7, 0, 30, 'Days to inspect before a deposit is returned', {
    readBy: '09',
  }),
  cfg.json(
    'residents.renovationHours',
    { start: '10:00', end: '18:00' },
    hours,
    { shape: '{ start, end }', pattern: TIME_RE.source },
    'Hours in which renovation work is allowed',
    { readBy: '09' },
  ),
  cfg.json(
    'residents.renovationBlackoutWeekdays',
    [0],
    uniqueInts(0, 6, 0, 7),
    { minItems: 0, maxItems: 7, min: 0, max: 6, unique: true },
    'Weekdays on which renovation work is not allowed (0 = Sunday)',
    { readBy: '09' },
  ),
  cfg.int('residents.renovationMaxDays', 90, 1, 365, 'Longest renovation in days', { readBy: '09' }),
  cfg.int('residents.renovationDepositPaise', 0, 0, 50_000_000, 'Deposit for renovation (paise)', {
    readBy: '09',
  }),
  cfg.int('residents.renovationFeePaise', 0, 0, 5_000_000, 'Fee for renovation (paise)', { readBy: '09' }),
  cfg.int(
    'residents.transferPremiumPaise',
    2_500_000,
    0,
    2_500_000,
    'Transfer premium (paise, bye-law ceiling)',
    {
      readBy: '09',
    },
  ),
  cfg.int('residents.shareTransferFeePaise', 50_000, 0, 50_000, 'Share transfer fee (paise)', {
    readBy: '09',
  }),
  cfg.int('residents.entranceFeePaise', 10_000, 0, 10_000, 'Entrance fee (paise)', { readBy: '09' }),
  cfg.int('residents.transferBackdateDays', 90, 0, 365, 'Days a transfer may be back-dated', {
    readBy: '09',
  }),
  cfg.bool('residents.directoryShowTenants', true, 'Show tenants in the directory', { readBy: '09, 26' }),
  cfg.bool('residents.dogVaccinationRequired', true, 'Registered dogs need a vaccination record', {
    readBy: '09',
  }),
] as [string, SettingDef][];

export const SETTINGS_REGISTRY: Readonly<Record<string, SettingDef>> = Object.freeze(
  Object.fromEntries(entries),
);
export type SettingKey = string;
export const SETTING_KEYS: readonly string[] = Object.freeze(entries.map(([k]) => k));
if (SETTING_KEYS.length !== entries.length || new Set(SETTING_KEYS).size !== SETTING_KEYS.length)
  throw new Error('society-setup settings registry: duplicate key');

export const isSettingKey = (k: string): boolean =>
  Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY, k);
export const settingDef = (k: string): SettingDef => {
  const d = SETTINGS_REGISTRY[k];
  if (!d) throw new Error(`unknown setting key ${k}`);
  return d;
};
export const keysOfNamespace = (ns: SettingNamespace): string[] =>
  SETTING_KEYS.filter(k => SETTINGS_REGISTRY[k]!.namespace === ns);

/** Every view and every edit permission of the registry (route-level any-of lists; the service still checks each key). */
export const ALL_VIEW_PERMISSIONS: readonly string[] = [
  ...new Set(Object.values(SETTINGS_REGISTRY).map(d => d.viewPermission)),
];
export const ALL_EDIT_PERMISSIONS: readonly string[] = [
  ...new Set(Object.values(SETTINGS_REGISTRY).map(d => d.editPermission)),
];

/** Typed values of the keys other modules read most (module 02 session policy, module 11 billing, module 14 approvals). */
export interface SettingTypes {
  'security.adminIdleMinutes': number;
  'security.stepUpMinutes': number;
  'billing.areaBasis': 'CARPET' | 'BUILT_UP' | 'SUPER_BUILT_UP';
  'billing.billingDay': number;
  'billing.dueDays': number;
  'billing.shiftDueDateOnHoliday': boolean;
  'billing.invoicePrefix': string;
  'billing.receiptPrefix': string;
  'billing.applyGst': boolean;
  'office.weeklyOffDays': number[];
  'office.openTime': string;
  'office.closeTime': string;
  'structure.groundFloorLabel': string;
  'structure.basementPrefix': string;
  'structure.areaDisplayUnit': 'SQFT' | 'SQM';
  'finance.showFinancesToResidents': boolean;
  'approvals.stepUpAbovePaise': number;
  'approvals.bulkApproveBelowPaise': number;
  'committee.minStrength': number;
  'committee.maxStrength': number;
  'committee.ownersOnly': boolean;
  'committee.maxTermYears': number;
  'committee.coOptionAllowed': boolean;
  'committee.showOnResidentApp': boolean;
  'committee.reminderDays': number[];
  'committee.handoverDelegationDays': number;
  'committee.handoverTemplate': { title: string; ownerDesignation: string | null }[];
}
export type SettingValue<K extends string> = K extends keyof SettingTypes ? SettingTypes[K] : unknown;
