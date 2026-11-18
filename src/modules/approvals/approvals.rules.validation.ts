import { z } from 'zod';
import { paginationQuery } from '../../utils/pagination';
import { APPROVAL_TYPES } from './approvals.catalogue';
import { DELEGATION_STATUS, LIMITS, RULE_ACTION, STEP_MODE } from './approvals.constants';

/** Zod schemas of 14.2b (sections 8.12 to 8.18). Bodies and queries are `.strict()`. Business rules (BR-14-28) live in the services. */
const id = z.coerce.number().int().positive();
const version = z.number().int().min(1);
const bool = z.enum(['true', 'false']).transform(v => v === 'true');
const type = z.enum(APPROVAL_TYPES as unknown as [string, ...string[]]);
const paise = (min: number, max: number) => z.number().int().min(min).max(max);
const reason = z.string().trim().min(LIMITS.reasonMin).max(LIMITS.reasonMax);
const unique = <T extends z.ZodTypeAny>(item: T, min: number, max: number) =>
  z
    .array(item)
    .min(min)
    .max(max)
    .refine(a => new Set(a).size === a.length, 'Values must be unique');
const roleKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);
const categoryKey = z.string().regex(/^[A-Z0-9_]{2,40}$/);

const step = z
  .object({
    stepNo: z.number().int().min(1).max(LIMITS.maxSteps),
    name: z.string().trim().min(2).max(60),
    mode: z.enum(STEP_MODE),
    roleKeys: unique(roleKey, 0, LIMITS.maxSlotsPerStep),
    userIds: unique(z.number().int().positive(), 0, LIMITS.maxSlotsPerStep),
    requiredCount: z.number().int().nullable(),
  })
  .strict();

const ruleFields = {
  name: z.string().trim().min(3).max(80),
  description: z.string().trim().max(300).nullable(),
  priority: z.number().int().min(1).max(999),
  isActive: z.boolean(),
  minAmountPaise: paise(0, LIMITS.maxAmountPaise),
  maxAmountPaise: paise(0, LIMITS.maxAmountPaise).nullable(),
  categoryKeys: unique(categoryKey, 1, 50).nullable(),
  requesterRoleKeys: unique(roleKey, 1, 15).nullable(),
  action: z.enum(RULE_ACTION),
  steps: z.array(step).max(LIMITS.maxSteps),
  fallbackRoleKeys: unique(roleKey, 0, 3),
  slaHours: z.number().int().min(1).max(720),
  reminderEveryHours: z.number().int().min(1).max(168),
  escalateAfterHours: z.number().int().min(1).max(1440).nullable(),
  escalationRoleKeys: unique(roleKey, 0, 5),
  escalationCanApprove: z.boolean(),
  stepUpAbovePaise: paise(0, LIMITS.maxAmountPaise).nullable(),
};

const create = z
  .object({
    type,
    name: ruleFields.name,
    priority: ruleFields.priority,
    action: ruleFields.action,
    steps: ruleFields.steps,
    description: ruleFields.description.optional(),
    isActive: ruleFields.isActive.optional(),
    minAmountPaise: ruleFields.minAmountPaise.optional(),
    maxAmountPaise: ruleFields.maxAmountPaise.optional(),
    categoryKeys: ruleFields.categoryKeys.optional(),
    requesterRoleKeys: ruleFields.requesterRoleKeys.optional(),
    fallbackRoleKeys: ruleFields.fallbackRoleKeys.optional(),
    slaHours: ruleFields.slaHours.optional(),
    reminderEveryHours: ruleFields.reminderEveryHours.optional(),
    escalateAfterHours: ruleFields.escalateAfterHours.optional(),
    escalationRoleKeys: ruleFields.escalationRoleKeys.optional(),
    escalationCanApprove: ruleFields.escalationCanApprove.optional(),
    stepUpAbovePaise: ruleFields.stepUpAbovePaise.optional(),
  })
  .strict();

/** PATCH: any subset plus `version`; `type` is not accepted (strict). */
const patch = z
  .object(
    Object.fromEntries(Object.entries(ruleFields).map(([k, v]) => [k, v.optional()])) as {
      [K in keyof typeof ruleFields]: z.ZodOptional<(typeof ruleFields)[K]>;
    },
  )
  .extend({ version })
  .strict();

export const ruleSchemas = {
  idParam: z.object({ id }).strict(),
  list: z.object({ type: type.optional(), includeInactive: bool.default(true) }).strict(),
  create,
  patch,
  remove: z.object({ version, reason }).strict(),
  reset: z.object({ type, reason }).strict(),
  simulate: z
    .object({
      type,
      amountPaise: paise(0, LIMITS.maxAmountPaise).default(0),
      categoryKey: categoryKey.optional(),
      requesterUserId: z.number().int().positive().optional(),
    })
    .strict(),
};

export const settingsSchemas = {
  patch: z
    .object({
      stepUpAbovePaise: paise(100_000, 10 ** 12).optional(),
      bulkApproveBelowPaise: paise(100_000, 10 ** 12).optional(),
    })
    .strict()
    .refine(b => Object.keys(b).length > 0, 'Send at least one setting'),
};

const delegationList = paginationQuery(['startsAt', 'createdAt'] as const, 'startsAt')
  .extend({
    scope: z.enum(['MINE', 'ALL']).default('MINE'),
    status: z.enum(DELEGATION_STATUS).optional(),
  })
  .strict();

export const delegationSchemas = {
  idParam: z.object({ id }).strict(),
  list: delegationList,
  create: z
    .object({
      delegatorUserId: z.number().int().positive().optional(),
      delegateUserId: z.number().int().positive(),
      startsAt: z
        .string()
        .datetime({ offset: true })
        .transform(v => new Date(v)),
      endsAt: z
        .string()
        .datetime({ offset: true })
        .transform(v => new Date(v)),
      types: unique(type, 1, 25).nullable().optional(),
      maxAmountPaise: paise(1, LIMITS.maxAmountPaise).nullable().optional(),
      reason,
    })
    .strict(),
  revoke: z.object({ version, reason }).strict(),
};
