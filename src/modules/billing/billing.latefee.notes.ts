import { BillingNote, ChargeHead, type Invoice } from '../../models';
import type { Ctx } from '../../types/context';
import { ensureSeeded } from './billing.heads.service';
import { issueDebitNote } from './billing.notes.debit';
import type { Transaction } from './billing.types';

/**
 * The write step of the late fee job: one issued debit note with reason `INTEREST` or `LATE_FEE` (BR-11-55) through the shared
 * debit note core of sub-module 11.4 (`issueDebitNote`: lines, tax of `FOLLOW_SOURCE` heads, round-off, number, ledger entry,
 * journal, audit, realtime, notification). This file adds the idempotency check by `dedupeKey` and sets the job markers.
 */
export interface LateFeeNoteInput {
  societyId: number;
  /** The invoice, locked `FOR UPDATE` by the caller (after its unit row). */
  invoice: Invoice;
  reasonCode: 'INTEREST' | 'LATE_FEE';
  /** Interest or flat fee before round-off. */
  amountPaise: number;
  dedupeKey: string;
  interestFromDate: string | null;
  interestToDate: string | null;
  lateFeePolicyId: number | null;
  remarks: string;
}

async function systemHead(
  societyId: number,
  key: 'INTEREST' | 'LATE_FEE',
  t: Transaction,
): Promise<ChargeHead> {
  let head = await ChargeHead.findOne({ where: { societyId, key }, transaction: t });
  if (!head) {
    await ensureSeeded(societyId, t);
    head = await ChargeHead.findOne({ where: { societyId, key }, transaction: t });
  }
  if (!head) throw new Error(`system charge head ${key} is missing`);
  return head;
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
    const head = await systemHead(input.societyId, input.reasonCode, t);
    const note = await issueDebitNote(
      ctx,
      input.societyId,
      input.invoice,
      {
        reasonCode: input.reasonCode,
        remarks: input.remarks,
        lines: [
          {
            head,
            kind: input.reasonCode,
            description:
              input.reasonCode === 'INTEREST'
                ? `Interest on ${input.invoice.invoiceNo} (${input.interestFromDate} to ${input.interestToDate})`
                : `Late fee on ${input.invoice.invoiceNo}`,
            amountPaise: input.amountPaise,
          },
        ],
        dedupeKey: input.dedupeKey,
        interestFromDate: input.interestFromDate,
        interestToDate: input.interestToDate,
        lateFeePolicyId: input.lateFeePolicyId,
      },
      t,
    );
    return {
      created: true,
      noteId: Number(note.id),
      noteNo: note.noteNo ?? '',
      totalPaise: Number(note.totalPaise),
    };
  },
};
