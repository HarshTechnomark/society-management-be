import { z } from 'zod';
import { MAX_LINE_PAISE } from './accounts.constants';
import { ymd } from './accounts.validation';

const amount = z.number().int().min(0).max(MAX_LINE_PAISE);

/** 8.12 body. A line with both or neither amount is refused by the engine (`422 JOURNAL_LINE_INVALID`), not here. */
export const openingSchemas = {
  post: z
    .object({
      asOfDate: ymd.refine(v => !Number.isNaN(Date.parse(v)), 'Not a date'),
      narration: z.string().trim().min(2).max(300).optional(),
      autoBalance: z.boolean().optional(),
      lines: z
        .array(
          z
            .object({
              ledgerAccountCode: z.string().trim().min(1).max(40),
              debitPaise: amount,
              creditPaise: amount,
              fundId: z.number().int().positive().optional(),
            })
            .strict(),
        )
        .min(1)
        .max(500),
    })
    .strict(),
};

export type OpeningInput = z.infer<typeof openingSchemas.post>;
