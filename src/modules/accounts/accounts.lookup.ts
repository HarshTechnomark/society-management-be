import { QueryTypes, type Transaction } from 'sequelize';
import { BankAccount, Fund, LedgerAccount, SocietyBalance, sequelize } from '../../models';
import { NotFoundError } from '../../utils/errors';
import { ERR, KEY_BANK, KEY_COLLECTION_FUND, SYSTEM_KEYS, type FundType } from './accounts.constants';
import { ensureBooks } from './accounts.chart';
import { n } from './accounts.shared';
import type { FundDto, SocietyBalanceDto } from './accounts.types';

export const CODE_RE = /^\d{4}(-\d{3})?$/;

/** `ledgerAccounts.exists` (BR-11-12): a code or a system key that is an active leaf. Seeds the chart first when the society has none. */
export async function ledgerAccountExists(societyId: number, codeOrKey: string): Promise<boolean> {
  if (codeOrKey === KEY_COLLECTION_FUND || codeOrKey === KEY_BANK) return true;
  const code = SYSTEM_KEYS[codeOrKey] ?? codeOrKey;
  if (!CODE_RE.test(code)) return false;
  const books = await SocietyBalance.findOne({ where: { societyId }, attributes: ['chartSeededAt'] });
  if (!books?.chartSeededAt) await sequelize.transaction(t => ensureBooks(t, societyId));
  const a = await LedgerAccount.findOne({ where: { societyId, code }, attributes: ['isGroup', 'isActive'] });
  return Boolean(a && !a.isGroup && a.isActive);
}

export async function ledgerAccountByCode(
  societyId: number,
  code: string,
  t?: Transaction,
): Promise<LedgerAccount | null> {
  return LedgerAccount.findOne({ where: { societyId, code: SYSTEM_KEYS[code] ?? code }, transaction: t });
}

/** The ledger of a fund (BR-13-3 `COLLECTION_FUND`), or null. */
export async function fundLedger(
  societyId: number,
  fundId: number,
  t?: Transaction,
): Promise<{ fund: Fund; ledger: LedgerAccount } | null> {
  const fund = await Fund.findOne({ where: { id: fundId, societyId }, transaction: t });
  if (!fund) return null;
  const ledger = await LedgerAccount.findByPk(fund.ledgerAccountId, { transaction: t });
  return ledger ? { fund, ledger } : null;
}

/** Section 8.20 `accounts.collectionBankAccount`: the active collection bank account and its `1110-NNN` code. */
export async function collectionBank(
  societyId: number,
  t?: Transaction,
): Promise<{ id: number; ledgerCode: string } | null> {
  const [row] = await sequelize.query<{ id: number; code: string }>(
    `SELECT b.id AS id, l.code AS code FROM bank_accounts b JOIN ledger_accounts l ON l.id = b.ledgerAccountId
      WHERE b.societyId = :societyId AND b.isCollectionAccount = 1 AND b.status = 'ACTIVE' LIMIT 1`,
    { replacements: { societyId }, type: QueryTypes.SELECT, transaction: t },
  );
  return row ? { id: n(row.id), ledgerCode: row.code } : null;
}

/** Section 8.20 `accounts.bankLedgerCode`. */
export async function bankLedgerCode(societyId: number, bankAccountId: number): Promise<string> {
  const [row] = await sequelize.query<{ code: string }>(
    `SELECT l.code AS code FROM bank_accounts b JOIN ledger_accounts l ON l.id = b.ledgerAccountId
      WHERE b.id = :bankAccountId AND b.societyId = :societyId`,
    { replacements: { societyId, bankAccountId }, type: QueryTypes.SELECT },
  );
  if (!row) throw new NotFoundError(ERR.bankAccountNotFound, 'Bank account not found');
  return row.code;
}

/** Section 8.20 `funds.get`. */
export async function getFund(societyId: number, fundId: number): Promise<FundDto | null> {
  const r = await fundLedger(societyId, fundId);
  if (!r) return null;
  return {
    id: n(r.fund.id),
    name: r.fund.name,
    fundType: r.fund.fundType,
    status: r.fund.status,
    ledgerCode: r.ledger.code,
    balancePaise: 0 - n(r.ledger.balancePaise),
  };
}

/** Section 8.20 `bankAccounts.get`. */
export async function getBankAccount(societyId: number, bankAccountId: number) {
  const b = await BankAccount.findOne({ where: { id: bankAccountId, societyId } });
  if (!b) return null;
  const code = await bankLedgerCode(societyId, bankAccountId);
  return {
    id: n(b.id),
    displayName: b.displayName,
    bankName: b.bankName,
    maskedNumber: `XXXXXX${b.accountNumberLast4}`,
    ledgerCode: code,
    status: b.status,
    isCollectionAccount: Boolean(b.isCollectionAccount),
    verificationStatus: b.verificationStatus,
  };
}

/** The stored society balance (zeros when the society has no books yet) with its funds; does not seed anything. */
export async function readSocietyBalance(societyId: number): Promise<SocietyBalanceDto> {
  const b = await SocietyBalance.findOne({ where: { societyId } });
  const funds = await sequelize.query<{
    id: number;
    name: string;
    fundType: FundType;
    balancePaise: string;
    showToResidents: number;
  }>(
    `SELECT f.id, f.name, f.fundType, f.showToResidents, -l.balancePaise AS balancePaise
       FROM funds f JOIN ledger_accounts l ON l.id = f.ledgerAccountId
      WHERE f.societyId = :societyId AND f.status = 'ACTIVE' ORDER BY f.id`,
    { replacements: { societyId }, type: QueryTypes.SELECT },
  );
  const total = n(b?.totalPaise);
  const earmarked = n(b?.earmarkedFundsPaise);
  return {
    societyId,
    inBankPaise: n(b?.inBankPaise),
    clearingPaise: n(b?.clearingPaise),
    cashPaise: n(b?.cashPaise),
    chequesPaise: n(b?.chequesPaise),
    totalPaise: total,
    investmentsPaise: n(b?.investmentsPaise),
    earmarkedFundsPaise: earmarked,
    generalPaise: total - earmarked,
    lastChangedAt: b?.lastChangedAt ? b.lastChangedAt.toISOString() : null,
    lastJournalEntryId: b?.lastJournalEntryId ? n(b.lastJournalEntryId) : null,
    funds: funds.map(f => ({
      id: n(f.id),
      name: f.name,
      fundType: f.fundType,
      balancePaise: n(f.balancePaise),
      showToResidents: Boolean(f.showToResidents),
    })),
  };
}
