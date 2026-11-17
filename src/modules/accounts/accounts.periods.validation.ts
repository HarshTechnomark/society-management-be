import { z } from 'zod';
import { financialYear, ymd } from './accounts.validation';

const version = z.number().int().min(1);

/** Section 8.18 request schemas. */
export const periodSchemas = {
  lock: z.object({ lockThrough: ymd, version }).strict(),
  unlock: z
    .object({
      fromDate: ymd,
      hours: z.number().int().min(1).max(168),
      reason: z.string().trim().min(10).max(500),
    })
    .strict(),
  relock: z.object({ version }).strict(),
  fyParam: z.object({ fy: financialYear }).strict(),
  close: z.object({ confirm: z.literal(true), version }).strict(),
};
