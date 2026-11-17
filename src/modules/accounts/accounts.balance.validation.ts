import { z } from 'zod';
import { ymd } from './accounts.validation';

/** 8.2 query: `from` and `to` are required dates; the range (at most 366 days) and `to <= today` are checked in the service. */
export const balanceSchemas = {
  history: z
    .object({
      from: ymd.refine(v => v >= '2000-01-01' && !Number.isNaN(Date.parse(v)), 'From 2000-01-01 on'),
      to: ymd.refine(v => !Number.isNaN(Date.parse(v)), 'Not a date'),
    })
    .strict(),
};
