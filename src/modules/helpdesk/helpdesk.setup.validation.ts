import { z } from 'zod';
import {
  CATEGORY_SCOPES,
  CATEGORY_STATUSES,
  DEFAULT_ASSIGNEE_TYPES,
  DESIGNATIONS,
  PRIORITIES,
  RULE_STATUSES,
  SLA_CALENDARS,
  TRIGGER_TYPES,
  TARGET_TYPES,
} from './helpdesk.constants';

/** Zod schemas of part 15.1 (sections 8.1 to 8.6). Bodies and queries are `.strict()`; business rules (BR-15-62 to 64) live in the services. */
const id = z.coerce.number().int().positive();
const posInt = z.number().int().positive();
const version = z.number().int().min(1);
const roleKey = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/);

const idParam = z.object({ id }).strict();

// ---------------------------------------------------------------- categories
const categoryFields = {
  icon: z
    .string()
    .regex(/^[a-z0-9-]{2,30}$/)
    .nullable(),
  defaultPriority: z.enum(PRIORITIES).nullable(),
  slaPolicyId: posInt.nullable(),
  defaultAssigneeType: z.enum(DEFAULT_ASSIGNEE_TYPES),
  defaultRoleKey: roleKey.nullable(),
  defaultAssigneeUserId: posInt.nullable(),
  defaultStaffId: posInt.nullable(),
  defaultVendorId: posInt.nullable(),
  isChargeable: z.boolean(),
  requiresAfterPhoto: z.boolean(),
  isSafety: z.boolean(),
  linksInvoice: z.boolean(),
  sortOrder: z.number().int().min(0).max(9999),
};
const categoryName = z.string().trim().min(2).max(60);

const categoryCreate = z
  .object({
    parentId: posInt.optional(),
    name: categoryName,
    scope: z.enum(CATEGORY_SCOPES),
    icon: categoryFields.icon.optional(),
    defaultPriority: categoryFields.defaultPriority.optional(),
    slaPolicyId: categoryFields.slaPolicyId.optional(),
    defaultAssigneeType: categoryFields.defaultAssigneeType.optional(),
    defaultRoleKey: categoryFields.defaultRoleKey.optional(),
    defaultAssigneeUserId: categoryFields.defaultAssigneeUserId.optional(),
    defaultStaffId: categoryFields.defaultStaffId.optional(),
    defaultVendorId: categoryFields.defaultVendorId.optional(),
    isChargeable: categoryFields.isChargeable.optional(),
    requiresAfterPhoto: categoryFields.requiresAfterPhoto.optional(),
    isSafety: categoryFields.isSafety.optional(),
    linksInvoice: categoryFields.linksInvoice.optional(),
    sortOrder: categoryFields.sortOrder.optional(),
  })
  .strict();

const categoryPatch = z
  .object({
    name: categoryName.optional(),
    scope: z.enum(CATEGORY_SCOPES).optional(),
    icon: categoryFields.icon.optional(),
    defaultPriority: categoryFields.defaultPriority.optional(),
    slaPolicyId: categoryFields.slaPolicyId.optional(),
    defaultAssigneeType: categoryFields.defaultAssigneeType.optional(),
    defaultRoleKey: categoryFields.defaultRoleKey.optional(),
    defaultAssigneeUserId: categoryFields.defaultAssigneeUserId.optional(),
    defaultStaffId: categoryFields.defaultStaffId.optional(),
    defaultVendorId: categoryFields.defaultVendorId.optional(),
    isChargeable: categoryFields.isChargeable.optional(),
    requiresAfterPhoto: categoryFields.requiresAfterPhoto.optional(),
    isSafety: categoryFields.isSafety.optional(),
    linksInvoice: categoryFields.linksInvoice.optional(),
    sortOrder: categoryFields.sortOrder.optional(),
    version,
  })
  .strict();

const versionBody = z.object({ version }).strict();

const categoryList = z
  .object({
    status: z.enum([...CATEGORY_STATUSES, 'ALL']).default('ACTIVE'),
    scope: z.enum(['PERSONAL', 'BUILDING']).optional(),
  })
  .strict();
const categoryKind = z.object({ kind: z.enum(['PERSONAL', 'BUILDING']) }).strict();

// ---------------------------------------------------------------- SLA policies
const minutes = z.number().int().min(0).max(10_000_000);
const policyName = z.string().trim().min(2).max(60);
const calendar = z.enum(SLA_CALENDARS);
const policyCreate = z
  .object({
    name: policyName,
    description: z.string().trim().max(300).nullable().optional(),
    isDefault: z.boolean().optional(),
    p1ResponseMinutes: minutes,
    p1ResolutionMinutes: minutes,
    p2ResponseMinutes: minutes,
    p2ResolutionMinutes: minutes,
    p3ResponseMinutes: minutes,
    p3ResolutionMinutes: minutes,
    p4ResponseMinutes: minutes,
    p4ResolutionMinutes: minutes,
    p2Calendar: calendar.optional(),
    p3Calendar: calendar.optional(),
    p4Calendar: calendar.optional(),
  })
  .strict();
const policyPatch = policyCreate.partial().extend({ version }).strict();
const policyList = z.object({ status: z.enum([...CATEGORY_STATUSES, 'ALL']).default('ACTIVE') }).strict();

// ---------------------------------------------------------------- escalation rules
const ruleBase = {
  name: z.string().trim().min(2).max(80),
  thresholdPercent: z.number().int().min(25).max(1000).nullable(),
  level: z.number().int().min(1).max(3),
  categoryId: posInt.nullable(),
  priority: z.enum(PRIORITIES).nullable(),
  targetType: z.enum(TARGET_TYPES),
  targetRoleKey: roleKey.nullable(),
  targetDesignation: z.enum(DESIGNATIONS).nullable(),
  targetUserId: posInt.nullable(),
  notifyAssignee: z.boolean(),
  status: z.enum(RULE_STATUSES),
};
const ruleCreate = z
  .object({
    name: ruleBase.name,
    triggerType: z.enum(TRIGGER_TYPES),
    thresholdPercent: ruleBase.thresholdPercent.optional(),
    level: ruleBase.level,
    categoryId: ruleBase.categoryId.optional(),
    priority: ruleBase.priority.optional(),
    targetType: ruleBase.targetType,
    targetRoleKey: ruleBase.targetRoleKey.optional(),
    targetDesignation: ruleBase.targetDesignation.optional(),
    targetUserId: ruleBase.targetUserId.optional(),
    notifyAssignee: ruleBase.notifyAssignee.optional(),
    status: ruleBase.status.optional(),
  })
  .strict();
const rulePatch = z
  .object({
    name: ruleBase.name.optional(),
    thresholdPercent: ruleBase.thresholdPercent.optional(),
    level: ruleBase.level.optional(),
    categoryId: ruleBase.categoryId.optional(),
    priority: ruleBase.priority.optional(),
    targetType: ruleBase.targetType.optional(),
    targetRoleKey: ruleBase.targetRoleKey.optional(),
    targetDesignation: ruleBase.targetDesignation.optional(),
    targetUserId: ruleBase.targetUserId.optional(),
    notifyAssignee: ruleBase.notifyAssignee.optional(),
    status: ruleBase.status.optional(),
    version,
  })
  .strict();
const ruleList = z.object({ status: z.enum([...RULE_STATUSES, 'ALL']).default('ALL') }).strict();
const ruleRemove = z.object({ version: z.coerce.number().int().min(1) }).strict();

// ---------------------------------------------------------------- settings
const settingsPatch = z
  .object({
    changes: z
      .array(
        z
          .object({
            key: z.string().min(1).max(80),
            value: z.unknown(),
            version: z.number().int().min(0).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(15)
      .refine(a => new Set(a.map(c => c.key)).size === a.length, 'Keys must be unique'),
  })
  .strict();

export const setupSchemas = {
  idParam,
  versionBody,
  category: { create: categoryCreate, patch: categoryPatch, list: categoryList, kind: categoryKind },
  policy: { create: policyCreate, patch: policyPatch, list: policyList },
  rule: { create: ruleCreate, patch: rulePatch, list: ruleList, remove: ruleRemove },
  settings: { patch: settingsPatch },
};
