/**
 * The module 13 functions other modules may import (section 8.20, 8.21) and the start-up hook `registerAccounts()`. Other modules
 * reach the books only through this file. The journal engine, the lookups and the balance reader are real; functions marked "part"
 * throw `501 NOT_IMPLEMENTED_IN_FOUNDATION` until their part fills the body (see README).
 */
import { registerQueue } from '../../lib/queue';
import {
  registerExportProvider,
  registerPurgeHandler,
  registerRetentionExpiryHandler,
} from '../societies/societies.public';
import { ACCOUNTS_QUEUE } from './accounts.constants';
import { backfillBooks, ensureBooks } from './accounts.chart';
import { isDateLocked, postDraft, postJournal, reverseByRef, reverseEntry } from './accounts.engine';
import { accountsExportProvider } from './accounts.exports';
import { registerAccountsJobs } from './accounts.jobs';
import {
  bankLedgerCode,
  collectionBank,
  getBankAccount,
  getFund,
  ledgerAccountExists,
  readSocietyBalance,
} from './accounts.lookup';
import { assertAccountsPortsReady } from './accounts.ports';
import { listForCollection as listExpensesForCollection } from './accounts.expenses.read';
import { installRealJournal } from './accounts.ports-wiring';
import { PURGE_TABLES, deleteRetainedAccounts, purgeAccounts } from './accounts.purge';
import { notImplemented } from './accounts.shared';
import type { DepositKind } from './accounts.constants';
import type { Ctx, FundDto, Transaction } from './accounts.types';

export { accountReports, cashBook, expenseReports, ReadTimeoutError } from './accounts.readers';
export { setAccountsPorts } from './accounts.ports';
export type { AccountsPorts } from './accounts.ports';
export type {
  SocietyBalanceDto,
  PostJournalInput,
  PostJournalResult,
  JournalLineInput,
} from './accounts.types';

/** 8.20 `journal`: `post` and `reverse` are the interface of modules 11, 12, 18, 21, 23; `postDraft` and `reverseEntry` are for 13.1. */
export const journal = {
  post: postJournal,
  reverse: reverseByRef,
  postDraft,
  reverseEntry,
};

export const accounts = {
  ensureBooks,
  isDateLocked,
  bankLedgerCode,
  collectionBankAccount: collectionBank,
};

export const balance = {
  get: readSocietyBalance,
  /** 13.1 */
  history: async (): Promise<never> => {
    throw notImplemented('balance.history');
  },
};

export const ledgerAccounts = { exists: ledgerAccountExists };

export const funds = {
  get: (societyId: number, fundId: number): Promise<FundDto | null> => getFund(societyId, fundId),
};

export const bankAccounts = { get: getBankAccount };

export const expenses = {
  /** 13.2: POSTED expenses with that `collectionId`; title = payee, category = transparencyCategory or head name; no bills, no payee contact. */
  listForCollection: listExpensesForCollection,
};

export interface DepositOwnerHooks {
  onDepositPaid(
    ctx: Ctx,
    input: { refType: string; refId: number; depositId: number },
    t: Transaction,
  ): Promise<void>;
  onDepositRefunded(
    ctx: Ctx,
    input: { refType: string; refId: number; depositId: number; refundedPaise: number },
    t: Transaction,
  ): Promise<void>;
}
export const deposits = {
  /** 13.4 */
  request: async (
    _ctx: Ctx,
    _input: {
      unitId: number;
      kind: DepositKind;
      refType: string;
      refId: number;
      amountPaise: number;
      payerResidentId?: number;
      title?: string;
      dueDate?: string;
    },
    _t: Transaction,
  ): Promise<{ depositId: number; invoiceId: number; paymentOrderId: number }> => {
    throw notImplemented('deposits.request');
  },
  /** 13.4 */
  requestRefund: async (
    _ctx: Ctx,
    _depositId: number,
    _input: { deductionPaise: number; reason: string },
    _t: Transaction,
  ): Promise<void> => {
    throw notImplemented('deposits.requestRefund');
  },
  /** 13.4: one owner per refType; a duplicate registration throws at boot. */
  registerOwner: (_refType: string, _hooks: DepositOwnerHooks): void => {
    throw notImplemented('deposits.registerOwner');
  },
};

export const settlements = {
  /** 13.3 (section 8.15). */
  ingest: async (..._args: unknown[]): Promise<never> => {
    throw notImplemented('settlements.ingest');
  },
};

export { backfillBooks };

/**
 * Start-up hook (call after `registerSocieties()`, `registerSocietySetup()`, `registerResidents()` and BEFORE `registerBilling()`, so the
 * module 11 start-up guard sees the real journal; done in `server.ts`, `worker.ts` and `npm run seed`): the production check of the
 * placeholder ports, module 05 export provider and purge handlers, the `accounts` queue and its jobs, and the real journal behind the
 * module 11 and 12 ports. Parts add their approval types and jobs through `registerAccountsJobs()`.
 */
export function registerAccounts(): void {
  assertAccountsPortsReady();
  registerExportProvider(accountsExportProvider);
  registerPurgeHandler({ module: 'accounts', order: 130, tables: PURGE_TABLES, purge: purgeAccounts });
  registerRetentionExpiryHandler({ module: 'accounts', order: 130, deleteRetained: deleteRetainedAccounts });
  registerQueue(
    ACCOUNTS_QUEUE,
    'Accounts: balance verification, settlements, statements, deposits, periods, exports',
    5,
  );
  registerAccountsJobs();
  installRealJournal();
}
