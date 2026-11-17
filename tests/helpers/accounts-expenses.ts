import { randomUUID } from 'node:crypto';
import { LedgerAccount, Society, sequelize } from '../../src/models';
import { setNow } from '../../src/lib/clock';
import { setRealtimeSink } from '../../src/lib/realtime';
import { ensureBooks } from '../../src/modules/accounts/accounts.chart';
import {
  accountsPortCalls,
  placeholderAccountsApprovalTypes,
  setAccountsPorts,
} from '../../src/modules/accounts/accounts.ports';
import { registerExpenseJobs } from '../../src/modules/accounts/accounts.expenses.jobs';
import { setBillFiles } from '../../src/modules/accounts/accounts.expenses.files';
import { moneyTx } from '../../src/modules/accounts/accounts.expenses.shared';
import { putPlaceholderFile } from '../../src/modules/society-setup/society-setup.ports';
import { events } from './auth';
import { addBankLedger, ctxOf, post } from './accounts';
import { memberOf, resetSetup, setupSociety } from './society-setup';

export const idemH = (): Record<string, string> => ({ 'Idempotency-Key': randomUUID() });

/** Fresh state for 13.2a tests: society reset, placeholder ports, the `EXPENSE` approval type registered. Call from `beforeEach`. */
export async function resetExpenses(): Promise<void> {
  await resetSetup();
  setAccountsPorts();
  setBillFiles();
  registerExpenseJobs();
  setNow('2026-11-01T04:30:00Z');
  events.length = 0;
  setRealtimeSink({
    emit: (e: Parameters<typeof events.push>[0]) => events.push(e),
    disconnectSession: () => undefined,
  } as never);
}

export interface ExpWorld {
  society: Society;
  sid: number;
  /** chairman (maker in most tests) */
  c: Awaited<ReturnType<typeof setupSociety>>['c'];
  user: Awaited<ReturnType<typeof setupSociety>>['user'];
  treasurer: Awaited<ReturnType<typeof memberOf>>;
  auditor: Awaited<ReturnType<typeof memberOf>>;
  id: Record<string, number>;
}

const CODES = [
  '1110-001',
  '1120',
  '1130',
  '1110',
  '2110',
  '2140',
  '2310',
  '4100',
  '5330',
  '5350',
  '2420',
  '4900',
  '1410',
];

/** A society with books, a bank ledger `1110-001` holding `bankPaise` and cash in hand holding `cashPaise` (opening balances). */
export async function expWorld(
  o: { plan?: string; bankPaise?: number; cashPaise?: number } = {},
): Promise<ExpWorld> {
  const s = await setupSociety({ plan: (o.plan ?? 'PREMIUM') as never });
  const sid = s.society.id!;
  await sequelize.transaction(t => ensureBooks(t, sid));
  await addBankLedger(sid);
  const sys = ctxOf(s.society, null);
  let ref = 0;
  for (const [code, amount] of [
    ['1110-001', o.bankPaise ?? 10_000_000],
    ['1120', o.cashPaise ?? 1_000_000],
  ] as const) {
    if (amount > 0)
      await post(sys, {
        date: '2026-10-01',
        voucherType: 'OPENING_BALANCE',
        refType: 'opening',
        refId: ++ref,
        narration: 'Opening balance',
        lines: [
          { ledgerAccountCode: code, debitPaise: amount, creditPaise: 0 },
          { ledgerAccountCode: 'OPENING_ADJUSTMENT', debitPaise: 0, creditPaise: amount },
        ],
      });
  }
  const rows = await LedgerAccount.findAll({ where: { societyId: sid, code: CODES } });
  return {
    society: s.society,
    sid,
    c: s.c,
    user: s.user,
    treasurer: await memberOf(s.society, 'treasurer'),
    auditor: await memberOf(s.society, 'auditor'),
    id: Object.fromEntries(rows.map(r => [r.code, Number(r.id)])),
  };
}

/** A cash expense body (Garden 5350, 1,800 INR) that module 14 auto-approves when the placeholder is replaced by `autoApprove()`. */
export const expBody = (w: ExpWorld, o: Record<string, unknown> = {}): Record<string, unknown> => ({
  expenseDate: '2026-10-30',
  payee: 'Shree Ganesh Gardeners',
  ledgerAccountId: w.id['5350'],
  grossAmountPaise: 180_000,
  paidFromLedgerAccountId: w.id['1120'],
  paymentMode: 'CASH',
  ...o,
});

/** NEFT from the bank with a reference. */
export const bankBody = (w: ExpWorld, o: Record<string, unknown> = {}) =>
  expBody(w, {
    paidFromLedgerAccountId: w.id['1110-001'],
    paymentMode: 'NEFT',
    paymentReference: 'UTR000123456',
    ...o,
  });

/** Module 14 with an `AUTO_APPROVE` rule: `approvals.request` runs `onApproved` in the caller's transaction and answers APPROVED. */
export function autoApprove(): void {
  let seq = 1000;
  setAccountsPorts({
    approvals: {
      request: async (ctx, input, t) => {
        accountsPortCalls.push({ fn: 'approvals.request', input, t });
        const id = ++seq;
        await placeholderAccountsApprovalTypes.get(input.type)!.onApproved(ctx, input.entityId, t);
        return { id, status: 'APPROVED' };
      },
    },
  });
}

export const bill = (w: ExpWorld, ownerUserId: number, purpose = 'EXPENSE_BILL'): number =>
  putPlaceholderFile({
    societyId: w.sid,
    ownerUserId,
    name: 'bill.jpg',
    purpose,
    content: Buffer.from('jpg'),
  });

export const decide = (
  w: ExpWorld,
  requestId: number,
  decision: 'approve' | 'reject' = 'approve',
  reason = 'No bill attached',
) =>
  w.treasurer.c('post', `/dev/approvals/${requestId}/${decision}`, decision === 'reject' ? { reason } : {}, {
    query: { source: 'accounts' },
  });

export { moneyTx };
