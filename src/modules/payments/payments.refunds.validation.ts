import { z } from 'zod';
import { REFUND_MODES, REFUND_STATUSES } from './payments.constants';

/** Zod schemas of section 8.19 (refunds). Bodies and queries are `.strict()`; the business rules (BR-12-35, 36) are in the service. */
const id = z.coerce.number().int().positive();
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const version = z.number().int().min(1);
const MASKED_ACCOUNT = /^[A-Za-z ]{2,20} x{4}\d{4}$/;
const OFFLINE = ['BANK_TRANSFER', 'CHEQUE', 'CASH'];

export const refundSchemas = {
  idParam: z.object({ id }),
  list: z
    .object({
      status: z.enum(REFUND_STATUSES).optional(),
      mode: z.enum(REFUND_MODES).optional(),
      unitId: id.optional(),
      from: ymd.optional(),
      to: ymd.optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      sortBy: z.enum(['createdAt', 'amountPaise']).default('createdAt'),
    })
    .strict(),
  create: z
    .object({
      paymentId: z.number().int().positive(),
      amountPaise: z.number().int().min(100).max(Number.MAX_SAFE_INTEGER),
      mode: z.enum(REFUND_MODES),
      reason: z.string().trim().min(10).max(500),
      reallocate: z.boolean().default(false),
      payeeName: z.string().trim().min(2).max(120).optional(),
      payeeAccountMasked: z
        .string()
        .trim()
        .regex(MASKED_ACCOUNT, 'Use a masked account such as HDFC xxxx4521')
        .optional(),
    })
    .strict()
    .superRefine((b, c) => {
      if (OFFLINE.includes(b.mode) && !b.payeeName)
        c.addIssue({ code: 'custom', path: ['payeeName'], message: 'Required for this refund mode' });
      if (b.mode === 'BANK_TRANSFER' && !b.payeeAccountMasked)
        c.addIssue({ code: 'custom', path: ['payeeAccountMasked'], message: 'Required for a bank transfer' });
    }),
  complete: z
    .object({
      paidOutOn: ymd,
      bankReference: z.string().trim().min(4).max(40).optional(),
      version,
    })
    .strict(),
};
