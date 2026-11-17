import { z } from 'zod';
import { financialYear, idParam, ymd } from './accounts.validation';
import { REPORT_NAMES } from './accounts.reports.service';

/** Section 8.19 query and the export body. `asOf` and a period are alternatives; `financialYear` replaces both. */
const bool = z.enum(['true', 'false']).transform(v => v === 'true');
const params = {
  asOf: ymd.optional(),
  from: ymd.optional(),
  to: ymd.optional(),
  financialYear: financialYear.optional(),
  ledgerAccountId: idParam.optional(),
  fundId: idParam.optional(),
  level: z.coerce.number().int().min(1).max(4).optional(),
};
const exclusive = (v: { asOf?: string; from?: string; to?: string; financialYear?: string }) =>
  !(v.financialYear && (v.asOf || v.from || v.to)) && !(v.asOf && (v.from || v.to));

export const reportSchemas = {
  report: z.object({ report: z.enum(REPORT_NAMES) }),
  query: z
    .object({
      ...params,
      includeZero: bool.optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(1000).default(100),
    })
    .strict()
    .refine(exclusive, 'Use either asOf, from and to, or financialYear'),
  exportBody: z
    .object({
      report: z.enum(REPORT_NAMES),
      params: z
        .object({ ...params, includeZero: z.boolean().optional() })
        .strict()
        .refine(exclusive, 'Use either asOf, from and to, or financialYear')
        .default({}),
      format: z.enum(['csv', 'xlsx', 'pdf']),
    })
    .strict(),
};

export const residentSchemas = {
  id: z.object({ id: idParam }),
};
