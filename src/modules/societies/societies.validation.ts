import { z } from 'zod';
import { SOCIETY_STATUSES, CLOSURE_REASONS } from '../../models/society.model';
import { LIFECYCLE_EVENT_TYPES } from '../../models/society-lifecycle-event.model';
import { GRANT_STATUSES } from '../../models/support-access-grant.model';
import { NOTE_CATEGORIES } from '../../models/society-note.model';
import { EXPORT_STATUSES } from '../../models/data-export.model';
import {
  HEALTH_BANDS,
  INDIAN_STATES,
  PLAN_KEYS,
  SELF_SERVE_PLAN_KEYS,
  SOCIETY_LOCALES,
  SUSPEND_REASON_CATEGORIES,
} from './societies.types';
import { SLUG_PATTERN } from './societies.slug';

/** Zod schemas for module 05 (section 8). Bodies are `.strict()`; ids are positive integers. */
const id = z.coerce.number().int().positive();
const version = z.number().int().min(1);
const page = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const bool = z.union([z.boolean(), z.enum(['true', 'false'])]).transform(v => v === true || v === 'true');
const many = <T extends z.ZodType>(s: T) =>
  z.preprocess(
    v => (v === undefined || v === '' ? undefined : Array.isArray(v) ? v : String(v).split(',')),
    z.array(s).min(1).optional(),
  );
const text = (min: number, max: number, what = 'Text') =>
  z
    .string()
    .trim()
    .min(min, `${what} must be at least ${min} characters`)
    .max(max, `${what} must be at most ${max} characters`);
const reason = (min = 10, max = 500) => text(min, max, 'Reason');
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const personName = z
  .string()
  .trim()
  .min(2)
  .max(120)
  .regex(/^[\p{L} .'-]+$/u, 'Use letters, spaces, dot, apostrophe or dash');
const email = z.string().trim().toLowerCase().max(254).pipe(z.email());
const mobile = z.string().regex(/^[6-9]\d{9}$/, 'Use a 10-digit Indian mobile number');
const pincode = z.string().regex(/^[1-9]\d{5}$/, 'Use a 6-digit pincode');
const state = z.enum(INDIAN_STATES);
const approxFlats = z.number().int().min(10, 'At least 10 flats').max(20000, 'At most 20,000 flats');
const slug = z.string().min(3).max(60).regex(SLUG_PATTERN, 'Use lowercase letters, digits and single dashes');
const gstin = z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Not a valid GSTIN');
const registrationNo = z
  .string()
  .trim()
  .max(60)
  .regex(/^[A-Za-z0-9/\-. ]+$/, 'Use letters, digits, / - . and spaces');
const timezone = z
  .string()
  .max(40)
  .refine(tz => {
    try {
      new Intl.DateTimeFormat('en-IN', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Not a valid IANA time zone');
const customPrice = z.number().int().min(100).max(100000);
const cycle = z.enum(['MONTHLY', 'ANNUAL']);
const planKey = z.enum(PLAN_KEYS);

const societyFields = {
  name: text(3, 150, 'Name'),
  legalName: text(1, 200, 'Legal name'),
  registrationNo,
  gstin,
  addressLine1: text(5, 200, 'Address'),
  addressLine2: z.string().trim().max(200),
  city: text(2, 80, 'City'),
  state,
  pincode,
  timezone,
  locale: z.enum(SOCIETY_LOCALES),
  approxFlats,
};

const listFilters = {
  q: text(2, 100, 'Search'),
  status: many(z.enum(SOCIETY_STATUSES)),
  planKey,
  state,
  city: text(2, 80, 'City'),
  organizationId: id,
  healthBand: z.enum(HEALTH_BANDS),
  createdVia: z.enum(['ASSISTED', 'SELF_SERVE']),
  trialEndingWithinDays: z.coerce.number().int().min(1).max(30),
  sortBy: z
    .enum([
      'name',
      'createdAt',
      'status',
      'healthScore',
      'trialEndsAt',
      'city',
      'activeUsers30',
      'unitsSnapshot',
      'units',
    ])
    .default('name')
    .transform(v => (v === 'units' ? 'unitsSnapshot' : v)),
  sortOrder: z.enum(['asc', 'desc']).default('asc'),
};

export const societySchemas = {
  idParam: z.object({ id }),
  noteParam: z.object({ id, noteId: id }),

  // 8.1
  signup: z
    .object({
      signupToken: z.string().min(10).max(200),
      person: z
        .object({ name: personName, email: email.optional(), role: z.enum(['chairman', 'society_admin']) })
        .strict(),
      society: z
        .object({
          name: societyFields.name,
          addressLine1: societyFields.addressLine1,
          addressLine2: societyFields.addressLine2.optional(),
          city: societyFields.city,
          state,
          pincode,
          approxFlats,
        })
        .strict(),
      planKey: z.enum(SELF_SERVE_PLAN_KEYS).default('STANDARD'),
      acceptTerms: z.literal(true, { message: 'Accept the terms to continue' }),
      confirmNotDuplicate: z.boolean().default(false),
    })
    .strict(),

  // 8.2
  list: z.object({ ...listFilters, ...page }).strict(),
  exportList: z.object(listFilters).strict(),
  slugQuery: z.object({ slug }).strict(),

  // 8.4
  create: z
    .object({
      society: z
        .object({
          name: societyFields.name,
          legalName: societyFields.legalName.optional(),
          slug: slug.optional(),
          registrationNo: registrationNo.optional(),
          gstin: gstin.optional(),
          addressLine1: societyFields.addressLine1,
          addressLine2: societyFields.addressLine2.optional(),
          city: societyFields.city,
          state,
          pincode,
          timezone: timezone.optional(),
          locale: z.enum(SOCIETY_LOCALES).optional(),
          approxFlats,
          organizationId: z.number().int().positive().optional(),
          requiresSupportConsent: z.boolean().optional(),
        })
        .strict(),
      firstAdmin: z
        .object({ name: personName, mobile, email, roleKey: z.enum(['chairman', 'society_admin']) })
        .strict(),
      plan: z
        .object({
          planKey,
          billingCycle: cycle,
          startAs: z.enum(['TRIAL', 'ACTIVE']),
          customPricePerFlatPaise: customPrice.optional(),
        })
        .strict(),
      confirmNotDuplicate: z.boolean().default(false),
    })
    .strict(),

  // 8.6
  update: z
    .object({
      name: societyFields.name.optional(),
      legalName: societyFields.legalName.nullable().optional(),
      registrationNo: registrationNo.nullable().optional(),
      gstin: gstin.nullable().optional(),
      addressLine1: societyFields.addressLine1.optional(),
      addressLine2: societyFields.addressLine2.nullable().optional(),
      city: societyFields.city.optional(),
      state: state.optional(),
      pincode: pincode.optional(),
      timezone: timezone.optional(),
      locale: z.enum(SOCIETY_LOCALES).optional(),
      approxFlats: approxFlats.optional(),
      organizationId: z.number().int().positive().nullable().optional(),
      version,
    })
    .strict(),

  // 8.7
  events: z
    .object({
      eventType: z.enum(LIFECYCLE_EVENT_TYPES).optional(),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
      ...page,
    })
    .strict(),

  // 8.8 to 8.15
  extendTrial: z.object({ days: z.number().int().min(1).max(30), reason: reason(), version }).strict(),
  convert: z
    .object({
      planKey: planKey.optional(),
      billingCycle: cycle,
      customPricePerFlatPaise: customPrice.optional(),
      reason: reason(),
      version,
    })
    .strict(),
  suspend: z
    .object({ reasonCategory: z.enum(SUSPEND_REASON_CATEGORIES), reason: reason(), version })
    .strict(),
  reactivate: z
    .object({
      reason: reason(),
      graceUntil: z.iso.datetime({ message: 'Use an ISO 8601 date and time' }).optional(),
      version,
    })
    .strict(),
  close: z
    .object({
      closureReason: z.enum(CLOSURE_REASONS),
      reason: reason(),
      confirmName: z.string().min(1).max(150),
      notifyResidents: z.boolean().default(true),
      version,
    })
    .strict()
    .refine(b => b.notifyResidents || ['DUPLICATE', 'FRAUD'].includes(b.closureReason), {
      path: ['notifyResidents'],
      message: 'Residents can be left out only for DUPLICATE or FRAUD',
    }),
  reopen: z
    .object({
      planKey,
      billingCycle: cycle,
      customPricePerFlatPaise: customPrice.optional(),
      reason: reason(),
      version,
    })
    .strict(),
  purgeHold: z.object({ reason: reason(10, 300), version }).strict(),
  nudge: z
    .object({
      template: z.enum(['ONBOARDING_HELP', 'ADOPTION_TIPS', 'PAYMENT_SETUP']).default('ONBOARDING_HELP'),
      note: z.string().trim().max(300).optional(),
    })
    .strict(),

  // 8.16
  notesQuery: z.object({ category: z.enum(NOTE_CATEGORIES).optional(), ...page }).strict(),
  createNote: z
    .object({
      body: text(3, 2000, 'Note'),
      category: z.enum(NOTE_CATEGORIES).default('GENERAL'),
      isPinned: z.boolean().default(false),
    })
    .strict(),
  updateNote: z
    .object({
      body: text(3, 2000, 'Note').optional(),
      category: z.enum(NOTE_CATEGORIES).optional(),
      isPinned: z.boolean().optional(),
      version,
    })
    .strict(),

  // 8.17, 8.24
  platformExport: z.object({ reason: reason(10, 300), includeDocuments: z.boolean().default(true) }).strict(),
  societyExport: z.object({ includeDocuments: z.boolean().default(true) }).strict(),
  exportsQuery: z
    .object({
      status: z.enum(EXPORT_STATUSES).optional(),
      kind: z.enum(['FULL', 'CLOSURE']).optional(),
      ...page,
    })
    .strict(),
  downloadQuery: z.object({ part: z.coerce.number().int().min(1).max(200).default(1) }).strict(),

  // 8.18, 8.19, 8.21
  grantsQuery: z
    .object({
      societyId: id.optional(),
      platformUserId: id.optional(),
      status: many(z.enum(GRANT_STATUSES)),
      scope: z.enum(['READ_ONLY', 'READ_WRITE']).optional(),
      isEmergency: bool.optional(),
      from: ymd.optional(),
      to: ymd.optional(),
      sortBy: z.enum(['createdAt', 'startedAt', 'endsAt', 'status']).default('createdAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
      ...page,
    })
    .strict()
    .refine(q => !q.from || !q.to || (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 366, {
      path: ['to'],
      message: 'The range can be at most 366 days',
    })
    .refine(q => !q.from || !q.to || q.from <= q.to, { path: ['to'], message: 'Must be on or after from' }),
  requestGrant: z
    .object({
      societyId: z.number().int().positive(),
      scope: z.enum(['READ_ONLY', 'READ_WRITE']),
      durationMinutes: z
        .number()
        .int()
        .min(15, 'At least 15 minutes')
        .max(240, 'At most 240 minutes')
        .refine(v => v % 15 === 0, 'Use steps of 15 minutes'),
      reason: reason(20, 500),
      ticketRef: z
        .string()
        .regex(/^[A-Z]{2,6}-\d{1,8}$/, 'Use a ticket reference like TKT-2041')
        .optional(),
      isEmergency: z.boolean().default(false),
    })
    .strict(),
  revokeGrant: z.object({ reason: reason(5, 300), version }).strict(),
  empty: z.object({}).strict(),

  // 8.23
  societyGrantsQuery: z.object({ status: many(z.enum(GRANT_STATUSES)), ...page }).strict(),
  approveGrant: z.object({ version }).strict(),
  denyGrant: z.object({ reason: reason(5, 300), version }).strict(),
  consentSetting: z.object({ requiresSupportConsent: z.boolean(), version }).strict(),
};
