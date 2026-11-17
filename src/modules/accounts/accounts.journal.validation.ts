import { z } from 'zod';
import { JOURNAL_STATUSES, JOURNAL_SOURCES, MAX_JOURNAL_LINES, MAX_LINE_PAISE } from './accounts.constants';

/** Zod schemas of sub-module 13.1b (section 8.11). Queries and bodies are `.strict()`. */
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
const csvOf = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform(v => v.split(',').map(s => s.trim()))
    .pipe(z.array(z.enum(values)).min(1).max(values.length));

/** Draft voucher types a manual journal may use (section 8.11). */
export const MANUAL_VOUCHER_TYPES = ['JOURNAL', 'CONTRA', 'PAYMENT', 'RECEIPT'] as const;

/** Line shape errors (both or neither side) are `422 JOURNAL_LINE_INVALID` in the service, so the schema only checks types. */
const side = z.number().int().min(0).max(MAX_LINE_PAISE);
const line = z
  .object({
    ledgerAccountCode: z.string().trim().min(1).max(40),
    debitPaise: side,
    creditPaise: side,
    fundId: z.number().int().positive().nullish(),
    lineNarration: z.string().max(200).nullish(),
  })
  .strict();
const lines = z.array(line).min(1).max(MAX_JOURNAL_LINES);
const version = z.number().int().min(1);

export const journalSchemas = {
  idParam: z.object({ id }).strict(),
  listQuery: z
    .object({
      from: ymd.optional(),
      to: ymd.optional(),
      voucherType: z.string().max(30).optional(),
      status: csvOf(JOURNAL_STATUSES).optional(),
      source: z.enum(JOURNAL_SOURCES).optional(),
      refType: z
        .string()
        .regex(/^[a-z][a-z_]{1,39}$/)
        .optional(),
      ledgerAccountId: id.optional(),
      fundId: id.optional(),
      q: z.string().trim().min(2).max(60).optional(),
      minAmountPaise: z.coerce.number().int().min(0).max(MAX_LINE_PAISE).optional(),
      maxAmountPaise: z.coerce.number().int().min(0).max(MAX_LINE_PAISE).optional(),
      sortBy: z.enum(['entryDate', 'voucherNo', 'totalPaise', 'createdAt']).default('entryDate'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
      page,
      limit,
    })
    .strict()
    .refine(v => !v.from || !v.to || v.to >= v.from, {
      message: '`to` must not be before `from`',
      path: ['to'],
    })
    .refine(
      v =>
        v.minAmountPaise === undefined ||
        v.maxAmountPaise === undefined ||
        v.maxAmountPaise >= v.minAmountPaise,
      { message: '`maxAmountPaise` must not be below `minAmountPaise`', path: ['maxAmountPaise'] },
    ),
  create: z
    .object({
      date: ymd,
      voucherType: z.enum(MANUAL_VOUCHER_TYPES).default('JOURNAL'),
      narration: z.string().trim().min(3).max(500),
      instrumentRef: z.string().trim().max(60).nullish(),
      lines,
    })
    .strict(),
  update: z
    .object({
      date: ymd.optional(),
      voucherType: z.enum(MANUAL_VOUCHER_TYPES).optional(),
      narration: z.string().trim().min(3).max(500).optional(),
      instrumentRef: z.string().trim().max(60).nullish(),
      lines: lines.optional(),
      version,
    })
    .strict(),
  submit: z.object({ version }).strict(),
  reverse: z
    .object({
      reversalDate: ymd.optional(),
      reason: z.string().trim().min(5).max(500),
      version,
    })
    .strict(),
};
export type CreateJournalBody = z.infer<typeof journalSchemas.create>;
export type UpdateJournalBody = z.infer<typeof journalSchemas.update>;
export type ListJournalsQuery = z.infer<typeof journalSchemas.listQuery>;
