import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { Payment } from '../../src/models';
import { putPlaceholderFile } from '../../src/modules/society-setup/society-setup.ports';
import { placeholderPaymentApprovals } from '../../src/modules/payments/payments.ports';
import type { RunSociety } from './billing-runs';

export const idemH = (): Record<string, string> => ({ 'Idempotency-Key': randomUUID() });

let seq = 0;
export const utr = (): string =>
  `UTR${String(Date.now() % 1e6).padStart(6, '0')}${String(++seq).padStart(6, '0')}`;
export const chequeNo = (): string => String(100_000 + ((++seq * 7919) % 899_999));

/** POST /payments/offline as the chairman. */
export function recordOffline(w: RunSociety, unitIndex: number, body: Record<string, unknown> = {}) {
  const method = (body.method as string | undefined) ?? 'CASH';
  const base: Record<string, unknown> = {
    unitId: w.units[unitIndex]!.id,
    payingFor: 'DUES',
    method,
    amountPaise: 100_000,
    paymentDate: '2026-11-04',
    ...(method === 'NEFT' || method === 'IMPS' || method === 'RTGS' ? { referenceNo: utr() } : {}),
    ...(method === 'UPI_TO_BANK' ? { referenceNo: String(100_000_000_000 + ++seq) } : {}),
    ...(method === 'CHEQUE'
      ? { cheque: { bankName: 'HDFC Bank', chequeNo: chequeNo(), chequeDate: '2026-11-04' } }
      : {}),
  };
  return w.c('post', '/payments/offline', { ...base, ...body }, { headers: idemH() });
}

/** The treasurer approves (or rejects) the placeholder approval request of a payment through the development page. */
export const decide = (
  w: RunSociety,
  requestId: number,
  decision: 'approve' | 'reject' = 'approve',
  reason = 'No match in the bank statement',
) =>
  w.treasurer.c('post', `/dev/approvals/${requestId}/${decision}`, decision === 'reject' ? { reason } : {}, {
    query: { source: 'payments' },
  });

export async function recordAndApprove(w: RunSociety, unitIndex: number, body: Record<string, unknown> = {}) {
  const r = await recordOffline(w, unitIndex, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const d = await decide(w, r.body.data.approval.requestId);
  expect(d.status, JSON.stringify(d.body)).toBe(200);
  return (await Payment.findByPk(r.body.data.id))!;
}

export const proofFile = (societyId: number, ownerUserId: number, purpose = 'PAYMENT_PROOF'): number =>
  putPlaceholderFile({ societyId, ownerUserId, name: 'proof.png', purpose, content: Buffer.from('png') });

export const pendingRequests = () =>
  [...placeholderPaymentApprovals.values()].filter(r => r.status === 'PENDING');
