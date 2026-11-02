import { z } from 'zod';
import {
  CREDIT_ENTRY_TYPES,
  CREDIT_NOTE_REASONS,
  CREDIT_STATUSES,
  DOCUMENT_TYPES,
  INVOICE_KINDS,
  INVOICE_STATUSES,
  PAYMENT_KINDS,
  PAYMENT_METHODS,
  PAYMENT_ORIGINS,
  PAYMENT_STATUSES,
  TAX_TYPES,
  TDS_SECTIONS,
} from './platform-billing.constants';

/** Zod schemas for module 06 (section 8). Bodies are `.strict()`; ids are positive integers. */
const id = z.coerce.number().int().positive();
const version = z.number().int().min(1);
const text = (min: number, max: number, what = 'Text') =>
  z
    .string()
    .trim()
    .min(min, `${what} must be at least ${min} characters`)
    .max(max, `${what} must be at most ${max} characters`);
const reason = text(10, 500, 'Reason');
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(
    s =>
      !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s),
    'Not a real date',
  );
const days = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
const commaOf = (values: readonly string[]) =>
  z
    .string()
    .trim()
    .refine(v => v.split(',').every(x => values.includes(x)), `Use a comma list of: ${values.join(', ')}`);

const page = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
};

const invoiceFilters = {
  documentType: z.enum(DOCUMENT_TYPES).optional(),
  status: commaOf(INVOICE_STATUSES).optional(),
  invoiceKind: z.enum(INVOICE_KINDS).optional(),
  issueFrom: ymd.optional(),
  issueTo: ymd.optional(),
  q: text(1, 60, 'Search').optional(),
  sortBy: z.enum(['issueDate', 'dueDate', 'totalPaise', 'amountDuePaise', 'invoiceNo']).default('issueDate'),
};
const dateRange = (v: { issueFrom?: string; issueTo?: string }, ctx: z.RefinementCtx) => {
  if (v.issueFrom && v.issueTo) {
    if (v.issueFrom > v.issueTo)
      ctx.addIssue({ code: 'custom', path: ['issueTo'], message: 'issueTo must not be before issueFrom' });
    else if (days(v.issueFrom, v.issueTo) > 366)
      ctx.addIssue({ code: 'custom', path: ['issueTo'], message: 'The range can be at most 366 days' });
  }
};

const statusList = commaOf(PAYMENT_STATUSES);
const paymentFilters = {
  kind: z.enum(PAYMENT_KINDS).optional(),
  status: statusList.optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  invoiceId: id.optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  sortBy: z.enum(['createdAt', 'amountPaise', 'capturedAt']).default('createdAt'),
};
const fromTo = (v: { from?: string; to?: string }, ctx: z.RefinementCtx) => {
  if (v.from && v.to && v.from > v.to)
    ctx.addIssue({ code: 'custom', path: ['to'], message: '`to` must not be before `from`' });
};

const decimal4 = (what: string, min: number, max: number) =>
  z
    .string()
    .regex(/^\d{1,8}(\.\d{1,4})?$/, `${what}: a decimal with at most 4 places`)
    .refine(v => Number(v) >= min && Number(v) <= max, `${what}: ${min} to ${max}`);

const amount = (min: number, max: number) => z.number().int().min(min).max(max);

const bankReference = text(4, 40, 'Bank reference').regex(
  /^[A-Za-z0-9/-]+$/,
  'Letters, digits, / and - only',
);

const manualPayment = z
  .object({
    societyId: id,
    invoiceId: id.optional(),
    method: z.enum(['NEFT', 'RTGS', 'IMPS', 'CHEQUE', 'UPI', 'DD']),
    amountPaise: amount(100, 100_000_000_000),
    receivedOn: ymd,
    bankReference,
    payerBankName: text(2, 100, 'Bank name').optional(),
    attachmentFileId: id.optional(),
    notes: text(1, 500, 'Notes').optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if ((v.method === 'CHEQUE' || v.method === 'DD') && !/^\d{6}$/.test(v.bankReference))
      ctx.addIssue({
        code: 'custom',
        path: ['bankReference'],
        message: 'A cheque or DD number has 6 digits',
      });
  });

export const platformBillingSchemas = {
  idParam: z.object({ id }),
  societyParam: z.object({ societyId: id }),

  societyInvoices: z.object({ ...page, ...invoiceFilters }).superRefine(dateRange),
  platformInvoices: z
    .object({ ...page, ...invoiceFilters, societyId: id.optional(), taxType: z.enum(TAX_TYPES).optional() })
    .superRefine(dateRange),
  exportInvoices: z
    .object({
      ...invoiceFilters,
      sortOrder: page.sortOrder,
      societyId: id.optional(),
      taxType: z.enum(TAX_TYPES).optional(),
    })
    .superRefine(dateRange),

  paymentOrder: z.object({ amountPaise: z.number().int().min(1).max(100_000_000_000).optional() }).strict(),
  verify: z
    .object({ gatewayPaymentId: z.string().regex(/^pay_[A-Za-z0-9]{8,40}$/, 'Not a gateway payment id') })
    .strict(),

  societyPayments: z.object({ ...page, ...paymentFilters }).superRefine(fromTo),
  platformPayments: z
    .object({
      ...page,
      ...paymentFilters,
      societyId: id.optional(),
      origin: z.enum(PAYMENT_ORIGINS).optional(),
    })
    .superRefine(fromTo),

  credits: z.object({
    ...page,
    entryType: z.enum(CREDIT_ENTRY_TYPES).optional(),
    status: commaOf(CREDIT_STATUSES).optional(),
    sortBy: z.enum(['createdAt']).default('createdAt'),
  }),

  tdsClaim: z
    .object({
      tdsSection: z.enum(TDS_SECTIONS),
      tdsRatePct: decimal4('tdsRatePct', 0.0001, 20).optional(),
      amountPaise: amount(100, 100_000_000_000),
      deductedOn: ymd,
      certificateFileId: id.optional(),
      notes: text(1, 500, 'Notes').optional(),
    })
    .strict(),
  tdsPatch: z.object({ certificateFileId: id, version }).strict(),
  tdsDecision: z
    .object({ decision: z.enum(['VERIFIED', 'REJECTED']), reason: reason.optional(), version })
    .strict()
    .superRefine((v, ctx) => {
      if (v.decision === 'REJECTED' && !v.reason)
        ctx.addIssue({ code: 'custom', path: ['reason'], message: 'A reason is required to reject' });
    }),

  autopay: z
    .object({ method: z.enum(['UPI_AUTOPAY', 'EMANDATE']), maxAmountPaise: amount(100, 500_000_000) })
    .strict(),

  manualInvoice: z
    .object({
      societyId: id,
      subscriptionId: id.optional(),
      lines: z
        .array(
          z
            .object({
              description: text(3, 300, 'Description'),
              quantity: decimal4('quantity', 0.0001, 99_999_999.9999),
              unitPricePaise: amount(1, 1_000_000_000),
            })
            .strict(),
        )
        .min(1)
        .max(20),
      notes: text(1, 500, 'Notes').optional(),
      serviceDate: ymd.optional(),
    })
    .strict(),
  creditNote: z
    .object({
      reason: z.enum(CREDIT_NOTE_REASONS),
      subtotalPaise: z.number().int().min(1),
      notes: text(10, 500, 'Notes'),
    })
    .strict(),
  approve: z.object({ version }).strict(),
  reject: z.object({ version, reason }).strict(),

  manualPayment,
  completeRefund: z
    .object({ bankReference: text(4, 40, 'Bank reference'), receivedOn: ymd, version })
    .strict(),
  refund: z
    .object({
      amountPaise: amount(100, 100_000_000_000),
      mode: z.enum(['GATEWAY', 'BANK_TRANSFER']),
      sourcePaymentId: id.optional(),
      payeeReference: text(5, 200, 'Payee reference')
        .refine(v => !/\d{9,}/.test(v), 'Do not enter a full account number')
        .optional(),
      reason,
    })
    .strict()
    .superRefine((v, ctx) => {
      if (v.mode === 'GATEWAY' && !v.sourcePaymentId)
        ctx.addIssue({ code: 'custom', path: ['sourcePaymentId'], message: 'Required for a gateway refund' });
      if (v.mode === 'BANK_TRANSFER' && !v.payeeReference)
        ctx.addIssue({ code: 'custom', path: ['payeeReference'], message: 'Required for a bank transfer' });
    }),
  goodwill: z.object({ amountPaise: amount(100, 100_000_000), reason }).strict(),

  // 8.15 to 8.17: the range of `days` is a business rule (422 GRACE_EXTENSION_INVALID)
  remind: z.object({ note: text(1, 300, 'Note').optional() }).strict(),
  extendGrace: z.object({ days: z.number().int(), reason, version }).strict(),
  writeOffRequest: z.object({ reason, version }).strict(),

  // 8.24 to 8.27
  approvals: z.object({
    type: z
      .enum([
        'MANUAL_PAYMENT',
        'REFUND',
        'MANUAL_INVOICE',
        'CREDIT_NOTE',
        'GOODWILL_CREDIT',
        'WRITE_OFF',
        'PAYMENT_MISMATCH',
      ])
      .optional(),
    page: page.page,
    limit: page.limit,
    sortBy: z.enum(['createdAt']).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
  }),
  dunning: z.object({
    status: commaOf(['PAST_DUE', 'SUSPENDED']).optional(),
    page: page.page,
    limit: page.limit,
    sortBy: z.enum(['daysLate', 'overduePaise', 'nextSuspensionDate']).default('daysLate'),
    sortOrder: page.sortOrder,
  }),
  revenue: z.object({ asOf: ymd.optional(), months: z.coerce.number().int().min(1).max(24).default(12) }),
  gstSummary: z.object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use YYYY-MM'),
    format: z.enum(['json', 'csv']).default('json'),
  }),
  tdsReceivable: z.object({
    financialYear: z
      .string()
      .regex(/^\d{4}-\d{2}$/, 'Use YYYY-YY')
      .refine(
        v => (Number(v.slice(0, 4)) + 1) % 100 === Number(v.slice(5)),
        'The second year must follow the first',
      ),
    quarter: z.coerce.number().int().min(1).max(4).optional(),
    status: commaOf(['CLAIMED', 'VERIFIED', 'REJECTED']).optional(),
    format: z.enum(['json', 'csv']).default('json'),
  }),
};
