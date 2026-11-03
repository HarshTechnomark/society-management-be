import { z } from 'zod';
import { BLOOD_GROUPS } from '../../models/emergency-profile.model';
import { FAMILY_RELATIONS, LINK_RELATIONS } from '../../models/unit-resident.model';
import { emailSchema, mobileSchema, nameSchema } from '../auth/auth.normalise';
import { SOCIETY_LOCALES } from '../societies/societies.types';
import {
  DOC_TYPES,
  GENDERS,
  HOUSEHOLDS,
  KYC_STATUSES,
  MANUAL_END_REASONS,
  OCCUPANCIES,
  PET_GENDERS,
  PET_INACTIVE_REASONS,
  PET_SPECIES,
  PET_VACCINATION_FILTERS,
  RESIDENT_STATUSES,
  SELF_DOC_TYPES,
} from './residents.constants';

/** Zod schemas of module 09 part 1 (section 8). Bodies are `.strict()`; ids are positive integers. */
const id = z.coerce.number().int().positive();
const version = z.number().int().min(1);
const bool = z.union([z.boolean(), z.enum(['true', 'false'])]).transform(v => v === true || v === 'true');
const page = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const text = (min: number, max: number, what = 'Text') =>
  z
    .string()
    .trim()
    .min(min, `${what} must be at least ${min} characters`)
    .max(max, `${what} must be at most ${max} characters`);
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const share = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Use up to 2 decimals')
  .refine(v => Number(v) >= 0.01 && Number(v) <= 100, 'Between 0.01 and 100');
const dob = ymd.refine(v => v >= '1900-01-01', 'Not before 1900');
const empty = z.object({}).strict();

const idParam = z.object({ id });
const linkParam = z.object({ linkId: id });
const unitParam = z.object({ unitId: id });
const docParam = z.object({ docId: id });
const sosParam = z.object({ sosId: id });

// ------------------------------------------------------------------ resident (8.5, 8.6)
const residentFields = {
  name: nameSchema,
  mobile: mobileSchema.nullable().optional(),
  alternateMobile: mobileSchema.nullable().optional(),
  email: emailSchema.nullable().optional(),
  dateOfBirth: dob.nullable().optional(),
  gender: z.enum(GENDERS).nullable().optional(),
  photoFileId: id.nullable().optional(),
  preferredLanguage: z.enum(SOCIETY_LOCALES as unknown as [string, ...string[]]).optional(),
  isNri: z.boolean().optional(),
  overseasPhone: z
    .string()
    .regex(/^\+[1-9]\d{6,14}$/, 'Use an overseas number like +14155550123')
    .refine(v => !v.startsWith('+91'), 'Use an overseas number, not +91')
    .nullable()
    .optional(),
  localRepresentativeResidentId: id.nullable().optional(),
  adminNote: text(0, 500, 'Note').nullable().optional(),
};
const linkFields = {
  unitId: id,
  relation: z.enum(LINK_RELATIONS),
  familyRelation: z.enum(FAMILY_RELATIONS).optional(),
  householdOf: z.enum(HOUSEHOLDS).optional(),
  sharePercent: share.optional(),
  isPrimary: z.boolean().optional(),
  isResiding: z.boolean().optional(),
  canLogin: z.boolean().optional(),
  fromDate: ymd,
};
const linkShape = z.object(linkFields).strict();
type LinkShape = z.infer<typeof linkShape>;
const linkRules = (l: LinkShape, ctx: z.RefinementCtx): void => {
  if (l.relation === 'FAMILY' && !l.familyRelation)
    ctx.addIssue({ code: 'custom', path: ['familyRelation'], message: 'Required for a family member' });
  if (l.relation !== 'FAMILY' && l.familyRelation)
    ctx.addIssue({ code: 'custom', path: ['familyRelation'], message: 'Only for a family member' });
  if ((l.relation === 'FAMILY' || l.relation === 'CARETAKER') && !l.householdOf)
    ctx.addIssue({ code: 'custom', path: ['householdOf'], message: 'OWNER or TENANT household' });
  if (l.relation !== 'FAMILY' && l.relation !== 'CARETAKER' && l.householdOf)
    ctx.addIssue({ code: 'custom', path: ['householdOf'], message: 'Only for family and caretaker links' });
};
const link = linkShape.superRefine(linkRules);
const docItem = z
  .object({
    fileId: id,
    docType: z.enum(DOC_TYPES),
    title: text(2, 120, 'Title').optional(),
    idLast4: z
      .string()
      .regex(/^[0-9A-Z]{4}$/, 'The last 4 characters, capital letters and digits')
      .optional(),
    expiresOn: ymd.optional(),
    unitId: id.optional(),
  })
  .strict();

const residentCreate = z
  .object({
    ...residentFields,
    link: link.optional(),
    invite: z.boolean().optional(),
    fileIds: z
      .array(docItem.omit({ unitId: true }))
      .max(5)
      .optional(),
  })
  .strict();

const residentPatch = z
  .object({
    ...Object.fromEntries(Object.entries(residentFields).map(([k, v]) => [k, (v as z.ZodType).optional()])),
    version,
  })
  .strict()
  .refine(b => Object.keys(b).some(k => k !== 'version'), 'Change at least one field');

const residentList = z.object({
  ...page,
  q: z.string().trim().min(2).max(60).optional(),
  unitId: id.optional(),
  buildingId: id.optional(),
  relation: z.enum(LINK_RELATIONS).optional(),
  status: z.enum(RESIDENT_STATUSES).optional(),
  hasLogin: bool.optional(),
  kycStatus: z.enum(KYC_STATUSES).optional(),
  sortBy: z.enum(['name', 'createdAt', 'updatedAt']).default('name'),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});
const residentExport = residentList.omit({ page: true, limit: true, sortBy: true, sortOrder: true });
const revealQuery = z.object({ reveal: z.literal('contacts').optional() });
const residentDelete = z.object({ reason: text(5, 500, 'Reason'), version }).strict();
const residentInvite = z
  .object({ email: emailSchema.optional(), message: text(0, 300, 'Message').optional() })
  .strict();

// ------------------------------------------------------------------ links (8.8 to 8.10)
const linkPatch = z
  .object({
    sharePercent: share.nullable().optional(),
    isPrimary: z.literal(true).optional(),
    isResiding: z.boolean().optional(),
    canLogin: z.boolean().optional(),
    familyRelation: z.enum(FAMILY_RELATIONS).optional(),
    version,
  })
  .strict()
  .refine(b => Object.keys(b).some(k => k !== 'version'), 'Change at least one field');
const linkEnd = z
  .object({
    toDate: ymd,
    endReason: z.enum(MANUAL_END_REASONS),
    endNote: text(0, 300, 'Note').optional(),
    promoteLinkId: id.optional(),
    version,
  })
  .strict();
const shares = z
  .object({
    shares: z
      .array(z.object({ linkId: id, sharePercent: share }).strict())
      .min(1)
      .max(20),
    primaryLinkId: id,
    version: z
      .array(z.object({ linkId: id, version }).strict())
      .min(1)
      .max(20),
  })
  .strict();
const vacate = z.object({ reason: text(5, 500, 'Reason'), effectiveDate: ymd.optional() }).strict();

// ------------------------------------------------------------------ documents (8.11)
const docCreate = docItem;
const selfDocCreate = z
  .object({
    fileId: id,
    docType: z.enum(SELF_DOC_TYPES),
    title: text(2, 120, 'Title').optional(),
    idLast4: z
      .string()
      .regex(/^[0-9A-Z]{4}$/, 'The last 4 characters, capital letters and digits')
      .optional(),
    expiresOn: ymd.optional(),
    unitId: id.optional(),
  })
  .strict();
const docVerify = z
  .object({ decision: z.enum(['VERIFIED', 'REJECTED']), reason: text(5, 300, 'Reason').optional(), version })
  .strict()
  .refine(b => b.decision === 'VERIFIED' || Boolean(b.reason), {
    path: ['reason'],
    message: 'Give the reason for rejecting it',
  });
const docDelete = z.object({ reason: text(5, 300, 'Reason') }).strict();
const download = z.object({ disposition: z.enum(['inline', 'attachment']).default('attachment') });

// ------------------------------------------------------------------ import (8.12)
const importStart = z
  .object({ fileId: id, mode: z.enum(['DRY_RUN', 'COMMIT']), inviteAll: z.boolean().default(false) })
  .strict();
const importParam = z.object({ jobId: z.string().regex(/^imp_[0-9a-f]{8}$/, 'Not an import id') });

// ------------------------------------------------------------------ flats, timeline, stats (8.3, 8.4)
const flatList = z.object({
  ...page,
  q: z.string().trim().min(2).max(60).optional(),
  buildingId: id.optional(),
  occupancy: z.enum(OCCUPANCIES).optional(),
  hasDues: bool.optional(),
  sortBy: z.enum(['unitLabel', 'duesPaise']).default('unitLabel'),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

// ------------------------------------------------------------------ household, pets, emergency, privacy, directory
const memberCreate = z
  .object({
    unitId: id,
    name: nameSchema,
    relation: z.enum(['FAMILY', 'CARETAKER']),
    familyRelation: z.enum(FAMILY_RELATIONS).optional(),
    mobile: mobileSchema.optional(),
    email: emailSchema.optional(),
    dateOfBirth: dob.optional(),
    canLogin: z.boolean().optional(),
    isResiding: z.boolean().optional(),
    invite: z.boolean().optional(),
  })
  .strict()
  .superRefine((b, c) => {
    if (b.relation === 'FAMILY' && !b.familyRelation)
      c.addIssue({ code: 'custom', path: ['familyRelation'], message: 'Required for a family member' });
    if (b.relation === 'CARETAKER' && b.familyRelation)
      c.addIssue({ code: 'custom', path: ['familyRelation'], message: 'Only for a family member' });
  });
const memberPatch = z
  .object({
    name: nameSchema.optional(),
    familyRelation: z.enum(FAMILY_RELATIONS).optional(),
    dateOfBirth: dob.nullable().optional(),
    canLogin: z.boolean().optional(),
    isResiding: z.boolean().optional(),
    version,
  })
  .strict()
  .refine(b => Object.keys(b).some(k => k !== 'version'), 'Change at least one field');
const memberDelete = z.object({ reason: text(0, 300, 'Reason').optional() }).strict();

const petFields = {
  name: text(1, 60, 'Name'),
  species: z.enum(PET_SPECIES),
  breed: text(1, 60, 'Breed').nullable().optional(),
  gender: z.enum(PET_GENDERS).optional(),
  colour: text(1, 40, 'Colour').nullable().optional(),
  dateOfBirth: ymd.nullable().optional(),
  photoFileId: id.nullable().optional(),
  licenceNo: text(2, 40, 'Licence').nullable().optional(),
  isNeutered: z.boolean().nullable().optional(),
  temperamentNote: text(0, 200, 'Note').nullable().optional(),
  lastVaccineName: text(1, 80, 'Vaccine').nullable().optional(),
  lastVaccinatedOn: ymd.nullable().optional(),
  vaccinationValidUntil: ymd.nullable().optional(),
  vaccinationFileId: id.nullable().optional(),
};
const petCreate = z.object({ unitId: id, ...petFields }).strict();
const petPatch = z
  .object({
    ...Object.fromEntries(Object.entries(petFields).map(([k, v]) => [k, (v as z.ZodType).optional()])),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    inactiveReason: z.enum(PET_INACTIVE_REASONS).optional(),
    version,
  })
  .strict()
  .refine(b => Object.keys(b).some(k => k !== 'version'), 'Change at least one field');
const petList = z.object({
  ...page,
  unitId: id.optional(),
  species: z.enum(PET_SPECIES).optional(),
  vaccination: z.enum(PET_VACCINATION_FILTERS).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
});

const emergencyContact = z
  .object({ name: text(2, 120, 'Name'), relation: text(2, 40, 'Relation'), mobile: mobileSchema })
  .strict();
const emergencyPut = z
  .object({
    bloodGroup: z.enum(BLOOD_GROUPS).nullable().optional(),
    medicalNotes: z.string().max(1000, 'At most 1000 characters').nullable().optional(),
    isSeniorCitizen: z.boolean().optional(),
    isDifferentlyAbled: z.boolean().optional(),
    mobilityNote: text(0, 200, 'Note').nullable().optional(),
    preferredHospital: text(0, 120, 'Hospital').nullable().optional(),
    contacts: z.array(emergencyContact).max(3).optional(),
    consent: z.boolean().optional(),
    withdrawConsent: z.boolean().optional(),
    keepContacts: z.boolean().optional(),
    version: version.optional(),
  })
  .strict();

const privacyPatch = z
  .object({
    directoryVisible: z.boolean().optional(),
    showMobileInDirectory: z.boolean().optional(),
    showEmailInDirectory: z.boolean().optional(),
    showPhotoInDirectory: z.boolean().optional(),
    version,
  })
  .strict()
  .refine(b => Object.keys(b).some(k => k !== 'version'), 'Change at least one field');

const directory = z.object({
  q: z.string().trim().min(2).max(60).optional(),
  buildingId: id.optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  sortBy: z.enum(['unitLabel', 'name']).default('unitLabel'),
});

export const residentSchemas = {
  empty,
  idParam,
  linkParam,
  unitParam,
  docParam,
  sosParam,
  importParam,
  residentCreate,
  residentPatch,
  residentList,
  residentExport,
  revealQuery,
  residentDelete,
  residentInvite,
  linkCreate: link,
  linkPatch,
  linkEnd,
  shares,
  vacate,
  docCreate,
  selfDocCreate,
  docVerify,
  docDelete,
  download,
  importStart,
  flatList,
  memberCreate,
  memberPatch,
  memberDelete,
  petCreate,
  petPatch,
  petList,
  emergencyPut,
  privacyPatch,
  directory,
};
export type { LinkShape };
