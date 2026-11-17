import { z } from 'zod';
import { idParam, limit, page, reason, ymd } from './accounts.validation';
import { SETTLEMENT_STATUSES } from './accounts.constants';
import { MAX_SETTLEMENT_ITEMS } from './accounts.settlements.service';

const paise = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const item = z
  .object({
    type: z.enum(['payment', 'refund']),
    gatewayPaymentId: z.string().trim().min(1).max(64),
    gatewayRefundId: z.string().trim().min(1).max(64).optional(),
    amountPaise: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
    feePaise: paise.default(0),
    taxPaise: paise.default(0),
  })
  .strict();

const settlement = z
  .object({
    gatewaySettlementId: z.string().trim().min(1).max(60),
    settlementDate: ymd,
    utr: z.string().trim().min(1).max(30).optional(),
    netPaise: z.number().int().max(Number.MAX_SAFE_INTEGER),
    feePaise: paise.optional(),
    feeGstPaise: paise.optional(),
    adjustmentPaise: z.number().int().optional(),
    items: z.array(item).min(1).max(MAX_SETTLEMENT_ITEMS),
  })
  .strict();

export const settlementSchemas = {
  idParam: z.object({ id: idParam }).strict(),
  list: z
    .object({
      status: z.enum(SETTLEMENT_STATUSES).optional(),
      from: ymd.optional(),
      to: ymd.optional(),
      q: z.string().trim().min(1).max(60).optional(),
      page,
      limit,
    })
    .strict(),
  /** `fileId` (CSV or XLSX report) or, for development and the module 29 fetch, the settlements as JSON. */
  import: z
    .object({
      gatewayProvider: z.string().trim().min(2).max(30),
      fileId: z.number().int().positive().optional(),
      settlements: z.array(settlement).min(1).max(50).optional(),
    })
    .strict()
    .refine(b => (b.fileId === undefined) !== (b.settlements === undefined), {
      message: 'Send either fileId or settlements',
      path: ['fileId'],
    }),
  accept: z.object({ reason, version: z.number().int().min(1) }).strict(),
};
