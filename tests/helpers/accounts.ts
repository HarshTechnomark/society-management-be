import { QueryTypes } from 'sequelize';
import { Fund, LedgerAccount, Society, sequelize } from '../../src/models';
import { setBillingPorts } from '../../src/modules/billing/billing.ports';
import { setPaymentsPorts } from '../../src/modules/payments/payments.ports';
import { setAccountsPorts } from '../../src/modules/accounts/accounts.ports';
import { installRealJournal } from '../../src/modules/accounts/accounts.ports-wiring';
import { ensureBooks } from '../../src/modules/accounts/accounts.chart';
import { postJournal } from '../../src/modules/accounts/accounts.engine';
import type { PostJournalInput } from '../../src/modules/accounts/accounts.types';
import { systemCtx, type Ctx } from '../../src/types/context';
import { makeUser } from './auth';
import { lifecycleSociety, resetSocieties } from './societies';

/** Fresh state for module 13 tests: the global reset, placeholder ports of modules 11, 12 and 13. Call from `beforeEach`. */
export async function resetAccounts(): Promise<void> {
  await resetSocieties();
  setBillingPorts();
  setPaymentsPorts();
  setAccountsPorts();
}

/** Installs the real engine behind the module 11 and 12 journal ports (what `registerAccounts()` does at start-up). */
export const useRealJournal = installRealJournal;

export interface AccountsWorld {
  society: Society;
  sid: number;
  /** A signed-in member context (USER posting). */
  user: Ctx;
  userId: number;
  /** A second user, for maker-checker tests. */
  other: Ctx;
  /** No user: webhooks, jobs, seeders (SYSTEM posting). */
  sys: Ctx;
}

export const ctxOf = (society: Society, userId: number | null, permissions: string[] = []): Ctx => ({
  ...systemCtx('t'),
  ...(userId
    ? {
        user: {
          id: userId,
          name: 'Tester',
          mobile: null,
          email: null,
          platformRoleId: null,
          status: 'ACTIVE',
        },
        actorRoleKey: 'treasurer',
      }
    : {}),
  society: {
    id: society.id!,
    name: society.name,
    status: 'ACTIVE',
    timezone: 'Asia/Kolkata',
    planKey: 'PREMIUM',
  },
  permissions: new Set(permissions),
});

/** A society with seeded books and two users. */
export async function accountsSociety(name = 'Books CHS', seed = true): Promise<AccountsWorld> {
  const society = await lifecycleSociety('ACTIVE', { name });
  const a = await makeUser({});
  const b = await makeUser({});
  const sid = society.id!;
  if (seed) await sequelize.transaction(t => ensureBooks(t, sid));
  return {
    society,
    sid,
    user: ctxOf(society, a.id),
    userId: a.id,
    other: ctxOf(society, b.id),
    sys: ctxOf(society, null),
  };
}

export const fundIdByType = async (societyId: number, fundType: string): Promise<number> =>
  Number((await Fund.findOne({ where: { societyId, fundType } }))!.id);

export const balanceOf = async (societyId: number, code: string): Promise<number> =>
  Number((await LedgerAccount.findOne({ where: { societyId, code } }))!.balancePaise);

/** Posts in its own transaction. */
export const post = (ctx: Ctx, input: PostJournalInput) =>
  sequelize.transaction(t => postJournal(ctx, input, t));

/** A second, bank-type leaf under 1110 (13.2 creates these through the bank account service). */
export async function addBankLedger(
  societyId: number,
  code = '1110-001',
  name = 'Bank - Test',
): Promise<LedgerAccount> {
  const parent = (await LedgerAccount.findOne({ where: { societyId, code: '1110' } }))!;
  return LedgerAccount.create({
    societyId,
    code,
    name,
    accountType: 'ASSET',
    subtype: 'BANK',
    parentId: Number(parent.id),
    isSystem: true,
  } as never);
}

/** Registers a collection bank account row for `ledgerId` (the engine resolves the system key `BANK` through it). */
export async function addCollectionBank(societyId: number, ledgerId: number): Promise<number> {
  const at = new Date();
  const [res] = await sequelize.query(
    `INSERT INTO bank_accounts (societyId, ledgerAccountId, displayName, bankName, ifsc, accountHolderName, accountNumberEnc,
       accountNumberLast4, accountNumberHash, isCollectionAccount, createdAt, updatedAt)
     VALUES (?, ?, 'Test bank', 'Test Bank', 'HDFC0001234', 'Test CHS', 'enc', '4821', ?, 1, ?, ?)`,
    {
      replacements: [societyId, ledgerId, `h${ledgerId}${Date.now()}`.padEnd(64, '0'), at, at],
      type: QueryTypes.INSERT,
    },
  );
  return Number(res);
}
