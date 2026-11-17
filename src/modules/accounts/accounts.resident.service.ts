import { NotFoundError } from '../../utils/errors';
import { financialYearOf } from '../../utils/numberSequences';
import { settings } from '../society-setup/society-setup.public';
import { entitlements } from '../subscriptions/subscriptions.public';
import { ENT, ERR } from './accounts.constants';
import { readSocietyBalance } from './accounts.lookup';
import { loadChart, readRows, rollUp, sumsByAccount } from './accounts.reports.queries';
import { fyRange } from './accounts.reports.service';
import { n, societyToday } from './accounts.shared';

/**
 * Section 8.3 and BR-13-19: the resident transparency view. Residents never see payee names, narrations, vendor names or unit
 * numbers: only totals, fund balances and spend grouped by `transparencyCategory`.
 */
const OTHER = 'Other';
const DEADLINE = { deadlineMs: 15_000 };

/** `404 NOT_FOUND` when module 08 setting `finance.showFinancesToResidents` is off. */
export async function assertVisible(societyId: number): Promise<void> {
  const on = await Promise.resolve(settings.get(societyId, 'finance.showFinancesToResidents' as never))
    .then(Boolean)
    .catch(() => false);
  if (!on) throw new NotFoundError('NOT_FOUND', 'Not found');
}

export interface CategoryAmount {
  category: string;
  financialYear: string;
  amountPaise: number;
}

async function byCategory(societyId: number, type: 'INCOME' | 'EXPENSE'): Promise<CategoryAmount[]> {
  const today = await societyToday(societyId);
  const fy = financialYearOf(today);
  const chart = await loadChart(societyId, DEADLINE);
  rollUp(
    chart,
    await sumsByAccount({ societyId, from: fyRange(fy).from, to: today, noClosing: true }, DEADLINE),
  );
  const out = new Map<string, number>();
  for (const a of chart.values()) {
    if (a.isGroup || a.accountType !== type) continue;
    const amount = type === 'INCOME' ? a.credit - a.debit : a.debit - a.credit;
    if (amount === 0) continue;
    const k = a.transparencyCategory ?? OTHER;
    out.set(k, (out.get(k) ?? 0) + amount);
  }
  return [...out.entries()]
    .map(([category, amountPaise]) => ({ category, financialYear: fy, amountPaise }))
    .sort((a, b) => b.amountPaise - a.amountPaise);
}

export async function societyFinances(societyId: number) {
  await assertVisible(societyId);
  const b = await readSocietyBalance(societyId);
  const full = await entitlements.isFeatureOn(societyId, ENT.transparencyDashboard);
  return {
    level: full ? 'FULL' : 'BALANCE',
    totalPaise: b.totalPaise,
    inBankPaise: b.inBankPaise,
    clearingPaise: b.clearingPaise,
    cashPaise: b.cashPaise,
    chequesPaise: b.chequesPaise,
    changedAt: b.lastChangedAt,
    funds: b.funds
      .filter(f => f.showToResidents)
      .map(f => ({ id: f.id, name: f.name, balancePaise: f.balancePaise })),
    spendByCategory: full ? await byCategory(societyId, 'EXPENSE') : null,
    incomeByCategory: full ? await byCategory(societyId, 'INCOME') : null,
  };
}

export async function fundStatementForResident(societyId: number, fundId: number) {
  await assertVisible(societyId);
  const [fund] = await readRows<Record<string, unknown>>(
    `SELECT f.id, f.name, f.fundType, f.ledgerAccountId FROM funds f
      WHERE f.id = :fundId AND f.societyId = :societyId AND f.showToResidents = 1`,
    { fundId, societyId },
    DEADLINE,
  );
  if (!fund) throw new NotFoundError(ERR.fundNotFound, 'Fund not found');
  const ledgerId = n(fund.ledgerAccountId);
  const [totals] = await readRows<{ c: string | null; d: string | null }>(
    `SELECT SUM(l.creditPaise) AS c, SUM(l.debitPaise) AS d
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId
      WHERE l.societyId = :societyId AND e.status = 'POSTED' AND l.ledgerAccountId = :ledgerId`,
    { societyId, ledgerId },
    DEADLINE,
  );
  const spend = await readRows<{ category: string | null; amount: string }>(
    `SELECT a.transparencyCategory AS category, SUM(l.debitPaise - l.creditPaise) AS amount
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId JOIN ledger_accounts a ON a.id = l.ledgerAccountId
      WHERE l.societyId = :societyId AND e.status = 'POSTED' AND l.fundId = :fundId AND a.accountType = 'EXPENSE'
      GROUP BY a.transparencyCategory HAVING amount <> 0 ORDER BY amount DESC`,
    { societyId, fundId },
    DEADLINE,
  );
  const [contrib] = await readRows<{ cnt: string }>(
    `SELECT COUNT(DISTINCT r.unitId) AS cnt FROM collection_requests r JOIN collections c ON c.id = r.collectionId
      WHERE r.societyId = :societyId AND c.fundId = :fundId AND r.paidPaise > 0`,
    { societyId, fundId },
    DEADLINE,
  );
  const collectedPaise = n(totals?.c);
  const spentPaise = n(totals?.d);
  const grouped = new Map<string, number>();
  for (const s of spend)
    grouped.set(s.category ?? OTHER, (grouped.get(s.category ?? OTHER) ?? 0) + n(s.amount));
  return {
    fund: { id: n(fund.id), name: String(fund.name), fundType: String(fund.fundType) },
    collectedPaise,
    spentPaise,
    balancePaise: collectedPaise - spentPaise,
    contributors: n(contrib?.cnt),
    spend: [...grouped.entries()].map(([category, amountPaise]) => ({ category, amountPaise })),
  };
}
