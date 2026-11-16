import { z } from 'zod';
import { FEE_METHODS } from './payments.constants';

const id = z.coerce.number().int().positive();
const paise = z.number().int().min(0).max(1_000_000_000);

const payItem = z
  .object({
    type: z.enum(['INVOICE', 'COLLECTION_REQUEST']),
    id: z.number().int().positive(),
    amountPaise: paise,
  })
  .strict();

export const onlineSchemas = {
  idParam: z.object({ id }).strict(),
  payablesQuery: z.object({ unitId: id }).strict(),
  createOrderBody: z
    .object({
      unitId: z.number().int().positive(),
      allocationMode: z.enum(['OLDEST_FIRST', 'SELECTED']),
      duesAmountPaise: paise.optional(),
      items: z.array(payItem).max(50).optional(),
      advancePaise: paise.optional(),
      methodHint: z.enum(FEE_METHODS).optional(),
      payListVersion: z.string().regex(/^[0-9a-f]{64}$/),
      device: z.enum(['PHONE', 'DESKTOP']).default('PHONE'),
    })
    .strict()
    .superRefine((b, ctx) => {
      if (b.allocationMode === 'OLDEST_FIRST') {
        if (b.duesAmountPaise === undefined && !(b.items ?? []).length)
          ctx.addIssue({ code: 'custom', path: ['duesAmountPaise'], message: 'Required for OLDEST_FIRST' });
        if ((b.items ?? []).some(i => i.type === 'INVOICE'))
          ctx.addIssue({ code: 'custom', path: ['items'], message: 'Invoice items need SELECTED' });
        if (b.advancePaise)
          ctx.addIssue({ code: 'custom', path: ['advancePaise'], message: 'Only for SELECTED' });
      } else {
        if (b.duesAmountPaise !== undefined)
          ctx.addIssue({ code: 'custom', path: ['duesAmountPaise'], message: 'Not allowed for SELECTED' });
        if (!(b.items ?? []).length && !b.advancePaise)
          ctx.addIssue({ code: 'custom', path: ['items'], message: 'Choose at least one item' });
      }
    }),
  verifyBody: z.object({ gatewayPaymentId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/) }).strict(),
  cancelBody: z.object({ reason: z.string().trim().min(5).max(300) }).strict(),
  listQuery: z
    .object({
      status: z.enum(['CREATED', 'ATTEMPTED', 'PAID', 'FAILED', 'EXPIRED', 'CANCELLED']).optional(),
      sourceType: z.enum(['PAY_LIST', 'MODULE', 'PAYMENT_LINK', 'AUTOPAY']).optional(),
      unitId: id.optional(),
      from: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      to: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      sortBy: z.enum(['createdAt', 'grossAmountPaise']).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    })
    .strict(),
  linkBody: z
    .object({
      unitId: z.number().int().positive(),
      amountMode: z.enum(['OUTSTANDING', 'FIXED']),
      amountPaise: z.number().int().min(100).max(100_000_000).optional(),
      expiresInDays: z.number().int().min(1).max(30).optional(),
      channels: z
        .array(z.enum(['SMS', 'WHATSAPP', 'EMAIL']))
        .min(1)
        .max(3)
        .refine(a => new Set(a).size === a.length, 'Channels must be unique')
        .optional(),
    })
    .strict()
    .refine(b => (b.amountMode === 'FIXED') === (b.amountPaise !== undefined), {
      path: ['amountPaise'],
      message: 'Required for FIXED and not allowed for OUTSTANDING',
    }),
  codeParam: z.object({ code: z.string().regex(/^[A-Za-z0-9]{10}$/) }).strict(),
  publicBody: z
    .object({ token: z.string().min(8).max(100).optional() })
    .strict()
    .optional(),
  publicVerifyBody: z
    .object({
      token: z.string().min(8).max(100).optional(),
      gatewayPaymentId: z.string().regex(/^[A-Za-z0-9_-]{6,64}$/),
    })
    .strict(),
  webhookParam: z.object({ gatewayAccountId: id }).strict(),
};
