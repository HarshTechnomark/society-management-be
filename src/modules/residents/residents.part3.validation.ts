import { z } from 'zod';

/** Zod building blocks shared by the part 3 schemas (renovation permits and ownership transfers). */
export const id = z.coerce.number().int().positive();
export const version = z.number().int().min(1);
export const text = (min: number, max: number, what = 'Text') =>
  z
    .string()
    .trim()
    .min(min, `${what} must be at least ${min} characters`)
    .max(max, `${what} must be at most ${max} characters`);
export const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine(v => {
    const d = new Date(`${v}T00:00:00.000Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, 'Not a real date');
export const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:mm');
export const idParam = z.object({ id });
export const listPage = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  sortOrder: z.enum(['asc', 'desc']).optional(),
};
export const docItem = <T extends readonly [string, ...string[]]>(types: T) =>
  z.object({ fileId: id, docType: z.enum(types), title: text(2, 120, 'Title').optional() }).strict();
