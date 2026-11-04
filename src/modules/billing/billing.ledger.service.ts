import type { Ctx, LedgerPostInput, SystemCtx, Transaction } from './billing.types';

/**
 * `unitLedger.*` of section 8.24 (BR-11-57 to BR-11-59). PLACEHOLDER bodies: sub-module 11.2 replaces them in this file
 * (keep the exported names and signatures; `billing.public.ts` re-exports `unitLedger` unchanged).
 */
const notImplemented = (fn: string): never => {
  throw new Error(`not implemented: ${fn}`);
};

export const unitLedger = {
  /** Appends one ledger entry inside the caller's transaction; exactly one of debit or credit is > 0. No audit. */
  post: async (_ctx: Ctx | SystemCtx, _e: LedgerPostInput, _t: Transaction): Promise<{ id: number }> =>
    notImplemented('unitLedger.post'),
  /** Paise: positive = dues, negative = advance (Σ outstanding of the flat's invoices − module 12 advance balance). */
  balance: async (_societyId: number, _unitId: number): Promise<number> =>
    notImplemented('unitLedger.balance'),
};
