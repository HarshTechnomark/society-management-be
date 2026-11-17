import { QueryTypes } from 'sequelize';
import { sequelize } from '../../models';
import { ValidationError } from '../../utils/errors';
import type { BalanceDirection, FundType } from './accounts.constants';
import { readSocietyBalance } from './accounts.lookup';
import { addDaysYmd, n, societyToday } from './accounts.shared';

/** 8.1 body. `lastReconciled*` come from the bank account row; the app never claims a bank balance it cannot prove (BR-13-18). */
export interface SocietyBalanceView {
  totalPaise: number;
  inBankPaise: number;
  clearingPaise: number;
  cashPaise: number;
  chequesPaise: number;
  investmentsPaise: number;
  earmarkedFundsPaise: number;
  generalPaise: number;
  lastChangedAt: string | null;
  bankAccounts: {
    id: number;
    displayName: string;
    bankName: string;
    maskedNumber: string;
    ledgerCode: string;
    balancePaise: number;
    isCollectionAccount: boolean;
    verificationStatus: string;
    lastReconciledDate: string | null;
    lastReconciledBalancePaise: number | null;
  }[];
  funds: { id: number; name: string; fundType: FundType; balancePaise: number }[];
  movements: {
    journalEntryId: number;
    changedAt: string;
    direction: BalanceDirection;
    deltaTotalPaise: number;
    label: string;
    totalPaise: number;
  }[];
}

const MOVEMENTS = 20;

export async function getSocietyBalance(societyId: number): Promise<SocietyBalanceView> {
  const b = await readSocietyBalance(societyId);
  const banks = await sequelize.query<Record<string, unknown>>(
    `SELECT b.id, b.displayName, b.bankName, b.accountNumberLast4, b.isCollectionAccount, b.verificationStatus,
            b.lastReconciledDate, b.lastReconciledBalancePaise, l.code AS ledgerCode, l.balancePaise AS balancePaise
       FROM bank_accounts b JOIN ledger_accounts l ON l.id = b.ledgerAccountId
      WHERE b.societyId = :societyId AND b.status = 'ACTIVE'
      ORDER BY b.isCollectionAccount DESC, b.id`,
    { replacements: { societyId }, type: QueryTypes.SELECT },
  );
  const moves = await sequelize.query<Record<string, unknown>>(
    `SELECT journalEntryId, changedAt, direction, deltaTotalPaise, label, totalPaise
       FROM balance_history WHERE societyId = :societyId ORDER BY id DESC LIMIT ${MOVEMENTS}`,
    { replacements: { societyId }, type: QueryTypes.SELECT },
  );
  return {
    totalPaise: b.totalPaise,
    inBankPaise: b.inBankPaise,
    clearingPaise: b.clearingPaise,
    cashPaise: b.cashPaise,
    chequesPaise: b.chequesPaise,
    investmentsPaise: b.investmentsPaise,
    earmarkedFundsPaise: b.earmarkedFundsPaise,
    generalPaise: b.generalPaise,
    lastChangedAt: b.lastChangedAt,
    bankAccounts: banks.map(r => ({
      id: n(r.id),
      displayName: String(r.displayName),
      bankName: String(r.bankName),
      maskedNumber: `XXXXXX${String(r.accountNumberLast4)}`,
      ledgerCode: String(r.ledgerCode),
      balancePaise: n(r.balancePaise),
      isCollectionAccount: Boolean(r.isCollectionAccount),
      verificationStatus: String(r.verificationStatus),
      lastReconciledDate: r.lastReconciledDate ? String(r.lastReconciledDate).slice(0, 10) : null,
      lastReconciledBalancePaise:
        r.lastReconciledBalancePaise === null || r.lastReconciledBalancePaise === undefined
          ? null
          : n(r.lastReconciledBalancePaise),
    })),
    funds: b.funds.map(f => ({ id: f.id, name: f.name, fundType: f.fundType, balancePaise: f.balancePaise })),
    movements: moves.map(m => ({
      journalEntryId: n(m.journalEntryId),
      changedAt: new Date(m.changedAt as string | Date).toISOString(),
      direction: m.direction as BalanceDirection,
      deltaTotalPaise: n(m.deltaTotalPaise),
      label: String(m.label),
      totalPaise: n(m.totalPaise),
    })),
  };
}

export interface BalancePoint {
  date: string;
  totalPaise: number;
  inBankPaise: number;
  clearingPaise: number;
  cashPaise: number;
  chequesPaise: number;
}

const ZERO = { totalPaise: 0, inBankPaise: 0, clearingPaise: 0, cashPaise: 0, chequesPaise: 0 };
const FIELDS = 'entryDate, totalPaise, inBankPaise, clearingPaise, cashPaise, chequesPaise';

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * 8.2 and public `balance.history`: one point per day of `from..to`, the last `balance_history` row (by entry date, then id) on or
 * before that day; days without a change repeat the previous value, and days before the first row are zero.
 */
export async function balanceHistory(
  societyId: number,
  from: string,
  to: string,
): Promise<{ points: BalancePoint[] }> {
  const errors: { field: string; message: string }[] = [];
  if (to < from) errors.push({ field: 'to', message: 'To must not be before from' });
  else if (daysBetween(from, to) > 366)
    errors.push({ field: 'to', message: 'The range is at most 366 days' });
  if (to > (await societyToday(societyId)))
    errors.push({ field: 'to', message: 'To must not be in the future' });
  if (errors.length) throw new ValidationError(errors);

  const baseline = await sequelize.query<Record<string, unknown>>(
    `SELECT ${FIELDS} FROM balance_history WHERE societyId = :societyId AND entryDate < :from ORDER BY entryDate DESC, id DESC LIMIT 1`,
    { replacements: { societyId, from }, type: QueryTypes.SELECT },
  );
  const rows = await sequelize.query<Record<string, unknown>>(
    `SELECT ${FIELDS} FROM balance_history WHERE societyId = :societyId AND entryDate >= :from AND entryDate <= :to ORDER BY entryDate, id`,
    { replacements: { societyId, from, to }, type: QueryTypes.SELECT },
  );
  const pick = (r: Record<string, unknown>) => ({
    totalPaise: n(r.totalPaise),
    inBankPaise: n(r.inBankPaise),
    clearingPaise: n(r.clearingPaise),
    cashPaise: n(r.cashPaise),
    chequesPaise: n(r.chequesPaise),
  });
  let current = baseline[0] ? pick(baseline[0]) : { ...ZERO };
  const points: BalancePoint[] = [];
  let i = 0;
  const total = daysBetween(from, to);
  for (let d = 0; d <= total; d++) {
    const date = addDaysYmd(from, d);
    while (i < rows.length && String(rows[i]!.entryDate).slice(0, 10) <= date) current = pick(rows[i++]!);
    points.push({ date, ...current });
  }
  return { points };
}
