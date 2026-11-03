import { z } from 'zod';
import { AppError } from '../../utils/errors';
import {
  DESIGNATIONS,
  EXIT_REASONS,
  HANDOVER_STATUSES,
  JOIN_MODES,
  MAX_HANDOVER_ITEMS,
  MAX_SEATS_STORED,
  PORTFOLIOS,
  SEAT_FLAGS,
  SEAT_STATUSES,
} from './committee.constants';

/** Section 7.2: the JSON shapes stored on the term row. Parsed on every read and write. */
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const CommitteeSeat = z
  .object({
    seatId: z.string().regex(/^S[1-9]\d{0,2}$/),
    userId: z.number().int().positive().nullable(),
    memberId: z.number().int().positive().nullable(),
    unitId: z.number().int().positive().nullable(),
    name: z.string().trim().min(2).max(120),
    designation: z.enum(DESIGNATIONS),
    joinMode: z.enum(JOIN_MODES),
    portfolios: z
      .array(z.enum(PORTFOLIOS))
      .max(8)
      .refine(a => new Set(a).size === a.length),
    publicEmail: z.string().email().max(254).toLowerCase().nullable(),
    showOnResidentPage: z.boolean(),
    status: z.enum(SEAT_STATUSES),
    fromDate: ymd.nullable(),
    toDate: ymd.nullable(),
    roleBeforeKey: z.string().max(80).nullable(),
    replaceExistingRole: z.boolean(),
    exitReason: z.enum(EXIT_REASONS).nullable(),
    exitNote: z.string().max(300).nullable(),
    resolutionRef: z.string().min(3).max(100).nullable(),
    flags: z.array(z.enum(SEAT_FLAGS)).max(3),
  })
  .strict();
export type SeatJson = z.infer<typeof CommitteeSeat>;

export const HandoverItem = z
  .object({
    itemId: z.string().regex(/^H[1-9]\d{0,1}$/),
    title: z.string().trim().min(3).max(120),
    ownerDesignation: z.enum(DESIGNATIONS).nullable(),
    status: z.enum(HANDOVER_STATUSES),
    note: z.string().max(300).nullable(),
    evidenceFileIds: z.array(z.number().int().positive()).max(5),
    updatedByUserId: z.number().int().positive().nullable(),
    updatedAt: z.string().datetime().nullable(),
  })
  .strict();
export type HandoverItemJson = z.infer<typeof HandoverItem>;

export const SeatList = z.array(CommitteeSeat).max(MAX_SEATS_STORED);
export const HandoverList = z.array(HandoverItem).max(MAX_HANDOVER_ITEMS);

const malformed = (what: string) =>
  new AppError(500, 'INTERNAL_ERROR', `The ${what} of this term is malformed`);
const raw = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);

/** Parses the `members` JSON; a malformed row is `500 INTERNAL_ERROR` (section 12). */
export function parseSeats(v: unknown): SeatJson[] {
  try {
    return SeatList.parse(raw(v));
  } catch {
    throw malformed('seat list');
  }
}
export function parseHandover(v: unknown): HandoverItemJson[] {
  try {
    return HandoverList.parse(raw(v));
  } catch {
    throw malformed('hand-over checklist');
  }
}
