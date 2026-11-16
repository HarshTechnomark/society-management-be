import { QueryTypes, type Transaction } from 'sequelize';
import { Fund, LedgerAccount, SocietyBalance, sequelize } from '../../models';
import { now } from '../../lib/clock';
import { audit } from '../../utils/audit';
import { systemCtx } from '../../types/context';
import {
  AUDIT,
  CHART_TEMPLATE_VERSION,
  SYSTEM_KEYS,
  type AccountSubtype,
  type AccountType,
  type FundType,
} from './accounts.constants';

/**
 * The seeded housing-society chart of accounts (template version 1, section 7.13) and the lazy, idempotent seeding of a society's books
 * (BR-13-15). Codes never change; other modules post by code or by system key (7.15).
 */
interface ChartRow {
  code: string;
  name: string;
  type: AccountType;
  subtype?: AccountSubtype;
  parent: string | null;
  group?: boolean;
  /** Cash-book category (`isCashBookCategory`). */
  c?: boolean;
  description?: string;
}
const A = 'ASSET';
const L = 'LIABILITY';
const F = 'FUND';
const I = 'INCOME';
const E = 'EXPENSE';

export const CHART: readonly ChartRow[] = [
  { code: '1000', name: 'Assets', type: A, parent: null, group: true },
  { code: '1100', name: 'Cash and bank', type: A, parent: '1000', group: true },
  { code: '1110', name: 'Bank accounts', type: A, subtype: 'BANK', parent: '1100', group: true },
  { code: '1120', name: 'Cash in hand', type: A, subtype: 'CASH', parent: '1100' },
  { code: '1130', name: 'Petty cash', type: A, subtype: 'PETTY_CASH', parent: '1100' },
  {
    code: '1140',
    name: 'Gateway clearing (received, reaching bank)',
    type: A,
    subtype: 'CLEARING',
    parent: '1100',
  },
  { code: '1150', name: 'Cheques in clearing', type: A, subtype: 'CHEQUES', parent: '1100' },
  { code: '1200', name: 'Investments', type: A, subtype: 'INVESTMENT', parent: '1000', group: true },
  { code: '1210', name: 'Fixed deposits', type: A, subtype: 'INVESTMENT', parent: '1200' },
  {
    code: '1300',
    name: "Members' receivable (maintenance dues)",
    type: A,
    subtype: 'RECEIVABLE',
    parent: '1000',
  },
  { code: '1310', name: 'Interest accrued receivable', type: A, parent: '1000' },
  { code: '1400', name: 'Tax assets, advances and prepaid', type: A, parent: '1000', group: true },
  { code: '1410', name: 'GST input credit', type: A, subtype: 'TAX', parent: '1400' },
  { code: '1420', name: 'TDS receivable (deducted by bank)', type: A, subtype: 'TAX', parent: '1400' },
  { code: '1430', name: 'Advances to vendors', type: A, parent: '1400' },
  { code: '1440', name: 'Prepaid expenses', type: A, parent: '1400' },
  { code: '1450', name: 'Utility and other deposits paid', type: A, parent: '1400' },
  { code: '1500', name: 'Fixed assets', type: A, parent: '1000', group: true },
  { code: '1510', name: 'Building and civil structure', type: A, parent: '1500' },
  { code: '1520', name: 'Plant and machinery (lifts, DG, pumps)', type: A, parent: '1500' },
  { code: '1530', name: 'Furniture, fixtures and equipment', type: A, parent: '1500' },
  { code: '1590', name: 'Accumulated depreciation', type: A, parent: '1500', description: 'Credit balance' },
  { code: '2000', name: 'Liabilities', type: L, parent: null, group: true },
  { code: '2100', name: 'Payables', type: L, subtype: 'PAYABLE', parent: '2000', group: true },
  { code: '2110', name: 'Sundry creditors (vendors)', type: L, subtype: 'PAYABLE', parent: '2100' },
  { code: '2120', name: 'Expenses payable', type: L, subtype: 'PAYABLE', parent: '2100' },
  { code: '2130', name: 'Refunds payable to members', type: L, subtype: 'PAYABLE', parent: '2100' },
  { code: '2140', name: 'TDS payable', type: L, subtype: 'TAX', parent: '2100' },
  { code: '2200', name: 'Member advances', type: L, parent: '2000', group: true },
  { code: '2210', name: "Members' advances", type: L, parent: '2200' },
  { code: '2300', name: 'Duties and taxes', type: L, subtype: 'TAX', parent: '2000', group: true },
  { code: '2310', name: 'Output CGST payable', type: L, subtype: 'TAX', parent: '2300' },
  { code: '2320', name: 'Output SGST payable', type: L, subtype: 'TAX', parent: '2300' },
  { code: '2330', name: 'Output IGST payable', type: L, subtype: 'TAX', parent: '2300' },
  { code: '2400', name: 'Funds', type: F, subtype: 'FUND', parent: null, group: true },
  { code: '2410', name: 'Sinking fund', type: F, subtype: 'FUND', parent: '2400' },
  { code: '2420', name: 'Repair and maintenance fund', type: F, subtype: 'FUND', parent: '2400' },
  { code: '2430', name: 'Corpus fund', type: F, subtype: 'FUND', parent: '2400' },
  { code: '2440', name: 'Collection and event funds', type: F, subtype: 'FUND', parent: '2400', group: true },
  { code: '2450', name: 'Other earmarked funds', type: F, subtype: 'FUND', parent: '2400', group: true },
  { code: '2500', name: 'Deposits payable', type: L, subtype: 'DEPOSIT', parent: '2000', group: true },
  { code: '2510', name: 'Renovation deposits', type: L, subtype: 'DEPOSIT', parent: '2500' },
  { code: '2520', name: 'Move-in and move-out deposits', type: L, subtype: 'DEPOSIT', parent: '2500' },
  { code: '2530', name: 'Amenity booking deposits', type: L, subtype: 'DEPOSIT', parent: '2500' },
  { code: '2540', name: 'Access card and key deposits', type: L, subtype: 'DEPOSIT', parent: '2500' },
  { code: '2550', name: 'Other refundable deposits', type: L, subtype: 'DEPOSIT', parent: '2500' },
  { code: '2600', name: 'Other liabilities', type: L, parent: '2000', group: true },
  { code: '2610', name: 'Unidentified receipts', type: L, parent: '2600' },
  { code: '2690', name: 'Suspense', type: L, parent: '2600' },
  { code: '3000', name: 'Surplus and opening', type: F, subtype: 'SURPLUS', parent: null, group: true },
  { code: '3100', name: 'Income and expenditure surplus', type: F, subtype: 'SURPLUS', parent: '3000' },
  { code: '3900', name: 'Opening balance adjustment', type: F, subtype: 'OPENING', parent: '3000' },
  { code: '4000', name: 'Income', type: I, parent: null, group: true },
  { code: '4100', name: 'Maintenance (service charges) income', type: I, parent: '4000' },
  { code: '4110', name: 'Non-occupancy charges', type: I, parent: '4000' },
  { code: '4120', name: 'Parking charges', type: I, parent: '4000' },
  { code: '4130', name: 'Water charges', type: I, parent: '4000' },
  { code: '4135', name: 'Electricity charges recovered', type: I, parent: '4000' },
  { code: '4140', name: 'Interest on arrears', type: I, parent: '4000' },
  { code: '4145', name: 'Late payment fee', type: I, parent: '4000' },
  { code: '4150', name: 'Festival and event contributions', type: I, parent: '4000' },
  { code: '4160', name: 'Amenity charges', type: I, parent: '4000' },
  { code: '4170', name: 'Fines and penalties', type: I, parent: '4000' },
  { code: '4180', name: 'Service charges recovered', type: I, parent: '4000' },
  { code: '4190', name: 'Other charges', type: I, parent: '4000' },
  { code: '4200', name: 'Municipal tax recoveries', type: I, parent: '4000' },
  { code: '4300', name: 'Interest on bank and fixed deposits', type: I, parent: '4000' },
  { code: '4310', name: 'Convenience fees recovered from members', type: I, parent: '4000' },
  { code: '4400', name: 'NOC and transfer fees', type: I, parent: '4000' },
  { code: '4420', name: 'Entrance fees', type: I, parent: '4000' },
  { code: '4600', name: 'Deposit deductions and forfeitures', type: I, parent: '4000' },
  { code: '4700', name: 'Rent from hoardings and mobile towers', type: I, parent: '4000' },
  { code: '4900', name: 'Transfer from funds', type: I, parent: '4000' },
  { code: '4950', name: 'Miscellaneous income', type: I, parent: '4000' },
  { code: '4990', name: 'Round-off', type: I, parent: '4000' },
  { code: '5000', name: 'Expenses', type: E, parent: null, group: true },
  { code: '5100', name: 'Housekeeping and cleaning', type: E, parent: '5000', c: true },
  { code: '5110', name: 'Security services', type: E, parent: '5000', c: true },
  { code: '5120', name: 'Staff salaries and wages', type: E, parent: '5000' },
  { code: '5200', name: 'Electricity (common areas)', type: E, parent: '5000', c: true },
  { code: '5210', name: 'Water purchase and municipal water', type: E, parent: '5000', c: true },
  { code: '5300', name: 'Repairs and maintenance (civil)', type: E, parent: '5000', c: true },
  { code: '5310', name: 'Repairs (electrical)', type: E, parent: '5000', c: true },
  { code: '5320', name: 'Repairs (plumbing)', type: E, parent: '5000', c: true },
  { code: '5330', name: 'Lift AMC and repairs', type: E, parent: '5000', c: true },
  { code: '5340', name: 'DG set fuel and maintenance', type: E, parent: '5000', c: true },
  { code: '5350', name: 'Garden and landscaping', type: E, parent: '5000', c: true },
  { code: '5360', name: 'Pest control', type: E, parent: '5000', c: true },
  { code: '5400', name: 'Property tax', type: E, parent: '5000' },
  { code: '5410', name: 'Insurance', type: E, parent: '5000' },
  { code: '5500', name: 'Printing, stationery and postage', type: E, parent: '5000', c: true },
  { code: '5510', name: 'Office and administration', type: E, parent: '5000', c: true },
  { code: '5520', name: 'Audit fees', type: E, parent: '5000' },
  { code: '5530', name: 'Legal and professional fees', type: E, parent: '5000', c: true },
  { code: '5540', name: 'Software subscriptions', type: E, parent: '5000' },
  { code: '5600', name: 'Bank charges', type: E, parent: '5000' },
  { code: '5610', name: 'Payment gateway charges', type: E, parent: '5000' },
  { code: '5700', name: 'Festival and event expenses', type: E, parent: '5000', c: true },
  { code: '5800', name: 'Depreciation', type: E, parent: '5000' },
  { code: '5900', name: 'Bad debts written off', type: E, parent: '5000' },
  { code: '5990', name: 'Miscellaneous expenses', type: E, parent: '5000', c: true },
];

/** Resident FULL-view category of a leaf (section 7.13 `transparencyCategory` defaults). */
export function transparencyCategoryOf(code: string, type: AccountType): string | null {
  const prefix = code.slice(0, 2);
  if (type === 'INCOME') return prefix === '41' ? 'Maintenance and charges' : 'Other income';
  if (type !== 'EXPENSE') return null;
  const map: Record<string, string> = {
    '51': 'Staff and security',
    '52': 'Utilities',
    '53': 'Repairs and maintenance',
    '54': 'Taxes and insurance',
    '55': 'Administration',
    '56': 'Bank and gateway charges',
    '57': 'Festivals and events',
  };
  return map[prefix] ?? 'Other';
}

/** The three standard funds created with the chart (BR-13-31). They cannot be closed. */
export const SEEDED_FUNDS: readonly { fundType: FundType; name: string; code: string }[] = [
  { fundType: 'SINKING', name: 'Sinking fund', code: '2410' },
  { fundType: 'REPAIR', name: 'Repair and maintenance fund', code: '2420' },
  { fundType: 'CORPUS', name: 'Corpus fund', code: '2430' },
];

const KEY_OF_CODE = new Map(Object.entries(SYSTEM_KEYS).map(([k, c]) => [c, k]));

async function seedChart(societyId: number, t: Transaction): Promise<void> {
  const at = now();
  const byCode = new Map<string, number>();
  const parentCodes = new Set(CHART.map(r => r.parent).filter((p): p is string => p !== null));
  let level = CHART.filter(r => r.parent === null);
  while (level.length) {
    await LedgerAccount.bulkCreate(
      level.map(r => ({
        societyId,
        code: r.code,
        name: r.name,
        accountType: r.type,
        subtype: r.subtype ?? 'OTHER',
        parentId: r.parent ? (byCode.get(r.parent) ?? null) : null,
        systemKey: KEY_OF_CODE.get(r.code) ?? null,
        isGroup: Boolean(r.group) || parentCodes.has(r.code),
        isSystem: true,
        isActive: true,
        isCashBookCategory: Boolean(r.c),
        transparencyCategory: r.group ? null : transparencyCategoryOf(r.code, r.type),
        description: r.description ?? null,
        balancePaise: 0,
        lastPostedAt: null,
        createdAt: at,
        updatedAt: at,
      })),
      { transaction: t },
    );
    const rows = await LedgerAccount.findAll({
      where: { societyId },
      attributes: ['id', 'code'],
      transaction: t,
    });
    for (const r of rows) byCode.set(r.code, Number(r.id));
    const done = new Set(level.map(r => r.code));
    level = CHART.filter(
      r => r.parent !== null && byCode.has(r.parent) && !byCode.has(r.code) && !done.has(r.code),
    );
  }
  await Fund.bulkCreate(
    SEEDED_FUNDS.map(f => ({
      societyId,
      fundType: f.fundType,
      name: f.name,
      nameKey: f.name.toLowerCase(),
      ledgerAccountId: byCode.get(f.code)!,
      showToResidents: true,
      createdAt: at,
      updatedAt: at,
    })),
    { transaction: t },
  );
}

const inserted = new WeakMap<Transaction, Set<number>>();

/**
 * Inserts the `society_balances` row (once per transaction, `ON DUPLICATE KEY UPDATE id = id` so concurrent first calls never gap-lock
 * each other), locks it `FOR UPDATE` and seeds the chart and the three funds when `chartSeededAt` is NULL (BR-13-15). Returns the locked
 * row; every writer of the books starts here, which is also lock order step 2 of BR-13-10.
 */
export async function lockBooks(t: Transaction, societyId: number): Promise<SocietyBalance> {
  let seen = inserted.get(t);
  if (!seen) inserted.set(t, (seen = new Set()));
  if (!seen.has(societyId)) {
    const at = now().toISOString().slice(0, 23).replace('T', ' ');
    await sequelize.query(
      `INSERT INTO society_balances (societyId, chartTemplateVersion, createdAt, updatedAt) VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE id = id`,
      { replacements: [societyId, CHART_TEMPLATE_VERSION, at, at], transaction: t },
    );
    seen.add(societyId);
  }
  const row = await SocietyBalance.findOne({ where: { societyId }, transaction: t, lock: t.LOCK.UPDATE });
  if (!row) throw new Error(`society_balances row of society ${societyId} missing`);
  if (!row.chartSeededAt) {
    await seedChart(societyId, t);
    row.chartSeededAt = now();
    row.chartTemplateVersion = CHART_TEMPLATE_VERSION;
    await row.save({ transaction: t });
    await audit(
      systemCtx('accounts'),
      {
        action: AUDIT.booksSeeded,
        entityType: 'society_balance',
        entityId: Number(row.id),
        societyId,
        after: { chartTemplateVersion: CHART_TEMPLATE_VERSION, accounts: CHART.length },
      },
      t,
    );
  }
  return row;
}

/** Section 8.20 `accounts.ensureBooks`. */
export async function ensureBooks(t: Transaction, societyId: number): Promise<void> {
  await lockBooks(t, societyId);
}

/** Seeds the books of every society that has none yet (new societies are seeded lazily on their first posting). Returns the society ids it seeded. */
export async function backfillBooks(): Promise<number[]> {
  const rows = await sequelize.query<{ id: number }>(
    `SELECT s.id FROM societies s
      LEFT JOIN society_balances b ON b.societyId = s.id
     WHERE b.id IS NULL OR b.chartSeededAt IS NULL ORDER BY s.id`,
    { type: QueryTypes.SELECT },
  );
  const done: number[] = [];
  for (const r of rows) {
    await sequelize.transaction(t => ensureBooks(t, Number(r.id)));
    done.push(Number(r.id));
  }
  return done;
}
