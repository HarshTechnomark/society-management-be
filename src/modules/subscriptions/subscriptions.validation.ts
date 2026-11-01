import { z } from 'zod';
import { PLAN_CODES } from './subscriptions.catalogue';

/** Zod schemas for module 04 (section 8). Every body is `.strict()`; ids are positive integers (8.1). */
const id = z.coerce.number().int().positive();
const reason = z.string().trim().min(5, 'Give a reason (at least 5 characters)').max(500);
const version = z.number().int().min(1);
const qVersion = z.coerce.number().int().min(1);
const planCode = z.enum(PLAN_CODES);
const selfServePlan = z.enum(['STARTER', 'STANDARD', 'PREMIUM']);
const cycle = z.enum(['MONTHLY', 'ANNUAL']);
const page = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const dir = z.enum(['asc', 'desc']).default('desc');
const bool = z.union([z.boolean(), z.enum(['true', 'false'])]).transform(v => v === true || v === 'true');
const iso = z.iso.datetime({ message: 'Use an ISO 8601 date and time' }).transform(s => new Date(s));
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const featureKey = z
  .string()
  .regex(/^[a-z]+\.[a-z0-9_]+$/, 'Not a feature key')
  .max(80);
const entitlementKey = z.string().min(3).max(80);
const many = <T extends z.ZodType>(s: T) =>
  z.preprocess(
    v => (v === undefined ? undefined : Array.isArray(v) ? v : String(v).split(',')),
    z.array(s).min(1),
  );

const grant = z.discriminatedUnion('type', [
  z.object({ type: z.literal('FEATURE'), key: featureKey }).strict(),
  z
    .object({
      type: z.literal('LIMIT_INCREMENT'),
      key: z.string().regex(/^limit\.[a-z0-9_]+$/),
      amount: z.number().int().min(1).max(1_000_000),
    })
    .strict(),
  z.object({ type: z.literal('FEATURE_CHOICE') }).strict(),
]);

const addonsQuery = z
  .string()
  .max(400)
  .transform((s, ctx) => {
    const parts = s.split(',').filter(Boolean);
    if (parts.length > 8) ctx.addIssue({ code: 'custom', message: 'At most 8 add-ons' });
    return parts.map(p => {
      const [code, qty] = p.split(':');
      const n = Number(qty ?? 1);
      if (!/^[A-Z][A-Z0-9_]{2,39}$/.test(code ?? '') || !Number.isInteger(n) || n < 1 || n > 100)
        ctx.addIssue({ code: 'custom', message: `Bad add-on entry ${p} (CODE:qty, qty 1–100)` });
      return { code: code ?? '', qty: n };
    });
  });

export const subscriptionSchemas = {
  // ---- params
  planParam: z.object({ planId: id }),
  versionParam: z.object({ versionId: id }),
  addonParam: z.object({ addonId: id }),
  subscriptionParam: z.object({ subscriptionId: id }),
  overrideParams: z.object({ subscriptionId: id, overrideId: id }),
  flagParam: z.object({ flagId: id }),
  flagOverrideParams: z.object({ flagId: id, overrideId: id }),
  ownedAddonParam: z.object({ subscriptionAddonId: id }),

  // ---- plans and versions (8.2)
  patchPlan: z
    .object({
      name: z.string().trim().min(2).max(60).optional(),
      description: z.string().trim().max(300).nullable().optional(),
      isPublic: z.boolean().optional(),
      isActive: z.boolean().optional(),
      reason,
      version,
    })
    .strict(),
  reasonOnly: z.object({ reason }).strict(),
  reasonVersion: z.object({ reason, version }).strict(),
  patchVersion: z
    .object({
      pricePerFlatPaise: z.number().int().min(0).max(50000).optional(),
      minBillableFlats: z.number().int().min(1).max(100000).optional(),
      annualFreeMonths: z.number().int().min(0).max(6).optional(),
      notes: z.string().trim().max(500).nullable().optional(),
      version,
    })
    .strict()
    .refine(b => Object.keys(b).length > 1, { message: 'Change at least one field', path: ['version'] }),
  putEntitlements: z
    .object({
      items: z
        .array(
          z
            .object({
              entitlementKey,
              isEnabled: z.boolean().optional(),
              limitValue: z.number().int().min(0).max(1_000_000_000_000).nullable().optional(),
              limitPerFlats: z.number().int().min(1).max(1000).nullable().optional(),
              overageUnitSize: z.number().int().min(1).max(1_000_000).nullable().optional(),
              overagePricePaise: z.number().int().min(0).max(1_000_000).nullable().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(600)
        .refine(a => new Set(a.map(i => i.entitlementKey)).size === a.length, 'Keys must be unique'),
      version,
    })
    .strict(),
  versionQuery: z.object({ version: qVersion }),
  migration: z
    .object({
      fromVersionIds: z.array(z.number().int().positive()).min(1).max(50).optional(),
      noticeDays: z.number().int().min(30).max(180).default(30),
      dryRun: z.boolean().default(false),
      reason,
    })
    .strict(),
  catalogueQuery: z.object({
    moduleNo: z.coerce.number().int().min(2).max(30).optional(),
    kind: z.enum(['FEATURE', 'LIMIT']).optional(),
    minPlan: z.enum([...PLAN_CODES, 'ALWAYS']).optional(),
    q: z.string().trim().max(60).optional(),
    status: z.enum(['LIVE', 'PLANNED']).optional(),
  }),

  // ---- add-ons (8.3)
  createAddon: z
    .object({
      code: z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/, 'Use capitals, digits and _ (3–40)'),
      name: z.string().trim().min(2).max(80),
      description: z.string().trim().max(300).optional(),
      billingType: z.enum(['ONE_TIME', 'RECURRING']),
      grants: z.array(grant).min(1).max(5),
      pricePaise: z.number().int().min(100).max(10_000_000),
      minTierRank: z.number().int().min(1).max(4),
      maxTierRank: z.number().int().min(1).max(4),
      maxQuantity: z.number().int().min(1).max(100),
      isOnSale: z.boolean().optional(),
      reason,
    })
    .strict()
    .refine(b => b.minTierRank <= b.maxTierRank, {
      message: 'Must be at least minTierRank',
      path: ['maxTierRank'],
    }),
  patchAddon: z
    .object({
      name: z.string().trim().min(2).max(80).optional(),
      description: z.string().trim().max(300).nullable().optional(),
      pricePaise: z.number().int().min(100).max(10_000_000).optional(),
      minTierRank: z.number().int().min(1).max(4).optional(),
      maxTierRank: z.number().int().min(1).max(4).optional(),
      maxQuantity: z.number().int().min(1).max(100).optional(),
      isOnSale: z.boolean().optional(),
      sortOrder: z.number().int().min(0).max(1000).optional(),
      billingType: z.enum(['ONE_TIME', 'RECURRING']).optional(),
      grants: z.array(grant).min(1).max(5).optional(),
      reason,
      version,
    })
    .strict(),

  // ---- platform subscriptions (8.4)
  listSubscriptions: z.object({
    status: many(z.enum(['TRIALING', 'ACTIVE', 'CANCELLED'])).optional(),
    planCode: planCode.optional(),
    billingCycle: cycle.optional(),
    hasPendingChange: bool.optional(),
    trialEndsBefore: ymd.optional(),
    societyId: id.optional(),
    q: z.string().trim().min(2).max(60).optional(),
    ...page,
    sortBy: z
      .enum(['statusChangedAt', 'currentPeriodEnd', 'trialEndsAt', 'billableFlats', 'createdAt'])
      .default('createdAt'),
    sortOrder: dir,
  }),
  platformChangePlan: z
    .object({
      planCode,
      timing: z.enum(['IMMEDIATE', 'PERIOD_END']).optional(),
      customPricePerFlatPaise: z.number().int().min(100).max(50000).optional(),
      customMinFlats: z.number().int().min(1).max(100000).optional(),
      skipLimitCheck: z.boolean().default(false),
      reason,
      version,
    })
    .strict()
    .refine(b => !b.skipLimitCheck || b.timing === 'PERIOD_END', {
      message: 'skipLimitCheck needs timing PERIOD_END',
      path: ['skipLimitCheck'],
    }),
  patchSubscription: z
    .object({
      pendingBillingCycle: cycle.nullable().optional(),
      customPricePerFlatPaise: z.number().int().min(100).max(50000).nullable().optional(),
      customMinFlats: z.number().int().min(1).max(100000).nullable().optional(),
      reason,
      version,
    })
    .strict(),
  overridesQuery: z.object({ includeHistory: bool.default(false) }),
  createOverride: z
    .object({
      targetType: z.enum(['KEY', 'MODULE']),
      entitlementKey: entitlementKey.optional(),
      moduleNo: z.number().int().min(2).max(30).optional(),
      isEnabled: z.boolean().optional(),
      limitValue: z.number().int().min(0).max(1_000_000_000_000).optional(),
      isUnlimited: z.boolean().optional(),
      source: z.enum(['CONTRACT', 'SUPPORT', 'PROMOTION']),
      startsAt: iso.optional(),
      expiresAt: iso.nullable().optional(),
      reason,
    })
    .strict()
    .superRefine((b, ctx) => {
      if (b.targetType === 'KEY' && !b.entitlementKey)
        ctx.addIssue({ code: 'custom', path: ['entitlementKey'], message: 'Required for KEY' });
      if (b.targetType === 'KEY' && b.moduleNo !== undefined)
        ctx.addIssue({ code: 'custom', path: ['moduleNo'], message: 'Only for MODULE' });
      if (b.targetType === 'MODULE' && b.moduleNo === undefined)
        ctx.addIssue({ code: 'custom', path: ['moduleNo'], message: 'Required for MODULE' });
      if (b.targetType === 'MODULE' && b.entitlementKey)
        ctx.addIssue({ code: 'custom', path: ['entitlementKey'], message: 'Only for KEY' });
      if (b.targetType === 'MODULE' && (b.limitValue !== undefined || b.isUnlimited))
        ctx.addIssue({ code: 'custom', path: ['limitValue'], message: 'A module override has no limit' });
    }),

  // ---- society (8.5, 8.6)
  plansQuery: z.object({ billingCycle: cycle.default('MONTHLY') }),
  quoteQuery: z.object({
    planCode,
    billingCycle: cycle.optional(),
    addons: addonsQuery.optional(),
  }),
  previewQuery: z.object({ planCode }),
  activate: z.object({ planCode, billingCycle: cycle, version }).strict(),
  changePlan: z.object({ planCode, version }).strict(),
  billingCycle: z.object({ billingCycle: cycle, version }).strict(),
  pendingChangeQuery: z.object({ type: z.enum(['PLAN', 'CYCLE']), version: qVersion }),
  buyAddon: z
    .object({
      addonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,39}$/),
      quantity: z.number().int().min(1).max(100).default(1),
      featureKey: featureKey.optional(),
    })
    .strict(),
  versionOnly: z.object({ version }).strict(),
  featureTrial: z.object({ featureKey }).strict(),
  cancel: z.object({ reason, version }).strict(),

  // ---- feature flags (8.7)
  listFlags: z.object({
    type: z.enum(['GLOBAL', 'PLAN', 'TENANT', 'PERCENTAGE', 'KILL_SWITCH']).optional(),
    q: z.string().trim().max(60).optional(),
    includeArchived: bool.default(false),
    ...page,
    sortBy: z.enum(['flagKey', 'updatedAt', 'type']).default('flagKey'),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
  }),
  createFlag: z
    .object({
      flagKey: z
        .string()
        .max(80)
        .regex(/^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/, 'Use lowercase module.feature_name'),
      description: z.string().trim().min(5).max(300),
      type: z.enum(['GLOBAL', 'PLAN', 'TENANT', 'PERCENTAGE', 'KILL_SWITCH']),
      isEnabled: z.boolean().optional(),
      minPlanCode: planCode.optional(),
      rolloutPercent: z.number().int().min(0).max(100).optional(),
      isClientVisible: z.boolean().optional(),
      ownerTeam: z.string().trim().max(60).optional(),
      expiresOn: ymd.optional(),
      reason,
    })
    .strict()
    .superRefine((b, ctx) => {
      if (b.type === 'PLAN' && !b.minPlanCode)
        ctx.addIssue({ code: 'custom', path: ['minPlanCode'], message: 'Required for PLAN flags' });
      if (b.type !== 'PLAN' && b.minPlanCode)
        ctx.addIssue({ code: 'custom', path: ['minPlanCode'], message: 'Only for PLAN flags' });
      if (b.type === 'PERCENTAGE' && b.rolloutPercent === undefined)
        ctx.addIssue({ code: 'custom', path: ['rolloutPercent'], message: 'Required for PERCENTAGE flags' });
      if (b.type !== 'PERCENTAGE' && b.rolloutPercent !== undefined)
        ctx.addIssue({ code: 'custom', path: ['rolloutPercent'], message: 'Only for PERCENTAGE flags' });
      if (b.type === 'KILL_SWITCH' && b.isClientVisible)
        ctx.addIssue({ code: 'custom', path: ['isClientVisible'], message: 'Must be false for KILL_SWITCH' });
    }),
  patchFlag: z
    .object({
      description: z.string().trim().min(5).max(300).optional(),
      minPlanCode: planCode.optional(),
      rolloutPercent: z.number().int().min(0).max(100).optional(),
      isClientVisible: z.boolean().optional(),
      ownerTeam: z.string().trim().max(60).nullable().optional(),
      expiresOn: ymd.nullable().optional(),
      reason,
      version,
    })
    .strict(),
  toggleFlag: z.object({ isEnabled: z.boolean(), reason, version }).strict(),
  evaluateQuery: z.object({ societyId: id }),
  flagOverride: z
    .object({ societyId: z.number().int().positive(), value: z.boolean(), reason, expiresAt: iso.optional() })
    .strict(),
};

export { selfServePlan };
