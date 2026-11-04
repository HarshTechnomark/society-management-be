import { BillingNote } from '../../models';
import type { Ctx } from '../../types/context';
import type { Transaction } from './billing.types';

/**
 * The write step of the late fee job: one issued debit note with reason `INTEREST` or `LATE_FEE` (BR-11-55). The note service of
 * sub-module 11.4 builds the lines, tax (`FOLLOW_SOURCE` heads), round-off, number, ledger entry and journal; this file only
 * adds the idempotency check by `dedupeKey` and lets tests inject a fake.
 */
export interface LateFeeNoteInput {
  societyId: number;
  invoiceId: number;
  reasonCode: 'INTEREST' | 'LATE_FEE';
  /** Interest or flat fee before round-off. */
  amountPaise: number;
  dedupeKey: string;
  interestFromDate: string | null;
  interestToDate: string | null;
  lateFeePolicyId: number | null;
  remarks: string;
}
export type LateFeeNoteIssuer = (
  ctx: Ctx,
  input: LateFeeNoteInput,
  t: Transaction,
) => Promise<{ noteId: number; noteNo: string; totalPaise: number }>;

let issuer: LateFeeNoteIssuer = async () => {
  throw new Error('not implemented: debit note issue for the late fee job');
};
/** Replaces the issuer (the real note service at start-up, a fake in tests); returns the previous one. */
export function setLateFeeNoteIssuer(next: LateFeeNoteIssuer): LateFeeNoteIssuer {
  const prev = issuer;
  issuer = next;
  return prev;
}

export const debitNotes = {
  /** `created: false` when a note with this `dedupeKey` already exists (the repeat run of a job). */
  async issueForLateFee(
    ctx: Ctx,
    input: LateFeeNoteInput,
    t: Transaction,
  ): Promise<{ created: boolean; noteId: number; noteNo: string; totalPaise: number }> {
    const existing = await BillingNote.findOne({
      where: { dedupeKey: input.dedupeKey, societyId: input.societyId },
      transaction: t,
    });
    if (existing)
      return {
        created: false,
        noteId: Number(existing.id),
        noteNo: existing.noteNo ?? '',
        totalPaise: Number(existing.totalPaise),
      };
    return { created: true, ...(await issuer(ctx, input, t)) };
  },
};
