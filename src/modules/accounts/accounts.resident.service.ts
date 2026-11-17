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
    await sumsByAccount(
      { societyId, from: fyRange(fy).from, to: today, noClosing: true, noFundConsumption: true },
      DEADLINE,
    ),
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

export interface FundStatementLine {
  kind: 'EXPENSE' | 'TRANSFER_OUT' | 'TRANSFER_IN' | 'CONTRIBUTION';
  date: string;
  label: string;
  amountPaise: number;
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
  const [totals] = await readRows<{
    c: string | null;
    d: string | null;
    sc: string | null;
    sd: string | null;
    mi: string | null;
    mo: string | null;
  }>(
    `SELECT SUM(CASE WHEN e.refType NOT IN ('fund_transfer','expense') THEN l.creditPaise - l.debitPaise ELSE 0 END) AS c,
            SUM(CASE WHEN e.refType = 'expense' THEN l.debitPaise - l.creditPaise ELSE 0 END) AS sd,
            SUM(CASE WHEN e.refType = 'fund_transfer' THEN l.creditPaise ELSE 0 END) AS mi,
            SUM(CASE WHEN e.refType = 'fund_transfer' THEN l.debitPaise ELSE 0 END) AS mo,
            SUM(l.creditPaise) AS sc, SUM(l.debitPaise) AS d
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId
      WHERE l.societyId = :societyId AND e.status = 'POSTED' AND l.ledgerAccountId = :ledgerId`,
    { societyId, ledgerId },
    DEADLINE,
  );
  // the expense head sits on another line of the same voucher that consumed this fund
  const spend = await readRows<{ category: string | null; amount: string }>(
    `SELECT a.transparencyCategory AS category, SUM(l.debitPaise - l.creditPaise) AS amount
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId JOIN ledger_accounts a ON a.id = l.ledgerAccountId
      WHERE l.societyId = :societyId AND e.status = 'POSTED' AND a.accountType = 'EXPENSE' AND e.refType = 'expense'
        AND EXISTS (SELECT 1 FROM journal_lines f WHERE f.journalEntryId = e.id AND f.fundId = :fundId AND f.ledgerAccountId = :ledgerId)
      GROUP BY a.transparencyCategory HAVING amount <> 0 ORDER BY amount DESC`,
    { societyId, fundId, ledgerId },
    DEADLINE,
  );
  const [contrib] = await readRows<{ cnt: string }>(
    `SELECT COUNT(*) AS cnt FROM (
       SELECT r.unitId FROM collection_requests r JOIN collections c ON c.id = r.collectionId
        WHERE r.societyId = :societyId AND c.fundId = :fundId AND r.paidPaise > 0
       UNION
       SELECT i.unitId FROM invoices i JOIN invoice_lines il ON il.invoiceId = i.id JOIN charge_heads h ON h.id = il.chargeHeadId
        WHERE i.societyId = :societyId AND h.fundId = :fundId AND i.paidPaise > 0
     ) u`,
    { societyId, fundId },
    DEADLINE,
  );
  const collectedPaise = n(totals?.c);
  const spentPaise = n(totals?.sd);
  const movedInPaise = n(totals?.mi);
  const movedOutPaise = n(totals?.mo);
  const grouped = new Map<string, number>();
  for (const s of spend)
    grouped.set(s.category ?? OTHER, (grouped.get(s.category ?? OTHER) ?? 0) + n(s.amount));
  // typed lines so the figures add up: balance = collected + movedIn - spent - movedOut. Labels are generic: no narration, payee or unit
  const lineRows = await readRows<{
    entryDate: string;
    refType: string | null;
    d: string;
    c: string;
    category: string | null;
  }>(
    `SELECT l.entryDate, e.refType, l.debitPaise AS d, l.creditPaise AS c,
            (SELECT a.transparencyCategory FROM journal_lines x JOIN ledger_accounts a ON a.id = x.ledgerAccountId
              WHERE x.journalEntryId = e.id AND a.accountType = 'EXPENSE' ORDER BY x.id LIMIT 1) AS category
       FROM journal_lines l JOIN journal_entries e ON e.id = l.journalEntryId
      WHERE l.societyId = :societyId AND e.status = 'POSTED' AND l.ledgerAccountId = :ledgerId
      ORDER BY l.entryDate, l.id LIMIT 1000`,
    { societyId, ledgerId },
    DEADLINE,
  );
  const lines: FundStatementLine[] = lineRows.map(r => {
    const debit = n(r.d);
    const credit = n(r.c);
    const date = String(r.entryDate).slice(0, 10);
    if (r.refType === 'expense')
      return { kind: 'EXPENSE', date, label: `Spent on ${r.category ?? OTHER}`, amountPaise: debit - credit };
    if (r.refType === 'fund_transfer')
      return credit > 0
        ? { kind: 'TRANSFER_IN', date, label: 'Moved in from another fund', amountPaise: credit }
        : { kind: 'TRANSFER_OUT', date, label: 'Moved out to another fund', amountPaise: debit };
    return { kind: 'CONTRIBUTION', date, label: 'Contributions collected', amountPaise: credit - debit };
  });
  return {
    fund: { id: n(fund.id), name: String(fund.name), fundType: String(fund.fundType) },
    lines,
    collectedPaise,
    spentPaise,
    movedInPaise,
    movedOutPaise,
    balancePaise: collectedPaise + movedInPaise - spentPaise - movedOutPaise,
    contributors: n(contrib?.cnt),
    spend: [...grouped.entries()].map(([category, amountPaise]) => ({ category, amountPaise })),
  };
}
