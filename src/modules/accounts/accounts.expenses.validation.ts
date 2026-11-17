import { z } from 'zod';
import { EXPENSE_PAYMENT_MODES, EXPENSE_STATUSES, EXPENSE_TYPES } from './accounts.constants';
import { idParam, reason } from './accounts.validation';

/** Zod schemas of sections 8.4 to 8.9. Business rules (BR-13-20 to 24) are in `accounts.expenses.rules.ts`. */
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const id = z.number().int().positive();
const amount = z.number().int().min(100).max(100_000_000_000);
const version = z.number().int().min(1);
const bool = z.union([z.boolean(), z.enum(['true', 'false']).transform(v => v === 'true')]);
const ref = z.string().regex(/^[A-Za-z0-9/-]{6,30}$/, '6 to 30 letters, digits, / or -');

const fields = {
  expenseType: z.enum(EXPENSE_TYPES),
  expenseDate: ymd,
  payee: z.string().trim().min(2).max(150),
  ledgerAccountId: id,
  description: z.string().trim().max(500).nullable(),
  grossAmountPaise: amount,
  gstPaise: z.number().int().min(0).max(100_000_000_000),
  tdsPaise: z.number().int().min(0).max(100_000_000_000),
  tdsSection: z
    .string()
    .regex(/^[0-9]{3}[A-Z]{0,3}$/, 'For example 194C')
    .nullable(),
  challanNo: ref.nullable(),
  paidFromLedgerAccountId: id,
  paymentMode: z.enum(EXPENSE_PAYMENT_MODES),
  paymentReference: ref.nullable(),
  fundId: id.nullable(),
  collectionId: id.nullable(),
  vendorId: id.nullable(),
  vendorBillId: id.nullable(),
  fileIds: z.array(id).max(5),
};

const createBody = z
  .object({
    expenseType: fields.expenseType.default('DIRECT'),
    expenseDate: fields.expenseDate,
    payee: fields.payee.optional(),
    ledgerAccountId: fields.ledgerAccountId.optional(),
    description: fields.description.optional(),
    grossAmountPaise: fields.grossAmountPaise,
    gstPaise: fields.gstPaise.default(0),
    tdsPaise: fields.tdsPaise.default(0),
    tdsSection: fields.tdsSection.optional(),
    challanNo: fields.challanNo.optional(),
    paidFromLedgerAccountId: fields.paidFromLedgerAccountId,
    paymentMode: fields.paymentMode,
    paymentReference: fields.paymentReference.optional(),
    fundId: fields.fundId.optional(),
    collectionId: fields.collectionId.optional(),
    vendorId: fields.vendorId.optional(),
    vendorBillId: fields.vendorBillId.optional(),
    fileIds: fields.fileIds.default([]),
    submit: z.boolean().default(true),
  })
  .strict();

const patchBody = z
  .object({
    expenseType: fields.expenseType.optional(),
    expenseDate: fields.expenseDate.optional(),
    payee: fields.payee.optional(),
    ledgerAccountId: fields.ledgerAccountId.optional(),
    description: fields.description.optional(),
    grossAmountPaise: fields.grossAmountPaise.optional(),
    gstPaise: fields.gstPaise.optional(),
    tdsPaise: fields.tdsPaise.optional(),
    tdsSection: fields.tdsSection.optional(),
    challanNo: fields.challanNo.optional(),
    paidFromLedgerAccountId: fields.paidFromLedgerAccountId.optional(),
    paymentMode: fields.paymentMode.optional(),
    paymentReference: fields.paymentReference.optional(),
    fundId: fields.fundId.optional(),
    collectionId: fields.collectionId.optional(),
    vendorId: fields.vendorId.optional(),
    vendorBillId: fields.vendorBillId.optional(),
    fileIds: fields.fileIds.optional(),
    version,
  })
  .strict();

const filters = {
  status: z.enum(EXPENSE_STATUSES).optional(),
  expenseType: z.enum(EXPENSE_TYPES).optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  ledgerAccountId: z.coerce.number().int().positive().optional(),
  fundId: z.coerce.number().int().positive().optional(),
  collectionId: z.coerce.number().int().positive().optional(),
  vendorId: z.coerce.number().int().positive().optional(),
  paidFrom: z.enum(['BANK', 'CASH', 'PETTY_CASH']).optional(),
  createdByMe: bool.optional(),
  q: z.string().trim().min(2).max(60).optional(),
  sortBy: z.enum(['expenseDate', 'grossAmountPaise', 'createdAt', 'status']).default('expenseDate'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
};

export const expenseSchemas = {
  idParam: z.object({ id: idParam }),
  create: createBody,
  patch: patchBody,
  list: z
    .object({
      ...filters,
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict(),
  export: z.object({ ...filters, format: z.enum(['csv']).default('csv') }).strict(),
  submit: z.object({ version }).strict(),
  withdraw: z.object({ version, reason }).strict(),
  remove: z.object({ version, reason }).strict(),
  reverse: z.object({ reversalDate: ymd.optional(), reason, version }).strict(),
  cashBook: z
    .object({
      account: z
        .string()
        .regex(/^(ALL|CASH|PETTY_CASH|BANK:[1-9][0-9]*)$/, 'ALL, CASH, PETTY_CASH or BANK:<id>')
        .default('ALL'),
      from: ymd,
      to: ymd,
      direction: z.enum(['IN', 'OUT']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    })
    .strict(),
};

export type CreateExpenseBody = z.infer<typeof createBody>;
export type PatchExpenseBody = z.infer<typeof patchBody>;
export type ExpenseListQuery = z.infer<typeof expenseSchemas.list>;
export type CashBookQuery = z.infer<typeof expenseSchemas.cashBook>;
