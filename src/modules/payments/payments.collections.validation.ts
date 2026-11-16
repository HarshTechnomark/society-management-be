import { z } from 'zod';
import {
  AUDIENCE_TYPES,
  COLLECTION_AMOUNT_MODES,
  COLLECTION_KINDS,
  COLLECTION_STATUSES,
  PAY_LIST_VISIBILITIES,
  REQUEST_STATUSES,
} from './payments.constants';

/** Zod schemas of sub-module 12.5 (sections 8.9, 8.21 to 8.23). Bodies and queries are `.strict()`. */
const id = z.coerce.number().int().positive();
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const version = z.number().int().min(1);
const bool = z.enum(['true', 'false']).transform(v => v === 'true');
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform(v =>
      v
        .split(',')
        .map(s => s.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values)).min(1).max(values.length));
const paise = (min: number, max: number) => z.number().int().min(min).max(max);

const fields = {
  title: text(4, 80),
  kind: z.enum(COLLECTION_KINDS),
  purpose: text(10, 1000),
  amountMode: z.enum(COLLECTION_AMOUNT_MODES),
  amountPerUnitPaise: paise(0, 10_000_000),
  minAmountPaise: paise(0, 10_000_000),
  isMandatory: z.boolean(),
  audienceType: z.enum(AUDIENCE_TYPES),
  audienceIds: z.array(z.number().int().positive()).min(1).max(2000),
  includeVacant: z.boolean(),
  dueDate: ymd,
  fundId: z.number().int().positive(),
  targetPaise: paise(100, 10_000_000_000),
  payListVisibility: z.enum(PAY_LIST_VISIBILITIES),
  sendNotice: z.boolean(),
};

const listSortBy = ['createdAt', 'dueDate', 'title', 'collectedPaise'] as const;
const requestSortBy = ['unitLabel', 'paidPaise', 'lastPaidAt'] as const;

export const collectionSchemas = {
  idParam: z.object({ id }),
  list: z
    .object({
      status: csvEnum(COLLECTION_STATUSES).optional(),
      kind: z.enum(COLLECTION_KINDS).optional(),
      isMandatory: bool.optional(),
      q: text(2, 60).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      sortBy: z.enum(listSortBy).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    })
    .strict(),
  create: z
    .object({
      title: fields.title,
      kind: fields.kind,
      purpose: fields.purpose,
      amountMode: fields.amountMode,
      amountPerUnitPaise: fields.amountPerUnitPaise.optional(),
      minAmountPaise: fields.minAmountPaise.optional(),
      isMandatory: fields.isMandatory,
      audienceType: fields.audienceType,
      audienceIds: fields.audienceIds.optional().nullable(),
      includeVacant: fields.includeVacant.default(false),
      dueDate: fields.dueDate,
      fundId: fields.fundId,
      targetPaise: fields.targetPaise.optional(),
      payListVisibility: fields.payListVisibility.default('COUNT_ONLY'),
      sendNotice: fields.sendNotice.default(true),
    })
    .strict(),
  patch: z
    .object({
      version,
      title: fields.title.optional(),
      kind: fields.kind.optional(),
      purpose: fields.purpose.optional(),
      amountMode: fields.amountMode.optional(),
      amountPerUnitPaise: fields.amountPerUnitPaise.optional(),
      minAmountPaise: fields.minAmountPaise.optional(),
      isMandatory: fields.isMandatory.optional(),
      audienceType: fields.audienceType.optional(),
      audienceIds: fields.audienceIds.optional().nullable(),
      includeVacant: fields.includeVacant.optional(),
      dueDate: fields.dueDate.optional(),
      fundId: fields.fundId.optional(),
      targetPaise: fields.targetPaise.optional(),
      payListVisibility: fields.payListVisibility.optional(),
      sendNotice: fields.sendNotice.optional(),
    })
    .strict(),
  deleteQuery: z.object({ version: z.coerce.number().int().min(1) }).strict(),
  versionBody: z.object({ version }).strict(),
  publish: z.object({ version, reason: text(1, 300).optional() }).strict(),
  reasonBody: z.object({ version, reason: text(5, 300) }).strict(),
  requestList: z
    .object({
      status: csvEnum(REQUEST_STATUSES).optional(),
      q: text(1, 60).optional(),
      buildingId: id.optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      sortBy: z.enum(requestSortBy).default('unitLabel'),
      sortOrder: z.enum(['asc', 'desc']).default('asc'),
    })
    .strict(),
  requestExport: z
    .object({
      status: csvEnum(REQUEST_STATUSES).optional(),
      q: text(1, 60).optional(),
      buildingId: id.optional(),
    })
    .strict(),
  addRequests: z.object({ unitIds: z.array(z.number().int().positive()).min(1).max(500), version }).strict(),
  waive: z.object({ reason: text(5, 300), version }).strict(),
  statement: z.object({ format: z.enum(['json', 'pdf']).default('json') }).strict(),
  meList: z
    .object({
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict(),
};
export type CreateInput = z.infer<typeof collectionSchemas.create>;
export type PatchInput = z.infer<typeof collectionSchemas.patch>;
export type ListQuery = z.infer<typeof collectionSchemas.list>;
export type RequestListQuery = z.infer<typeof collectionSchemas.requestList>;
