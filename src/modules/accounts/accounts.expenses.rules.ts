import { BankAccount, Fund, LedgerAccount } from '../../models';
import { featureAllowed, featureNotInPlan, getEntitlements } from '../subscriptions/entitlements.service';
import { payments } from '../payments/payments.public';
import { NotFoundError, PaymentRequiredError, UnprocessableError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { CODE, ENT, ERR, type ExpensePaymentMode, type ExpenseType } from './accounts.constants';
import { periodLocked } from './accounts.engine.core';
import { isDateLocked } from './accounts.engine.lock';
import { accountsPorts } from './accounts.ports';
import { addDaysYmd, n, societyToday } from './accounts.shared';
import { setting } from './accounts.expenses.shared';
import type { Transaction } from './accounts.types';

/** The columns BR-13-20 to 24 look at; a draft row, a PATCH merge and a posting all go through the same checks. */
export interface ExpenseValues {
  expenseType: ExpenseType;
  expenseDate: string;
  payee: string;
  ledgerAccountId: number;
  description: string | null;
  grossAmountPaise: number;
  gstPaise: number;
  tdsPaise: number;
  tdsSection: string | null;
  challanNo: string | null;
  paidFromLedgerAccountId: number;
  paymentMode: ExpensePaymentMode;
  paymentReference: string | null;
  fundId: number | null;
  collectionId: number | null;
  vendorId: number | null;
  vendorBillId: number | null;
}

export interface Resolved {
  values: ExpenseValues;
  head: LedgerAccount;
  paidFrom: LedgerAccount;
  fund: Fund | null;
  bankAccountId: number | null;
}

export interface ResolveOpts {
  /** Fields whose plan gate is checked (create: all, PATCH: the changed ones, posting: none). */
  gate: ((field: string) => boolean) | null;
  /** BR-13-20 date window and lock (the engine checks the lock again when posting). */
  checkDate: boolean;
}

const STATUTORY_CODES: readonly string[] = [
  CODE.outputCgst,
  CODE.outputSgst,
  CODE.outputIgst,
  CODE.tdsPayable,
];
const REF_MODES: readonly string[] = ['CHEQUE', 'NEFT', 'RTGS', 'IMPS'];
const bad = (field: string, message: string) => new ValidationError([{ field, message }]);
const head422 = (field: string, message: string) =>
  new UnprocessableError(ERR.invalidExpenseHead, message, [{ field, message }]);
const source422 = (field: string, message: string) =>
  new UnprocessableError(ERR.invalidPaymentSource, message, [{ field, message }]);

/** `402 FEATURE_NOT_IN_PLAN` with `errors[0].field` set to the request field that needs the plan feature. */
async function requireFeature(ctx: Ctx, key: (typeof ENT)[keyof typeof ENT], field: string): Promise<void> {
  const ent = await getEntitlements(ctx.society!.id);
  if (featureAllowed(ent, key)) return;
  const e = await featureNotInPlan(ent, key);
  throw new PaymentRequiredError('FEATURE_NOT_IN_PLAN', e.message, [
    { ...(e.errors?.[0] ?? { message: key }), field, entitlementKey: key },
  ]);
}

/** BR-13-20: the date window and the lock. */
export async function checkExpenseDate(societyId: number, date: string, t: Transaction): Promise<void> {
  const today = await societyToday(societyId);
  const days = Number(await setting(societyId, 'finance.expenseBackdateDays'));
  if (date > today || date < addDaysYmd(today, -days))
    throw new UnprocessableError(
      ERR.dateOutOfRange,
      'The date is in the future or older than the back-date window',
      [{ field: 'expenseDate', message: `Use a date from ${addDaysYmd(today, -days)} to ${today}` }],
    );
  if (await isDateLocked(societyId, date, t)) throw periodLocked(date);
}

/** BR-13-20 to BR-13-23 (and the references of BR-13-28): validates `v`, returns the normalised values and the rows it resolved. */
export async function resolveExpense(
  ctx: Ctx,
  v: ExpenseValues,
  t: Transaction,
  o: ResolveOpts,
): Promise<Resolved> {
  const societyId = ctx.society!.id;
  const gate = async (key: (typeof ENT)[keyof typeof ENT], field: string) => {
    if (o.gate?.(field)) await requireFeature(ctx, key, field);
  };
  const ent = await getEntitlements(societyId);
  const out: ExpenseValues = { ...v };

  // plan gates (8.6 field gates)
  if (out.expenseType !== 'DIRECT') await gate(ENT.expenses, 'expenseType');
  if (out.gstPaise > 0) await gate(ENT.expenses, 'gstPaise');
  if (out.tdsPaise > 0) await gate(ENT.tds, 'tdsPaise');
  if (out.vendorId) await gate(ENT.expenses, 'vendorId');
  if (out.vendorBillId) await gate(ENT.vendorPayments, 'vendorBillId');

  if (o.checkDate) await checkExpenseDate(societyId, out.expenseDate, t);

  // BR-13-21 head
  let head: LedgerAccount | null;
  if (out.expenseType === 'VENDOR_BILL') {
    head = await LedgerAccount.findOne({ where: { societyId, code: CODE.vendorPayable }, transaction: t });
    if (!head) throw new NotFoundError(ERR.ledgerAccountNotFound, 'Ledger account not found');
    out.ledgerAccountId = n(head.id);
  } else {
    head = await LedgerAccount.findOne({ where: { id: out.ledgerAccountId, societyId }, transaction: t });
    if (!head) throw new NotFoundError(ERR.ledgerAccountNotFound, 'Ledger account not found');
    if (out.expenseType === 'STATUTORY_DUE') {
      if (!STATUTORY_CODES.includes(head.code))
        throw head422('ledgerAccountId', 'A statutory due goes to 2310, 2320, 2330 or 2140');
    } else {
      if (head.isGroup || !head.isActive || head.accountType !== 'EXPENSE')
        throw head422('ledgerAccountId', 'Choose an active expense account');
      if (!featureAllowed(ent, ENT.expenses) && !head.isCashBookCategory)
        throw head422('ledgerAccountId', 'This account is not a cash book category on your plan');
    }
    if (!head.isActive) throw head422('ledgerAccountId', 'The account is not active');
  }
  const isTdsDeposit = out.expenseType === 'STATUTORY_DUE' && head.code === CODE.tdsPayable;

  // BR-13-23 amounts
  if (out.gstPaise >= out.grossAmountPaise) throw bad('gstPaise', 'GST must be below the amount');
  if (out.tdsPaise >= out.grossAmountPaise) throw bad('tdsPaise', 'TDS must be below the amount');
  if (out.expenseType !== 'DIRECT' && out.gstPaise !== 0)
    throw bad('gstPaise', 'GST is not allowed on this type');
  if (out.expenseType === 'STATUTORY_DUE') {
    if (out.tdsPaise !== 0) throw bad('tdsPaise', 'A statutory due carries no TDS');
    if (out.fundId || out.collectionId) throw head422('fundId', 'A statutory due is not paid from a fund');
  }
  if (out.tdsPaise > 0 && !out.tdsSection) throw bad('tdsSection', 'TDS section is required with TDS');
  if (isTdsDeposit && !out.tdsSection)
    throw head422('tdsSection', 'Say which TDS section is being deposited');
  if (out.challanNo && !isTdsDeposit)
    throw head422('challanNo', 'A challan number is only for a TDS deposit');
  if (out.expenseType === 'STATUTORY_DUE' && !isTdsDeposit && out.tdsSection)
    throw head422('tdsSection', 'GST dues carry no TDS section');
  if (!isTdsDeposit && out.tdsPaise === 0) out.tdsSection = null;

  // BR-13-22 paid-from and mode
  const paidFrom = await LedgerAccount.findOne({
    where: { id: out.paidFromLedgerAccountId, societyId },
    transaction: t,
  });
  if (!paidFrom) throw new NotFoundError(ERR.ledgerAccountNotFound, 'Ledger account not found');
  if (paidFrom.isGroup || !paidFrom.isActive || !['BANK', 'CASH', 'PETTY_CASH'].includes(paidFrom.subtype))
    throw source422('paidFromLedgerAccountId', 'Pay from an active bank, cash or petty cash account');
  if (paidFrom.subtype === 'PETTY_CASH') await gate(ENT.pettyCash, 'paidFromLedgerAccountId');
  const cashLike = paidFrom.subtype !== 'BANK';
  if (out.paymentMode === 'CASH' ? !cashLike : cashLike)
    throw source422(
      'paymentMode',
      cashLike ? 'Cash accounts are paid in cash' : 'Cash is paid from a cash account',
    );
  if (REF_MODES.includes(out.paymentMode) && !out.paymentReference)
    throw bad('paymentReference', 'A reference is required for this payment mode');
  let bankAccountId: number | null = null;
  if (paidFrom.subtype === 'BANK') {
    const b = await BankAccount.findOne({
      where: { societyId, ledgerAccountId: n(paidFrom.id) },
      attributes: ['id', 'status'],
      transaction: t,
    });
    if (b?.status === 'CLOSED') throw source422('paidFromLedgerAccountId', 'The bank account is closed');
    bankAccountId = b ? n(b.id) : null;
  }

  // fund and collection
  if (out.collectionId) {
    const c = await payments.collections.get(societyId, out.collectionId);
    if (!c) throw new NotFoundError('COLLECTION_NOT_FOUND', 'Collection not found');
    if (!['PUBLISHED', 'CLOSED'].includes(c.status))
      throw head422('collectionId', 'Only a published or closed collection can have expenses');
    if (out.fundId && out.fundId !== c.fundId)
      throw head422('fundId', 'The fund must be the fund of the collection');
    out.fundId = c.fundId;
  }
  let fund: Fund | null = null;
  if (out.fundId) {
    fund = await Fund.findOne({ where: { id: out.fundId, societyId }, transaction: t });
    if (!fund) throw new NotFoundError(ERR.fundNotFound, 'Fund not found');
    if (fund.status !== 'ACTIVE') throw new UnprocessableError(ERR.fundInactive, 'The fund is closed');
  }

  // module 21 vendor and bill
  if (out.vendorId && !(await accountsPorts().vendors.exists(societyId, out.vendorId)))
    throw new NotFoundError('VENDOR_NOT_FOUND', 'Vendor not found');
  if (out.expenseType === 'VENDOR_BILL') {
    if (!out.vendorBillId) throw bad('vendorBillId', 'A vendor bill expense needs the bill');
    const bill = await accountsPorts().vendors.getBill(societyId, out.vendorBillId);
    if (!bill) throw new NotFoundError('VENDOR_BILL_NOT_FOUND', 'Vendor bill not found');
    if (out.vendorId && bill.vendorId !== out.vendorId)
      throw bad('vendorBillId', 'The bill belongs to another vendor');
    out.vendorId = bill.vendorId;
    if (bill.payablePaise < out.grossAmountPaise)
      throw new UnprocessableError(
        ERR.vendorBillNotPayable,
        'The bill has less outstanding than this amount',
        [{ field: 'grossAmountPaise', message: 'Above the outstanding amount of the bill' }],
      );
  } else if (out.vendorBillId) {
    throw bad('vendorBillId', 'Only a vendor bill expense carries a bill');
  }

  return { values: out, head, paidFrom, fund, bankAccountId };
}

/** BR-13-24: bill photos above the threshold. */
export async function checkBillRequired(
  societyId: number,
  grossPaise: number,
  fileCount: number,
): Promise<void> {
  const limit = Number(await setting(societyId, 'finance.billRequiredAbovePaise'));
  if (grossPaise > limit && fileCount < 1)
    throw new UnprocessableError(ERR.billRequired, 'Attach a bill photo for this amount', [
      { field: 'fileIds', message: 'A bill photo is required above the limit' },
    ]);
}
