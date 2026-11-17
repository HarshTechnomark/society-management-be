import { z } from 'zod';
import { idParam } from './accounts.validation';

const bool = z.enum(['true', 'false']).transform(v => v === 'true');
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const CUSTOM_SUBTYPES = ['OTHER', 'RECEIVABLE', 'PAYABLE', 'TAX'] as const;

/** 8.10 schemas. */
export const ledgerSchemas = {
  idParam: z.object({ id: idParam }),
  list: z
    .object({
      type: z.enum(['ASSET', 'LIABILITY', 'FUND', 'INCOME', 'EXPENSE']).optional(),
      activeOnly: bool.default(true),
      cashBookOnly: bool.optional(),
    })
    .strict(),
  create: z
    .object({
      parentId: z.number().int().positive(),
      code: z.string().regex(/^\d{4}$/, 'Use a 4 digit code'),
      name: text(2, 120),
      isGroup: z.boolean().default(false),
      subtype: z.enum(CUSTOM_SUBTYPES).default('OTHER'),
      isCashBookCategory: z.boolean().default(false),
      transparencyCategory: text(2, 40).optional(),
      description: z.string().trim().max(300).optional(),
    })
    .strict(),
  patch: z
    .object({
      name: text(2, 120).optional(),
      isActive: z.boolean().optional(),
      isCashBookCategory: z.boolean().optional(),
      transparencyCategory: text(2, 40).nullable().optional(),
      description: z.string().trim().max(300).nullable().optional(),
      version: z.number().int().positive(),
    })
    .strict(),
};

export type LedgerCreateInput = z.infer<typeof ledgerSchemas.create>;
export type LedgerPatchInput = z.infer<typeof ledgerSchemas.patch>;
export type LedgerListQuery = z.infer<typeof ledgerSchemas.list>;
