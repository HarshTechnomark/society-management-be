import { z } from 'zod';
import {
  CREDIT_REASON_CODES,
  DEBIT_REASON_CODES,
  INVOICE_STATUSES,
  INVOICE_TYPES,
  NOTE_STATUSES,
  NOTE_TYPES,
  type NoteReasonCode,
} from './billing.constants';

/** Zod schemas of sub-module 11.4 (sections 8.11 to 8.17 and 8.19). Bodies and queries are `.strict()`. */
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
const paise = z.number().int().min(1).max(100_000_000);

const userCreditReasons = CREDIT_REASON_CODES.filter(
  r => !['CANCELLATION', 'WRITE_OFF', 'SOURCE_REFUND'].includes(r),
) as [NoteReasonCode, ...NoteReasonCode[]];
const debitReasons = DEBIT_REASON_CODES.filter(r =>
  ['ADDITIONAL_CHARGE', 'BILLING_ERROR', 'OTHER'].includes(r),
) as [NoteReasonCode, ...NoteReasonCode[]];

const filters = {
  status: z.enum([...INVOICE_STATUSES, 'OVERDUE', 'OPEN']).optional(),
  unitId: id.optional(),
  buildingId: id.optional(),
  invoiceType: z.enum(INVOICE_TYPES).optional(),
  financialYear: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  periodStart: ymd.optional(),
  billingRunId: id.optional(),
  billToResidentId: id.optional(),
  isDisputed: bool.optional(),
  dueFrom: ymd.optional(),
  dueTo: ymd.optional(),
  q: text(1, 60).optional(),
  sortBy: z
    .enum(['invoiceDate', 'dueDate', 'totalPaise', 'outstandingPaise', 'unitLabel', 'invoiceNo'])
    .default('invoiceDate'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
};

export const invoiceSchemas = {
  idParam: z.object({ id }),
  list: z
    .object({
      ...filters,
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict(),
  export: z.object({ ...filters, format: z.literal('csv').default('csv') }).strict(),
  adHoc: z
    .object({
      unitId: z.number().int().positive(),
      lines: z
        .array(
          z
            .object({
              chargeHeadId: z.number().int().positive(),
              description: text(2, 200),
              amountPaise: paise,
            })
            .strict(),
        )
        .min(1)
        .max(20),
      dueDate: ymd,
      description: text(2, 300),
    })
    .strict(),
  creditNote: z
    .object({
      reasonCode: z.enum(userCreditReasons),
      remarks: text(5, 500),
      lines: z
        .array(
          z
            .object({ invoiceLineId: z.number().int().positive(), amountPaise: z.number().int().min(1) })
            .strict(),
        )
        .min(1)
        .max(50)
        .refine(l => new Set(l.map(x => x.invoiceLineId)).size === l.length, 'Line ids must be unique'),
    })
    .strict(),
  debitNote: z
    .object({
      reasonCode: z.enum(debitReasons),
      remarks: text(5, 500),
      lines: z
        .array(
          z
            .object({
              chargeHeadId: z.number().int().positive(),
              description: text(2, 200),
              amountPaise: paise,
            })
            .strict(),
        )
        .min(1)
        .max(20),
    })
    .strict(),
  cancel: z.object({ reason: text(10, 500) }).strict(),
  writeOff: z.object({ amountPaise: z.number().int().min(1), reason: text(10, 500) }).strict(),
  noteList: z
    .object({
      noteType: z.enum(NOTE_TYPES).optional(),
      status: z.enum(NOTE_STATUSES).optional(),
      reasonCode: z.string().max(20).optional(),
      invoiceId: id.optional(),
      unitId: id.optional(),
      from: ymd.optional(),
      to: ymd.optional(),
      sortBy: z.enum(['createdAt', 'noteDate', 'totalPaise']).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict(),
  patchNote: z
    .object({
      remarks: text(5, 500).optional(),
      lines: creditLines(),
      version,
    })
    .strict(),
  withdraw: z.object({ reason: text(5, 500), version }).strict(),
};

function creditLines() {
  return z
    .array(
      z.object({ invoiceLineId: z.number().int().positive(), amountPaise: z.number().int().min(1) }).strict(),
    )
    .min(1)
    .max(50)
    .refine(l => new Set(l.map(x => x.invoiceLineId)).size === l.length, 'Line ids must be unique')
    .optional();
}
