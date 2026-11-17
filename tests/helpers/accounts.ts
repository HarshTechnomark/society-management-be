import { QueryTypes } from 'sequelize';
import { Fund, LedgerAccount, Society, sequelize } from '../../src/models';
import { setBillingPorts } from '../../src/modules/billing/billing.ports';
import { setPaymentsPorts } from '../../src/modules/payments/payments.ports';
import { setAccountsPorts } from '../../src/modules/accounts/accounts.ports';
import { installRealJournal } from '../../src/modules/accounts/accounts.ports-wiring';
import { ensureBooks } from '../../src/modules/accounts/accounts.chart';
import { accountNumberHash, encryptAccountNumber } from '../../src/modules/accounts/accounts.bank.crypto';
import { nextLedgerCode } from '../../src/modules/accounts/accounts.bank.shared';
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

/** A real fund with its `2440-NNN` / `2450-NNN` ledger (what `POST /accounts/funds` creates), for tests that need a fund id of module 12. */
export async function addFund(
  societyId: number,
  name = 'Test event fund',
  fundType: 'COLLECTION' | 'CUSTOM' = 'COLLECTION',
): Promise<number> {
  return sequelize.transaction(async t => {
    await ensureBooks(t, societyId);
    const groupCode = fundType === 'CUSTOM' ? '2450' : '2440';
    const group = (await LedgerAccount.findOne({ where: { societyId, code: groupCode }, transaction: t }))!;
    const code = await nextLedgerCode(societyId, groupCode, t);
    const ledger = await LedgerAccount.create(
      {
        societyId,
        code,
        name,
        accountType: 'FUND',
        subtype: 'FUND',
        parentId: Number(group.id),
        isSystem: true,
      } as never,
      { transaction: t },
    );
    const f = await Fund.create(
      { societyId, fundType, name, nameKey: name.toLowerCase(), ledgerAccountId: Number(ledger.id) } as never,
      { transaction: t },
    );
    return Number(f.id);
  });
}

/** A real, verified bank account with its `1110-NNN` ledger (collection account unless `collection: false`). Returns the bank account id. */
export async function addBankAccount(
  societyId: number,
  o: { collection?: boolean; number?: string; ifsc?: string; displayName?: string } = {},
): Promise<number> {
  const number = o.number ?? `5020${String(Date.now()).slice(-9)}${Math.floor(Math.random() * 90 + 10)}`;
  const ifsc = o.ifsc ?? 'HDFC0001234';
  const code = await sequelize.transaction(async t => {
    await ensureBooks(t, societyId);
    return nextLedgerCode(societyId, '1110', t);
  });
  const ledger = await addBankLedger(societyId, code, `Bank - ${o.displayName ?? 'Test'}`);
  const at = new Date();
  const [res] = await sequelize.query(
    `INSERT INTO bank_accounts (societyId, ledgerAccountId, displayName, bankName, ifsc, accountHolderName, accountNumberEnc,
       accountNumberLast4, accountNumberHash, isCollectionAccount, verificationStatus, verifiedAt, createdAt, updatedAt)
     VALUES (?, ?, ?, 'HDFC Bank', ?, 'Test CHS', ?, ?, ?, ?, 'VERIFIED', ?, ?, ?)`,
    {
      replacements: [
        societyId,
        Number(ledger.id),
        o.displayName ?? 'Test',
        ifsc,
        encryptAccountNumber(societyId, number),
        number.slice(-4),
        accountNumberHash(ifsc, number),
        o.collection === false ? 0 : 1,
        at,
        at,
        at,
      ],
      type: QueryTypes.INSERT,
    },
  );
  return Number(res);
}
