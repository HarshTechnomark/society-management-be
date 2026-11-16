import { z } from 'zod';
import { MANDATE_STATUSES, MANDATE_TYPES } from './payments.constants';

/** Zod schemas of sections 8.8 and 8.20 (AutoPay mandates). The cap limits (BR-12-47) are business rules, checked in the service. */
const id = z.coerce.number().int().positive();
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const version = z.number().int().min(1);
const page = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};

export const autopaySchemas = {
  idParam: z.object({ id }),
  myList: z.object({ status: z.enum(MANDATE_STATUSES).optional(), unitId: id.optional(), ...page }).strict(),
  create: z
    .object({
      unitId: z.number().int().positive(),
      mandateType: z.enum(MANDATE_TYPES),
      maxAmountPaise: z.number().int().safe(),
      startDate: ymd,
      endDate: ymd,
      debitDaysBeforeDue: z.number().int().min(1).max(5).optional(),
    })
    .strict(),
  versionBody: z.object({ version }).strict(),
  cancelBody: z.object({ version, reason: z.string().trim().min(1).max(300).optional() }).strict(),
  adminList: z
    .object({
      status: z.enum(MANDATE_STATUSES).optional(),
      unitId: id.optional(),
      mandateType: z.enum(MANDATE_TYPES).optional(),
      ...page,
    })
    .strict(),
  adminCancel: z.object({ version, reason: z.string().trim().min(5).max(300) }).strict(),
};
