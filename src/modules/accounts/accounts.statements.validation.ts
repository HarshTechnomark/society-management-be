import { z } from 'zod';
import { STATEMENT_FORMATS } from './accounts.constants';

/** Zod schemas of section 8.16 and the BRS query of 8.14. Bodies and queries are `.strict()`. */
const id = z.coerce.number().int().positive();
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const version = z.number().int().min(1);

export const statementSchemas = {
  idParam: z.object({ id }),
  import: z
    .object({
      bankAccountId: z.number().int().positive(),
      fileId: z.number().int().positive(),
      parserKey: z.enum(STATEMENT_FORMATS).optional(),
    })
    .strict(),
  list: z
    .object({
      bankAccountId: id.optional(),
      status: z.enum(['UPLOADED', 'PARSED', 'FAILED', 'RECONCILED']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
      sortBy: z.enum(['createdAt', 'periodTo']).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
    })
    .strict(),
  lines: z
    .object({
      matchStatus: z.enum(['UNMATCHED', 'MATCHED', 'IGNORED']).optional(),
      direction: z.enum(['CREDIT', 'DEBIT']).optional(),
      from: ymd.optional(),
      to: ymd.optional(),
      q: z.string().trim().min(1).max(100).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      sortBy: z.enum(['txnDate', 'lineNo', 'amount']).default('txnDate'),
      sortOrder: z.enum(['asc', 'desc']).default('asc'),
    })
    .strict(),
  versionBody: z.object({ version }).strict(),
  match: z.object({ journalLineId: z.number().int().positive(), version }).strict(),
  ignore: z.object({ reason: z.string().trim().min(5).max(200), version }).strict(),
  createEntry: z
    .object({
      ledgerAccountCode: z
        .string()
        .trim()
        .regex(/^\d{4}(-\d{3})?$/, 'Use an account code such as 5600'),
      narration: z.string().trim().min(3).max(200).optional(),
      version,
    })
    .strict(),
  brs: z.object({ asOf: ymd.optional() }).strict(),
  sample: z.object({ bankAccountId: id }).strict(),
};
