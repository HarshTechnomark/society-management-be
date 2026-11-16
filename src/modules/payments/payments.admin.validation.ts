import { z } from 'zod';
import {
  PAYMENT_METHODS,
  PAYMENT_SOURCES,
  PAYMENT_STATUSES,
  REVERSAL_REASON_CODES,
} from './payments.constants';

/** Zod schemas of sub-module 12.3 (sections 8.5, 8.7, 8.10, 8.13 to 8.17). Queries and bodies are `.strict()`. */
const id = z.coerce.number().int().positive();
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const page = z.coerce.number().int().min(1).default(1);
const limit = z.coerce.number().int().min(1).max(100).default(20);
const sortOrder = z.enum(['asc', 'desc']).default('desc');
const csvOf = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform(v => v.split(',').map(s => s.trim()))
    .pipe(z.array(z.enum(values)).min(1).max(values.length));
const flag = z.literal('true').transform(() => true);

const listFields = {
  q: z.string().trim().min(2).max(60).optional(),
  unitId: id.optional(),
  status: csvOf(PAYMENT_STATUSES).optional(),
  method: csvOf(PAYMENT_METHODS).optional(),
  source: z.enum(PAYMENT_SOURCES).optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  needsReview: flag.optional(),
  isDuplicateSuspect: flag.optional(),
  chequeStatus: z.literal('PENDING').optional(),
};
const rangeOk = (v: { from?: string; to?: string }) => !v.from || !v.to || v.to >= v.from;
const rangeMsg = { message: '`to` must not be before `from`', path: ['to'] };

export const adminSchemas = {
  idParam: z.object({ id }),
  unitParam: z.object({ unitId: id }),
  listQuery: z
    .object({
      ...listFields,
      sortBy: z.enum(['paymentDate', 'createdAt', 'amountPaise', 'receiptNo']).default('paymentDate'),
      sortOrder,
      page,
      limit,
    })
    .strict()
    .refine(rangeOk, rangeMsg),
  exportQuery: z
    .object({
      type: z.enum(['PAYMENTS', 'REFUNDS']).default('PAYMENTS'),
      format: z.literal('csv').default('csv'),
      ...listFields,
      status: z.string().optional(),
      sortBy: z.enum(['paymentDate', 'createdAt', 'amountPaise', 'receiptNo']).default('paymentDate'),
      sortOrder,
    })
    .strict()
    .refine(rangeOk, rangeMsg),
  summaryQuery: z
    .object({
      month: z
        .string()
        .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM')
        .optional(),
    })
    .strict(),
  feedQuery: z.object({}).strict(),
  reverseBody: z
    .object({
      reasonCode: z.enum(REVERSAL_REASON_CODES),
      reason: z.string().trim().min(10).max(500),
      version: z.number().int().min(1),
    })
    .strict(),
  reallocateBody: z
    .object({
      targets: z
        .array(
          z
            .object({
              type: z.enum(['INVOICE', 'COLLECTION_REQUEST', 'ADVANCE']),
              id: z.number().int().positive().optional(),
              amountPaise: z.number().int().min(100),
            })
            .strict()
            .refine(t => t.type === 'ADVANCE' || t.id !== undefined, {
              message: 'id is required',
              path: ['id'],
            }),
        )
        .min(1)
        .max(50)
        .refine(a => a.filter(t => t.type === 'ADVANCE').length <= 1, 'At most one ADVANCE target'),
      reason: z.string().trim().min(10).max(500),
      version: z.number().int().min(1),
    })
    .strict(),
  resendBody: z
    .object({
      channels: z
        .array(z.enum(['EMAIL', 'WHATSAPP', 'SMS', 'PUSH']))
        .min(1)
        .max(4)
        .refine(a => new Set(a).size === a.length, 'Channels must be unique'),
    })
    .strict(),
  reviewDoneBody: z
    .object({ note: z.string().trim().min(5).max(300), version: z.number().int().min(1) })
    .strict(),
  // ---- resident
  myListQuery: z
    .object({
      unitId: id.optional(),
      from: ymd.optional(),
      to: ymd.optional(),
      sortBy: z.enum(['paymentDate', 'amountPaise']).default('paymentDate'),
      sortOrder,
      page,
      limit,
    })
    .strict()
    .refine(rangeOk, rangeMsg)
    .refine(v => !v.from || !v.to || Date.parse(v.to) - Date.parse(v.from) <= 3 * 366 * 86_400_000, {
      message: 'The range may be at most 3 years',
      path: ['to'],
    }),
  myAdvancesQuery: z.object({ unitId: id, page, limit }).strict(),
  advancesQuery: z.object({ page, limit }).strict(),
};
