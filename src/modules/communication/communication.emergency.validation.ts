import { z } from 'zod';
import { EMERGENCY_STATUSES, EMERGENCY_TYPES, LIMITS, RESPONSE_STATUSES } from './communication.constants';

/** Zod schemas of sections 8.25 to 8.30 (strict bodies and queries). */
const id = z
  .string()
  .regex(/^[1-9]\d{0,18}$/, 'Not a valid id')
  .transform(Number);
const version = z.number().int().min(1);
const bool = z.enum(['true', 'false']).transform(v => v === 'true');
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

const audience = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('ALL') }).strict(),
    z
      .object({
        type: z.literal('BUILDINGS'),
        ids: z.array(z.number().int().positive()).min(1).max(LIMITS.audienceBuildingsMax),
      })
      .strict(),
  ])
  .optional();

export const emergencySchemas = {
  idParam: z.object({ id }).strict(),
  attendParam: z.object({ id, responseId: id }).strict(),
  start: z
    .object({
      type: z.enum(EMERGENCY_TYPES),
      title: text(3, 120).optional(),
      message: text(LIMITS.emergencyMessageMin, LIMITS.emergencyMessageMax),
      audience,
      includeStaff: z.boolean().optional(),
      collectResponses: z.boolean().optional(),
      isDrill: z.boolean().optional(),
      confirm: z.literal(true, { message: 'Confirm the alert (confirm must be true)' }),
    })
    .strict(),
  list: z
    .object({
      status: z.enum(EMERGENCY_STATUSES).optional(),
      type: z.enum(EMERGENCY_TYPES).optional(),
      isDrill: bool.optional(),
      from: ymd.optional(),
      to: ymd.optional(),
      sortBy: z.enum(['startedAt']).default('startedAt'),
      sortOrder: z.enum(['asc', 'desc']).default('desc'),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict(),
  rollCall: z
    .object({
      status: z.enum([...RESPONSE_STATUSES, 'NO_RESPONSE']).optional(),
      buildingId: z.coerce.number().int().positive().optional(),
      floor: z.coerce.number().int().min(-20).max(200).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    })
    .strict(),
  update: z.object({ version, message: text(LIMITS.emergencyUpdateMin, LIMITS.emergencyUpdateMax) }).strict(),
  realert: z.object({ version }).strict(),
  resolve: z
    .object({ version, allClearMessage: text(LIMITS.emergencyUpdateMin, LIMITS.emergencyUpdateMax) })
    .strict(),
  cancel: z.object({ version, reason: text(LIMITS.emergencyCancelMin, LIMITS.emergencyCancelMax) }).strict(),
  response: z
    .object({
      status: z.enum(RESPONSE_STATUSES),
      peopleCount: z.number().int().min(1).max(LIMITS.peopleCountMax).optional(),
      note: z.string().trim().max(LIMITS.responseNoteMax).optional(),
      unitId: z.number().int().positive().optional(),
      channel: z.enum(['APP', 'PUSH_ACTION']).optional(),
    })
    .strict(),
  attend: z.object({ note: z.string().trim().max(200).optional() }).strict(),
};
