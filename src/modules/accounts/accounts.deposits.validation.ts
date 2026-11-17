import { z } from 'zod';
import { DEPOSIT_KINDS, DEPOSIT_REFUND_MODES, DEPOSIT_STATUSES } from './accounts.constants';
import { idParam, limit, page, reason, ymd } from './accounts.validation';

const version = z.number().int().min(1);
const amount = z.number().int().min(100).max(100_000_000);

/** Section 8.17 request schemas. */
export const depositSchemas = {
  idParam: z.object({ id: idParam }).strict(),
  list: z
    .object({
      status: z.enum(DEPOSIT_STATUSES).optional(),
      kind: z.enum(DEPOSIT_KINDS).optional(),
      unitId: idParam.optional(),
      q: z.string().trim().min(1).max(60).optional(),
      sortBy: z.enum(['createdAt', 'amountPaise']).default('createdAt'),
      page,
      limit,
    })
    .strict(),
  create: z
    .object({
      unitId: z.number().int().positive(),
      residentId: z.number().int().positive().optional(),
      kind: z.enum(DEPOSIT_KINDS),
      title: z.string().trim().min(3).max(120),
      amountPaise: amount,
      dueDate: ymd.optional(),
      isOpening: z.boolean().default(false),
      openingDate: ymd.optional(),
      refType: z
        .string()
        .regex(/^[a-z][a-z_]{1,39}$/)
        .optional(),
      refId: z.number().int().positive().optional(),
      notes: z.string().trim().max(500).optional(),
    })
    .strict()
    .superRefine((b, ctx) => {
      if (b.isOpening && !b.openingDate)
        ctx.addIssue({ code: 'custom', path: ['openingDate'], message: 'Required for an opening deposit' });
      if (!b.isOpening && !b.dueDate)
        ctx.addIssue({ code: 'custom', path: ['dueDate'], message: 'Required' });
      if ((b.refType === undefined) !== (b.refId === undefined))
        ctx.addIssue({ code: 'custom', path: ['refId'], message: 'Send refType and refId together' });
    }),
  deduct: z.object({ amountPaise: amount, reason, date: ymd, version }).strict(),
  forfeit: z.object({ reason, date: ymd, version }).strict(),
  refundRequest: z.object({ reason: reason.optional(), version }).strict(),
  refundPaid: z
    .object({
      paidFromLedgerAccountId: z.number().int().positive(),
      refundMode: z.enum(DEPOSIT_REFUND_MODES),
      refundReference: z.string().trim().max(30).optional(),
      date: ymd,
      version,
    })
    .strict(),
  cancel: z.object({ reason, version }).strict(),
};
