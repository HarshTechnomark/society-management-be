import { z } from 'zod';
import { BANK_ACCOUNT_KINDS, STATEMENT_FORMATS } from './accounts.constants';

/** Zod schemas of the bank account routes (section 8.14). Bodies and queries are `.strict()`. */
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const version = z.number().int().min(1);
const bool = z.enum(['true', 'false']).transform(v => v === 'true');
const ifsc = z
  .string()
  .trim()
  .transform(v => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC'));
const accountNumber = z
  .string()
  .trim()
  .regex(/^\d{9,18}$/, 'Enter 9 to 18 digits');
const MAX_OPENING = 10_000_000_000_000;

export const bankSchemas = {
  idParam: z.object({ id: z.coerce.number().int().positive() }).strict(),
  list: z
    .object({
      status: z.enum(['ACTIVE', 'CLOSED', 'ALL']).default('ACTIVE'),
      isCollectionAccount: bool.optional(),
      verificationStatus: z.enum(['UNVERIFIED', 'VERIFIED']).optional(),
    })
    .strict(),
  create: z
    .object({
      displayName: text(2, 60),
      bankName: text(2, 100),
      branchName: text(1, 100).optional(),
      ifsc,
      accountKind: z.enum(BANK_ACCOUNT_KINDS),
      accountHolderName: text(2, 150),
      accountNumber,
      confirmAccountNumber: z.string().trim(),
      statementFormat: z.enum(STATEMENT_FORMATS).optional(),
      openingBalancePaise: z.number().int().min(-MAX_OPENING).max(MAX_OPENING).optional(),
      openingBalanceDate: ymd.optional(),
      isCollectionAccount: z.boolean().optional(),
    })
    .strict()
    .superRefine((v, ctx) => {
      if (v.confirmAccountNumber !== v.accountNumber)
        ctx.addIssue({
          code: 'custom',
          path: ['confirmAccountNumber'],
          message: 'The account numbers do not match',
        });
      if ((v.openingBalancePaise ?? 0) !== 0 && !v.openingBalanceDate)
        ctx.addIssue({
          code: 'custom',
          path: ['openingBalanceDate'],
          message: 'Required when there is an opening balance',
        });
    }),
  patch: z
    .object({
      displayName: text(2, 60).optional(),
      branchName: text(1, 100).nullable().optional(),
      statementFormat: z.enum(STATEMENT_FORMATS).optional(),
      accountHolderName: text(2, 150).optional(),
      ifsc: ifsc.optional(),
      accountNumber: accountNumber.optional(),
      confirmAccountNumber: z.string().trim().optional(),
      version,
    })
    .strict()
    .superRefine((v, ctx) => {
      if (v.accountNumber !== undefined && v.confirmAccountNumber !== v.accountNumber)
        ctx.addIssue({
          code: 'custom',
          path: ['confirmAccountNumber'],
          message: 'The account numbers do not match',
        });
    }),
  versionBody: z.object({ version }).strict(),
  close: z.object({ reason: text(5, 500), version }).strict(),
};

export type BankCreateInput = z.infer<typeof bankSchemas.create>;
export type BankPatchInput = z.infer<typeof bankSchemas.patch>;
export type BankListQuery = z.infer<typeof bankSchemas.list>;
