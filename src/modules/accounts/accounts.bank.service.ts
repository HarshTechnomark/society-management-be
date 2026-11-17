import { Op, QueryTypes, type Transaction, type WhereOptions } from 'sequelize';
import { BankAccount, LedgerAccount, sequelize } from '../../models';
import { assertFeature } from '../subscriptions/entitlements.service';
import { audit } from '../../utils/audit';
import { ConflictError, UnprocessableError, ValidationError } from '../../utils/errors';
import type { Ctx } from '../../types/context';
import { moneyTx } from '../payments/payments.shared';
import { ensureBooks } from './accounts.chart';
import { postJournal } from './accounts.engine';
import { AUDIT, CODE, ENT, ERR, RT, NOTIFY, roomFinance } from './accounts.constants';
import { emitToRoom } from '../../lib/realtime';
import { accountsPorts } from './accounts.ports';
import { n, societyIdOf, societyToday, invalidState } from './accounts.shared';
import {
  accountNumberHash,
  decryptAccountNumber,
  encryptAccountNumber,
  last4,
  maskNumber,
} from './accounts.bank.crypto';
import {
  bankNotFound,
  committeeUserIds,
  groupLedger,
  nextLedgerCode,
  staleVersion,
} from './accounts.bank.shared';
import type { BankCreateInput, BankListQuery, BankPatchInput } from './accounts.bank.validation';

/** 13.2 bank accounts (sections 5.5, 6.6 and 8.14). Money only through the engine; the number never leaves this file unmasked except `reveal`. */
export const MAX_BANK_ACCOUNTS = 10;

export interface BankAccountDto {
  id: number;
  displayName: string;
  bankName: string;
  branchName: string | null;
  ifsc: string;
  accountKind: string;
  accountHolderName: string;
  maskedNumber: string;
  isCollectionAccount: boolean;
  statementFormat: string;
  openingBalancePaise: number;
  openingBalanceDate: string | null;
  verificationStatus: string;
  verifiedBy: number | null;
  verifiedAt: string | null;
  lastReconciledDate: string | null;
  lastReconciledBalancePaise: number | null;
  status: string;
  ledgerCode: string;
  balancePaise: number;
  createdBy: number | null;
  version: number;
  createdAt: string;
}

function toDto(b: BankAccount, ledger: Pick<LedgerAccount, 'code' | 'balancePaise'>): BankAccountDto {
  return {
    id: n(b.id),
    displayName: b.displayName,
    bankName: b.bankName,
    branchName: b.branchName,
    ifsc: b.ifsc,
    accountKind: b.accountKind,
    accountHolderName: b.accountHolderName,
    maskedNumber: maskNumber(b.accountNumberLast4),
    isCollectionAccount: Boolean(b.isCollectionAccount),
    statementFormat: b.statementFormat,
    openingBalancePaise: n(b.openingBalancePaise),
    openingBalanceDate: b.openingBalanceDate,
    verificationStatus: b.verificationStatus,
    verifiedBy: b.verifiedBy ? n(b.verifiedBy) : null,
    verifiedAt: b.verifiedAt ? b.verifiedAt.toISOString() : null,
    lastReconciledDate: b.lastReconciledDate,
    lastReconciledBalancePaise:
      b.lastReconciledBalancePaise === null ? null : n(b.lastReconciledBalancePaise),
    status: b.status,
    ledgerCode: ledger.code,
    balancePaise: n(ledger.balancePaise),
    createdBy: b.createdBy ? n(b.createdBy) : null,
    version: n(b.version),
    createdAt: b.createdAt.toISOString(),
  };
}

const auditShape = (b: BankAccount) => ({
  id: n(b.id),
  displayName: b.displayName,
  bankName: b.bankName,
  branchName: b.branchName,
  ifsc: b.ifsc,
  accountKind: b.accountKind,
  accountHolderName: b.accountHolderName,
  maskedNumber: maskNumber(b.accountNumberLast4),
  isCollectionAccount: Boolean(b.isCollectionAccount),
  statementFormat: b.statementFormat,
  verificationStatus: b.verificationStatus,
  status: b.status,
});

async function dtoOf(b: BankAccount, t?: Transaction): Promise<BankAccountDto> {
  const l = await LedgerAccount.findByPk(b.ledgerAccountId, { transaction: t });
  return toDto(b, l ?? { code: '', balancePaise: 0 });
}

const afterCommitFinance = (t: Transaction, societyId: number, id: number) =>
  t.afterCommit(() =>
    emitToRoom(roomFinance(societyId), RT.balanceUpdated, { societyId, bankAccountId: id }),
  );

function notifyCommittee(t: Transaction, ctx: Ctx, societyId: number, b: BankAccount, change: string) {
  t.afterCommit(async () => {
    const ids = (await committeeUserIds(societyId)).filter(id => id !== ctx.user?.id);
    if (ids.length)
      await accountsPorts().notifications.send(NOTIFY.bankAccountChanged, ids, {
        societyId,
        bankAccountId: n(b.id),
        displayName: b.displayName,
        maskedNumber: maskNumber(b.accountNumberLast4),
        change,
      });
  });
}

async function loadLocked(societyId: number, id: number, t: Transaction): Promise<BankAccount> {
  const b = await BankAccount.findOne({
    where: { id, societyId },
    transaction: t,
    lock: t.LOCK.UPDATE,
  });
  if (!b) throw bankNotFound();
  return b;
}

const duplicate = () =>
  new ConflictError(ERR.duplicateBankAccount, 'This account number is already added for this society');

async function assertDateNotFuture(ctx: Ctx, date: string, field: string): Promise<void> {
  if (date > (await societyToday(societyIdOf(ctx))))
    throw new ValidationError([{ field, message: 'The date cannot be in the future' }]);
}

// ------------------------------------------------------------------ reads
export async function listBankAccounts(societyId: number, q: BankListQuery): Promise<BankAccountDto[]> {
  const where: WhereOptions = { societyId };
  const w = where as Record<string, unknown>;
  if (q.status !== 'ALL') w.status = q.status;
  if (q.isCollectionAccount !== undefined) w.isCollectionAccount = q.isCollectionAccount;
  if (q.verificationStatus) w.verificationStatus = q.verificationStatus;
  const rows = await BankAccount.findAll({ where, order: [['id', 'ASC']] });
  if (!rows.length) return [];
  const ledgers = await LedgerAccount.findAll({
    where: { id: { [Op.in]: rows.map(r => n(r.ledgerAccountId)) } },
    attributes: ['id', 'code', 'balancePaise'],
  });
  const byId = new Map(ledgers.map(l => [n(l.id), l]));
  return rows.map(b => toDto(b, byId.get(n(b.ledgerAccountId)) ?? { code: '', balancePaise: 0 }));
}

export async function getBankAccountDto(societyId: number, id: number): Promise<BankAccountDto> {
  const b = await BankAccount.findOne({ where: { id, societyId } });
  if (!b) throw bankNotFound();
  return dtoOf(b);
}

// ------------------------------------------------------------------ create (BR-13-36, BR-13-37)
export async function createBankAccount(ctx: Ctx, input: BankCreateInput): Promise<BankAccountDto> {
  const societyId = societyIdOf(ctx);
  const opening = input.openingBalancePaise ?? 0;
  if (opening !== 0 && input.openingBalanceDate)
    await assertDateNotFuture(ctx, input.openingBalanceDate, 'openingBalanceDate');
  return moneyTx(async t => {
    await ensureBooks(t, societyId); // locks society_balances: lock order step 2
    const [active] = await sequelize.query<{ c: string }>(
      `SELECT COUNT(*) AS c FROM bank_accounts WHERE societyId = :societyId AND status = 'ACTIVE'`,
      { replacements: { societyId }, type: QueryTypes.SELECT, transaction: t },
    );
    const count = n(active?.c);
    if (count >= 1) await assertFeature(ctx, ENT.bankAndCashAccounts);
    if (count >= MAX_BANK_ACCOUNTS)
      throw new UnprocessableError(ERR.bankAccountLimit, `At most ${MAX_BANK_ACCOUNTS} active bank accounts`);

    const hash = accountNumberHash(input.ifsc, input.accountNumber);
    if (await BankAccount.findOne({ where: { societyId, accountNumberHash: hash }, transaction: t }))
      throw duplicate();

    const wantsCollection = input.isCollectionAccount ?? count === 0;
    if (wantsCollection)
      await sequelize.query(
        `UPDATE bank_accounts SET isCollectionAccount = 0, version = version + 1, updatedAt = NOW(3)
          WHERE societyId = :societyId AND isCollectionAccount = 1 AND status = 'ACTIVE'`,
        { replacements: { societyId }, transaction: t },
      );

    const group = await groupLedger(societyId, CODE.bankGroup, t);
    const code = await nextLedgerCode(societyId, CODE.bankGroup, t);
    const ledger = await LedgerAccount.create(
      {
        societyId,
        code,
        name: `Bank - ${input.displayName}`.slice(0, 120),
        accountType: 'ASSET',
        subtype: 'BANK',
        parentId: n(group.id),
        isSystem: true,
        createdBy: ctx.user?.id ?? null,
      } as never,
      { transaction: t },
    );
    const b = await BankAccount.create(
      {
        societyId,
        ledgerAccountId: n(ledger.id),
        displayName: input.displayName,
        bankName: input.bankName,
        branchName: input.branchName ?? null,
        ifsc: input.ifsc,
        accountKind: input.accountKind,
        accountHolderName: input.accountHolderName,
        accountNumberEnc: encryptAccountNumber(societyId, input.accountNumber),
        accountNumberLast4: last4(input.accountNumber),
        accountNumberHash: hash,
        isCollectionAccount: wantsCollection,
        statementFormat: input.statementFormat ?? 'GENERIC_CSV',
        openingBalancePaise: opening,
        openingBalanceDate: opening !== 0 ? (input.openingBalanceDate ?? null) : null,
        createdBy: ctx.user?.id ?? null,
        updatedBy: ctx.user?.id ?? null,
      } as never,
      { transaction: t },
    );
    if (opening !== 0)
      await postJournal(
        ctx,
        {
          date: input.openingBalanceDate!,
          voucherType: 'OPENING_BALANCE',
          refType: 'bank_opening',
          refId: n(b.id),
          narration: `Opening balance of ${input.displayName}`,
          lines:
            opening > 0
              ? [
                  { ledgerAccountCode: code, debitPaise: opening, creditPaise: 0 },
                  { ledgerAccountCode: CODE.openingAdjustment, debitPaise: 0, creditPaise: opening },
                ]
              : [
                  { ledgerAccountCode: CODE.openingAdjustment, debitPaise: -opening, creditPaise: 0 },
                  { ledgerAccountCode: code, debitPaise: 0, creditPaise: -opening },
                ],
        },
        t,
      );
    await audit(
      ctx,
      {
        action: AUDIT.bankAccountCreated,
        entityType: 'bank_account',
        entityId: n(b.id),
        entityLabel: b.displayName,
        societyId,
        before: null,
        after: auditShape(b),
      },
      t,
    );
    notifyCommittee(t, ctx, societyId, b, 'added');
    afterCommitFinance(t, societyId, n(b.id));
    const fresh = (await BankAccount.findByPk(n(b.id), { transaction: t }))!;
    return dtoOf(fresh, t);
  });
}

// ------------------------------------------------------------------ patch
export async function patchBankAccount(ctx: Ctx, id: number, input: BankPatchInput): Promise<BankAccountDto> {
  const societyId = societyIdOf(ctx);
  return moneyTx(async t => {
    await ensureBooks(t, societyId);
    const b = await loadLocked(societyId, id, t);
    if (n(b.version) !== input.version) throw staleVersion();
    if (b.status !== 'ACTIVE') throw invalidState('This bank account is closed');
    const before = auditShape(b);
    const sensitive = input.ifsc !== undefined || input.accountNumber !== undefined;
    if (sensitive) {
      const full = input.accountNumber ?? decryptAccountNumber(societyId, (await unscopedEnc(id, t))!);
      const ifsc = input.ifsc ?? b.ifsc;
      const hash = accountNumberHash(ifsc, full);
      if (hash !== b.accountNumberHash) {
        if (
          await BankAccount.findOne({
            where: { societyId, accountNumberHash: hash, id: { [Op.ne]: id } },
            transaction: t,
          })
        )
          throw duplicate();
        b.accountNumberHash = hash;
        b.ifsc = ifsc;
        if (input.accountNumber !== undefined) {
          b.accountNumberEnc = encryptAccountNumber(societyId, full);
          b.accountNumberLast4 = last4(full);
        }
        b.verificationStatus = 'UNVERIFIED';
        b.verifiedBy = null;
        b.verifiedAt = null;
      }
    }
    if (input.displayName !== undefined) b.displayName = input.displayName;
    if (input.branchName !== undefined) b.branchName = input.branchName;
    if (input.statementFormat !== undefined) b.statementFormat = input.statementFormat;
    if (input.accountHolderName !== undefined) {
      if (input.accountHolderName !== b.accountHolderName && b.verificationStatus === 'VERIFIED') {
        // a different holder is a different account as far as the second person's check goes
        b.verificationStatus = 'UNVERIFIED';
        b.verifiedBy = null;
        b.verifiedAt = null;
      }
      b.accountHolderName = input.accountHolderName;
    }
    b.updatedBy = ctx.user?.id ?? null;
    b.version = n(b.version) + 1;
    await b.save({ transaction: t });
    if (input.displayName !== undefined)
      await LedgerAccount.update(
        { name: `Bank - ${input.displayName}`.slice(0, 120) },
        { where: { id: n(b.ledgerAccountId), societyId }, transaction: t },
      );
    await audit(
      ctx,
      {
        action: AUDIT.bankAccountUpdated,
        entityType: 'bank_account',
        entityId: n(b.id),
        entityLabel: b.displayName,
        societyId,
        before,
        after: auditShape(b),
      },
      t,
    );
    notifyCommittee(t, ctx, societyId, b, 'edited');
    return dtoOf(b, t);
  });
}

async function unscopedEnc(id: number, t: Transaction): Promise<Buffer | null> {
  const row = await BankAccount.unscoped().findByPk(id, { attributes: ['accountNumberEnc'], transaction: t });
  return row ? Buffer.from(row.accountNumberEnc) : null;
}

// ------------------------------------------------------------------ verify (maker-checker)
export async function verifyBankAccount(ctx: Ctx, id: number, version: number): Promise<BankAccountDto> {
  const societyId = societyIdOf(ctx);
  const me = ctx.user?.id ?? null;
  return moneyTx(async t => {
    const b = await loadLocked(societyId, id, t);
    if (n(b.version) !== version) throw staleVersion();
    if (b.status !== 'ACTIVE') throw invalidState('This bank account is closed');
    if (b.verificationStatus === 'VERIFIED') throw invalidState('This bank account is already verified');
    if (me !== null && (n(b.createdBy) === me || n(b.updatedBy) === me))
      throw new ConflictError(
        ERR.makerChecker,
        'The person who added or last edited this account cannot verify it',
      );
    const before = auditShape(b);
    b.verificationStatus = 'VERIFIED';
    b.verifiedBy = me;
    b.verifiedAt = new Date();
    b.version = n(b.version) + 1;
    await b.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.bankAccountVerified,
        entityType: 'bank_account',
        entityId: n(b.id),
        entityLabel: b.displayName,
        societyId,
        before,
        after: auditShape(b),
      },
      t,
    );
    t.afterCommit(async () => {
      const to = [b.createdBy, b.updatedBy].filter((v): v is number => Boolean(v) && n(v) !== me).map(n);
      if (to.length)
        await accountsPorts().notifications.send(NOTIFY.bankAccountVerified, [...new Set(to)], {
          societyId,
          bankAccountId: n(b.id),
          displayName: b.displayName,
        });
    });
    return dtoOf(b, t);
  });
}

// ------------------------------------------------------------------ set collection
export async function setCollectionAccount(ctx: Ctx, id: number, version: number): Promise<BankAccountDto> {
  const societyId = societyIdOf(ctx);
  return moneyTx(async t => {
    await ensureBooks(t, societyId);
    const b = await loadLocked(societyId, id, t);
    if (n(b.version) !== version) throw staleVersion();
    if (b.status !== 'ACTIVE') throw invalidState('This bank account is closed');
    if (b.isCollectionAccount) return dtoOf(b, t);
    const before = auditShape(b);
    await sequelize.query(
      `UPDATE bank_accounts SET isCollectionAccount = 0, version = version + 1, updatedAt = NOW(3)
        WHERE societyId = :societyId AND isCollectionAccount = 1 AND status = 'ACTIVE'`,
      { replacements: { societyId }, transaction: t },
    );
    b.isCollectionAccount = true;
    b.updatedBy = ctx.user?.id ?? null;
    b.version = n(b.version) + 1;
    await b.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.bankAccountCollectionSet,
        entityType: 'bank_account',
        entityId: n(b.id),
        entityLabel: b.displayName,
        societyId,
        before,
        after: auditShape(b),
      },
      t,
    );
    notifyCommittee(t, ctx, societyId, b, 'made the collection account');
    return dtoOf(b, t);
  });
}

// ------------------------------------------------------------------ close (BR-13-37)
export async function closeBankAccount(
  ctx: Ctx,
  id: number,
  input: { reason: string; version: number },
): Promise<BankAccountDto> {
  const societyId = societyIdOf(ctx);
  return moneyTx(async t => {
    await ensureBooks(t, societyId);
    const b = await loadLocked(societyId, id, t);
    if (n(b.version) !== input.version) throw staleVersion();
    if (b.status !== 'ACTIVE') throw invalidState('This bank account is already closed');
    if (b.isCollectionAccount)
      throw new UnprocessableError(
        ERR.collectionAccountRequired,
        'Make another account the collection account before closing this one',
      );
    const ledger = (await LedgerAccount.findByPk(n(b.ledgerAccountId), {
      transaction: t,
      lock: t.LOCK.UPDATE,
    }))!;
    if (n(ledger.balancePaise) !== 0)
      throw new UnprocessableError(
        ERR.bankBalanceNotZero,
        'The book balance must be zero to close an account',
      );
    const before = auditShape(b);
    b.status = 'CLOSED';
    b.closedAt = new Date();
    b.updatedBy = ctx.user?.id ?? null;
    b.version = n(b.version) + 1;
    await b.save({ transaction: t });
    ledger.isActive = false;
    await ledger.save({ transaction: t });
    await audit(
      ctx,
      {
        action: AUDIT.bankAccountClosed,
        entityType: 'bank_account',
        entityId: n(b.id),
        entityLabel: b.displayName,
        societyId,
        before,
        after: auditShape(b),
        reason: input.reason,
      },
      t,
    );
    notifyCommittee(t, ctx, societyId, b, 'closed');
    return dtoOf(b, t);
  });
}

// ------------------------------------------------------------------ reveal (BR-13-35)
export async function revealAccountNumber(ctx: Ctx, id: number): Promise<{ accountNumber: string }> {
  const societyId = societyIdOf(ctx);
  return sequelize.transaction(async t => {
    const b = await BankAccount.findOne({ where: { id, societyId }, transaction: t });
    if (!b) throw bankNotFound();
    const enc = await unscopedEnc(id, t);
    const accountNumber = decryptAccountNumber(societyId, enc!);
    await audit(
      ctx,
      {
        action: AUDIT.bankAccountRevealed,
        entityType: 'bank_account',
        entityId: n(b.id),
        entityLabel: b.displayName,
        societyId,
        after: { maskedNumber: maskNumber(b.accountNumberLast4) },
      },
      t,
    );
    return { accountNumber };
  });
}
