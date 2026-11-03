import { z } from 'zod';
import { emailSchema, mobileSchema, nameSchema } from '../auth/auth.normalise';
import {
  DUES_POLICIES,
  TRANSFER_DOC_TYPES,
  TRANSFER_STATUSES,
  TRANSFER_TYPES,
} from './residents.part3.constants';
import { docItem, id, idParam, listPage, text, version, ymd } from './residents.part3.validation';

/** Zod schemas of ownership transfers (section 8.17). Bodies are `.strict()`. */
const share = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Use up to 2 decimals')
  .refine(v => Number(v) >= 0.01 && Number(v) <= 100, 'Between 0.01 and 100');

const buyer = z
  .object({
    residentId: id.optional(),
    name: nameSchema.optional(),
    mobile: mobileSchema.nullable().optional(),
    email: emailSchema.nullable().optional(),
    dateOfBirth: ymd.nullable().optional(),
    sharePercent: share,
    isPrimary: z.boolean(),
    isResiding: z.boolean().optional(),
  })
  .strict()
  .superRefine((b, c) => {
    if (b.residentId === undefined && !(b.name && b.mobile))
      c.addIssue({ code: 'custom', path: ['residentId'], message: 'Give residentId, or name and mobile' });
    if (b.residentId !== undefined && (b.name || b.mobile || b.email || b.dateOfBirth))
      c.addIssue({
        code: 'custom',
        path: ['name'],
        message: 'Give residentId or the person details, not both',
      });
  });

const money = (max: number) => z.number().int().min(0).max(max);
const fields = {
  transferType: z.enum(TRANSFER_TYPES),
  effectiveDate: ymd,
  deedRegistrationNo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9/ -]{3,60}$/, '3 to 60 letters, digits, slash, space or hyphen')
    .nullable()
    .optional(),
  deedDate: ymd.nullable().optional(),
  considerationPaise: money(100_000_000_000).optional(),
  buyers: z.array(buyer).min(1).max(6),
  // caps are checked in the service (422 FEE_ABOVE_CAP); the schema only bounds the type
  transferPremiumPaise: money(1_000_000_000).optional(),
  shareTransferFeePaise: money(1_000_000_000).optional(),
  entranceFeePaise: money(1_000_000_000).optional(),
  duesPolicy: z.enum(DUES_POLICIES).optional(),
  endTenancy: z.boolean().optional(),
  notes: text(0, 1000, 'Notes').nullable().optional(),
  fileIds: z.array(docItem(TRANSFER_DOC_TYPES)).max(10).optional(),
};

const create = z.object({ unitId: id, ...fields }).strict();
const patch = z
  .object({
    transferType: fields.transferType.optional(),
    effectiveDate: fields.effectiveDate.optional(),
    deedRegistrationNo: fields.deedRegistrationNo,
    deedDate: fields.deedDate,
    considerationPaise: fields.considerationPaise,
    buyers: fields.buyers.optional(),
    transferPremiumPaise: fields.transferPremiumPaise,
    shareTransferFeePaise: fields.shareTransferFeePaise,
    entranceFeePaise: fields.entranceFeePaise,
    duesPolicy: fields.duesPolicy,
    endTenancy: fields.endTenancy,
    notes: fields.notes,
    fileIds: fields.fileIds,
    version,
  })
  .strict()
  .refine(b => Object.keys(b).some(k => k !== 'version'), 'Change at least one field');

const versionOnly = z.object({ version }).strict();
const cancel = z.object({ reason: text(5, 500, 'Reason'), version }).strict();
const list = z.object({
  ...listPage,
  status: z.enum(TRANSFER_STATUSES).optional(),
  unitId: id.optional(),
  sortBy: z.enum(['effectiveDate', 'createdAt']).default('createdAt'),
});

export const transferSchemas = { idParam, create, patch, versionOnly, cancel, list };
