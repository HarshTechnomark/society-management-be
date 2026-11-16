import { z } from 'zod';

/** Zod schemas of 12.2 (sections 8.6, 8.11, 8.12). Bodies and queries are `.strict()`; ids are positive integers. */
const id = z.coerce.number().int().positive();
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const version = z.number().int().min(1);

export const OFFLINE_METHODS = ['CASH', 'CHEQUE', 'NEFT', 'IMPS', 'RTGS', 'UPI_TO_BANK'] as const;
export const DECLARED_METHODS = ['NEFT', 'IMPS', 'RTGS', 'UPI_TO_BANK'] as const;
export type OfflineMethod = (typeof OFFLINE_METHODS)[number];

/** BR-12-26 reference patterns (after trimming; bank transfers are upper-cased before the match). */
export const UTR_RE = /^[A-Z0-9]{12,22}$/;
export const UPI_REF_RE = /^\d{12}$/;
export const CHEQUE_NO_RE = /^\d{6}$/;

/** Checks the reference of the method; returns the normalised reference (UTR upper-cased) or an error message. */
export function checkReference(
  method: string,
  raw: string | undefined,
): { ok: true; value: string | null } | { ok: false; message: string } {
  const v = raw?.trim();
  if (method === 'CASH') return { ok: true, value: null };
  if (method === 'CHEQUE') return { ok: true, value: null };
  if (!v) return { ok: false, message: 'Required for this method' };
  if (method === 'UPI_TO_BANK')
    return UPI_REF_RE.test(v)
      ? { ok: true, value: v }
      : { ok: false, message: 'Use the 12-digit UPI reference' };
  const u = v.toUpperCase();
  return UTR_RE.test(u)
    ? { ok: true, value: u }
    : { ok: false, message: 'Use the UTR: 12 to 22 letters and digits' };
}

const fileIds = z.array(z.number().int().positive()).max(3);

const offline = z
  .object({
    unitId: z.number().int().positive(),
    payingFor: z.enum(['DUES', 'COLLECTION']),
    collectionRequestId: z.number().int().positive().optional(),
    method: z.enum(OFFLINE_METHODS),
    amountPaise: z.number().int().min(100).max(100_000_000),
    paymentDate: ymd,
    referenceNo: z.string().trim().max(40).optional(),
    cheque: z
      .object({
        bankName: text(2, 80),
        chequeNo: z.string().trim().regex(CHEQUE_NO_RE, 'Six digits'),
        chequeDate: ymd,
      })
      .strict()
      .optional(),
    payerName: text(2, 120).optional(),
    fileIds: fileIds.optional(),
    notes: z.string().trim().max(500).optional(),
    confirmDuplicate: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.payingFor === 'COLLECTION' && !v.collectionRequestId)
      c.addIssue({
        code: 'custom',
        path: ['collectionRequestId'],
        message: 'Required when paying for a collection',
      });
    if (v.payingFor === 'DUES' && v.collectionRequestId)
      c.addIssue({
        code: 'custom',
        path: ['collectionRequestId'],
        message: 'Only when paying for a collection',
      });
    if (v.method === 'CHEQUE' && !v.cheque)
      c.addIssue({ code: 'custom', path: ['cheque'], message: 'Cheque details are required' });
    if (v.method !== 'CHEQUE' && v.cheque)
      c.addIssue({ code: 'custom', path: ['cheque'], message: 'Only for cheque payments' });
    if (v.method === 'CHEQUE' && v.referenceNo)
      c.addIssue({
        code: 'custom',
        path: ['referenceNo'],
        message: 'Use the cheque number in cheque.chequeNo',
      });
    if (v.method === 'CASH' && v.referenceNo)
      c.addIssue({ code: 'custom', path: ['referenceNo'], message: 'Cash has no reference' });
    const ref = checkReference(v.method, v.referenceNo);
    if (!ref.ok) c.addIssue({ code: 'custom', path: ['referenceNo'], message: ref.message });
    if (fileIds && v.fileIds && new Set(v.fileIds).size !== v.fileIds.length)
      c.addIssue({ code: 'custom', path: ['fileIds'], message: 'Files must be unique' });
  });

const declared = z
  .object({
    unitId: z.number().int().positive(),
    method: z.enum(DECLARED_METHODS),
    amountPaise: z.number().int().min(100).max(100_000_000),
    paymentDate: ymd,
    referenceNo: z.string().trim().max(40),
    fileIds: fileIds.min(1),
    note: z.string().trim().max(300).optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.method === 'UPI_TO_BANK' && v.amountPaise > 50_000_000)
      c.addIssue({ code: 'custom', path: ['amountPaise'], message: 'At most 50,000,000 paise for UPI' });
    const ref = checkReference(v.method, v.referenceNo);
    if (!ref.ok) c.addIssue({ code: 'custom', path: ['referenceNo'], message: ref.message });
    if (new Set(v.fileIds).size !== v.fileIds.length)
      c.addIssue({ code: 'custom', path: ['fileIds'], message: 'Files must be unique' });
  });

const idParam = z.object({ id }).strict();

const deposit = z
  .object({
    paymentIds: z.array(z.number().int().positive()).min(1).max(100),
    depositedOn: ymd,
    bankAccountId: z.number().int().positive(),
  })
  .strict()
  .superRefine((v, c) => {
    if (new Set(v.paymentIds).size !== v.paymentIds.length)
      c.addIssue({ code: 'custom', path: ['paymentIds'], message: 'Ids must be unique' });
  });

const clear = z.object({ clearedOn: ymd, version }).strict();
const bounce = z
  .object({
    bouncedOn: ymd,
    reason: text(5, 200),
    applyBounceCharge: z.boolean().optional(),
    bounceChargePaise: z.number().int().min(0).max(500_000).optional(),
    version,
  })
  .strict();
const ret = z.object({ reason: text(5, 300), version }).strict();

const csv = (allowed: readonly string[]) =>
  z
    .string()
    .transform(s =>
      s
        .split(',')
        .map(x => x.trim().toUpperCase())
        .filter(Boolean),
    )
    .refine(a => a.length > 0 && a.every(x => allowed.includes(x)), 'Unknown value');
export const CHEQUE_STATUSES = [
  'RECEIVED',
  'DEPOSITED',
  'CLEARED',
  'BOUNCED',
  'RETURNED',
  'PENDING_APPROVAL',
  'REJECTED',
] as const;
const list = z
  .object({
    status: csv(CHEQUE_STATUSES).optional(),
    unitId: id.optional(),
    q: z.string().trim().min(2).max(60).optional(),
    chequeFrom: ymd.optional(),
    chequeTo: ymd.optional(),
    dueForDeposit: z
      .enum(['true', 'false'])
      .transform(v => v === 'true')
      .optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const offlineSchemas = { offline, declared, idParam, deposit, clear, bounce, ret, list };
