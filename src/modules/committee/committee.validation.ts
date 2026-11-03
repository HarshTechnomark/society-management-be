import { z } from 'zod';
import {
  DESIGNATIONS,
  MAX_SEATS_INPUT,
  PORTFOLIOS,
  TERM_KINDS,
  TERM_SOURCES,
  TERM_STATUSES,
} from './committee.constants';

/** Zod schemas of module 10.1 (section 8). Bodies are `.strict()`; ids are positive integers; the business rules are in the service. */
const id = z.coerce.number().int().positive();
const version = z.number().int().min(1);
const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const portfolios = z
  .array(z.enum(PORTFOLIOS))
  .max(8)
  .refine(a => new Set(a).size === a.length, 'Portfolios must be unique');
const publicEmail = z.string().trim().toLowerCase().email().max(254);
/** 400 here; the 422 range check of the spec (3 to 25, society settings) is in the service. */
const strength = z.number().int().min(1).max(255);

const idParam = z.object({ id });
const seatParam = z.object({ id, seatId: z.string().regex(/^S[1-9]\d{0,2}$/) });

const seat = z
  .object({
    seatId: z
      .string()
      .regex(/^S[1-9]\d{0,2}$/)
      .optional(),
    userId: id.optional(),
    name: text(2, 120).optional(),
    designation: z.enum(DESIGNATIONS),
    joinMode: z.enum(['ELECTED', 'NOMINATED', 'APPOINTED']).optional(),
    unitId: id.optional(),
    portfolios: portfolios.optional(),
    publicEmail: publicEmail.nullable().optional(),
    showOnResidentPage: z.boolean().optional(),
    replaceExistingRole: z.boolean().optional(),
  })
  .strict();

const termCreate = z
  .object({
    name: text(3, 120),
    kind: z.enum(TERM_KINDS).optional(),
    source: z.enum(['MANUAL', 'HISTORICAL']).optional(),
    startDate: ymd,
    endDate: ymd,
    strength,
    notes: z.string().max(1000).optional(),
    seats: z.array(seat).min(1).max(MAX_SEATS_INPUT),
    resolutionRef: text(3, 100).optional(),
  })
  .strict()
  .superRefine((b, ctx) => {
    if (b.source === 'HISTORICAL') {
      if (!b.resolutionRef)
        ctx.addIssue({
          code: 'custom',
          path: ['resolutionRef'],
          message: 'The resolution reference is required',
        });
      b.seats.forEach((s, i) => {
        if (!s.name)
          ctx.addIssue({ code: 'custom', path: ['seats', i, 'name'], message: 'The name is required' });
        if (s.seatId)
          ctx.addIssue({ code: 'custom', path: ['seats', i, 'seatId'], message: 'Not allowed on create' });
      });
    } else
      b.seats.forEach((s, i) => {
        if (s.userId === undefined)
          ctx.addIssue({
            code: 'custom',
            path: ['seats', i, 'userId'],
            message: 'The seat holder is required',
          });
        if (s.unitId === undefined)
          ctx.addIssue({
            code: 'custom',
            path: ['seats', i, 'unitId'],
            message: 'The qualifying flat is required',
          });
        if (s.seatId)
          ctx.addIssue({ code: 'custom', path: ['seats', i, 'seatId'], message: 'Not allowed on create' });
      });
  });

const termPatch = z
  .object({
    version,
    name: text(3, 120).optional(),
    kind: z.enum(TERM_KINDS).optional(),
    startDate: ymd.optional(),
    endDate: ymd.optional(),
    strength: strength.optional(),
    notes: z.string().max(1000).nullable().optional(),
    seats: z.array(seat).min(1).max(MAX_SEATS_INPUT).optional(),
    reason: text(5, 500).optional(),
  })
  .strict()
  .refine(b => Object.keys(b).some(k => k !== 'version' && k !== 'reason'), 'Nothing to change');

const termDelete = z.object({ version, reason: text(5, 500) }).strict();

const seatPatch = z
  .object({
    version,
    portfolios: portfolios.optional(),
    publicEmail: publicEmail.nullable().optional(),
    showOnResidentPage: z.boolean().optional(),
    unitId: id.optional(),
  })
  .strict()
  .refine(b => Object.keys(b).some(k => k !== 'version'), 'Nothing to change');

const termList = z.object({
  status: z.enum(TERM_STATUSES).optional(),
  source: z.enum(TERM_SOURCES).optional(),
  sortBy: z.enum(['startDate', 'createdAt']).default('startDate'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const committeeSchemas = {
  idParam,
  seatParam,
  termCreate,
  termPatch,
  termDelete,
  seatPatch,
  termList,
};
