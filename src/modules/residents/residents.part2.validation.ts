import { z } from 'zod';
import { FAMILY_RELATIONS } from '../../models/unit-resident.model';
import { emailSchema, mobileSchema, nameSchema } from '../auth/auth.normalise';
import { DOC_TYPES, ID_DOC_TYPES } from './residents.constants';
import {
  AGREEMENT_TYPES,
  JOIN_RELATIONS,
  JOIN_STATUSES_ALL,
  MOVE_DOC_TYPES,
  MOVE_STATUSES_ALL,
  MOVE_TYPES,
  POLICE_STATUSES,
  TENANCY_DOC_TYPES,
  TENANCY_END_REASONS,
  TENANCY_STATUSES_ALL,
} from './residents.part2.constants';

/** Zod schemas of module 09 part 2 (sections 8.13 to 8.15, 8.23). Bodies are `.strict()`. */
const id = z.coerce.number().int().positive();
const version = z.number().int().min(1);
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
const hhmm = z.string().regex(/^([01]\d|2[0-3]):(00|30)$/, 'Use HH:mm on the hour or half hour');
const page = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
/** A repeatable query value: `?status=A&status=B` or `?status=A,B`. */
const list = <T extends readonly [string, ...string[]]>(values: T) =>
  z.preprocess(
    v => (v === undefined ? undefined : (Array.isArray(v) ? v : [v]).flatMap(x => String(x).split(','))),
    z.array(z.enum(values)).optional(),
  );
const order = z.enum(['asc', 'desc']).optional();

const idParam = z.object({ id });
const codeParam = z.object({
  code: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .min(3)
    .max(60),
});
const empty = z.object({}).strict();
const versionOnly = z.object({ version }).strict();

const docOf = <T extends readonly [string, ...string[]]>(types: T) =>
  z
    .object({
      fileId: id,
      docType: z.enum(types),
      title: text(2, 120, 'Title').optional(),
      idLast4: z
        .string()
        .regex(/^[0-9A-Z]{4}$/, 'The last 4 characters, capital letters and digits')
        .optional(),
    })
    .strict();

// ------------------------------------------------------------------ tenancies
const household = z
  .object({
    name: nameSchema,
    familyRelation: z.enum(FAMILY_RELATIONS).optional(),
    relation: z.literal('CARETAKER').optional(),
    mobile: mobileSchema.nullable().optional(),
    dateOfBirth: ymd.nullable().optional(),
    canLogin: z.boolean().optional(),
  })
  .strict()
  .refine(
    h => Boolean(h.familyRelation) !== Boolean(h.relation),
    'Give familyRelation, or relation CARETAKER',
  );
const tenant = z.union([
  z.object({ residentId: id }).strict(),
  z
    .object({
      name: nameSchema,
      mobile: mobileSchema,
      email: emailSchema.nullable().optional(),
      dateOfBirth: ymd.nullable().optional(),
    })
    .strict(),
]);
const tenancyFields = {
  agreementType: z.enum(AGREEMENT_TYPES).optional(),
  agreementStart: ymd,
  agreementEnd: ymd,
  agreementRegistrationNo: z
    .string()
    .regex(/^[A-Za-z0-9/-]{3,40}$/, '3 to 40 letters, digits, / or -')
    .nullable()
    .optional(),
  monthlyRentPaise: z.number().int().min(0).max(100_000_000).optional(),
  securityDepositPaise: z.number().int().min(0).max(1_000_000_000).optional(),
  maintenancePayer: z.enum(['OWNER', 'TENANT']).optional(),
  occupantCount: z.number().int().min(1).max(20).optional(),
  inviteTenant: z.boolean().optional(),
  household: z.array(household).max(10).optional(),
};
const tenancyCreate = z
  .object({
    unitId: id,
    tenant,
    ...tenancyFields,
    fileIds: z.array(docOf(TENANCY_DOC_TYPES)).max(5).optional(),
  })
  .strict();
const tenancyPatch = z
  .object({
    ...tenancyFields,
    agreementStart: ymd.optional(),
    agreementEnd: ymd.optional(),
    fileIds: z.array(docOf(TENANCY_DOC_TYPES)).max(5).optional(),
    version,
  })
  .strict();
const tenancyList = z.object({
  ...page,
  unitId: id.optional(),
  status: list(TENANCY_STATUSES_ALL),
  policeVerificationStatus: z.enum(POLICE_STATUSES).optional(),
  expiringWithinDays: z.coerce.number().int().min(1).max(180).optional(),
  maintenancePayer: z.enum(['OWNER', 'TENANT']).optional(),
  sortBy: z.enum(['agreementEnd', 'createdAt']).default('agreementEnd'),
  sortOrder: order,
});
const tenancyApprove = z.object({ note: text(0, 300, 'Note').optional(), version }).strict();
const reason = (min: number, max: number) => z.object({ reason: text(min, max, 'Reason'), version }).strict();
const tenancyActivate = z.object({ moveInDate: ymd, version }).strict();
const tenancyRenew = z
  .object({
    agreementEnd: ymd,
    fileId: id.optional(),
    monthlyRentPaise: z.number().int().min(0).max(100_000_000).optional(),
    version,
  })
  .strict();
const tenancyEnd = z
  .object({
    endedOn: ymd,
    endReason: z.enum(TENANCY_END_REASONS),
    endNote: text(0, 300, 'Note').optional(),
    version,
  })
  .strict();
const police = z
  .object({
    status: z.enum(POLICE_STATUSES),
    verifiedOn: ymd.optional(),
    reference: text(3, 60, 'Reference').optional(),
    note: text(0, 300, 'Note').optional(),
    fileId: id.optional(),
    version,
  })
  .strict();
const myTenancyDocs = z.object({ fileIds: z.array(docOf(TENANCY_DOC_TYPES)).min(1).max(5) }).strict();

// ------------------------------------------------------------------ join requests
const joinCreate = z
  .object({
    societyCode: codeParam.shape.code,
    unitId: id,
    relation: z.enum(JOIN_RELATIONS),
    familyRelation: z.enum(FAMILY_RELATIONS).optional(),
    householdOf: z.enum(['OWNER', 'TENANT']).optional(),
    agreementStart: ymd.optional(),
    agreementEnd: ymd.optional(),
    email: emailSchema.optional(),
    dateOfBirth: ymd.optional(),
    message: text(0, 300, 'Message').optional(),
    fileIds: z.array(docOf(DOC_TYPES)).min(1).max(5),
  })
  .strict()
  .superRefine((v, c) => {
    const add = (path: string, message: string) => c.addIssue({ code: 'custom', path: [path], message });
    if (v.relation === 'FAMILY' && !v.familyRelation) add('familyRelation', 'Required for a family member');
    if (v.relation !== 'FAMILY' && v.familyRelation) add('familyRelation', 'Only for a family member');
    const hh = v.relation === 'FAMILY' || v.relation === 'CARETAKER';
    if (hh && !v.householdOf) add('householdOf', 'OWNER or TENANT household');
    if (!hh && v.householdOf) add('householdOf', 'Only for family and caretaker requests');
    if (v.relation === 'TENANT' && (!v.agreementStart || !v.agreementEnd))
      add('agreementStart', 'Give the agreement start and end dates');
    if (v.relation !== 'TENANT' && (v.agreementStart || v.agreementEnd))
      add('agreementStart', 'Only for a tenant');
    void ID_DOC_TYPES;
  });
const joinUnits = z.object({ q: z.string().trim().min(1).max(20) });
const joinList = z.object({
  ...page,
  status: list(JOIN_STATUSES_ALL),
  unitId: id.optional(),
  relation: z.enum(JOIN_RELATIONS).optional(),
  sortBy: z.enum(['createdAt']).default('createdAt'),
  sortOrder: order,
});
const joinConfirm = z.object({ note: text(0, 300, 'Note').optional(), version }).strict();

// ------------------------------------------------------------------ moves
const vehicle = z
  .string()
  .transform(v => v.replace(/[\s-]/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}[0-9]{1,2}[A-Z]{0,3}[0-9]{4}$/, 'Not a valid vehicle number'));
const moveFields = {
  moveDate: ymd,
  slotStart: hhmm,
  slotEnd: hhmm,
  liftLabel: text(2, 40, 'Lift').optional(),
  vehicleNumber: vehicle.optional(),
  moverCompany: text(2, 150, 'Company').optional(),
  moverMobile: mobileSchema.optional(),
  helperCount: z.number().int().min(0).max(30).optional(),
  itemsNote: text(0, 500, 'Note').optional(),
  fileIds: z.array(docOf(MOVE_DOC_TYPES)).max(3).optional(),
};
const moveCreate = z
  .object({ unitId: id, type: z.enum(MOVE_TYPES), householdOf: z.enum(['OWNER', 'TENANT']), ...moveFields })
  .strict();
const movePatch = z
  .object({
    moveDate: ymd.optional(),
    slotStart: hhmm.optional(),
    slotEnd: hhmm.optional(),
    liftLabel: moveFields.liftLabel,
    vehicleNumber: moveFields.vehicleNumber,
    moverCompany: moveFields.moverCompany,
    moverMobile: moveFields.moverMobile,
    helperCount: moveFields.helperCount,
    itemsNote: moveFields.itemsNote,
    fileIds: moveFields.fileIds,
    version,
  })
  .strict();
const moveList = z
  .object({
    ...page,
    type: z.enum(MOVE_TYPES).optional(),
    status: list(MOVE_STATUSES_ALL),
    unitId: id.optional(),
    buildingId: id.optional(),
    dateFrom: ymd.optional(),
    dateTo: ymd.optional(),
    sortBy: z.enum(['moveDate', 'createdAt']).default('moveDate'),
    sortOrder: order,
  })
  .refine(
    q =>
      !q.dateFrom ||
      !q.dateTo ||
      (new Date(q.dateTo).getTime() - new Date(q.dateFrom).getTime()) / 86_400_000 <= 92,
    { message: 'dateFrom and dateTo must be at most 92 days apart', path: ['dateTo'] },
  );
const moveStart = z.object({ version }).strict();
const gateStart = z.object({ gatePassCode: z.string().trim().length(8), version }).strict();
const moveComplete = z.object({ note: text(0, 300, 'Note').optional(), version }).strict();
const inspection = z
  .object({
    result: z.enum(['PASSED', 'DAMAGE_FOUND']),
    damageDeductionPaise: z.number().int().min(0),
    note: text(5, 500, 'Note'),
    version,
  })
  .strict()
  .refine(v => v.result === 'DAMAGE_FOUND' || v.damageDeductionPaise === 0, {
    message: 'A passed inspection has no deduction',
    path: ['damageDeductionPaise'],
  });
const gateQuery = z.object({ date: ymd.optional() });

export const part2Schemas = {
  empty,
  idParam,
  codeParam,
  versionOnly,
  tenancyCreate,
  tenancyPatch,
  tenancyList,
  tenancyApprove,
  tenancyReject: reason(5, 500),
  tenancyCancel: reason(5, 300),
  tenancyActivate,
  tenancyRenew,
  tenancyEnd,
  police,
  myTenancyDocs,
  joinCreate,
  joinUnits,
  joinList,
  joinConfirm,
  joinDecline: reason(5, 300),
  moveCreate,
  movePatch,
  moveList,
  moveStart,
  gateStart,
  moveComplete,
  inspection,
  moveCancel: reason(5, 300),
  moveOverride: reason(5, 500),
  gateQuery,
};
