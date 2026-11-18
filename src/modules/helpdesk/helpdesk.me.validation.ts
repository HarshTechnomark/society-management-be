import { z } from 'zod';
import { AFFECTED_LEVELS, LIMITS, URGENCIES } from './helpdesk.constants';

/** Zod schemas of the resident and building-issue routes (8.10, 8.11, 8.17, 8.22 to 8.28). Bodies and queries are strict. */

const id = z.coerce.number().int().positive();
const version = z.number().int().min(1);
const fileIds = z
  .array(z.number().int().positive())
  .max(LIMITS.maxFiles)
  .refine(a => new Set(a).size === a.length, 'Duplicate files');
const page = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const datetime = z
  .string()
  .datetime({ offset: true })
  .transform(v => new Date(v));

const buildingIssue = z
  .object({
    locationNodeId: id.optional(),
    qrToken: z
      .string()
      .regex(/^[A-Za-z0-9]{12}$/, 'Not a QR code')
      .optional(),
    affectedLevel: z.enum(AFFECTED_LEVELS).optional(),
    categoryId: id,
    subCategoryId: id.optional(),
    urgency: z.enum(URGENCIES),
    title: text(LIMITS.titleMin, LIMITS.titleMax).optional(),
    description: z.string().trim().max(LIMITS.descMax).optional(),
    assetId: id.optional(),
    duplicateReason: text(10, 300).optional(),
    fileIds: fileIds.optional(),
  })
  .strict()
  .refine(v => v.locationNodeId !== undefined || v.qrToken !== undefined, {
    message: 'A location or a QR code is required',
    path: ['locationNodeId'],
  });

export const meSchemas = {
  idParam: z.object({ id }).strict(),
  fileParam: z.object({ id, fileId: id }).strict(),
  qrParam: z.object({ qrToken: z.string().regex(/^[A-Za-z0-9]{12}$/, 'Not a QR code') }).strict(),
  list: z
    .object({
      tab: z.enum(['OPEN', 'CLOSED', 'ALL']).default('OPEN'),
      kind: z.enum(['PERSONAL', 'BUILDING']).optional(),
      unitId: id.optional(),
      sortBy: z.enum(['lastActivityAt', 'createdAt']).default('lastActivityAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
      ...page,
    })
    .strict(),
  buildingList: z
    .object({
      scope: z.enum(['NEAR_ME', 'ALL']).default('NEAR_ME'),
      status: z.enum(['OPEN', 'RESOLVED']).default('OPEN'),
      buildingId: id.optional(),
      ...page,
    })
    .strict(),
  similar: z.object({ locationNodeId: id, categoryId: id, q: text(2, 100).optional() }).strict(),
  comments: z
    .object({ before: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })
    .strict(),
  download: z.object({ disposition: z.enum(['inline', 'attachment']).default('inline') }).strict(),
  transparency: z.object({ months: z.coerce.number().int().min(1).max(12).default(6) }).strict(),
  personal: z
    .object({
      unitId: id,
      categoryId: id,
      subCategoryId: id.optional(),
      title: text(LIMITS.titleMin, LIMITS.titleMax),
      description: text(LIMITS.personalDescMin, LIMITS.descMax),
      urgency: z.enum(URGENCIES).optional(),
      preferredSlotFrom: datetime.optional(),
      preferredSlotTo: datetime.optional(),
      invoiceId: id.optional(),
      fileIds: fileIds.optional(),
    })
    .strict(),
  buildingIssue,
  comment: z.object({ body: text(1, LIMITS.commentMax), fileIds: fileIds.optional() }).strict(),
  upvote: z.object({ note: text(0, 300).optional() }).strict(),
  confirm: z
    .object({ score: z.number().int().min(1).max(5).optional(), comment: text(0, 500).optional(), version })
    .strict(),
  rating: z.object({ score: z.number().int().min(1).max(5), comment: text(0, 500).optional() }).strict(),
  reopen: z.object({ reason: text(5, 500), version }).strict(),
  cancel: z.object({ reason: text(5, 500), version }).strict(),
  escalate: z.object({ reason: text(10, 500) }).strict(),
  estimate: z
    .object({ decision: z.enum(['APPROVE', 'REJECT']), comment: text(0, 300).optional(), version })
    .strict(),
};
