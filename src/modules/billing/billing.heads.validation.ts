import { z } from 'zod';
import { paginationQuery } from '../../utils/pagination';
import {
  CHARGE_HEAD_KEY_RE,
  GST_TREATMENTS,
  HEAD_TYPES,
  PAYER_ROUTINGS,
  SYSTEM_HEAD_KEYS,
} from './billing.constants';
import { archiveBody, idParam, positiveInt, statusQuery, text, versionField } from './billing.setup.shared';

/** Zod schemas of section 8.1 (charge heads). Bodies are `.strict()`; the business rules (BR-11-8 to BR-11-13) are in the service. */
const SYSTEM_TYPES = ['INTEREST', 'LATE_FEE', 'OPENING_ARREARS'] as const;
const USER_HEAD_TYPES = HEAD_TYPES.filter(t => !(SYSTEM_TYPES as readonly string[]).includes(t)) as [
  string,
  ...string[],
];
const USER_GST = GST_TREATMENTS.filter(g => g !== 'FOLLOW_SOURCE') as ['NONE', 'THRESHOLD', 'ALWAYS'];

const sac = z.string().regex(/^\d{4,8}$/, 'The SAC code is 4 to 8 digits');
const ledgerCode = z
  .string()
  .regex(/^(\d{4}(-\d{3})?|[A-Z][A-Z_]{2,39})$/, 'Use an account code such as 4100 or a system key');
const sortOrder = z.number().int().min(0).max(999);

const listQuery = paginationQuery(['sortOrder', 'name', 'key'] as const, 'sortOrder')
  .partial({ sortBy: true, sortOrder: true })
  .extend({
    status: statusQuery,
    headType: z.enum(HEAD_TYPES).optional(),
    q: z.string().trim().min(1).max(40).optional(),
    sortBy: z.enum(['sortOrder', 'name', 'key']).default('sortOrder'),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
    limit: z.coerce.number().int().min(1).max(100).default(100),
  });

const create = z
  .object({
    key: z
      .string()
      .regex(CHARGE_HEAD_KEY_RE, 'Use capital letters, digits and underscores, starting with a letter')
      .refine(k => !(SYSTEM_HEAD_KEYS as readonly string[]).includes(k), 'This is a system head key'),
    name: text(2, 80),
    description: z.string().trim().max(300).optional(),
    headType: z.enum(USER_HEAD_TYPES),
    payerRouting: z.enum(PAYER_ROUTINGS).optional(),
    gstTreatment: z.enum(USER_GST).optional(),
    sacCode: sac.optional(),
    prorate: z.boolean().optional(),
    interestBearing: z.boolean().optional(),
    ledgerAccountCode: ledgerCode,
    fundId: positiveInt.optional(),
    sortOrder: sortOrder.optional(),
  })
  .strict()
  .refine(b => (b.gstTreatment ?? 'NONE') === 'NONE' || b.sacCode !== undefined, {
    path: ['sacCode'],
    message: 'The SAC code is required when the head is taxed',
  });

const patch = z
  .object({
    name: text(2, 80).optional(),
    description: z.string().trim().max(300).nullable().optional(),
    payerRouting: z.enum(PAYER_ROUTINGS).optional(),
    gstTreatment: z.enum(USER_GST).optional(),
    sacCode: sac.nullable().optional(),
    prorate: z.boolean().optional(),
    interestBearing: z.boolean().optional(),
    ledgerAccountCode: ledgerCode.optional(),
    fundId: positiveInt.nullable().optional(),
    sortOrder: sortOrder.optional(),
    version: versionField,
  })
  .strict()
  .refine(b => Object.keys(b).some(k => k !== 'version'), { message: 'Nothing to change' });

export const headSchemas = { idParam, listQuery, create, patch, archive: archiveBody };
export type HeadCreateInput = z.infer<typeof create>;
export type HeadPatchInput = z.infer<typeof patch>;
export type HeadListQuery = z.infer<typeof listQuery>;
