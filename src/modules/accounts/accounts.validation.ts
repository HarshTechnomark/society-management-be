import { z } from 'zod';
import { MAX_LINE_PAISE } from './accounts.constants';
import { CODE_RE } from './accounts.lookup';

/** Zod pieces every part reuses (route validation schemas are written by the parts). */
export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const paise = z.number().int().min(0).max(MAX_LINE_PAISE);
export const positivePaise = z.number().int().min(1).max(MAX_LINE_PAISE);
export const idParam = z.coerce.number().int().positive();
export const ledgerCode = z.string().regex(CODE_RE, 'Use a 4 digit code such as 5330 or 1110-001');
export const financialYear = z.string().regex(/^\d{4}-\d{2}$/, 'Use YYYY-YY');
export const reason = z.string().trim().min(5).max(500);
export const page = z.coerce.number().int().min(1).default(1);
export const limit = z.coerce.number().int().min(1).max(100).default(20);
/** Section 8.20 line input (a manual journal line carries a code, never a system key). */
export const journalLineInput = z
  .object({
    ledgerAccountCode: z.string().min(1).max(40),
    debitPaise: paise,
    creditPaise: paise,
    fundId: z.number().int().positive().optional(),
    lineNarration: z.string().max(200).optional(),
  })
  .refine(l => l.debitPaise > 0 !== l.creditPaise > 0, 'Exactly one of debit and credit is above zero');
