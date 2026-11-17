import { PaymentAllocation, CollectionRequest, Collection, type Payment } from '../../models';
import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';
import type { JournalInput, JournalLine } from '../billing/billing.ports';
import { ACCOUNT } from './payments.constants';
import type { Transaction } from './payments.types';
import { n } from './payments.shared';

/**
 * Journal postings of section 6.9, built from the payment's own columns. Symbolic account codes: module 13 resolves them.
 * Every journal balances (the port refuses an imbalance).
 */

/** Debit account of the receipt journal: where the money sat when it came in. */
export function receiptDebitAccount(p: Pick<Payment, 'source' | 'method' | 'status'>): string {
  if (p.source === 'ONLINE' || p.source === 'AUTOPAY') return ACCOUNT.gatewayClearing;
  if (p.method === 'CASH') return ACCOUNT.cashInHand;
  if (p.method === 'CHEQUE') return p.status === 'CLEARED' ? ACCOUNT.bank : ACCOUNT.chequesInClearing;
  return ACCOUNT.bank;
}

/** Money to optional collection requests, summed per fund (`COLLECTION_FUND` lines carry `fundId`). */
export async function collectionPartsByFund(
  paymentId: number,
  t: Transaction,
): Promise<Map<number | null, number>> {
  const rows = await sequelize.query<{ fundId: number | null; amountPaise: string }>(
    `SELECT c.fundId AS fundId, SUM(a.amountPaise) AS amountPaise
       FROM payment_allocations a
       JOIN collection_requests r ON r.id = a.collectionRequestId
       JOIN collections c ON c.id = r.collectionId
      WHERE a.paymentId = :paymentId AND a.targetType = 'COLLECTION_REQUEST'
      GROUP BY c.fundId`,
    { replacements: { paymentId }, type: QueryTypes.SELECT, transaction: t },
  );
  return new Map(rows.map(r => [r.fundId === null ? null : Number(r.fundId), Number(r.amountPaise)]));
}

/** Net credit side of a receipt (`MEMBER_RECEIVABLE`, `COLLECTION_FUND`, `MEMBER_ADVANCES`, `GATEWAY_FEE_RECOVERY`). */
export async function receiptCreditLines(p: Payment, t: Transaction): Promise<JournalLine[]> {
  const lines: JournalLine[] = [];
  const unitId = n(p.unitId);
  if (n(p.toInvoicesPaise) > 0)
    lines.push({
      accountCode: ACCOUNT.memberReceivable,
      debitPaise: 0,
      creditPaise: n(p.toInvoicesPaise),
      unitId,
    });
  const byFund = await collectionPartsByFund(n(p.id), t);
  for (const [fundId, amount] of byFund)
    if (amount > 0)
      lines.push({ accountCode: ACCOUNT.collectionFund, debitPaise: 0, creditPaise: amount, unitId, fundId });
  if (n(p.toAdvancePaise) > 0)
    lines.push({
      accountCode: ACCOUNT.memberAdvances,
      debitPaise: 0,
      creditPaise: n(p.toAdvancePaise),
      unitId,
    });
  const fee = n(p.convenienceFeePaise) + n(p.convenienceFeeGstPaise);
  if (fee > 0)
    lines.push({ accountCode: ACCOUNT.gatewayFeeRecovery, debitPaise: 0, creditPaise: fee, unitId });
  return lines;
}

const swap = (l: JournalLine): JournalLine => ({
  ...l,
  debitPaise: l.creditPaise,
  creditPaise: l.debitPaise,
});

/** Receipt journal (6.9 first rows): Dr money account gross, Cr the split. */
export async function captureJournal(p: Payment, unitLabel: string, t: Transaction): Promise<JournalInput> {
  const credits = await receiptCreditLines(p, t);
  const gross = credits.reduce((a, l) => a + l.creditPaise, 0);
  return {
    date: p.paymentDate,
    voucherType: 'RECEIPT',
    refType: 'payment',
    refId: n(p.id),
    narration: `Receipt ${p.receiptNo ?? ''} · ${unitLabel}`.trim(),
    lines: [
      { accountCode: receiptDebitAccount(p), debitPaise: gross, creditPaise: 0, unitId: n(p.unitId) },
      ...credits,
    ],
  };
}

/** Reversal, bounce and return: the mirror of the receipt journal as it stood (`credits` from before the allocations were undone). */
export function mirrorJournal(
  p: Payment,
  credits: JournalLine[],
  unitLabel: string,
  debitAccount: string,
  today: string,
): JournalInput {
  const gross = credits.reduce((a, l) => a + l.creditPaise, 0);
  return {
    date: today,
    voucherType: 'JOURNAL',
    // `payment_reversal`, not `payment`: module 13 keeps (refType, refId) unique among posted entries, and the receipt journal owns ('payment', id)
    refType: 'payment_reversal',
    refId: n(p.id),
    narration: `Reversal of receipt ${p.receiptNo ?? ''} · ${unitLabel}`.trim(),
    lines: [
      ...credits.map(swap),
      { accountCode: debitAccount, debitPaise: 0, creditPaise: gross, unitId: n(p.unitId) },
    ],
  };
}

/** Advance applied to an invoice: Dr `MEMBER_ADVANCES`, Cr `MEMBER_RECEIVABLE`. */
export function advanceAppliedJournal(
  societyUnit: { unitId: number; label: string },
  allocationId: number,
  amountPaise: number,
  date: string,
): JournalInput {
  return {
    date,
    voucherType: 'JOURNAL',
    refType: 'payment_allocation',
    refId: allocationId,
    narration: `Advance applied · ${societyUnit.label}`,
    lines: [
      {
        accountCode: ACCOUNT.memberAdvances,
        debitPaise: amountPaise,
        creditPaise: 0,
        unitId: societyUnit.unitId,
      },
      {
        accountCode: ACCOUNT.memberReceivable,
        debitPaise: 0,
        creditPaise: amountPaise,
        unitId: societyUnit.unitId,
      },
    ],
  };
}

/** Allocation released to advance (reallocation, invoice cancelled, refund freeing): Dr receivable or fund, Cr `MEMBER_ADVANCES`. */
export function releaseJournal(
  unit: { unitId: number; label: string },
  refId: number,
  date: string,
  receivablePaise: number,
  fundParts: Map<number | null, number>,
): JournalInput {
  const lines: JournalLine[] = [];
  if (receivablePaise > 0)
    lines.push({
      accountCode: ACCOUNT.memberReceivable,
      debitPaise: receivablePaise,
      creditPaise: 0,
      unitId: unit.unitId,
    });
  for (const [fundId, amount] of fundParts)
    if (amount > 0)
      lines.push({
        accountCode: ACCOUNT.collectionFund,
        debitPaise: amount,
        creditPaise: 0,
        unitId: unit.unitId,
        fundId,
      });
  const total = lines.reduce((a, l) => a + l.debitPaise, 0);
  lines.push({ accountCode: ACCOUNT.memberAdvances, debitPaise: 0, creditPaise: total, unitId: unit.unitId });
  return {
    date,
    voucherType: 'JOURNAL',
    refType: 'payment_allocation',
    refId,
    narration: `Allocation released to advance · ${unit.label}`,
    lines,
  };
}

// keep imports used for typing in consumers
export type { PaymentAllocation, CollectionRequest, Collection };
