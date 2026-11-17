import { AsyncLocalStorage } from 'node:async_hooks';
import { Fund, JournalEntry } from '../../models';
import { audit } from '../../utils/audit';
import { ConflictError, NotFoundError, UnprocessableError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { moneyTx } from '../payments/payments.shared';
import { ensureBooks } from './accounts.chart';
import { isDateLocked, postJournal } from './accounts.engine';
import { APPROVAL_TYPES, AUDIT, CODE, ENTITY, ERR } from './accounts.constants';
import { accountsPorts, placeholderAccountsApprovals } from './accounts.ports';
import type { ApprovalTypeHooks } from './accounts.ports';
import { fundLedger } from './accounts.lookup';
import { n, societyIdOf, societyToday } from './accounts.shared';
import { fundNotFound } from './accounts.bank.shared';
import type { FundTransferInput } from './accounts.funds.validation';
import type { Transaction } from './accounts.types';

/**
 * Fund transfer (BR-13-33, section 8.13): `POST /accounts/fund-transfers` makes a module 14 `FUND_TRANSFER` request; on approval the
 * handler posts a `JOURNAL` voucher (Dr source ledger, Cr target ledger; `null` = General, ledger 3100) with `refType 'fund_transfer'`
 * and `refId` = the approval request id. The `FUND_TRANSFER` callbacks get only the entity id (the fund the request names), so the
 * request id and payload come from the deciding code through `withApprovalRequest` (dev hook) and, in the placeholder, from
 * `placeholderAccountsApprovals`. ASSUMPTION: module 14 will pass its request (id and payload) to the callback instead.
 */
export interface FundTransferPayload {
  fromFundId: number | null;
  toFundId: number | null;
  date: string;
  reason: string;
}

const current = new AsyncLocalStorage<number>();
/** Runs `fn` with the id of the approval request being decided (used by the development hook and, later, module 14's adapter). */
export const withApprovalRequest = <T>(requestId: number, fn: () => Promise<T>): Promise<T> =>
  current.run(requestId, fn);

const notFound = () => new NotFoundError(ERR.fundNotFound, 'Fund not found');

async function checkSide(societyId: number, fundId: number | null, t?: Transaction) {
  if (fundId === null) return null;
  const r = await fundLedger(societyId, fundId, t);
  if (!r) throw notFound();
  if (r.fund.status !== 'ACTIVE')
    throw new UnprocessableError(ERR.fundInactive, `Fund ${r.fund.name} is closed`, [
      { field: 'fundId', message: 'Fund is closed' },
    ]);
  return r;
}

const codeOf = (side: Awaited<ReturnType<typeof checkSide>>): string =>
  side ? side.ledger.code : CODE.surplus;

/** Request side: validates, then asks module 14. Returns the request id and status, plus the voucher when module 14 auto-approved. */
export async function requestFundTransfer(
  ctx: Ctx,
  input: FundTransferInput,
): Promise<{ approvalRequestId: number; status: 'PENDING' | 'APPROVED'; voucherNo: string | null }> {
  const societyId = societyIdOf(ctx);
  if (input.fromFundId === input.toFundId)
    throw new UnprocessableError(ERR.fundTransferSameFund, 'Choose two different funds');
  if (input.date > (await societyToday(societyId)))
    throw new ValidationError([{ field: 'date', message: 'The date cannot be in the future' }]);
  return moneyTx(async t => {
    await ensureBooks(t, societyId);
    const from = await checkSide(societyId, input.fromFundId, t);
    const to = await checkSide(societyId, input.toFundId, t);
    if (await isDateLocked(societyId, input.date, t))
      throw new ConflictError(ERR.periodLocked, 'The books are locked for this date');
    if (from && 0 - n(from.ledger.balancePaise) < input.amountPaise)
      throw new UnprocessableError(ERR.fundBalanceInsufficient, 'The source fund does not hold that much', [
        { field: 'amountPaise', message: 'Exceeds the source fund balance' },
      ]);
    const fromName = from?.fund.name ?? 'General';
    const toName = to?.fund.name ?? 'General';
    const entityId = (input.toFundId ?? input.fromFundId)!;
    const payload: FundTransferPayload = {
      fromFundId: input.fromFundId,
      toFundId: input.toFundId,
      date: input.date,
      reason: input.reason,
    };
    const r = await accountsPorts().approvals.request(
      ctx,
      {
        type: APPROVAL_TYPES.fundTransfer,
        entityType: ENTITY.fund,
        entityId,
        title: `Transfer from ${fromName} to ${toName}`,
        amountPaise: input.amountPaise,
        summary: input.reason,
        payload: { ...payload, amountPaise: input.amountPaise },
      },
      t,
    );
    await audit(
      ctx,
      {
        action: AUDIT.fundTransferRequested,
        entityType: 'fund',
        entityId,
        entityLabel: `${fromName} to ${toName}`,
        societyId,
        after: { ...payload, amountPaise: input.amountPaise, approvalRequestId: r.id },
      },
      t,
    );
    let voucherNo: string | null = null;
    if (r.status === 'APPROVED') {
      const e = await JournalEntry.findOne({
        where: { societyId, refType: 'fund_transfer', refId: String(r.id), status: 'POSTED' },
        transaction: t,
      });
      voucherNo = e?.voucherNo ?? null;
    }
    return { approvalRequestId: r.id, status: r.status, voucherNo };
  });
}

/** Approval side: re-checks and posts inside the approver's transaction `t`. */
export async function postFundTransfer(
  ctx: Ctx,
  requestId: number,
  p: FundTransferPayload & { amountPaise: number },
  t: Transaction,
): Promise<{ entryId: number; voucherNo: string }> {
  const societyId = societyIdOf(ctx);
  await ensureBooks(t, societyId);
  const from = await checkSide(societyId, p.fromFundId, t);
  const to = await checkSide(societyId, p.toFundId, t);
  const r = await postJournal(
    ctx,
    {
      date: p.date,
      voucherType: 'JOURNAL',
      refType: 'fund_transfer',
      refId: requestId,
      narration: `Fund transfer: ${p.reason}`.slice(0, 500),
      lines: [
        { ledgerAccountCode: codeOf(from), debitPaise: p.amountPaise, creditPaise: 0 },
        { ledgerAccountCode: codeOf(to), debitPaise: 0, creditPaise: p.amountPaise },
      ],
      enforceFundBalance: true,
      label: `Fund transfer to ${to?.fund.name ?? 'General'}`.slice(0, 160),
    },
    t,
  );
  await audit(
    ctx,
    {
      action: AUDIT.fundTransferPosted,
      entityType: 'fund',
      entityId: n((p.toFundId ?? p.fromFundId)!),
      societyId,
      after: { ...p, approvalRequestId: requestId, journalEntryId: r.id, voucherNo: r.voucherNo },
    },
    t,
  );
  return { entryId: r.id, voucherNo: r.voucherNo };
}

function requestOf(entityId: number) {
  const id = current.getStore();
  const req = id ? placeholderAccountsApprovals.get(id) : undefined;
  if (!id || !req || !req.payload || req.entityId !== entityId)
    throw new ConflictError(ERR.invalidState, 'The fund transfer request could not be found');
  return { id, payload: req.payload as unknown as FundTransferPayload & { amountPaise: number } };
}

/** The `FUND_TRANSFER` type definition registered with module 14 (`registerFundJobs`). */
export const fundTransferHooks: ApprovalTypeHooks = {
  type: APPROVAL_TYPES.fundTransfer,
  async onApproved(ctx, entityId, t) {
    const { id, payload } = requestOf(entityId);
    await postFundTransfer(ctx, id, payload, t);
  },
  async onRejected() {
    // nothing was posted; module 14 tells the requester
  },
  async describe(entityId) {
    const f = await Fund.findByPk(entityId, { attributes: ['name'] });
    return [{ label: 'Fund', value: f?.name ?? `#${entityId}` }];
  },
};

export { fundNotFound };
